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
 *  - runEinPortalInvitesOnce (every few minutes): invites the customer of each held
 *    or paid order that includes the EIN to the Zoho CRM Portal, once.
 *  - runEinPortalSweepOnce (hourly): ticks "EIN Docs Received" (and its timestamp)
 *    when the passport is on the Deal, and clears the passport field 30 days after
 *    the EIN is issued, or 30 days after the order is cancelled or refunded.
 *
 * Every invite and sweep is recorded in ein_portal_invites (migration 0030), which
 * holds no identity data. Alerts carry the order and Deal ids only.
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

const DAY_MS = 24 * 60 * 60 * 1000;
/** A failed (or interrupted) invite is retried after this long. */
export const INVITE_RETRY_AFTER_MS = 60 * 60 * 1000;
/** After this many attempts an invite stops retrying and asks a person. */
export const INVITE_MAX_ATTEMPTS = 6;
const INVITE_BATCH = 25;
const SWEEP_BATCH = 500;

// ── Invites ───────────────────────────────────────────────────────────────

interface InviteCandidate {
  order_id: string;
  filing_session_id: string;
  crm_deal_id: string;
  email: string | null;
}

export async function runEinPortalInvitesOnce(deps: EinPortalDeps): Promise<{ invited: string[]; failed: string[]; blocked: string[] }> {
  const out = { invited: [] as string[], failed: [] as string[], blocked: [] as string[] };
  if (!invitesEnabled(deps.config)) return out;
  const now = deps.now();
  const since = new Date(now.getTime() - deps.config.inviteLookbackDays * DAY_MS);
  const retryBefore = new Date(now.getTime() - INVITE_RETRY_AFTER_MS);

  // The Deal is the webhook-recorded orders.crm_deal_id of the order that carries the
  // EIN, never the client-suppliable filing_sessions.crm_deal_id.
  const { rows } = await deps.db.query<InviteCandidate>(
    `SELECT o.order_id, o.filing_session_id, o.crm_deal_id, fs.email
     FROM orders o
     JOIN filing_sessions fs ON fs.filing_session_id = o.filing_session_id
     LEFT JOIN ein_portal_invites i ON i.order_id = o.order_id
     WHERE o.payment_status IN ('authorized', 'paid')
       AND o.crm_deal_id IS NOT NULL
       AND COALESCE(o.authorized_at, o.paid_at) >= $2
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(o.line_items) li WHERE li->>'offer_code' = ANY($1::text[]))
       AND (i.order_id IS NULL OR (i.status IN ('pending', 'failed') AND i.updated_at < $3))
     ORDER BY COALESCE(o.authorized_at, o.paid_at)
     LIMIT ${INVITE_BATCH}`,
    [EIN_CARRYING_CODES, since, retryBefore],
  );

  for (const row of rows) {
    // Claim the row first, atomically, so two server instances never both invite.
    const claim = await deps.db.query<{ attempts: number }>(
      `INSERT INTO ein_portal_invites (order_id, filing_session_id, zoho_deal_id, status, attempts, updated_at)
       VALUES ($1, $2, $3, 'pending', 1, $4)
       ON CONFLICT (order_id) DO UPDATE
         SET status = 'pending', attempts = ein_portal_invites.attempts + 1, updated_at = $4
         WHERE ein_portal_invites.status IN ('pending', 'failed') AND ein_portal_invites.updated_at < $5
       RETURNING attempts`,
      [row.order_id, row.filing_session_id, row.crm_deal_id, now, retryBefore],
    );
    if (claim.rows.length === 0) continue;
    const attempts = claim.rows[0].attempts;

    const result = row.email
      ? await deps.zoho.inviteDealContact(row.crm_deal_id, row.email, deps.config.portalUserTypeId)
      : { ok: false as const, permanent: true, error: "filing session has no email" };

    if (result.ok) {
      await deps.db.query(
        `UPDATE ein_portal_invites SET status = 'invited', zoho_contact_id = $2, invited_at = $3, last_error = NULL, updated_at = $3 WHERE order_id = $1`,
        [row.order_id, result.value.contactId, now],
      );
      out.invited.push(row.order_id);
      continue;
    }

    const blocked = result.permanent === true || attempts >= INVITE_MAX_ATTEMPTS;
    await deps.db.query(
      `UPDATE ein_portal_invites SET status = $2, last_error = $3, updated_at = $4 WHERE order_id = $1`,
      [row.order_id, blocked ? "blocked" : "failed", result.error.slice(0, 500), now],
    );
    if (blocked) {
      out.blocked.push(row.order_id);
      await deps.alert(
        "EIN portal invite needs a person",
        `Order ${row.order_id}, Deal ${row.crm_deal_id}: the customer was not invited to the Zoho CRM Portal after ${attempts} attempt(s).\n` +
          `Reason: ${result.error}\nFix the Deal (linked Contact and email), then invite the Contact from Zoho CRM.`,
      );
    } else {
      out.failed.push(row.order_id);
    }
  }
  return out;
}

// ── Sweep: docs received and passport retention ─────────────────────

interface SweepRow {
  order_id: string;
  zoho_deal_id: string;
  docs_received_at: Date | null;
  closed_seen_at: Date | null;
  payment_status: string;
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

export async function runEinPortalSweepOnce(
  deps: EinPortalDeps,
): Promise<{ docsReceived: string[]; purged: string[]; errors: string[] }> {
  const out = { docsReceived: [] as string[], purged: [] as string[], errors: [] as string[] };
  const cfg = deps.config;
  if (!sweepEnabled(cfg)) return out;
  const now = deps.now();

  const { rows } = await deps.db.query<SweepRow>(
    `SELECT i.order_id, i.zoho_deal_id, i.docs_received_at, i.closed_seen_at, o.payment_status
     FROM ein_portal_invites i JOIN orders o ON o.order_id = i.order_id
     WHERE i.status = 'invited' AND i.passport_purged_at IS NULL
     ORDER BY i.updated_at
     LIMIT ${SWEEP_BATCH}`,
  );

  for (const row of rows) {
    try {
      const read = await deps.zoho.readDeal(row.zoho_deal_id, {
        docsReceived: cfg.docsReceivedField,
        passport: cfg.passportField,
        einIssuedDate: cfg.einIssuedDateField,
      });
      if (!read.ok) {
        out.errors.push(`${row.order_id}: ${read.error}`);
        await deps.db.query(`UPDATE ein_portal_invites SET last_error = $2, updated_at = $3 WHERE order_id = $1`, [row.order_id, read.error.slice(0, 500), now]);
        continue;
      }
      const deal = read.value;
      const hasPassport = deal.passportFiles.length > 0;
      let docsReceivedAt = row.docs_received_at;
      let closedSeenAt = row.closed_seen_at;

      // 1. Passport on the Deal: tick EIN Docs Received (a Zoho workflow may already have).
      if (hasPassport && !docsReceivedAt) {
        if (!deal.docsReceived && cfg.docsReceivedField) {
          const mark = await deps.zoho.markDocsReceived(
            row.zoho_deal_id,
            { docsReceived: cfg.docsReceivedField, docsReceivedAt: cfg.docsReceivedAtField },
            now,
          );
          if (!mark.ok) {
            out.errors.push(`${row.order_id}: ${mark.error}`);
            await deps.db.query(`UPDATE ein_portal_invites SET last_error = $2, updated_at = $3 WHERE order_id = $1`, [row.order_id, mark.error.slice(0, 500), now]);
            continue;
          }
        }
        docsReceivedAt = now;
        out.docsReceived.push(row.order_id);
        await deps.alert(
          "EIN docs received",
          `Order ${row.order_id}, Deal ${row.zoho_deal_id}: the passport photo page is on the Deal (uploaded through the Zoho CRM Portal). Ready for the SS-4.`,
        );
      }

      // 2. Cancelled or refunded: remember when first seen (our order status or the Deal stage).
      const cancelled = row.payment_status === "released" || row.payment_status === "refunded" || (deal.stage !== null && cfg.purgeStages.includes(deal.stage));
      if (cancelled && !closedSeenAt) closedSeenAt = now;

      // 3. Retention: clear the passport 30 days after EIN issue, or within 30 days of cancellation.
      let purgedAt: Date | null = null;
      const due =
        (deal.einIssuedDate !== null && daysPassedSinceDate(deal.einIssuedDate, cfg.purgeDays, now)) ||
        (closedSeenAt !== null && cancellationPurgeDue(closedSeenAt, cfg.purgeDays, now));
      if (hasPassport && due) {
        const cleared = await deps.zoho.clearFileField(row.zoho_deal_id, cfg.passportField, deal.passportFiles);
        if (cleared.ok) {
          purgedAt = now;
          out.purged.push(row.order_id);
        } else {
          out.errors.push(`${row.order_id}: ${cleared.error}`);
          await deps.alert(
            "EIN passport purge failed",
            `Order ${row.order_id}, Deal ${row.zoho_deal_id}: the passport photo page is past its retention date but could not be cleared.\nReason: ${cleared.error}\nDelete it from the Deal in Zoho CRM by hand.`,
          );
        }
      }

      await deps.db.query(
        `UPDATE ein_portal_invites
         SET docs_received_at = $2, closed_seen_at = $3, passport_purged_at = $4, last_error = NULL, updated_at = $5
         WHERE order_id = $1`,
        [row.order_id, docsReceivedAt, closedSeenAt, purgedAt, now],
      );
    } catch (err) {
      out.errors.push(`${row.order_id}: ${describeError(err)}`);
    }
  }
  return out;
}
