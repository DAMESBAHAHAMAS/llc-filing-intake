import type { Pool, PoolClient } from "pg";
import { describeError } from "../db/describeError.js";
import { sendOpsAlert } from "../ops/alerts.js";
import { enqueueCustomerEmails } from "../orderEmails/worker.js";
import { enqueueDealUpdate } from "../routes/webhooksStripe.js";
import {
  cancelPaymentIntent,
  createPaymentLink,
  retrievePaymentIntent,
  type CreatePaymentLinkParams,
  type StripePaymentIntent,
  type StripePaymentLink,
} from "../stripe/restClient.js";
import { fulfillmentAfterPaymentEnds } from "./holdState.js";

/**
 * Day-5 card-hold release: the owner's final hold rule (Damian, 25 Nov 2026;
 * A6Y2-T144 final pre-launch round; memory "ffl-final-hold-rule"):
 *
 *  1. A hold is captured when the Articles are submitted to Sunbiz: the operator
 *     calls POST /api/orders/:orderId/sunbiz-submitted (routes/orders.ts), which
 *     records sunbiz_submitted_at and captures. A submitted order is never
 *     released here, whatever Florida's turnaround.
 *  2. A lapsed or released hold is NEVER charged off-session.
 *  3. A hold still uncaptured 120 hours after it was placed (or 1 hour before
 *     Stripe's own capture_before, if that comes first) is released here: the
 *     PaymentIntent is cancelled, the order is marked released, the Zoho Deal
 *     gets Payment_Status = HOLD_EXPIRED_ZOHO_VALUE and Hold_Expires (the release
 *     time), and the customer is emailed a one-time Stripe Payment Link for the
 *     same amount. Its PaymentIntent carries metadata.order_id, so the existing
 *     webhook (payment_intent.succeeded) marks the order paid when the customer pays.
 *  4. A hold that lapsed on its own before the job reached it (Stripe's
 *     payment_intent.canceled with cancellation_reason "automatic") gets the same
 *     Deal update, link and email; nothing is cancelled, it is already gone.
 *
 * Safe rollout:
 *  - HOLD_RELEASE_START (default 2026-11-25, midnight Florida time): only holds
 *    placed on or after it are ever released. Older holds are never touched; they
 *    raise ONE ops alert listing them (orders.hold_release_alerted_at).
 *  - HOLD_RELEASE_ENABLED (default on): "off" stops the job entirely.
 *  - A held order that already has proof of filing is never released (its
 *    capture failed for another reason); it raises one ops alert instead.
 *
 * Each order is taken (hold_release_started_at) before any Stripe call, and every
 * Stripe call has an idempotency key, so a run that stops halfway is resumed by the
 * next one without a second cancel or a second link. Payment Links are created only
 * here, only when the job runs.
 */

export const DEFAULT_HOLD_RELEASE_START = "2026-11-25";
export const DEFAULT_HOLD_RELEASE_AFTER_HOURS = 120;
/**
 * The Zoho Deal Payment_Status value written when the job releases a hold.
 * Owner decision: "Hold Expired". Zoho has no such picklist value yet, so the
 * default is the existing "Hold Released" until Damian adds "Hold Expired" and
 * sets HOLD_EXPIRED_ZOHO_VALUE=Hold Expired (merge checklist).
 */
export const DEFAULT_HOLD_EXPIRED_ZOHO_VALUE = "Hold Released";
/** Stripe cancellation reasons that mean the hold lapsed by itself. */
export const LAPSED_REASONS = ["automatic", "expired"] as const;
const LAPSED_SQL = `('automatic', 'expired')`;
/** A Stripe card hold lasts 7 days; releasing at or after that would be pointless. */
const MAX_AFTER_HOURS = 7 * 24 - 1;
const BATCH = 20;

export interface HoldReleaseConfig {
  enabled: boolean;
  /** Holds authorized before this instant are never released by the job. */
  start: Date;
  afterHours: number;
  /** Set when an env value is unusable; the job then does nothing. */
  error?: string;
  /** Zoho Deal Payment_Status for a released hold (HOLD_EXPIRED_ZOHO_VALUE). */
  zohoPaymentStatus: string;
}

/** Midnight of a YYYY-MM-DD date in Florida (America/New_York), as an instant. */
export function floridaMidnight(date: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  // Florida is UTC-5 (EST) or UTC-4 (EDT): try both, keep the one that is midnight there.
  for (const offset of [5, 4]) {
    const candidate = new Date(Date.UTC(y, mo, d, offset));
    const hour = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" }).format(candidate);
    if (Number(hour) === 0 && candidate.getUTCDate() === d) return candidate;
  }
  return null;
}

export function holdReleaseConfig(env: Record<string, string | undefined> = process.env): HoldReleaseConfig {
  const enabledRaw = (env.HOLD_RELEASE_ENABLED ?? "on").trim().toLowerCase();
  const enabled = !["off", "false", "0", "no"].includes(enabledRaw);
  const startRaw = (env.HOLD_RELEASE_START ?? "").trim() || DEFAULT_HOLD_RELEASE_START;
  const start = floridaMidnight(startRaw) ?? (/^\d{4}-\d{2}-\d{2}T/.test(startRaw) ? new Date(startRaw) : null);
  const afterRaw = (env.HOLD_RELEASE_AFTER_HOURS ?? "").trim();
  const afterHours = afterRaw ? Number(afterRaw) : DEFAULT_HOLD_RELEASE_AFTER_HOURS;
  const zohoPaymentStatus = (env.HOLD_EXPIRED_ZOHO_VALUE ?? "").trim() || DEFAULT_HOLD_EXPIRED_ZOHO_VALUE;

  if (!start || Number.isNaN(start.getTime())) {
    return { enabled: false, start: new Date(NaN), afterHours, zohoPaymentStatus, error: `HOLD_RELEASE_START "${startRaw}" is not a date (YYYY-MM-DD)` };
  }
  if (!Number.isFinite(afterHours) || afterHours < 24 || afterHours > MAX_AFTER_HOURS) {
    return { enabled: false, start, afterHours, zohoPaymentStatus, error: `HOLD_RELEASE_AFTER_HOURS "${afterRaw}" must be between 24 and ${MAX_AFTER_HOURS}` };
  }
  return { enabled, start, afterHours, zohoPaymentStatus };
}

export interface HoldReleaseDeps {
  cancelPaymentIntent: (id: string, idempotencyKey: string, reason: "abandoned") => Promise<StripePaymentIntent>;
  retrievePaymentIntent: (id: string) => Promise<StripePaymentIntent>;
  createPaymentLink: (params: CreatePaymentLinkParams) => Promise<StripePaymentLink>;
  alert: (subject: string, body: string) => Promise<unknown>;
  now: () => Date;
  config: () => HoldReleaseConfig;
}

export const defaultHoldReleaseDeps: HoldReleaseDeps = {
  cancelPaymentIntent,
  retrievePaymentIntent,
  createPaymentLink,
  alert: sendOpsAlert,
  now: () => new Date(),
  config: () => holdReleaseConfig(),
};

interface LineItem {
  offer_code?: string;
  stripe_price_id?: string | null;
  unit_amount_cents?: number;
  quantity?: number;
}

interface CandidateRow {
  order_id: string;
  filing_session_id: string;
  stripe_payment_intent_id: string;
  line_items: LineItem[] | null;
  total_cents: number;
  payment_status: string;
  hold_release_error: string | null;
}

export interface HoldReleaseResult {
  ran: boolean;
  released: string[];
  failed: string[];
  skipped: string[];
  alertedLegacy: string[];
  alertedWithProof: string[];
}

/**
 * The Payment Link's lines: the order's own priced lines (same Stripe Prices,
 * same quantities). The Finance-Ready kickoff's zero-amount selected-package line
 * has no Stripe Price and is left out, so the link is for the hold amount only.
 * Null when the priced lines do not add up to the order total.
 */
export function paymentLinkLines(lineItems: LineItem[] | null, totalCents: number): Array<{ price: string; quantity: number }> | null {
  const priced = (lineItems ?? []).filter((li) => typeof li.stripe_price_id === "string" && li.stripe_price_id.startsWith("price_"));
  if (priced.length === 0) return null;
  const sum = priced.reduce((acc, li) => acc + (li.unit_amount_cents ?? NaN) * (li.quantity ?? 1), 0);
  if (sum !== totalCents) return null;
  return priced.map((li) => ({ price: li.stripe_price_id as string, quantity: li.quantity ?? 1 }));
}

/** Zoho DateTime: ISO 8601 with offset, no milliseconds (zoho/einPortal.ts). */
export function zohoDateTime(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

function isMissingColumn(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === "42703" || /column .*(hold_release|hold_auto_released|payment_link|sunbiz_submitted|hold_cancellation|capture_before).* does not exist/i.test(e?.message ?? "");
}

let missingColumnLogged = false;

/** Moves to the next order quietly; alerts ops only the first time an order's error is set. */
async function recordError(pool: Pool, deps: HoldReleaseDeps, row: CandidateRow, error: string): Promise<void> {
  await pool.query(`UPDATE orders SET hold_release_error = $2 WHERE order_id = $1`, [row.order_id, error.slice(0, 500)]);
  if (!row.hold_release_error) {
    await deps.alert(
      "Day-5 hold release needs a person",
      `Order ${row.order_id}: ${error}. The job retries every run; no card was charged.`
    );
  }
}

/** Marked before the alert is sent, so an order is never in two alerts. One row at a time: a handful at most. */
async function markAlerted(pool: Pool, ids: string[], at: Date): Promise<void> {
  for (const id of ids) {
    await pool.query(`UPDATE orders SET hold_release_alerted_at = $2 WHERE order_id = $1 AND hold_release_alerted_at IS NULL`, [id, at]);
  }
}

async function alertOldHolds(pool: Pool, deps: HoldReleaseDeps, cfg: HoldReleaseConfig): Promise<string[]> {
  const { rows } = await pool.query<{ order_id: string; authorized_at: Date; total_cents: number }>(
    `SELECT order_id, authorized_at, total_cents FROM orders
     WHERE payment_status = 'authorized' AND authorized_at < $1 AND hold_release_alerted_at IS NULL
     ORDER BY authorized_at ASC`,
    [cfg.start]
  );
  if (!rows.length) return [];
  const ids = rows.map((r) => r.order_id);
  await markAlerted(pool, ids, deps.now());
  await deps.alert(
    "Card holds placed before the Day-5 release started",
    [
      `These ${rows.length} held order(s) were authorized before ${cfg.start.toISOString()} (HOLD_RELEASE_START), so the Day-5 job will NOT release them or send a payment link. Capture each on Sunbiz submission, or release it by hand (POST /api/orders/:orderId/release-hold). Nothing is ever charged off-session.`,
      ...rows.map((r) => `- ${r.order_id}: $${(r.total_cents / 100).toFixed(2)}, held since ${new Date(r.authorized_at).toISOString()}`),
    ].join("\n")
  );
  return ids;
}

async function alertHeldWithProof(pool: Pool, deps: HoldReleaseDeps, cfg: HoldReleaseConfig, cutoff: Date): Promise<string[]> {
  const { rows } = await pool.query<{ order_id: string; capture_error: string | null }>(
    `SELECT order_id, capture_error FROM orders
     WHERE payment_status = 'authorized' AND (proof_of_filing_at IS NOT NULL OR sunbiz_submitted_at IS NOT NULL)
       AND authorized_at >= $1 AND authorized_at <= $2 AND hold_release_alerted_at IS NULL`,
    [cfg.start, cutoff]
  );
  if (!rows.length) return [];
  const ids = rows.map((r) => r.order_id);
  await markAlerted(pool, ids, deps.now());
  await deps.alert(
    "Filed orders still not collected at Day 5",
    [
      "These orders were submitted to Sunbiz (or have proof of filing) but the hold was not captured, so the Day-5 job leaves them alone. Retry the capture (POST /api/orders/:orderId/sunbiz-submitted) before the hold expires.",
      ...rows.map((r) => `- ${r.order_id}${r.capture_error ? ` (last error: ${r.capture_error})` : ""}`),
    ].join("\n")
  );
  return ids;
}

/** Cancels the hold. Returns "ok" when it is (now) cancelled, "captured" when it was collected meanwhile. */
async function cancelHold(deps: HoldReleaseDeps, row: CandidateRow): Promise<"ok" | "captured" | { error: string }> {
  try {
    const pi = await deps.cancelPaymentIntent(row.stripe_payment_intent_id, `day5-release-${row.order_id}`, "abandoned");
    if (pi.status === "canceled") return "ok";
    if (pi.status === "succeeded") return "captured";
    return { error: `the hold could not be cancelled (PaymentIntent status ${pi.status})` };
  } catch (err) {
    // Already cancelled (Stripe expired it, or an earlier run) or captured: read it.
    try {
      const pi = await deps.retrievePaymentIntent(row.stripe_payment_intent_id);
      if (pi.status === "canceled") return "ok";
      if (pi.status === "succeeded") return "captured";
      return { error: `cancelling the hold failed: ${describeError(err)} (PaymentIntent status ${pi.status})` };
    } catch {
      return { error: `cancelling the hold failed: ${describeError(err)}` };
    }
  }
}

async function finishRelease(
  pool: Pool,
  row: CandidateRow,
  link: StripePaymentLink,
  at: Date,
  zohoPaymentStatus: string
): Promise<"released" | "changed" | "email_not_queued"> {
  const client: PoolClient = await pool.connect();
  let emailQueued = true;
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ payment_status: string; fulfillment_status: string; crm_deal_id: string | null }>(
      `SELECT payment_status, fulfillment_status, crm_deal_id FROM orders
       WHERE order_id = $1 AND hold_auto_released_at IS NULL AND payment_status IN ('authorized', 'released')
       FOR UPDATE`,
      [row.order_id]
    );
    if (!locked.rowCount) {
      await client.query("ROLLBACK");
      return "changed";
    }
    const current = locked.rows[0];
    const fulfillment = current.payment_status === "authorized" ? fulfillmentAfterPaymentEnds(current.fulfillment_status) : current.fulfillment_status;
    await client.query(
      `UPDATE orders
       SET payment_status = 'released', released_at = COALESCE(released_at, $2), fulfillment_status = $3,
           hold_auto_released_at = $2, payment_link_id = $4, payment_link_url = $5, hold_release_error = NULL
       WHERE order_id = $1`,
      [row.order_id, at, fulfillment, link.id, link.url]
    );
    // Field-only Deal update (Stage unchanged). Payment_Status is the owner's
    // "Hold Expired" marker once Zoho has that value (HOLD_EXPIRED_ZOHO_VALUE);
    // Hold_Expires is the existing Deals datetime field, set to the release time.
    // The webhook skips its own Deal update for this job's cancel, so this is the
    // only one for a Day-5 release.
    await enqueueDealUpdate(
      client,
      { order_id: row.order_id, filing_session_id: row.filing_session_id, crm_deal_id: current.crm_deal_id },
      { extra_fields: { Payment_Status: zohoPaymentStatus, Hold_Expires: zohoDateTime(at) } }
    );
    emailQueued = await enqueueCustomerEmails(client, {
      orderId: row.order_id,
      filingSessionId: row.filing_session_id,
      emailTypes: ["hold_released"],
      paymentMode: "released",
      paymentLinkUrl: link.url,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return emailQueued ? "released" : "email_not_queued";
}

/** One pass of the Day-5 release. */
export async function runHoldReleaseOnce(pool: Pool, deps: HoldReleaseDeps = defaultHoldReleaseDeps): Promise<HoldReleaseResult> {
  const result: HoldReleaseResult = { ran: false, released: [], failed: [], skipped: [], alertedLegacy: [], alertedWithProof: [] };
  const cfg = deps.config();
  if (cfg.error) {
    console.error(`[hold release] not running: ${cfg.error}`);
    return result;
  }
  if (!cfg.enabled) return result;

  const now = deps.now();
  const cutoff = new Date(now.getTime() - cfg.afterHours * 3600 * 1000);
  let candidates: CandidateRow[];
  try {
    result.alertedLegacy = await alertOldHolds(pool, deps, cfg);
    result.alertedWithProof = await alertHeldWithProof(pool, deps, cfg, cutoff);
    // Due: 120 h after authorization, or 1 h before Stripe's own expiry if that
    // comes first (holdSweep records capture_before). Rows that keep failing go
    // last, so they never starve newer holds of the batch.
    candidates = (
      await pool.query<CandidateRow>(
        `SELECT order_id, filing_session_id, stripe_payment_intent_id, line_items, total_cents, payment_status, hold_release_error
         FROM orders
         WHERE stripe_payment_intent_id IS NOT NULL AND hold_auto_released_at IS NULL
           AND (
             (payment_status = 'authorized' AND proof_of_filing_at IS NULL AND sunbiz_submitted_at IS NULL AND authorized_at >= $1
               AND (authorized_at <= $2 OR (capture_before IS NOT NULL AND capture_before <= $3)))
             OR (payment_status = 'released' AND hold_release_started_at IS NULL AND authorized_at >= $1
               AND hold_cancellation_reason IN ${LAPSED_SQL})
             OR (hold_release_started_at IS NOT NULL AND payment_status IN ('authorized', 'released'))
           )
         ORDER BY (hold_release_error IS NOT NULL) ASC, authorized_at ASC
         LIMIT ${BATCH}`,
        [cfg.start, cutoff, new Date(now.getTime() + 3600 * 1000)]
      )
    ).rows;
  } catch (err) {
    if (isMissingColumn(err)) {
      if (!missingColumnLogged) console.error("[hold release] orders columns missing: apply migration 0038. The job does nothing until then.");
      missingColumnLogged = true;
      return result;
    }
    throw err;
  }
  result.ran = true;

  for (const row of candidates) {
    try {
      // Checked before taking the order: without a link the hold is not released at all.
      const lines = paymentLinkLines(row.line_items, row.total_cents);
      if (!lines) {
        await recordError(pool, deps, row, "its line items do not give Stripe Prices that add up to the order total, so no payment link can be made; the hold was NOT released");
        result.failed.push(row.order_id);
        continue;
      }

      // Take the order before any Stripe call: one this job already took, a held
      // order still not filed or submitted (re-checked here, so proof or a Sunbiz
      // submission recorded since the SELECT wins), or a hold that lapsed by itself.
      const taken = await pool.query(
        `UPDATE orders SET hold_release_started_at = COALESCE(hold_release_started_at, $2)
         WHERE order_id = $1 AND hold_auto_released_at IS NULL
           AND (
             (hold_release_started_at IS NOT NULL AND payment_status IN ('authorized', 'released'))
             OR (payment_status = 'authorized' AND proof_of_filing_at IS NULL AND sunbiz_submitted_at IS NULL)
             OR (payment_status = 'released' AND hold_cancellation_reason IN ${LAPSED_SQL})
           )
         RETURNING order_id`,
        [row.order_id, now]
      );
      if (!taken.rowCount) {
        result.skipped.push(row.order_id);
        continue;
      }

      // A released order's hold is already gone (lapsed, or cancelled by an earlier run).
      const cancelled = row.payment_status === "released" ? "ok" : await cancelHold(deps, row);
      if (cancelled === "captured") {
        // Collected meanwhile: the webhook marks it paid. Nothing to release.
        await pool.query(`UPDATE orders SET hold_release_started_at = NULL WHERE order_id = $1 AND hold_auto_released_at IS NULL`, [row.order_id]);
        result.skipped.push(row.order_id);
        continue;
      }
      if (cancelled !== "ok") {
        await recordError(pool, deps, row, cancelled.error);
        result.failed.push(row.order_id);
        continue;
      }

      let link: StripePaymentLink;
      try {
        link = await deps.createPaymentLink({
          lineItems: lines,
          metadata: { order_id: row.order_id, filing_session_id: row.filing_session_id, reason: "day5_hold_release" },
          confirmationMessage: "Thank you. Your payment is approved and your order continues. We will email you as soon as your filing is complete.",
          idempotencyKey: `day5-paylink-${row.order_id}`,
        });
      } catch (err) {
        await recordError(pool, deps, row, `the hold is released but the payment link could not be created: ${describeError(err)}`);
        result.failed.push(row.order_id);
        continue;
      }

      const outcome = await finishRelease(pool, row, link, now, cfg.zohoPaymentStatus);
      if (outcome === "changed") {
        result.skipped.push(row.order_id);
        continue;
      }
      if (outcome === "email_not_queued") {
        await deps.alert("Customer email not queued", `Order ${row.order_id}: the Day-5 payment link email could not be queued. Send this link by hand: ${link.url}`);
      }
      result.released.push(row.order_id);
    } catch (err) {
      console.error(`[hold release] order ${row.order_id} failed:`, describeError(err));
      result.failed.push(row.order_id);
    }
  }

  if (result.released.length) {
    await deps.alert(
      "Card holds released at Day 5",
      `${result.released.length} uncaptured hold(s) released, nothing charged; each customer is being emailed a one-time payment link for the same amount:\n` +
        result.released.map((id) => `- ${id}`).join("\n")
    );
  }
  return result;
}
