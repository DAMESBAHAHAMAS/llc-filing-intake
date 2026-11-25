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
 *  1. A hold is captured when the filing is submitted to Sunbiz (routes/orders.ts).
 *  2. A lapsed or released hold is NEVER charged off-session.
 *  3. A hold still uncaptured 120 hours after it was placed is released here:
 *     the PaymentIntent is cancelled, the order is marked released, the Zoho Deal
 *     gets Payment_Status "Hold Released" and Hold_Expires (the release time), and
 *     the customer is emailed a one-time Stripe Payment Link for the same amount.
 *     Its PaymentIntent carries metadata.order_id, so the existing webhook
 *     (payment_intent.succeeded) marks the order paid when the customer pays.
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

  if (!start || Number.isNaN(start.getTime())) {
    return { enabled: false, start: new Date(NaN), afterHours, error: `HOLD_RELEASE_START "${startRaw}" is not a date (YYYY-MM-DD)` };
  }
  if (!Number.isFinite(afterHours) || afterHours < 24 || afterHours > MAX_AFTER_HOURS) {
    return { enabled: false, start, afterHours, error: `HOLD_RELEASE_AFTER_HOURS "${afterRaw}" must be between 24 and ${MAX_AFTER_HOURS}` };
  }
  return { enabled, start, afterHours };
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
  return e?.code === "42703" || /column .*(hold_release|hold_auto_released|payment_link).* does not exist/i.test(e?.message ?? "");
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
     WHERE payment_status = 'authorized' AND proof_of_filing_at IS NOT NULL
       AND authorized_at >= $1 AND authorized_at <= $2 AND hold_release_alerted_at IS NULL`,
    [cfg.start, cutoff]
  );
  if (!rows.length) return [];
  const ids = rows.map((r) => r.order_id);
  await markAlerted(pool, ids, deps.now());
  await deps.alert(
    "Filed orders still not collected at Day 5",
    [
      "Proof of filing is recorded but the hold was not captured, so the Day-5 job leaves these alone. Retry the capture (POST /api/orders/:orderId/proof-of-filing) before the hold expires.",
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
  at: Date
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
    // Field-only Deal update (Stage unchanged). "Hold Released" is the existing
    // Payment_Status value the webhook already writes; Hold_Expires is the existing
    // Deals datetime field, set to the moment the hold was released.
    await enqueueDealUpdate(
      client,
      { order_id: row.order_id, filing_session_id: row.filing_session_id, crm_deal_id: current.crm_deal_id },
      { extra_fields: { Payment_Status: "Hold Released", Hold_Expires: zohoDateTime(at) } }
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
    candidates = (
      await pool.query<CandidateRow>(
        `SELECT order_id, filing_session_id, stripe_payment_intent_id, line_items, total_cents, payment_status, hold_release_error
         FROM orders
         WHERE stripe_payment_intent_id IS NOT NULL AND hold_auto_released_at IS NULL
           AND (
             (payment_status = 'authorized' AND proof_of_filing_at IS NULL AND authorized_at >= $1 AND authorized_at <= $2)
             OR (hold_release_started_at IS NOT NULL AND payment_status IN ('authorized', 'released'))
           )
         ORDER BY authorized_at ASC
         LIMIT ${BATCH}`,
        [cfg.start, cutoff]
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

      // Take the order before any Stripe call. Only a held order, or one this job already took.
      const taken = await pool.query(
        `UPDATE orders SET hold_release_started_at = COALESCE(hold_release_started_at, $2)
         WHERE order_id = $1 AND hold_auto_released_at IS NULL
           AND (payment_status = 'authorized' OR (hold_release_started_at IS NOT NULL AND payment_status = 'released'))
         RETURNING order_id`,
        [row.order_id, now]
      );
      if (!taken.rowCount) {
        result.skipped.push(row.order_id);
        continue;
      }

      const cancelled = await cancelHold(deps, row);
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

      const outcome = await finishRelease(pool, row, link, now);
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
