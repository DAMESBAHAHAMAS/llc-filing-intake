import { Router, type Request } from "express";
import { timingSafeEqual } from "node:crypto";
import { pool } from "../db/pool.js";
import { describeError } from "../db/describeError.js";
import { cancelPaymentIntent, capturePaymentIntent, retrievePaymentIntent, StripeApiError } from "../stripe/restClient.js";
import { holdNoLongerCapturable } from "../payments/holdState.js";
import { enqueueDealUpdate } from "../payments/dealUpdates.js";
import { attemptSavedCardCharge } from "../payments/savedCard.js";
import { requiresPayAfterFiling } from "../offers/payAfterFiling.js";
import { sendOpsAlert } from "../ops/alerts.js";
import { deliverProofToCustomer } from "../proofDelivery/deliverProof.js";
import { isResendableEmailType, listOrderEmails, queueOrderEmail, requeueDeadLetteredEmail } from "../orderEmails/worker.js";

export const ordersRouter = Router();

/**
 * Operator-only endpoints for card holds. Protected by OPERATOR_API_KEY
 * (header x-operator-key). With the key unset, the endpoints refuse every
 * request rather than run unprotected.
 */
function operatorAuthorized(req: Request): boolean {
  const expected = process.env.OPERATOR_API_KEY;
  const given = req.header("x-operator-key");
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface ProofOrder {
  order_id: string;
  filing_session_id: string;
  payment_status: string;
  stripe_payment_intent_id: string | null;
  total_cents: number;
  currency: string;
  deferred_cents?: number | null;
  saved_card_attempts?: number | null;
  saved_card_payment_intent_id?: string | null;
}

/**
 * POST /api/orders/:orderId/proof-of-filing
 * Body: { document_number: string }
 *
 * Records proof of filing (the Sunbiz document number of the filed
 * Articles), delivers it to the customer, and then collects the held
 * payment. This is the only path that collects money on a held order —
 * Damian's rule: the card is not charged until proof of filing is
 * delivered. If delivery fails nothing is collected and the order stays
 * as it was; calling this route again retries from there, and sends the
 * customer nothing further once delivery has succeeded.
 *
 * If the hold can no longer be collected (it expired or was released),
 * the card saved at checkout is charged instead. Either way the order
 * becomes "paid" only when Stripe's own payment_intent.succeeded webhook
 * arrives — this route never marks an order paid itself.
 *
 * If the saved card is declined the customer is emailed to arrange another
 * way to pay and ops is alerted. Calling this route again tries the card
 * again, as a new attempt rather than a replay of the decline.
 *
 * A cancelled order, or one with no filing in it, is refused before
 * anything is recorded.
 */
ordersRouter.post("/api/orders/:orderId/proof-of-filing", async (req, res) => {
  if (!operatorAuthorized(req)) {
    res.status(401).json({ error: "operator key required" });
    return;
  }
  const documentNumber = typeof req.body?.document_number === "string" ? req.body.document_number.trim() : "";
  if (!/^[A-Z0-9-]{4,20}$/i.test(documentNumber)) {
    res.status(400).json({ error: "document_number is required (the Sunbiz document number of the filed Articles; the EIN for an EIN-only order)" });
    return;
  }

  const orderId = req.params.orderId;
  let order: ProofOrder;
  try {
    const existing = await pool.query<{ order_id: string; payment_status: string; line_items: Array<{ offer_code?: string }> | null; cancelled_at: Date | null }>(
      `SELECT order_id, payment_status, line_items, cancelled_at FROM orders WHERE order_id = $1`,
      [orderId]
    );
    if (!existing.rows.length) {
      res.status(404).json({ error: "order not found" });
      return;
    }
    if (existing.rows[0].cancelled_at) {
      res.status(409).json({ error: "order is cancelled; nothing is filed or collected", order_id: orderId });
      return;
    }
    if (!requiresPayAfterFiling(existing.rows[0].line_items ?? [])) {
      res.status(409).json({ error: "order includes no filing", order_id: orderId });
      return;
    }
    const { rows } = await pool.query<ProofOrder>(
      `UPDATE orders
       SET proof_of_filing_ref = COALESCE(proof_of_filing_ref, $2), proof_of_filing_at = COALESCE(proof_of_filing_at, now())
       WHERE order_id = $1
       RETURNING order_id, filing_session_id, payment_status, stripe_payment_intent_id, total_cents, currency,
                 deferred_cents, saved_card_attempts, saved_card_payment_intent_id`,
      [orderId, documentNumber]
    );
    order = rows[0];
  } catch (err) {
    res.status(500).json({ error: "could not record proof of filing", detail: describeError(err) });
    return;
  }

  if (order.payment_status === "paid") {
    // Already collected, so nothing depends on this send; the customer still gets their proof.
    const delivery = await deliverProofToCustomer(pool, order.order_id);
    if (!delivery.ok) await alertProofNotDelivered(order.order_id, delivery.error);
    res.status(200).json({ order_id: order.order_id, status: "already_paid", proof_delivered: delivery.ok });
    return;
  }
  if (!["authorized", "released"].includes(order.payment_status) || !order.stripe_payment_intent_id) {
    res.status(409).json({ error: `order payment_status is ${order.payment_status}; nothing held to collect`, order_id: order.order_id });
    return;
  }

  const delivery = await deliverProofToCustomer(pool, order.order_id);
  if (!delivery.ok) {
    await alertProofNotDelivered(order.order_id, delivery.error);
    res.status(502).json({ error: "proof of filing was not delivered to the customer; nothing was collected", detail: delivery.error, order_id: order.order_id });
    return;
  }

  // Services delivered after the filing (EIN) stay uncollected here; they
  // are charged when complete (POST /api/orders/:id/service-complete).
  const deferred = Math.max(0, Number(order.deferred_cents ?? 0));
  const collectNowCents = order.total_cents - deferred;

  // Stripe's own word that the authorization expired, even if the
  // PaymentIntent has not yet moved to canceled.
  let holdExpired = false;
  if (order.payment_status === "authorized") {
    try {
      const captured =
        deferred > 0
          ? await capturePaymentIntent(order.stripe_payment_intent_id, `capture-${order.order_id}`, collectNowCents)
          : await capturePaymentIntent(order.stripe_payment_intent_id, `capture-${order.order_id}`);
      res.status(200).json({
        order_id: order.order_id,
        status: "collection_requested",
        payment_intent_status: captured.status,
        collected_cents: collectNowCents,
        deferred_cents: deferred,
      });
      return;
    } catch (err) {
      const code = err instanceof StripeApiError ? (err.stripeError as { code?: string } | undefined)?.code : undefined;
      if (!holdNoLongerCapturable(code)) {
        await recordCaptureError(order.order_id, err);
        res.status(502).json({ error: "collection failed", detail: describeError(err), order_id: order.order_id });
        return;
      }
      // Hold expired or released, or already captured — checked below.
      holdExpired = code === "charge_expired_for_capture";
    }
  }

  if (order.saved_card_payment_intent_id) {
    res.status(200).json({ order_id: order.order_id, status: "saved_card_charged", payment_intent: order.saved_card_payment_intent_id });
    return;
  }

  let original;
  try {
    original = await retrievePaymentIntent(order.stripe_payment_intent_id);
  } catch (err) {
    await recordCaptureError(order.order_id, err);
    res.status(502).json({ error: "saved-card charge failed", detail: describeError(err), order_id: order.order_id });
    return;
  }

  // Stripe gives the same error for an expired hold and one already
  // captured, for example after a lost response more than a day ago, once
  // the idempotency key has gone. Charging the card then would be a second
  // charge, so the saved card is used only when the hold really ended.
  if (original.status === "succeeded") {
    res.status(200).json({ order_id: order.order_id, status: "collection_requested", payment_intent_status: original.status });
    return;
  }
  if (original.status !== "canceled" && !holdExpired) {
    const err = new Error(`the hold is in state ${original.status}, so it was neither collected nor released`);
    await recordCaptureError(order.order_id, err);
    res.status(502).json({ error: "collection failed", detail: describeError(err), order_id: order.order_id });
    return;
  }

  const attempt = await attemptSavedCardCharge({
    original,
    orderId: order.order_id,
    prefix: "fallback",
    declinedAttempts: order.saved_card_attempts ?? 0,
    amountCents: collectNowCents,
    currency: order.currency || "usd",
    metadata: { order_id: order.order_id, reason: "hold_expired_before_proof_of_filing" },
  });

  if (attempt.kind === "charged") {
    await pool.query(`UPDATE orders SET saved_card_payment_intent_id = $2, capture_error = NULL WHERE order_id = $1`, [order.order_id, attempt.paymentIntentId]);
    res.status(200).json({ order_id: order.order_id, status: "saved_card_charged", payment_intent_status: attempt.status, collected_cents: collectNowCents, deferred_cents: deferred });
    return;
  }
  if (attempt.kind === "declined") {
    await pool.query(`UPDATE orders SET saved_card_attempts = saved_card_attempts + 1, capture_error = $2 WHERE order_id = $1`, [order.order_id, attempt.detail]);
    const customerEmailed = await askCustomerToArrangePayment(order, collectNowCents, "fallback");
    await sendOpsAlert(
      "Saved card declined after filing",
      `Order ${order.order_id}: ${attempt.detail}. Proof of filing is delivered and the card was not charged. ${customerEmailed ? "The customer has been emailed to arrange payment." : "The customer email could not be queued."} Calling proof of filing again retries the card.`
    );
    res.status(502).json({ error: "saved-card charge failed", status: "saved_card_declined", detail: attempt.detail, order_id: order.order_id, customer_emailed: customerEmailed });
    return;
  }
  await recordCaptureError(order.order_id, new Error(attempt.detail));
  res.status(502).json({ error: "saved-card charge failed", detail: attempt.detail, order_id: order.order_id });
});

/**
 * POST /api/orders/:orderId/service-complete
 * Body: { service_ref: string }  (for an EIN: the EIN itself)
 *
 * Charges the part of a formation order that was deferred until a
 * post-filing service was complete (Damian, 2 Oct 2026: "Services such as
 * EIN filing are charged when that service is complete, using the card you
 * checked out with"). Only after the formation part has been collected, so
 * nothing is ever charged before the LLC is filed. Charged once: the
 * idempotency key is per order, and a recorded charge is never repeated.
 */
ordersRouter.post("/api/orders/:orderId/service-complete", async (req, res) => {
  if (!operatorAuthorized(req)) {
    res.status(401).json({ error: "operator key required" });
    return;
  }
  const serviceRef = typeof req.body?.service_ref === "string" ? req.body.service_ref.trim() : "";
  if (!/^[A-Z0-9-]{4,20}$/i.test(serviceRef)) {
    res.status(400).json({ error: "service_ref is required (for an EIN, the EIN that was issued)" });
    return;
  }
  const orderId = req.params.orderId;
  let order: {
    order_id: string;
    payment_status: string;
    stripe_payment_intent_id: string | null;
    deferred_cents: number;
    deferred_payment_intent_id: string | null;
    deferred_attempts: number;
    filing_session_id: string;
    currency: string;
  };
  try {
    const { rows } = await pool.query(
      `SELECT order_id, payment_status, stripe_payment_intent_id, deferred_cents, deferred_payment_intent_id, deferred_attempts, filing_session_id, currency
       FROM orders WHERE order_id = $1`,
      [orderId]
    );
    if (!rows.length) {
      res.status(404).json({ error: "order not found" });
      return;
    }
    order = rows[0];
  } catch (err) {
    res.status(500).json({ error: "could not read order", detail: describeError(err) });
    return;
  }

  if (!order.deferred_cents || order.deferred_cents <= 0) {
    res.status(409).json({ error: "order has no deferred service charge", order_id: order.order_id });
    return;
  }
  if (order.deferred_payment_intent_id) {
    res.status(200).json({ order_id: order.order_id, status: "already_requested", payment_intent: order.deferred_payment_intent_id });
    return;
  }
  if (order.payment_status !== "paid" || !order.stripe_payment_intent_id) {
    res.status(409).json({
      error: `formation part not yet collected (payment_status ${order.payment_status}); record proof of filing first`,
      order_id: order.order_id,
    });
    return;
  }

  let original;
  try {
    original = await retrievePaymentIntent(order.stripe_payment_intent_id);
  } catch (err) {
    await failServiceCharge(order.order_id, serviceRef, describeError(err));
    res.status(502).json({ error: "service charge failed", detail: describeError(err), order_id: order.order_id });
    return;
  }

  // The service reference is an EIN for this service, so it stays out of
  // Stripe metadata and out of ops alerts.
  const attempt = await attemptSavedCardCharge({
    original,
    orderId: order.order_id,
    prefix: "deferred",
    declinedAttempts: order.deferred_attempts ?? 0,
    amountCents: order.deferred_cents,
    currency: order.currency || "usd",
    metadata: { order_id: order.order_id, kind: "deferred_service" },
  });

  if (attempt.kind === "charged") {
    await pool.query(
      `UPDATE orders SET deferred_service_ref = $2, deferred_payment_intent_id = $3, deferred_requested_at = now(), deferred_charge_error = NULL
       WHERE order_id = $1`,
      [order.order_id, serviceRef, attempt.paymentIntentId]
    );
    res.status(200).json({ order_id: order.order_id, status: "deferred_service_charged", payment_intent_status: attempt.status, amount_cents: order.deferred_cents });
    return;
  }

  await failServiceCharge(order.order_id, serviceRef, attempt.detail);
  if (attempt.kind === "declined") {
    await pool.query(`UPDATE orders SET deferred_attempts = deferred_attempts + 1 WHERE order_id = $1`, [order.order_id]);
    const customerEmailed = await askCustomerToArrangePayment(order, order.deferred_cents, "deferred");
    res.status(502).json({ error: "service charge failed", status: "saved_card_declined", detail: attempt.detail, order_id: order.order_id, customer_emailed: customerEmailed });
    return;
  }
  res.status(502).json({ error: "service charge failed", detail: attempt.detail, order_id: order.order_id });
});

/** POST /api/orders/:orderId/release-hold — cancels a hold without collecting. */
ordersRouter.post("/api/orders/:orderId/release-hold", async (req, res) => {
  if (!operatorAuthorized(req)) {
    res.status(401).json({ error: "operator key required" });
    return;
  }
  try {
    const { rows } = await pool.query(`SELECT order_id, payment_status, stripe_payment_intent_id FROM orders WHERE order_id = $1`, [
      req.params.orderId,
    ]);
    if (!rows.length) {
      res.status(404).json({ error: "order not found" });
      return;
    }
    const order = rows[0];
    if (order.payment_status !== "authorized" || !order.stripe_payment_intent_id) {
      res.status(409).json({ error: `order payment_status is ${order.payment_status}; no hold to release` });
      return;
    }
    const cancelled = await cancelPaymentIntent(order.stripe_payment_intent_id, `release-${order.order_id}`);
    res.status(200).json({ order_id: order.order_id, status: "release_requested", payment_intent_status: cancelled.status });
  } catch (err) {
    res.status(502).json({ error: "release failed", detail: describeError(err) });
  }
});

/**
 * POST /api/orders/:orderId/cancel
 * Body: { reason?: string }
 *
 * The customer cancelled, or the filing cannot go ahead: "You can cancel
 * any time until we submit your filing. We release any hold still in place
 * and you pay nothing." The order is marked first, so nothing can file it
 * or charge its saved card while the hold is being released, and calling
 * again retries a release that failed. Refused once the filing is
 * submitted or recorded, and on an order already paid, which is a refund.
 */
ordersRouter.post("/api/orders/:orderId/cancel", async (req, res) => {
  if (!operatorAuthorized(req)) {
    res.status(401).json({ error: "operator key required" });
    return;
  }
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";
  try {
    const { rows } = await pool.query<{
      order_id: string;
      filing_session_id: string;
      payment_status: string;
      fulfillment_status: string;
      stripe_payment_intent_id: string | null;
      proof_of_filing_at: Date | null;
      cancelled_at: Date | null;
      crm_deal_id: string | null;
    }>(
      `SELECT order_id, filing_session_id, payment_status, fulfillment_status, stripe_payment_intent_id, proof_of_filing_at, cancelled_at, crm_deal_id
       FROM orders WHERE order_id = $1`,
      [req.params.orderId]
    );
    if (!rows.length) {
      res.status(404).json({ error: "order not found" });
      return;
    }
    const order = rows[0];
    if (order.proof_of_filing_at || order.fulfillment_status === "transmitted") {
      res.status(409).json({ error: "the filing has been submitted, so this order can no longer be cancelled", order_id: order.order_id });
      return;
    }
    if (!["authorized", "released"].includes(order.payment_status)) {
      res.status(409).json({ error: `order payment_status is ${order.payment_status}; no hold to cancel`, order_id: order.order_id });
      return;
    }

    if (!order.cancelled_at) {
      await pool.query(`UPDATE orders SET cancelled_at = now(), cancellation_reason = $2, fulfillment_status = 'not_ready' WHERE order_id = $1`, [
        order.order_id,
        reason || null,
      ]);
      await pool.query(`UPDATE registered_agent_acceptances SET status = 'expired' WHERE filing_session_id = $1 AND status = 'acceptance_requested'`, [
        order.filing_session_id,
      ]);
      await enqueueDealUpdate(pool as never, order, {
        target_stage: process.env.ZOHO_DEAL_STAGE_ON_REFUND || "Closed Lost",
        extra_fields: { Payment_Status: "Hold Released" },
      });
      await queueOrderEmail(pool, {
        orderId: order.order_id,
        filingSessionId: order.filing_session_id,
        emailTypes: ["order_cancelled"],
        paymentMode: "hold",
      });
      await sendOpsAlert("Order cancelled", `Order ${order.order_id}${reason ? `: ${reason}` : ""}. Any hold is released and the customer pays nothing.`);
    }

    if (order.payment_status === "authorized" && order.stripe_payment_intent_id) {
      try {
        await cancelPaymentIntent(order.stripe_payment_intent_id, `release-${order.order_id}`);
      } catch (err) {
        const code = err instanceof StripeApiError ? (err.stripeError as { code?: string } | undefined)?.code : undefined;
        if (!holdNoLongerCapturable(code)) {
          await sendOpsAlert("Hold not released", `Order ${order.order_id} is cancelled, but its hold was not released: ${describeError(err)}. Call cancel again to retry.`);
          res.status(502).json({ error: "order cancelled, but the hold was not released", detail: describeError(err), order_id: order.order_id });
          return;
        }
      }
    }
    res.status(200).json({ order_id: order.order_id, status: "cancelled" });
  } catch (err) {
    res.status(500).json({ error: "cancel failed", detail: describeError(err) });
  }
});

/** GET /api/orders/:orderId/emails — what was sent to the customer, what failed and why. */
ordersRouter.get("/api/orders/:orderId/emails", async (req, res) => {
  if (!operatorAuthorized(req)) {
    res.status(401).json({ error: "operator key required" });
    return;
  }
  try {
    res.status(200).json({ order_id: req.params.orderId, emails: await listOrderEmails(pool, req.params.orderId) });
  } catch (err) {
    res.status(500).json({ error: "email lookup failed", detail: describeError(err) });
  }
});

/**
 * POST /api/orders/:orderId/emails/:emailType/resend
 *
 * Puts a dead-lettered customer email back in the queue, for example once
 * Resend is healthy again or a bad address has been fixed. The filing
 * confirmation is not queued: the proof-of-filing route retries it.
 */
ordersRouter.post("/api/orders/:orderId/emails/:emailType/resend", async (req, res) => {
  if (!operatorAuthorized(req)) {
    res.status(401).json({ error: "operator key required" });
    return;
  }
  const { orderId, emailType } = req.params;
  if (emailType === "filing_confirmation") {
    res.status(409).json({ error: "the filing confirmation is not queued; call POST /api/orders/:orderId/proof-of-filing again to retry it" });
    return;
  }
  if (!isResendableEmailType(emailType)) {
    res.status(400).json({ error: "unknown email type" });
    return;
  }
  try {
    const requeued = await requeueDeadLetteredEmail(pool, orderId, emailType);
    if (!requeued) {
      res.status(409).json({ error: `no dead-lettered ${emailType} email on this order` });
      return;
    }
    res.status(200).json({ order_id: orderId, email_type: emailType, status: "queued", requeued });
  } catch (err) {
    res.status(500).json({ error: "email resend failed", detail: describeError(err) });
  }
});

async function askCustomerToArrangePayment(
  order: { order_id: string; filing_session_id: string },
  amountCents: number,
  chargeKind: "fallback" | "deferred"
): Promise<boolean> {
  const { queued } = await queueOrderEmail(pool, {
    orderId: order.order_id,
    filingSessionId: order.filing_session_id,
    emailTypes: ["payment_problem"],
    paymentMode: "hold",
    dedupeKey: chargeKind,
    details: { amount_cents: amountCents, charge_kind: chargeKind },
  });
  return queued;
}

async function failServiceCharge(orderId: string, serviceRef: string, detail: string): Promise<void> {
  await pool
    .query(`UPDATE orders SET deferred_charge_error = $2, deferred_service_ref = COALESCE(deferred_service_ref, $3) WHERE order_id = $1`, [
      orderId,
      detail.slice(0, 500),
      serviceRef,
    ])
    .catch(() => undefined);
  await sendOpsAlert(`Service charge failed: order ${orderId}`, `Charging the saved card for the completed service failed: ${detail}. The customer has not been charged for it.`);
}

async function alertProofNotDelivered(orderId: string, reason: string): Promise<void> {
  console.error(`[payments] proof of filing not delivered for order ${orderId}: ${reason}`);
  await sendOpsAlert("Proof of filing not delivered", `Order ${orderId}: ${reason}. Proof of filing is recorded. A held payment stays uncollected until delivery succeeds; call the proof-of-filing endpoint again to retry.`);
}

async function recordCaptureError(orderId: string, err: unknown): Promise<void> {
  try {
    await pool.query(`UPDATE orders SET capture_error = $2 WHERE order_id = $1`, [orderId, describeError(err)]);
  } catch (e) {
    console.error(`[payments] could not record capture error for ${orderId}:`, describeError(e));
  }
  console.error(`[payments] collection problem on order ${orderId}:`, describeError(err));
  await sendOpsAlert("Payment could not be collected", `Order ${orderId}: ${describeError(err)}. Proof of filing is recorded; the card was not charged.`);
}
