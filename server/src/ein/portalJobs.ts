import type { Pool } from "pg";
import { describeError } from "../db/describeError.js";
import { sendOpsAlert } from "../ops/alerts.js";
import { realEinPortalClient, type EinPortalClient } from "../zoho/einPortal.js";
import { EIN_CARRYING_CODES, einPortalConfig, invitesEnabled, sweepEnabled, type EinPortalConfig } from "./onboarding.js";

/**
 * ST17: the two EIN-portal jobs. Both do nothing unless EIN_ONBOARDING_ENABLED=true
 * and their own settings are present (ein/onboarding.ts), so deploying this changes
 * nothing until an owner switches it on.
 *
 * The passport lives on the Zoho Deal, so everything is decided per Deal
 * (ein_portal_deals, migration 0030), never per order:
 *  - registerEinDeals: one row per verified Deal that carries a held or paid EIN order.
 *  - runEinPortalInvitesOnce (every 10 minutes): invites that Deal's Contact to the
 *    Zoho CRM Portal, once.
 *  - runEinPortalSweepOnce (hourly): detects the passport on the Deal and ticks
 *    "EIN Docs Received" with its timestamp (Zoho workflows are not relied on);
 *    clears the passport 30 days after the EIN Issued Date, or within 30 days of the
 *    Deal being cancelled or refunded; keeps watching for a re-upload afterwards.
 *
 * The table holds no identity data. Alerts carry Deal ids only.
 */

export type Db = Pick<Pool, "query">;

export interface EinPortalDeps {
  db: Db;
  zoho: EinPortalClient;
  config: EinPortalConfig;
  now: () => Date;
  alert: (subject: string, body: string) => Promise<void>;
}

export function defaultEinPortalDeps(pool: Pool): EinPortalDeps {
  return {
    db: pool,
    zoho: realEinPortalClient,
    config: einPortalConfig(),
    now: () => new Date(),
    alert: async (subject, body) => {
      await sendOpsAlert(subject, body);
    },
  };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A failed (or interrupted) invite is retried after this long. */
export const INVITE_RETRY_AFTER_MS = HOUR_MS;
/** After this many attempts an invite stops retrying and asks a person. */
export const INVITE_MAX_ATTEMPTS = 6;
/** After retention is due, a Deal is re-checked daily (a re-upload is cleared at once) for this long. */
export const WATCH_AFTER_DUE_DAYS = 90;
const INVITE_BATCH = 25;
const SWEEP_BATCH = 500;

/**
 * orders.crm_deal_id can start as a browser-supplied value (Stripe metadata copied
 * from filing_sessions.crm_deal_id). Only trust it once a sync job for that order
 * succeeded: the server created the Deal itself (order_deal), or the Deal's linked
 * Contact was verified against the customer's email (deal_stage_update). A plain join:
 * an order with two such jobs appears twice, which both callers tolerate.
 */
const VERIFIED_DEAL_JOIN = `JOIN crm_sync_queue q
    ON q.order_id = o.order_id AND q.status = 'synced'
   AND (q.sync_type = 'order_deal'
        OR (q.sync_type = 'deal_stage_update' AND q.payload_snapshot->>'crm_deal_id' = o.crm_deal_id))`;

type LineItems = Array<{ offer_code?: unknown }> | null;

/** True when an order's line-item snapshot carries the EIN (bought alone or in a bundle). */
export function carriesEin(lineItems: LineItems): boolean {
  return Array.isArray(lineItems) && lineItems.some((li) => typeof li?.offer_code === "string" && EIN_CARRYING_CODES.includes(li.offer_code));
}

/** Adds a row for each verified Deal with a held or paid EIN order from the lookback window. */
export async function registerEinDeals(deps: EinPortalDeps): Promise<number> {
  const now = deps.now();
  const since = new Date(now.getTime() - deps.config.inviteLookbackDays * DAY_MS);
  const { rows } = await deps.db.query<{ order_id: string; filing_session_id: string; crm_deal_id: string; line_items: LineItems }>(
    `SELECT o.order_id, o.filing_session_id, o.crm_deal_id, o.line_items
     FROM orders o
     ${VERIFIED_DEAL_JOIN}
     WHERE o.payment_status IN ('authorized', 'paid')
       AND o.crm_deal_id IS NOT NULL
       AND COALESCE(o.authorized_at, o.paid_at) >= $1
     ORDER BY COALESCE(o.authorized_at, o.paid_at)`,
    [since],
  );
  const firstByDeal = new Map<string, { order_id: string; filing_session_id: string }>();
  for (const o of rows) {
    if (carriesEin(o.line_items) && !firstByDeal.has(o.crm_deal_id)) firstByDeal.set(o.crm_deal_id, o);
  }
  let added = 0;
  for (const [dealId, o] of firstByDeal) {
    const res = await deps.db.query(
      `INSERT INTO ein_portal_deals (zoho_deal_id, filing_session_id, first_order_id, next_check_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4, $4)
       ON CONFLICT (zoho_deal_id) DO NOTHING`,
      [dealId, o.filing_session_id, o.order_id, now],
    );
    added += res.rowCount ?? 0;
  }
  return added;
}

/** True when the Deal has verified EIN orders that took money and every one was refunded. */
async function allEinOrdersRefunded(db: Db, dealId: string): Promise<boolean> {
  const { rows } = await db.query<{ payment_status: string; line_items: LineItems }>(
    `SELECT o.payment_status, o.line_items FROM orders o
     ${VERIFIED_DEAL_JOIN}
     WHERE o.crm_deal_id = $1 AND o.payment_status IN ('authorized', 'paid', 'refunded')`,
    [dealId],
  );
  const ein = rows.filter((o) => carriesEin(o.line_items));
  return ein.length > 0 && ein.every((o) => o.payment_status === "refunded");
}

/**
 * Whether a portal invite can be expected for these held or paid EIN orders, so the
 * success page and the confirmation email never promise one that cannot go out. The
 * invite needs a Contact on the Deal: Deals created at intake have one (llc-worker.js
 * links Contact_Name), and their id is on the order from payment time. Deals this
 * server creates at payment (an order_deal sync job) have no Contact, so their invite
 * would be blocked until a person links one. The intake Deal id must also have a
 * Deal ownership check (deal_stage_update) that has not dead-lettered: the invite job
 * only uses Deals whose check succeeded (VERIFIED_DEAL_JOIN).
 */
export async function einInviteExpected(db: Db, scope: { filingSessionId: string } | { orderId: string }): Promise<boolean> {
  const bySession = "filingSessionId" in scope;
  const { rows } = await db.query<{ line_items: LineItems }>(
    `SELECT o.line_items
     FROM orders o
     JOIN crm_sync_queue v
       ON v.order_id = o.order_id AND v.sync_type = 'deal_stage_update'
      AND v.payload_snapshot->>'crm_deal_id' = o.crm_deal_id AND v.status <> 'dead_letter'
     LEFT JOIN crm_sync_queue q ON q.order_id = o.order_id AND q.sync_type = 'order_deal'
     WHERE ${bySession ? "o.filing_session_id" : "o.order_id"} = $1
       AND o.payment_status IN ('authorized', 'paid')
       AND o.crm_deal_id IS NOT NULL
       AND q.id IS NULL`,
    [bySession ? scope.filingSessionId : scope.orderId],
  );
  return rows.some((o) => carriesEin(o.line_items));
}

// ── Invites ───────────────────────────────────────────────────────────────

export async function runEinPortalInvitesOnce(deps: EinPortalDeps): Promise<{ invited: string[]; failed: string[]; blocked: string[] }> {
  const out = { invited: [] as string[], failed: [] as string[], blocked: [] as string[] };
  if (!invitesEnabled(deps.config)) return out;
  await registerEinDeals(deps);
  const now = deps.now();
  const retryBefore = new Date(now.getTime() - INVITE_RETRY_AFTER_MS);

  const { rows } = await deps.db.query<{ zoho_deal_id: string; email: string | null }>(
    `SELECT d.zoho_deal_id, fs.email
     FROM ein_portal_deals d JOIN filing_sessions fs ON fs.filing_session_id = d.filing_session_id
     WHERE d.invite_status IN ('pending', 'failed') AND (d.invite_claimed_at IS NULL OR d.invite_claimed_at < $1)
     ORDER BY d.created_at
     LIMIT ${INVITE_BATCH}`,
    [retryBefore],
  );

  for (const row of rows) {
    // Claim first, atomically, so two server instances never both invite.
    const claim = await deps.db.query<{ invite_attempts: number }>(
      `UPDATE ein_portal_deals
       SET invite_status = 'pending', invite_attempts = invite_attempts + 1, invite_claimed_at = $2, updated_at = $2
       WHERE zoho_deal_id = $1 AND invite_status IN ('pending', 'failed') AND (invite_claimed_at IS NULL OR invite_claimed_at < $3)
       RETURNING invite_attempts`,
      [row.zoho_deal_id, now, retryBefore],
    );
    if (claim.rows.length === 0) continue;
    const attempts = claim.rows[0].invite_attempts;

    const result = row.email
      ? await deps.zoho.inviteDealContact(row.zoho_deal_id, row.email, deps.config.portalUserTypeId)
      : { ok: false as const, permanent: true, error: "filing session has no email" };

    if (result.ok) {
      await deps.db.query(
        `UPDATE ein_portal_deals SET invite_status = 'invited', zoho_contact_id = $2, invited_at = $3, updated_at = $3 WHERE zoho_deal_id = $1`,
        [row.zoho_deal_id, result.value.contactId, now],
      );
      out.invited.push(row.zoho_deal_id);
      continue;
    }

    // CANNOT_PROCESS means "already invited, or under GDPR". On a retry it almost
    // certainly means our earlier attempt reached Zoho before timing out: invited.
    if (!result.ok && result.code === "CANNOT_PROCESS" && attempts > 1) {
      await deps.db.query(
        `UPDATE ein_portal_deals SET invite_status = 'invited', invited_at = $2, last_error = $3, updated_at = $2 WHERE zoho_deal_id = $1`,
        [row.zoho_deal_id, now, `treated as invited: ${result.error}`.slice(0, 500)],
      );
      out.invited.push(row.zoho_deal_id);
      continue;
    }

    const blocked = result.permanent === true || attempts >= INVITE_MAX_ATTEMPTS;
    await deps.db.query(`UPDATE ein_portal_deals SET invite_status = $2, last_error = $3, updated_at = $4 WHERE zoho_deal_id = $1`, [
      row.zoho_deal_id,
      blocked ? "blocked" : "failed",
      result.error.slice(0, 500),
      now,
    ]);
    if (blocked) {
      out.blocked.push(row.zoho_deal_id);
      await deps.alert(
        "EIN portal invite needs a person",
        `Deal ${row.zoho_deal_id}: the customer was not invited to the Zoho CRM Portal after ${attempts} attempt(s).\n` +
          `Reason: ${result.error}\n` +
          (result.code === "CANNOT_PROCESS"
            ? "Zoho says the Contact is already invited or under a GDPR process: check the Contact, and re-invite it from Zoho CRM if needed. "
            : result.code === "OAUTH_SCOPE_MISMATCH"
              ? "The backend's Zoho OAuth token lacks the ZohoCRM.settings.clientportal scope: re-authorise it, then invite the Contact from Zoho CRM. "
              : "Fix the Deal (linked Contact and its email), then invite the Contact from Zoho CRM. ") +
          `The passport on this Deal is still detected and cleared on schedule.`,
      );
    } else {
      out.failed.push(row.zoho_deal_id);
    }
  }
  return out;
}

// ── Sweep: docs received and passport retention ─────────────────────────────

interface SweepRow {
  zoho_deal_id: string;
  docs_received_at: Date | null;
  closed_seen_at: Date | null;
  passport_purged_at: Date | null;
  failing_since: Date | null;
  alerted_error: string | null;
}

const NY_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** The UTC instant of midnight at the start of a yyyy-mm-dd day in America/New_York. */
export function newYorkMidnightUtc(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return NaN;
  const utcMidnight = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // New York is UTC-4 or UTC-5 at midnight (clock changes happen at 2 a.m.): pick the
  // candidate that New York's own clock reads as 00:00 on that date.
  for (const hours of [4, 5]) {
    const t = utcMidnight + hours * HOUR_MS;
    const parts = Object.fromEntries(NY_CLOCK.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
    if (`${parts.year}-${parts.month}-${parts.day}` === date && parts.hour === "00" && parts.minute === "00") return t;
  }
  return utcMidnight + 5 * HOUR_MS;
}

/**
 * When the EIN-issued retention period ends: midnight in New York at the start of the
 * day `days` days after the issue date (Zoho's Date field has no time or zone, and the
 * business runs on Florida time). Anchoring to UTC midnight would clear 4-5 hours early.
 */
export function einRetentionEnds(date: string, days: number): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return NaN;
  const target = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return newYorkMidnightUtc(target.toISOString().slice(0, 10));
}

/** True when the retention period after an EIN issue date has ended. */
export function daysPassedSinceDate(date: string, days: number, now: Date): boolean {
  const end = einRetentionEnds(date, days);
  return Number.isFinite(end) && now.getTime() >= end;
}

/**
 * Cancellation is noticed by the sweep some time after it happened (an hour normally,
 * longer if the server was down). Clearing one day early keeps the "within 30 days"
 * promise with a day's margin.
 */
export function cancellationPurgeDue(closedSeenAt: Date, days: number, now: Date): boolean {
  return now.getTime() >= closedSeenAt.getTime() + (days - 1) * DAY_MS;
}

/** When retention fell due (the earlier rule wins), or null if it has not. */
function dueSince(einIssuedDate: string | null, closedSeenAt: Date | null, days: number, now: Date): Date | null {
  const candidates: number[] = [];
  if (einIssuedDate && daysPassedSinceDate(einIssuedDate, days, now)) candidates.push(einRetentionEnds(einIssuedDate, days));
  if (closedSeenAt && cancellationPurgeDue(closedSeenAt, days, now)) candidates.push(closedSeenAt.getTime() + (days - 1) * DAY_MS);
  return candidates.length ? new Date(Math.min(...candidates)) : null;
}

/** A row is leased to one sweep pass for this long, so overlapping passes skip it. */
export const SWEEP_LEASE_MS = 15 * 60 * 1000;
/** A Deal read or docs-received write failing this long raises an alert (purge failures alert at once). */
export const PERSISTENT_FAILURE_MS = DAY_MS;
/** A Deal Zoho no longer has is retired after this many days of "not found". */
export const DEAL_GONE_RETIRE_DAYS = 30;

export async function runEinPortalSweepOnce(deps: EinPortalDeps): Promise<{ docsReceived: string[]; purged: string[]; errors: string[] }> {
  const out = { docsReceived: [] as string[], purged: [] as string[], errors: [] as string[] };
  const cfg = deps.config;
  if (!sweepEnabled(cfg)) return out;
  await registerEinDeals(deps);
  const now = deps.now();

  // Every Deal is swept whatever its invite status: a customer invited by hand, or a
  // returning portal user, still has their passport detected and cleared.
  const { rows } = await deps.db.query<{ zoho_deal_id: string }>(
    `SELECT d.zoho_deal_id
     FROM ein_portal_deals d
     WHERE d.retired_at IS NULL AND d.next_check_at <= $1
     ORDER BY d.next_check_at
     LIMIT ${SWEEP_BATCH}`,
    [now],
  );

  for (const { zoho_deal_id: dealId } of rows) {
    // Lease the row first, atomically: a pass that overlaps this one (another server
    // instance, or a slow pass) finds next_check_at moved on and skips it.
    const lease = await deps.db.query<SweepRow>(
      `UPDATE ein_portal_deals SET next_check_at = $3, updated_at = $2
       WHERE zoho_deal_id = $1 AND retired_at IS NULL AND next_check_at <= $2
       RETURNING zoho_deal_id, docs_received_at, closed_seen_at, passport_purged_at, failing_since, alerted_error`,
      [dealId, now, new Date(now.getTime() + SWEEP_LEASE_MS)],
    );
    const row = lease.rows[0];
    if (!row) continue;

    // Each failure is a kind (for de-duplicating alerts) plus its detail text.
    const errors: Array<{ kind: string; text: string }> = [];
    let purgeFailed = false;
    let dealGone = false;
    let closedSeenAt = row.closed_seen_at;
    let purgedAt: Date | null = null;
    let due: Date | null = null;
    let hasPassport = false;
    try {
      const read = await deps.zoho.readDeal(dealId, {
        docsReceived: cfg.docsReceivedField,
        passport: cfg.passportField,
        einIssuedDate: cfg.einIssuedDateField,
      });
      if (!read.ok) {
        dealGone = read.permanent === true;
        errors.push({ kind: dealGone ? "Deal not found" : "Deal read failed", text: `Deal read failed: ${read.error}` });
      } else {
        const deal = read.value;
        hasPassport = deal.passportFiles.length > 0;

        // 1. Passport on the Deal: this job detects the upload itself and ticks EIN Docs
        //    Received with its timestamp (a Zoho workflow may also do it). A failed write
        //    is retried on the next pass and never stops step 3 below.
        if (hasPassport && !row.docs_received_at) {
          let marked = true;
          if (!deal.docsReceived && cfg.docsReceivedField) {
            const mark = await deps.zoho.markDocsReceived(dealId, { docsReceived: cfg.docsReceivedField, docsReceivedAt: cfg.docsReceivedAtField }, now);
            if (!mark.ok) {
              marked = false;
              errors.push({ kind: "EIN Docs Received update failed", text: `EIN Docs Received update failed: ${mark.error}` });
            }
          }
          if (marked) {
            await deps.db.query(`UPDATE ein_portal_deals SET docs_received_at = $2 WHERE zoho_deal_id = $1 AND docs_received_at IS NULL`, [dealId, now]);
            out.docsReceived.push(dealId);
            await deps.alert(
              "EIN docs received",
              `Deal ${dealId}: the passport photo page is on the Deal (uploaded through the Zoho CRM Portal). Ready for the SS-4.`,
            );
          }
        }

        // 2. Cancelled or refunded: the Deal's Stage or Payment_Status, or every EIN order
        //    on the Deal refunded. A released card hold is NOT a cancellation (held orders
        //    are often released and charged later). First-seen time is kept in our table
        //    and cleared again if the Deal stops being cancelled.
        const cancelled =
          (await allEinOrdersRefunded(deps.db, dealId)) ||
          (deal.stage !== null && cfg.purgeStages.includes(deal.stage)) ||
          (deal.paymentStatus !== null && cfg.purgePaymentStatuses.includes(deal.paymentStatus));
        closedSeenAt = cancelled ? (row.closed_seen_at ?? now) : null;

        // 3. Retention: clear the passport 30 days after EIN issue, or within 30 days of
        //    cancellation, re-checked on every pass (so a re-upload after a purge is cleared too).
        due = dueSince(deal.einIssuedDate, closedSeenAt, cfg.purgeDays, now);
        if (hasPassport && due) {
          const cleared = await deps.zoho.clearImageField(dealId, cfg.passportField, deal.passportFiles);
          if (cleared.ok) {
            purgedAt = now;
            out.purged.push(dealId);
          } else {
            purgeFailed = true;
            errors.push({ kind: "passport purge failed", text: `passport purge failed: ${cleared.error}` });
          }
        }
      }
    } catch (err) {
      errors.push({ kind: "sweep error", text: describeError(err) });
    }

    // Failures: a purge failure alerts at once; a Deal read or docs-received write that
    // keeps failing alerts after PERSISTENT_FAILURE_MS. Alerts are de-duplicated by the
    // kinds of failure (not the changing detail text), so each kind alerts once per run
    // of failures; a clean pass resets it.
    const lastError = errors.length ? errors.map((e) => e.text).join("; ").slice(0, 500) : null;
    const alertKey = errors.length ? [...new Set(errors.map((e) => e.kind))].sort().join(", ") : null;
    const failingSince = lastError ? (row.failing_since ?? now) : null;
    let alertedError = lastError ? row.alerted_error : null;
    if (lastError) {
      out.errors.push(`${dealId}: ${lastError}`);
      const persistent = failingSince !== null && now.getTime() - failingSince.getTime() >= PERSISTENT_FAILURE_MS;
      if ((purgeFailed || persistent) && alertedError !== alertKey) {
        await deps.alert(
          purgeFailed ? "EIN passport purge failed" : "EIN portal sweep keeps failing",
          `Deal ${dealId}: ${lastError}
` +
            (purgeFailed
              ? "The passport photo page is past its retention date. Delete it from the Deal in Zoho CRM by hand. The sweep keeps retrying hourly."
              : `Failing since ${failingSince!.toISOString()}. The sweep keeps retrying hourly.`),
        );
        alertedError = alertKey;
      }
    }

    // Not due, or failing: check on the next pass. Due: daily (catches a re-upload), and
    // retired once nothing has been on the Deal for WATCH_AFTER_DUE_DAYS after it fell due.
    // A Deal Zoho no longer has: daily, and retired after DEAL_GONE_RETIRE_DAYS (it was
    // alerted after a day).
    const goneTooLong = dealGone && failingSince !== null && now.getTime() - failingSince.getTime() >= DEAL_GONE_RETIRE_DAYS * DAY_MS;
    const retire =
      goneTooLong || (!lastError && due !== null && !hasPassport && now.getTime() >= due.getTime() + WATCH_AFTER_DUE_DAYS * DAY_MS);
    const nextCheck = dealGone || (due !== null && !lastError) ? new Date(now.getTime() + DAY_MS) : now;
    await deps.db.query(
      `UPDATE ein_portal_deals
       SET closed_seen_at = $2, passport_purged_at = COALESCE($3, passport_purged_at), last_error = $4,
           failing_since = $5, alerted_error = $6, next_check_at = $7, retired_at = $8, updated_at = $9
       WHERE zoho_deal_id = $1`,
      [dealId, closedSeenAt, purgedAt, lastError, failingSince, alertedError, nextCheck, retire ? now : null, now],
    );
  }
  return out;
}
