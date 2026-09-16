import type { Pool } from "pg";
import { describeError } from "../db/describeError.js";
import type { StripeCheckoutClient } from "./stripeCheckoutClient.js";

interface OfferLineItem {
  /** Stripe Price ID, env-overridable so live-mode Prices (Stripe mints
   *  new ids on "Copy to live mode") can be swapped in without a code
   *  change. */
  price: string;
  quantity: number;
  /** Human-readable label for this line, snapshotted into orders.line_items. */
  label: string;
  /** This service's own authoritative amount for this line — used to
   *  build the internal order record. Deliberately NOT fetched from
   *  Stripe at request time: order persistence must succeed or fail
   *  independently of Stripe's reachability (Gate 2 requirement — a
   *  Stripe-API failure and an order-persistence failure are distinct
   *  failure modes). If this ever drifts from the actual Stripe Price's
   *  unit_amount, the integration test (checkoutService.test.ts) that
   *  compares order.total_cents against the real Stripe Price catches it. */
  amount_cents: number;
}

/**
 * Server-defined, closed set of purchasable offers. The client sends
 * only crm_intent — never a Price ID or an amount — and this map is the
 * only place crm_intent resolves to real Stripe Prices and real prices
 * (DECISIONS.md, 2026-08-11: prices are Stripe Price IDs, never
 * client-computed).
 *
 * TEST-MODE Price IDs (acct_1ChHmZDo01bXdbWS, livemode: false), verified
 * live against Stripe on 2026-08-28 (product descriptions + unit_amount)
 * as part of Gate 2 checkout integration. This map must be updated with
 * live-mode Price IDs and re-verified amounts before go-live.
 */
export const OFFER_LINE_ITEMS: Record<string, OfferLineItem[]> = {
  LLC_FORMATION_FASTTRACK: [
    {
      price: process.env.STRIPE_PRICE_FASTTRACK || "price_1U8ag7Do01bXdbWSrDQBWI8H",
      quantity: 1,
      label: "Florida LLC Formation — FastTrack",
      amount_cents: 49900,
    },
  ],
  LLC_FORMATION_PREMIUM: [
    {
      price: process.env.STRIPE_PRICE_PREMIUM || "price_1U8agADo01bXdbWSN7stU2LF",
      quantity: 1,
      label: "Florida LLC Formation — Premium",
      amount_cents: 99900,
    },
  ],
  EIN_FILING: [
    {
      price: process.env.STRIPE_PRICE_EIN || "price_1U8agEDo01bXdbWSFyTsJj7n",
      quantity: 1,
      label: "EIN Filing Service",
      amount_cents: 29900,
    },
  ],
  // Two line items on purpose — the pricing decision was to show
  // "Florida LLC Filing" and "Service Fee" as separate lines at
  // Checkout, not one bundled total. Replaces the archived combined
  // $129 Price (price_1U8afzDo01bXdbWSpjBCA0jn, inactive) — do not
  // reintroduce it.
  LLC_FORMATION_DIY: [
    {
      price: process.env.STRIPE_PRICE_DIY_FILING_FEE || "price_1U9HsDDo01bXdbWStkpesATi",
      quantity: 1,
      label: "Florida LLC Filing",
      amount_cents: 12500,
    },
    {
      price: process.env.STRIPE_PRICE_DIY_SERVICE_FEE || "price_1U9HsRDo01bXdbWSHUSLnbcO",
      quantity: 1,
      label: "Service Fee",
      amount_cents: 400,
    },
  ],
};

export type CheckoutFailureReason =
  | "missing_fields"
  | "unknown_crm_intent"
  | "session_not_ready"
  | "session_lookup_failed"
  | "stage_not_complete"
  | "order_persist_failed"
  | "stripe_failed";

export type CheckoutResult =
  | { ok: true; orderId: string; checkoutUrl: string | null; reusedOrder: boolean }
  | { ok: false; reason: CheckoutFailureReason; detail?: string; orderId?: string };

/**
 * Orchestrates the full pre-payment path for POST /checkout/session:
 *
 *   1. validate input
 *   2. resolve crm_intent -> this service's own line items (never trusts
 *      a client-supplied Price ID or amount)
 *   3. gate: filing_sessions.current_stage === 'complete'
 *      (unchanged from the original checkout.ts — GOVERNANCE.md #2:
 *      never charge a card before the order record is durably
 *      persisted, which itself depends on the filing record being
 *      complete first)
 *   4. persist the internal order row (checkout_status 'pending') — BEFORE any
 *      Stripe call. If this fails, stop; no Stripe call is made. Reuses
 *      an existing non-paid order for this (filing_session_id, crm_intent)
 *      if one exists (a cancelled/abandoned-then-retried Checkout), rather
 *      than inserting a second row every retry.
 *   5. call Stripe to create the Checkout Session. On success, mark the
 *      order 'checkout_created' and log the session id to filing_events
 *      (keeps every attempt's session id historically identifiable, even
 *      when the order row itself was reused). On failure, mark it
 *      'checkout_failed' with the reason — the filing session and the
 *      order row are never deleted in either case.
 *
 * Takes the Stripe client as a parameter (same injectable-client pattern
 * as ZohoClient/EmailSender elsewhere in this codebase) so tests can run
 * the real gate + real order persistence against the real dev database
 * without needing live Stripe credentials, by passing a fake client.
 */
export async function createCheckoutSession(
  pool: Pool,
  stripeClient: StripeCheckoutClient,
  input: { filingSessionId: string; crmIntent: string }
): Promise<CheckoutResult> {
  const { filingSessionId, crmIntent } = input;

  if (!filingSessionId || !crmIntent) {
    return { ok: false, reason: "missing_fields" };
  }

  const lineItems = OFFER_LINE_ITEMS[crmIntent];
  if (!lineItems) {
    return { ok: false, reason: "unknown_crm_intent" };
  }

  let currentStage: string | null;
  try {
    const existing = await pool.query<{ current_stage: string | null }>(
      "SELECT current_stage FROM filing_sessions WHERE filing_session_id = $1",
      [filingSessionId]
    );
    if (!existing.rowCount) {
      return { ok: false, reason: "session_not_ready" };
    }
    currentStage = existing.rows[0].current_stage;
  } catch (err) {
    return { ok: false, reason: "session_lookup_failed", detail: describeError(err) };
  }

  if (currentStage !== "complete") {
    return { ok: false, reason: "stage_not_complete" };
  }

  const orderLineItemsSnapshot = lineItems.map((li) => ({
    price: li.price,
    label: li.label,
    quantity: li.quantity,
    amount_cents: li.amount_cents,
  }));
  const totalCents = lineItems.reduce((sum, li) => sum + li.amount_cents * li.quantity, 0);
  const product = crmIntent;

  // Retry reuse (Gate 2 return-routes task, §10): a customer who cancelled
  // or abandoned Checkout and comes back to retry must not get a second
  // Order for the same (filing_session_id, crm_intent) — reuse the most
  // recent non-paid one instead of inserting a new row. A `paid` order is
  // never reused (that's a completed sale; a repeat purchase attempt, if
  // ever supported, is a distinct concern outside this task).
  let orderId: string;
  let reusedOrder = false;
  try {
    const existing = await pool.query<{ order_id: string }>(
      `SELECT order_id FROM orders
       WHERE filing_session_id = $1 AND crm_intent = $2 AND payment_status != 'paid'
       ORDER BY created_at DESC LIMIT 1`,
      [filingSessionId, crmIntent]
    );
    if (existing.rowCount) {
      orderId = existing.rows[0].order_id;
      reusedOrder = true;
      await pool.query(
        `UPDATE orders SET line_items = $2, total_cents = $3, checkout_status = 'pending', failure_reason = NULL WHERE order_id = $1`,
        [orderId, JSON.stringify(orderLineItemsSnapshot), totalCents]
      );
    } else {
      const inserted = await pool.query<{ order_id: string }>(
        `INSERT INTO orders (filing_session_id, crm_intent, product, line_items, total_cents, currency, checkout_status)
         VALUES ($1, $2, $3, $4, $5, 'usd', 'pending')
         RETURNING order_id`,
        [filingSessionId, crmIntent, product, JSON.stringify(orderLineItemsSnapshot), totalCents]
      );
      orderId = inserted.rows[0].order_id;
    }
  } catch (err) {
    return { ok: false, reason: "order_persist_failed", detail: describeError(err) };
  }

  try {
    const session = await stripeClient.createCheckoutSession({
      lineItems: lineItems.map((li) => ({ price: li.price, quantity: li.quantity })),
      filingSessionId,
      crmIntent,
      orderId,
    });

    await pool.query(
      `UPDATE orders SET checkout_status = 'checkout_created', stripe_checkout_session_id = $2 WHERE order_id = $1`,
      [orderId, session.id]
    );
    // Every Checkout Session ever created for this order is logged here —
    // reusing the order overwrites orders.stripe_checkout_session_id with
    // only the latest one, so this append-only trail (not a new table —
    // filing_events already exists for exactly this kind of audit record)
    // is what keeps old, superseded session ids historically identifiable.
    await pool.query(
      `INSERT INTO filing_events (filing_session_id, event_type, payload) VALUES ($1, $2, $3)`,
      [filingSessionId, "checkout_session_created", { order_id: orderId, stripe_checkout_session_id: session.id, crm_intent: crmIntent, reused_order: reusedOrder }]
    );

    return { ok: true, orderId, checkoutUrl: session.url, reusedOrder };
  } catch (err) {
    const detail = describeError(err);
    // Preserve the filing session and the order row — only the order's
    // checkout_status/failure_reason changes. Never delete either on a
    // Stripe failure.
    await pool.query(
      `UPDATE orders SET checkout_status = 'checkout_failed', failure_reason = $2 WHERE order_id = $1`,
      [orderId, detail]
    );
    return { ok: false, reason: "stripe_failed", detail, orderId };
  }
}

export interface CheckoutSessionStatus {
  found: boolean;
  orderId?: string;
  filingSessionId?: string;
  crmIntent?: string;
  product?: string;
  checkoutStatus?: string;
  paymentStatus?: string;
  totalCents?: number;
  currency?: string;
}

/**
 * Read-only lookup for the Checkout success/cancel return routes
 * (Gate 2 return-routes task). Keyed ONLY on the Stripe Checkout Session
 * id — the same high-entropy identifier Stripe's own {CHECKOUT_SESSION_ID}
 * placeholder puts in success_url/cancel_url — never on a client-supplied
 * order_id or filing_session_id, so a URL can't be edited to browse
 * another customer's order by guessing a smaller/sequential id.
 *
 * Deliberately returns only non-sensitive fields: no email, name,
 * address, or filing_data. filing_session_id/crm_intent are included
 * because the cancel page's "retry Checkout" action needs them to call
 * POST /checkout/session again — seeing them proves nothing exploitable
 * beyond what the Stripe session id itself already would (see
 * GATE2-STRIPE-RETURN-ROUTES-STATUS.md §8 for the full authorization
 * posture and its documented limits).
 */
export async function getCheckoutSessionStatus(pool: Pool, stripeSessionId: string): Promise<CheckoutSessionStatus> {
  if (!stripeSessionId) return { found: false };
  const { rows } = await pool.query<{
    order_id: string;
    filing_session_id: string;
    crm_intent: string;
    product: string;
    checkout_status: string;
    payment_status: string;
    total_cents: number;
    currency: string;
  }>(
    `SELECT order_id, filing_session_id, crm_intent, product, checkout_status, payment_status, total_cents, currency
     FROM orders WHERE stripe_checkout_session_id = $1`,
    [stripeSessionId]
  );
  const row = rows[0];
  if (!row) return { found: false };
  return {
    found: true,
    orderId: row.order_id,
    filingSessionId: row.filing_session_id,
    crmIntent: row.crm_intent,
    product: row.product,
    checkoutStatus: row.checkout_status,
    paymentStatus: row.payment_status,
    totalCents: row.total_cents,
    currency: row.currency,
  };
}
