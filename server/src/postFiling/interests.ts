import type { Pool } from "pg";
import { describeError } from "../db/describeError.js";
import { sendOpsAlert } from "../ops/alerts.js";
import { VERIFIED_DEAL_JOIN } from "../ein/portalJobs.js";
import { auth, detail, recordOk, timeout, zfetch } from "../zoho/einPortal.js";

/**
 * A6Y2-T144 Dispatch 13: the post-filing roadmap on /checkout/success (ST17).
 *
 * The customer flags any of three topics for follow-up once their Articles are
 * filed. Each flag is saved against the filing session (table
 * post_filing_interests, migration 0032) and copied to the Zoho Deal in one update:
 * the multi-select Post_Filing_Interests gets the full current set (so turning a
 * flag off removes it) and the long-text Post_Filing_License_Note gets the optional
 * licence/permit note (empty when that flag is off). Both are plain field writes, so
 * a retry can never duplicate anything, and they need only the Deals update
 * permission the service already uses.
 *
 * Trust rules:
 *   - A write needs a filing session AND an order of that session that is held or
 *     paid (the pair the Stripe success URL carries). Nothing else can write.
 *   - The Deal is never taken from the browser. It is the Deal of the session's
 *     earliest held or paid order whose Deal id was verified by a successful sync
 *     job (VERIFIED_DEAL_JOIN, the rule the EIN portal jobs use).
 *   - The Zoho copy runs in the background; the page never waits on Zoho.
 */

/**
 * ST17 four-card hub (Damian, 25 Nov 2026):
 *   Local Business Licenses & Permits     -> licenses_permits
 *   Business Banking, Credit & Financing  -> bank_account
 *   Bookkeeping, Tax & Annual Compliance  -> tax_compliance
 *   Dedicated Filing Support & Strategy   -> filing_support (migration 0039)
 */
export const INTERESTS = ["bank_account", "licenses_permits", "tax_compliance", "filing_support"] as const;
export type Interest = (typeof INTERESTS)[number];

/**
 * Zoho picklist values (Deals.Post_Filing_Interests, field id 2654294000040656012).
 * The note goes to Deals.Post_Filing_License_Note (long text, id 2654294000040639002).
 */
export const INTEREST_LABELS: Record<Interest, string> = {
  bank_account: "Bank Account Setup",
  licenses_permits: "Licenses and Permits",
  tax_compliance: "Tax and Compliance",
  // No such picklist value exists in Zoho yet. It is sent only once Damian has
  // added it and set POST_FILING_SUPPORT_ZOHO_VALUE (labelsFor); until then the
  // choice is saved in post_filing_interests only.
  filing_support: "",
};

export const NOTE_MAX = 500;

export type Db = Pick<Pool, "query">;

export interface PostFilingConfig {
  /** Kill switch. On unless POST_FILING_INTERESTS_ENABLED=false. */
  enabled: boolean;
  /** API name of the Deal multi-select field. */
  dealField: string;
  /** API name of the Deal long-text field for the licence note. */
  noteField: string;
  /**
   * The Post_Filing_Interests picklist value for "Dedicated Filing Support &
   * Strategy" (POST_FILING_SUPPORT_ZOHO_VALUE). Empty until Damian adds the value
   * in Zoho: the choice is then kept out of the Zoho copy.
   */
  filingSupportValue: string;
}

export function postFilingConfig(env: Record<string, string | undefined> = process.env): PostFilingConfig {
  return {
    enabled: (env.POST_FILING_INTERESTS_ENABLED ?? "true").trim().toLowerCase() !== "false",
    dealField: (env.POST_FILING_INTERESTS_FIELD ?? "").trim() || "Post_Filing_Interests",
    noteField: (env.POST_FILING_NOTE_FIELD ?? "").trim() || "Post_Filing_License_Note",
    filingSupportValue: (env.POST_FILING_SUPPORT_ZOHO_VALUE ?? "").trim(),
  };
}

export interface InterestState {
  bank_account: boolean;
  licenses_permits: boolean;
  tax_compliance: boolean;
  filing_support: boolean;
  license_note: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function isInterest(value: unknown): value is Interest {
  return typeof value === "string" && (INTERESTS as readonly string[]).includes(value);
}

/**
 * The customer's note, made safe to store and to show in Zoho: control characters
 * removed (newlines and tabs kept), trimmed, at most NOTE_MAX characters. Empty -> null.
 */
export function cleanNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  return cleaned ? cleaned.slice(0, NOTE_MAX) : null;
}

/** True when the order belongs to the filing session and is held or paid. */
export async function sessionHasHeldOrPaidOrder(db: Db, filingSessionId: string, orderId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM orders o
     JOIN filing_sessions fs ON fs.filing_session_id = o.filing_session_id
     WHERE o.order_id = $1 AND o.filing_session_id = $2 AND o.payment_status IN ('authorized', 'paid')
     LIMIT 1`,
    [orderId, filingSessionId],
  );
  return rows.length > 0;
}

const EMPTY: InterestState = { bank_account: false, licenses_permits: false, tax_compliance: false, filing_support: false, license_note: null };

export async function readInterests(db: Db, filingSessionId: string): Promise<InterestState> {
  const { rows } = await db.query<InterestState>(
    `SELECT bank_account, licenses_permits, tax_compliance, filing_support, license_note FROM post_filing_interests WHERE filing_session_id = $1`,
    [filingSessionId],
  );
  return rows[0] ? { ...rows[0] } : { ...EMPTY };
}

/** Column per interest. Only these fixed names are ever put into SQL. */
const COLUMN: Record<Interest, string> = {
  bank_account: "bank_account",
  licenses_permits: "licenses_permits",
  tax_compliance: "tax_compliance",
  filing_support: "filing_support",
};

/**
 * Sets one flag (and, for the licence check, the note when one is sent) and queues
 * the Zoho copy. A request that changes nothing does not queue a copy.
 */
export async function saveInterest(
  db: Db,
  filingSessionId: string,
  interest: Interest,
  selected: boolean,
  note: string | null | undefined,
  now: Date,
): Promise<InterestState> {
  const col = COLUMN[interest];
  const setNote = interest === "licenses_permits" && note !== undefined;
  const current = await readInterests(db, filingSessionId);
  const changed = current[interest] !== selected || (setNote && current.license_note !== note);
  if (!changed) return current;
  await db.query(
    `INSERT INTO post_filing_interests (filing_session_id, ${col}, license_note, version, next_sync_at, created_at, updated_at)
     VALUES ($1, $2, $3, 1, $4, $4, $4)
     ON CONFLICT (filing_session_id) DO UPDATE SET
       ${col} = $2,
       license_note = CASE WHEN $5 THEN $3 ELSE post_filing_interests.license_note END,
       version = post_filing_interests.version + 1,
       crm_attempts = 0,
       crm_blocked_at = NULL,
       next_sync_at = $4,
       updated_at = $4`,
    [filingSessionId, selected, setNote ? note : null, now, setNote],
  );
  return readInterests(db, filingSessionId);
}

// ── Zoho copy ─────────────────────────────────────────────────────────────

export type ZohoResult = { ok: true } | { ok: false; error: string; permanent?: boolean };

export interface PostFilingZohoClient {
  /** Sets exactly these Deal fields (the multi-select is replaced, not merged). */
  updateDeal(dealId: string, fields: Record<string, unknown>): Promise<ZohoResult>;
}

export interface PostFilingDeps {
  db: Db;
  zoho: PostFilingZohoClient;
  config: PostFilingConfig;
  now: () => Date;
  alert: (subject: string, body: string) => Promise<unknown>;
}

const MINUTE_MS = 60_000;
/** A claimed row is left alone this long (two 20 s Zoho calls fit well inside). */
export const CLAIM_LEASE_MS = 10 * MINUTE_MS;
/**
 * Waits between tries. The Deal is often not verified yet when the customer clicks
 * (the webhook's sync job runs within a minute or two), so early tries are short.
 * After the last one (about 3 days in all) the row needs a person.
 */
export const RETRY_DELAYS_MS = [1, 5, 15, 60, 6 * 60, 24 * 60, 48 * 60].map((m) => m * MINUTE_MS);
const BATCH = 25;
/** Repeated failures with the same cause alert once per this window, not once per customer. */
export const ALERT_REPEAT_MS = 6 * 60 * MINUTE_MS;

export function labelsFor(state: InterestState, filingSupportValue = ""): string[] {
  const labels: Record<Interest, string> = { ...INTEREST_LABELS, filing_support: filingSupportValue };
  return INTERESTS.filter((i) => state[i] && labels[i]).map((i) => labels[i]);
}

/** The Deal of the session's earliest held or paid order whose Deal id was verified. */
export async function verifiedDealFor(db: Db, filingSessionId: string): Promise<string | null> {
  const { rows } = await db.query<{ crm_deal_id: string }>(
    `SELECT o.crm_deal_id
     FROM orders o
     ${VERIFIED_DEAL_JOIN}
     WHERE o.filing_session_id = $1
       AND o.payment_status IN ('authorized', 'paid')
       AND o.crm_deal_id IS NOT NULL
     ORDER BY COALESCE(o.authorized_at, o.paid_at) ASC
     LIMIT 1`,
    [filingSessionId],
  );
  return rows[0]?.crm_deal_id ?? null;
}

interface ClaimedRow extends InterestState {
  filing_session_id: string;
  version: number;
  crm_attempts: number;
}

/** The Deal fields for the customer's current choices. */
export function dealFieldsFor(config: PostFilingConfig, state: InterestState): Record<string, unknown> {
  return {
    [config.dealField]: labelsFor(state, config.filingSupportValue),
    [config.noteField]: state.licenses_permits && state.license_note ? state.license_note : null,
  };
}

/**
 * Postgres "relation does not exist" for this feature's table: migration 0032 has not
 * been applied yet. (Code 42P01 on Postgres; pg-mem in tests sets only the message.)
 */
export function isMissingTable(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  const message = typeof e?.message === "string" ? e.message : "";
  if (message.includes('relation "post_filing_interests" does not exist') && (e?.code === undefined || e.code === "42P01")) return true;
  // Migration 0032 applied but not 0039: treated the same way (switched off).
  return /column "?filing_support"? does not exist/.test(message) && (e?.code === undefined || e.code === "42703");
}

let running = false;
let missingTableLogged = false;
const lastAlertAt = new Map<string, number>();

/** For tests. */
export function resetPostFilingJobState(): void {
  running = false;
  missingTableLogged = false;
  lastAlertAt.clear();
}

export async function runPostFilingSyncOnce(deps: PostFilingDeps): Promise<{ synced: string[]; retried: string[]; blocked: string[] }> {
  const out = { synced: [] as string[], retried: [] as string[], blocked: [] as string[] };
  // One pass at a time: a slow Zoho pass must not overlap the next timer tick.
  if (!deps.config.enabled || running) return out;
  running = true;
  try {
    await syncDue(deps, out);
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    if (!missingTableLogged) console.error("[post-filing sync] table post_filing_interests is missing: apply migration 0032");
    missingTableLogged = true;
  } finally {
    running = false;
  }
  return out;
}

async function syncDue(deps: PostFilingDeps, out: { synced: string[]; retried: string[]; blocked: string[] }): Promise<void> {
  const now = deps.now();
  const leaseBefore = new Date(now.getTime() - CLAIM_LEASE_MS);
  const { rows: due } = await deps.db.query<{ filing_session_id: string }>(
    `SELECT filing_session_id FROM post_filing_interests
     WHERE synced_version < version AND crm_blocked_at IS NULL AND next_sync_at <= $1
       AND (crm_claimed_at IS NULL OR crm_claimed_at < $2)
     ORDER BY next_sync_at
     LIMIT ${BATCH}`,
    [now, leaseBefore],
  );
  for (const { filing_session_id: id } of due) {
    const claimed = await deps.db.query<ClaimedRow>(
      `UPDATE post_filing_interests SET crm_claimed_at = $2
       WHERE filing_session_id = $1 AND synced_version < version AND crm_blocked_at IS NULL AND next_sync_at <= $2
         AND (crm_claimed_at IS NULL OR crm_claimed_at < $3)
       RETURNING filing_session_id, bank_account, licenses_permits, tax_compliance, filing_support, license_note, version, crm_attempts`,
      [id, now, leaseBefore],
    );
    const row = claimed.rows[0];
    if (!row) continue;
    try {
      const result = await copyToDeal(deps, row);
      if (result.ok) {
        await deps.db.query(
          `UPDATE post_filing_interests SET synced_version = GREATEST(synced_version, $2), zoho_deal_id = $3,
             crm_synced_at = $4, crm_attempts = 0, last_error = NULL, crm_claimed_at = NULL, updated_at = $4
           WHERE filing_session_id = $1`,
          [id, row.version, result.dealId, now],
        );
        out.synced.push(id);
        continue;
      }
      await recordFailure(deps, row, result.error, result.permanent === true, now, out);
    } catch (err) {
      await recordFailure(deps, row, describeError(err), false, now, out);
    }
  }
}

async function copyToDeal(
  deps: PostFilingDeps,
  row: ClaimedRow,
): Promise<{ ok: true; dealId: string } | { ok: false; error: string; permanent?: boolean }> {
  const dealId = await verifiedDealFor(deps.db, row.filing_session_id);
  if (!dealId) return { ok: false, error: "no verified Zoho Deal for this filing session yet" };
  const set = await deps.zoho.updateDeal(dealId, dealFieldsFor(deps.config, row));
  return set.ok ? { ok: true, dealId } : set;
}

async function recordFailure(
  deps: PostFilingDeps,
  row: ClaimedRow,
  error: string,
  permanent: boolean,
  now: Date,
  out: { retried: string[]; blocked: string[] },
): Promise<void> {
  const attempts = row.crm_attempts + 1;
  const block = permanent || attempts > RETRY_DELAYS_MS.length;
  const next = new Date(now.getTime() + RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1]);
  // Only when the customer has not changed anything since the claim: a newer change
  // (which already reset the attempts and the block) is tried again right away.
  const recorded = await deps.db.query(
    `UPDATE post_filing_interests SET crm_attempts = $3, last_error = $4, next_sync_at = $5, crm_blocked_at = $6,
       crm_claimed_at = NULL, updated_at = $7
     WHERE filing_session_id = $1 AND version = $2`,
    [row.filing_session_id, row.version, attempts, error.slice(0, 500), next, block ? now : null, now],
  );
  if ((recorded.rowCount ?? 0) === 0) {
    await deps.db.query(
      `UPDATE post_filing_interests SET crm_claimed_at = NULL, last_error = $2, updated_at = $3 WHERE filing_session_id = $1`,
      [row.filing_session_id, error.slice(0, 500), now],
    );
    out.retried.push(row.filing_session_id);
    return;
  }
  if (!block) {
    out.retried.push(row.filing_session_id);
    return;
  }
  out.blocked.push(row.filing_session_id);
  // One alert per cause per ALERT_REPEAT_MS (a wrong field name would otherwise alert per customer).
  const cause = error.replace(/\d{6,}/g, "#").slice(0, 200);
  const last = lastAlertAt.get(cause);
  if (last !== undefined && now.getTime() - last < ALERT_REPEAT_MS) return;
  lastAlertAt.set(cause, now.getTime());
  await deps
    .alert(
      "Post-filing interests not copied to Zoho",
      `Filing session ${row.filing_session_id}: ${labelsFor(row, "Filing Support and Strategy").join(", ") || "(none selected)"}. ${error}. ` +
        `The customer's choices are saved in post_filing_interests (other sessions with the same error are not alerted again for 6 hours: ` +
        `SELECT * FROM post_filing_interests WHERE crm_blocked_at IS NOT NULL). Fix the cause, then clear crm_blocked_at to retry.`,
    )
    .catch(() => undefined);
}

/** Zoho rejected the record itself (bad field or value): retrying will not help. */
function permanentRecordError(error: string): boolean {
  return /INVALID_DATA|MANDATORY_NOT_FOUND|INVALID_MODULE|NOT_ALLOWED/i.test(error);
}

export const realPostFilingZohoClient: PostFilingZohoClient = {
  async updateDeal(dealId, fields) {
    try {
      const res = await zfetch(`https://www.zohoapis.com/crm/v8/Deals/${encodeURIComponent(dealId)}`, {
        method: "PUT",
        headers: { ...(await auth()), "Content-Type": "application/json" },
        ...timeout(),
        body: JSON.stringify({ data: [fields] }),
      });
      if (res.status === 404) return { ok: false, permanent: true, error: `Deal ${dealId} not found` };
      if (!res.ok) {
        const d = await detail(res);
        // A missing OAuth scope is not cured by retrying.
        const permanent = (res.status === 400 && permanentRecordError(d)) || /OAUTH_SCOPE_MISMATCH/.test(d);
        return { ok: false, permanent, error: `Zoho Deal update failed: ${d}` };
      }
      const rec = recordOk(await res.json().catch(() => ({})));
      return rec.ok ? { ok: true } : { ok: false, permanent: permanentRecordError(rec.error), error: `Zoho Deal update failed: ${rec.error}` };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  },
};

export function defaultPostFilingDeps(pool: Db): PostFilingDeps {
  return {
    db: pool,
    zoho: realPostFilingZohoClient,
    config: postFilingConfig(),
    now: () => new Date(),
    alert: sendOpsAlert,
  };
}
