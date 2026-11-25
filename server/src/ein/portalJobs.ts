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
          `Reason: ${result.error}\nFix the Deal (linked Contact and its email), then invite the Contact from Zoho CRM. ` +
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
  last_error: string | null;
}

/** True when `now` is at least `days` days after a yyyy-mm-dd date (UTC). */
export function daysPassedSinceDate(date: string, days: number, now: Date): boolean {
  const start = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(start) && now.getTime() >= start + days * DAY_MS;
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
  if (einIssuedDate && daysPassedSinceDate(einIssuedDate, days, now)) candidates.push(Date.parse(`${einIssuedDate}T00:00:00Z`) + days * DAY_MS);
  if (closedSeenAt && cancellationPurgeDue(closedSeenAt, days, now)) candidates.push(closedSeenAt.getTime() + (days - 1) * DAY_MS);
  return candidates.length ? new Date(Math.min(...candidates)) : null;
}

export async function runEinPortalSweepOnce(deps: EinPortalDeps): Promise<{ docsReceived: string[]; purged: string[]; errors: string[] }> {
  const out = { docsReceived: [] as string[], purged: [] as string[], errors: [] as string[] };
  const cfg = deps.config;
  if (!sweepEnabled(cfg)) return out;
  await registerEinDeals(deps);
  const now = deps.now();

  // Every Deal is swept whatever its invite status: a customer invited by hand, or a
  // returning portal user, still has their passport detected and cleared.
  const { rows } = await deps.db.query<SweepRow>(
    `SELECT d.zoho_deal_id, d.docs_received_at, d.closed_seen_at, d.passport_purged_at, d.last_error
     FROM ein_portal_deals d
     WHERE d.retired_at IS NULL AND d.next_check_at <= $1
     ORDER BY d.next_check_at
     LIMIT ${SWEEP_BATCH}`,
    [now],
  );

  const setError = async (dealId: string, error: string, nextCheck: Date) => {
    out.errors.push(`${dealId}: ${error}`);
    await deps.db.query(`UPDATE ein_portal_deals SET last_error = $2, next_check_at = $3, updated_at = $4 WHERE zoho_deal_id = $1`, [
      dealId,
      error.slice(0, 500),
      nextCheck,
      now,
    ]);
  };

  for (const row of rows) {
    const dealId = row.zoho_deal_id;
    try {
      const read = await deps.zoho.readDeal(dealId, {
        docsReceived: cfg.docsReceivedField,
        passport: cfg.passportField,
        einIssuedDate: cfg.einIssuedDateField,
      });
      if (!read.ok) {
        await setError(dealId, read.error, new Date(now.getTime() + (read.permanent ? DAY_MS : HOUR_MS)));
        continue;
      }
      const deal = read.value;
      const hasPassport = deal.passportFiles.length > 0;

      // 1. Passport on the Deal: this job detects the upload itself and ticks EIN Docs
      //    Received with its timestamp. A Zoho workflow may also do it (optional extra).
      //    The claim makes sure only one server instance writes and alerts.
      if (hasPassport && !row.docs_received_at) {
        const claimed = await deps.db.query(
          `UPDATE ein_portal_deals SET docs_received_at = $2, updated_at = $2 WHERE zoho_deal_id = $1 AND docs_received_at IS NULL RETURNING zoho_deal_id`,
          [dealId, now],
        );
        if (claimed.rows.length > 0) {
          if (!deal.docsReceived && cfg.docsReceivedField) {
            const mark = await deps.zoho.markDocsReceived(dealId, { docsReceived: cfg.docsReceivedField, docsReceivedAt: cfg.docsReceivedAtField }, now);
            if (!mark.ok) {
              await deps.db.query(`UPDATE ein_portal_deals SET docs_received_at = NULL WHERE zoho_deal_id = $1`, [dealId]);
              await setError(dealId, mark.error, new Date(now.getTime() + HOUR_MS));
              continue;
            }
          }
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
      const closedSeenAt = cancelled ? (row.closed_seen_at ?? now) : null;

      // 3. Retention: clear the passport 30 days after EIN issue, or within 30 days of
      //    cancellation, re-checked on every pass (so a re-upload after a purge is cleared too).
      const due = dueSince(deal.einIssuedDate, closedSeenAt, cfg.purgeDays, now);
      let purgedAt = row.passport_purged_at;
      let lastError: string | null = null;
      if (hasPassport && due) {
        const cleared = await deps.zoho.clearImageField(dealId, cfg.passportField, deal.passportFiles);
        if (cleared.ok) {
          purgedAt = now;
          out.purged.push(dealId);
        } else {
          lastError = cleared.error.slice(0, 500);
          out.errors.push(`${dealId}: ${cleared.error}`);
          // Alert once per distinct failure, not every hour.
          if (row.last_error !== lastError) {
            await deps.alert(
              "EIN passport purge failed",
              `Deal ${dealId}: the passport photo page is past its retention date but could not be cleared.\nReason: ${cleared.error}\n` +
                `Delete it from the Deal in Zoho CRM by hand. The sweep keeps retrying hourly.`,
            );
          }
        }
      }

      // Not due: check on every pass. Due: daily (catches a re-upload), retried hourly
      // while a purge is failing, and retired once nothing has been on the Deal for
      // WATCH_AFTER_DUE_DAYS after retention fell due.
      const retire = due !== null && !hasPassport && now.getTime() >= due.getTime() + WATCH_AFTER_DUE_DAYS * DAY_MS;
      const nextCheck = due === null || lastError ? now : new Date(now.getTime() + DAY_MS);
      await deps.db.query(
        `UPDATE ein_portal_deals
         SET closed_seen_at = $2, passport_purged_at = $3, last_error = $4, next_check_at = $5, retired_at = $6, updated_at = $7
         WHERE zoho_deal_id = $1`,
        [dealId, closedSeenAt, purgedAt, lastError, nextCheck, retire ? now : null, now],
      );
    } catch (err) {
      out.errors.push(`${dealId}: ${describeError(err)}`);
    }
  }
  return out;
}
