import type { Pool } from "pg";
import type Stripe from "stripe";
import { describeError } from "../db/describeError.js";
import type { StripeCheckoutClient } from "../checkout/stripeCheckoutClient.js";
import type { ZohoClient } from "../zoho/client.js";

export type WebhookProcessingResult =
  | "paid"
  | "ignored_unhandled_event_type"
  | "order_not_found"
  | "payment_not_confirmed"
  | "amount_or_currency_mismatch"
  | "already_paid_noop";

/** Mirrors the CHECK constraint on orders.fulfillment_status (migration 0010). */
export type FulfillmentStatus =
  | "not_ready"
  | "ready"
  | "in_progress"
  | "transmitted"
  | "failed"
  | "requires_review";

interface OrderRow {
  order_id: string;
  filing_session_id: string;
  checkout_status: string;
  payment_status: string;
  total_cents: number;
  currency: string;
  crm_deal_id: string | null;
  product: string;
}

/**
 * Minimal, intentionally shallow fulfillment-readiness check — NOT a
 * substitute for the PDF composer's own validation
 * (pdf/composeArticlesOfOrganizationContext.ts), which remains the
 * authority on whether filing_data is complete enough to actually
 * generate Articles of Organization. This only needs to distinguish
 * "structurally absent" (the case Gate 2's own checkout gate — stage !==
 * 'complete' — should already prevent, but this is the payment-side
 * backstop for it) from "present enough to hand to the next stage." Full
 * field-level validation belongs to whatever consumes filing_data next
 * (PDF generation, and eventually Sunbiz transmission), not to this
 * payment-triggered gate.
 */
function isFilingDataFulfillmentReady(filingData: unknown): boolean {
  if (!filingData || typeof filingData !== "object") return false;
  const llcName = (filingData as Record<string, unknown>).llc_name;
  return typeof llcName === "string" && llcName.trim().length > 0;
}

/**
 * Handles one already-signature-verified Stripe event. Never called
 * directly by the route with an unverified payload — see
 * routes/stripeWebhook.ts, where `stripe.webhooks.constructEvent` runs
 * first and this function only ever receives its output.
 *
 * Idempotency: claims `event.id` in stripe_webhook_events (migration
 * 0008) via INSERT ... ON CONFLICT DO NOTHING before any other write.
 * A 0-row claim means this exact event was already processed (by an
 * earlier delivery of the same event.id — Stripe's own retry semantics
 * guarantee the id is stable across redeliveries) — returns immediately,
 * no reprocessing, no duplicate order update, no duplicate CRM call.
 *
 * Payment verification (Gate 2 §5): the embedded session object on the
 * event is NOT trusted for payment_status — this function re-fetches the
 * Checkout Session fresh from Stripe by id (stripeClient.retrieveCheckoutSession)
 * and only proceeds if that live read says `paymentStatus === 'paid'`
 * AND the amount/currency match this service's own order row. The
 * webhook's arrival alone never marks anything paid.
 */
export async function processStripeWebhookEvent(
  pool: Pool,
  stripeClient: StripeCheckoutClient,
  zohoClient: ZohoClient,
  event: Stripe.Event
): Promise<{
  claimed: boolean;
  result?: WebhookProcessingResult;
  orderId?: string;
  fulfillmentStatus?: FulfillmentStatus;
}> {
  const claim = await pool.query<{ id: string }>(
    `INSERT INTO stripe_webhook_events (id, type, payload) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [event.id, event.type, JSON.stringify(event.data.object)]
  );
  if (!claim.rowCount) {
    // A row for this event.id already exists. Two possibilities:
    //  - it was already fully processed (processing_result IS NOT NULL)
    //    -> genuine duplicate delivery, do nothing.
    //  - an earlier attempt claimed it but never finished (e.g. the
    //    Stripe verification lookup threw, below, and this is Stripe's
    //    own retry of the same event.id) -> processing_result IS NULL,
    //    and this attempt should proceed exactly as a fresh claim,
    //    reusing the same row rather than erroring on the PK conflict.
    const { rows } = await pool.query<{ processing_result: string | null }>(
      "SELECT processing_result FROM stripe_webhook_events WHERE id = $1",
      [event.id]
    );
    if (rows[0]?.processing_result != null) {
      return { claimed: false };
    }
    // Fall through — reprocess using the existing (unfinished) row.
  }

  const finish = async (result: WebhookProcessingResult, orderId: string | null) => {
    await pool.query(
      `UPDATE stripe_webhook_events SET processing_result = $2, order_id = $3, processed_at = now() WHERE id = $1`,
      [event.id, result, orderId]
    );
    return { claimed: true, result, orderId: orderId ?? undefined };
  };

  if (event.type !== "checkout.session.completed") {
    // Any other event type is acknowledged (2xx) and ignored — Stripe
    // convention: only 5xx/4xx should trigger a retry, and there's
    // nothing here for us to act on. No order/payment state changes.
    return finish("ignored_unhandled_event_type", null);
  }

  const sessionId = (event.data.object as Stripe.Checkout.Session).id;

  const { rows } = await pool.query<OrderRow>(
    `SELECT order_id, filing_session_id, checkout_status, payment_status, total_cents, currency, crm_deal_id, product
     FROM orders WHERE stripe_checkout_session_id = $1`,
    [sessionId]
  );
  const order = rows[0];
  if (!order) {
    // Unknown order_id (Gate 2 §13.C): never guess or mark an unrelated
    // order paid. Acknowledge the event (retrying won't make a
    // never-created order appear) but record it for manual follow-up.
    return finish("order_not_found", null);
  }

  if (order.payment_status === "paid") {
    // Already paid (e.g. this filing session's order was confirmed by an
    // earlier event with a different event.id — theoretically possible
    // if Stripe ever sent two distinct completed-payment events for the
    // same session, which it doesn't in practice, but this is a cheap,
    // correct extra guard against double-processing regardless of cause).
    return finish("already_paid_noop", order.order_id);
  }

  // Authoritative verification — never trust the embedded event payload
  // for payment state (Gate 2 §5). Re-fetch fresh from Stripe by id.
  let retrieved;
  try {
    retrieved = await stripeClient.retrieveCheckoutSession(sessionId);
  } catch (err) {
    // Could not verify — do NOT mark paid on an unverifiable event.
    // Re-thrown so the route returns 500 and Stripe retries delivery
    // (a transient Stripe-API error here should NOT be treated the same
    // as a legitimate "not paid" — that would risk silently swallowing a
    // real payment). Not marked processed for exactly that reason: the
    // stripe_webhook_events row stays un-finished (order_id/result
    // NULL), which is fine — POST/UPDATE re-runs the same claimed row's
    // follow-up work on a genuine retry, since only the initial INSERT
    // used ON CONFLICT DO NOTHING, not this step.
    throw new Error(`Stripe verification lookup failed: ${describeError(err)}`);
  }

  if (retrieved.paymentStatus !== "paid") {
    // Unpaid/expired Checkout Session (Gate 2 §13.E/F): the order stays
    // exactly as it was — never marked paid on an unconfirmed payment.
    return finish("payment_not_confirmed", order.order_id);
  }

  if (retrieved.amountTotal !== order.total_cents || retrieved.currency !== order.currency) {
    // Defense against catalog drift or a corrupted session — Stripe says
    // paid, but not for the amount/currency this order actually recorded
    // at creation time. Do not mark paid; flag for manual review instead
    // of trusting a mismatched total.
    return finish("amount_or_currency_mismatch", order.order_id);
  }

  // ── Payment confirmed: mark paid AND decide fulfillment readiness,
  // atomically (Sunbiz-fulfillment bridge — DECISIONS.md, "Sunbiz
  // fulfillment bridge"). Both writes, the fulfillment-readiness audit
  // event, and the idempotency ledger's own completion are one
  // transaction. Before this existed, "mark paid" and "log the
  // consequence" were two independent pool.query calls — a crash between
  // them, followed by Stripe's routine redelivery of the same event.id,
  // would hit the already_paid_noop guard above on retry and permanently
  // skip whatever came after the first write, because that guard (by
  // design) never re-examines an order once payment_status = 'paid'.
  // Wrapping the full outcome in one transaction removes that gap: on
  // any failure here, everything rolls back, payment_status is still
  // 'pending', and Stripe's retry reprocesses this event from scratch —
  // exactly the same safe-retry guarantee this function already gives
  // the Stripe-verification-lookup failure above (that path's own
  // comment explains why the stripe_webhook_events row is deliberately
  // left unfinished on failure; the same reasoning applies here).
  const client = await pool.connect();
  let fulfillmentStatus: FulfillmentStatus;
  try {
    await client.query("BEGIN");

    await client.query(`UPDATE orders SET payment_status = 'paid' WHERE order_id = $1`, [order.order_id]);

    // Fulfillment readiness is decided HERE and ONLY here — this is the
    // sole, authoritative chokepoint for orders.fulfillment_status
    // (migration 0010's own comment). filing_data is re-read fresh
    // inside this transaction, with FOR UPDATE, rather than trusting any
    // value read before payment was confirmed — a customer can take
    // arbitrarily long between creating a Checkout Session (which gated
    // on filing_sessions.current_stage = 'complete' at that earlier
    // moment — checkoutService.ts) and actually paying, and FOR UPDATE
    // additionally blocks a concurrent POST /api/session/stage from
    // racing to clear filing_data while this decision is being made.
    const sessionRow = await client.query<{ filing_data: unknown }>(
      `SELECT filing_data FROM filing_sessions WHERE filing_session_id = $1 FOR UPDATE`,
      [order.filing_session_id]
    );
    const filingData = sessionRow.rows[0]?.filing_data ?? null;
    const ready = isFilingDataFulfillmentReady(filingData);
    fulfillmentStatus = ready ? "ready" : "requires_review";

    await client.query(
      `UPDATE orders
       SET fulfillment_status = $2,
           fulfillment_ready_at = CASE WHEN $2 = 'ready' THEN now() ELSE fulfillment_ready_at END
       WHERE order_id = $1`,
      [order.order_id, fulfillmentStatus]
    );

    // Distinct event_type from 'payment_confirmed' below on purpose —
    // this is the fulfillment signal itself, not a restatement of the
    // payment event. An operator (or, later, a fulfillment worker)
    // watching filing_events for 'fulfillment_ready' sees exactly the
    // trigger this task exists to create; 'fulfillment_blocked_missing_filing_data'
    // is the requires_review case's own record of *why*.
    await client.query(
      `INSERT INTO filing_events (filing_session_id, event_type, payload) VALUES ($1, $2, $3)`,
      [
        order.filing_session_id,
        ready ? "fulfillment_ready" : "fulfillment_blocked_missing_filing_data",
        { order_id: order.order_id, stripe_session_id: sessionId },
      ]
    );

    // CRM (Gate 2 §9): Zoho's live account is ZOHOONE_TRIAL_EXPIRED and,
    // separately, Deal-at-checkout was never built (a draft of it was
    // discarded during Gate 2 checkout integration — see
    // GATE2-CHECKOUT-INTEGRATION-STATUS.md §0/§9) — orders.crm_deal_id is
    // therefore always NULL today. Zoho availability is never a
    // prerequisite for the payment confirmation above, which has already
    // been written by this point regardless of what happens below (and
    // commits together with it — a Zoho outage was never on this
    // transaction's critical path before, and still isn't: this block
    // makes no network call, only a plain INSERT recording that no call
    // was made or possible).
    //
    // realZohoClient.syncSession (zoho/client.ts, unmodified by this task)
    // has no "update this specific Deal by id" capability — it only ever
    // creates a new Deal when isPaid is true. Calling it here with a
    // crm_deal_id already set would risk creating a SECOND Deal for the
    // same order, violating the explicit "do not create duplicate Deals"
    // requirement. So: if a crm_deal_id is ever present (dead code today,
    // written for when Deal-at-checkout exists), this deliberately does
    // NOT call syncSession — it records that an update is needed but not
    // yet possible with the current client, rather than faking success or
    // risking a duplicate create.
    const crmResult = order.crm_deal_id
      ? "crm_deal_update_not_implemented" // exists but realZohoClient can't update-by-id yet
      : "no_crm_deal_yet"; // Deal-at-checkout not built — nothing to update
    await client.query(
      `INSERT INTO filing_events (filing_session_id, event_type, payload) VALUES ($1, $2, $3)`,
      [order.filing_session_id, "payment_confirmed", { order_id: order.order_id, stripe_session_id: sessionId, crm_result: crmResult }]
    );

    await client.query(
      `UPDATE stripe_webhook_events SET processing_result = $2, order_id = $3, processed_at = now() WHERE id = $1`,
      [event.id, "paid", order.order_id]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    // Re-thrown, not swallowed — same reasoning as the Stripe-verification
    // failure above: the route returns 500, Stripe retries delivery, and
    // the stripe_webhook_events row (claimed by the INSERT at the top of
    // this function, on the pool, before this transaction began) stays
    // un-finished, so the retry reprocesses this event fully rather than
    // being mistaken for a genuine duplicate.
    throw new Error(`Payment confirmation transaction failed: ${describeError(err)}`);
  } finally {
    client.release();
  }

  return { claimed: true, result: "paid", orderId: order.order_id, fulfillmentStatus };
}
