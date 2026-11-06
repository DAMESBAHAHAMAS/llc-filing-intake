import { Router, type Request } from "express";
import { timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";
import { describeError } from "../db/describeError.js";
import { cancelPaymentIntent, capturePaymentIntent, placeReplacementHold, retrievePaymentIntent, StripeApiError } from "../stripe/restClient.js";
import { holdNoLongerCapturable } from "../payments/holdState.js";
import { enqueueDealUpdate } from "../payments/dealUpdates.js";
import { attemptSavedCardCharge } from "../payments/savedCard.js";
import { requiresPayAfterFiling } from "../offers/payAfterFiling.js";
import { needsSunbizFiling } from "../offers/sunbizFiling.js";
import { findFilingBlocker } from "../fulfillment/filingGate.js";
import { hasDiyPackage } from "../offers/diyPackage.js";
import { isLiveTestOrder } from "../offers/liveTest.js";
import { orderIsLiveTest } from "../offers/liveTestSeal.js";
import { approvalCurrent, clearanceFor, sameEntityName } from "../payments/filingClearance.js";
import { isFloridaLlcDocumentNumber } from "../payments/documentNumber.js";
import { buildPdfContext } from "../pdf/context.js";
import { generateArticlesOfOrganizationPdf } from "../pdf/serviceClient.js";
import type { FilingSessionRecord } from "../pdf/types.js";
import { sendOpsAlert } from "../ops/alerts.js";
import { deliverProofToCustomer } from "../proofDelivery/deliverProof.js";
import { isResendableEmailType, listOrderEmails, queueOrderEmail, requeueDeadLetteredEmail } from "../orderEmails/worker.js";

export const ordersRouter = Router();

/**
 * Operator-only endpoints for card holds. Protected by OPERATOR_API_KEY
 * (header x-operator-key). With the key unset, the endpoints refuse every
 * request rather than run unprotected.
 */
export function operatorAuthorized(req: Request): boolean {
  const expected = process.env.OPERATOR_API_KEY;
  const given = req.header("x-operator-key");
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A live test files nothing, so there is no filing confirmation to send. */
const NO_PROOF_EMAIL_FOR_LIVE_TEST = { ok: true, alreadyDelivered: false } as const;

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
 * anything is recorded. So is a Sunbiz filing that was not submitted, whose
 * customer agent has not accepted, or whose Articles do not exist: a document
 * number can only be real for a filing that went to Florida.
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
  let liveTest = false;
  try {
    const existing = await pool.query<{
      order_id: string;
      filing_session_id: string;
      payment_status: string;
      line_items: Array<{ offer_code?: string }> | null;
      cancelled_at: Date | null;
      fulfillment_status: string;
      sunbiz_tracking_number: string | null;
      proof_of_filing_ref: string | null;
    }>(
      `SELECT order_id, filing_session_id, payment_status, line_items, cancelled_at, fulfillment_status, sunbiz_tracking_number, proof_of_filing_ref FROM orders WHERE order_id = $1`,
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
    liveTest = isLiveTestOrder(existing.rows[0].line_items);
    if (existing.rows[0].proof_of_filing_ref && existing.rows[0].proof_of_filing_ref.toUpperCase() !== documentNumber.toUpperCase()) {
      res.status(409).json({ error: "a different document number is already recorded on this order; it was not changed", code: "document_number_differs", recorded: existing.rows[0].proof_of_filing_ref, order_id: orderId });
      return;
    }
    if (!["authorized", "released", "paid"].includes(existing.rows[0].payment_status)) {
      res.status(409).json({ error: `order payment_status is ${existing.rows[0].payment_status}; nothing held to collect`, order_id: orderId });
      return;
    }
    // After a released test hold there is nothing to collect: the fallback
    // below would be an off-session charge of a test card.
    if (liveTest && existing.rows[0].payment_status === "released") {
      res.status(409).json({ error: "this test hold is released; a test is never charged to the saved card", code: "live_test_released", order_id: orderId });
      return;
    }
    if (!requiresPayAfterFiling(existing.rows[0].line_items ?? [])) {
      res.status(409).json({ error: "order includes no filing", order_id: orderId });
      return;
    }
    if (needsSunbizFiling(existing.rows[0].line_items ?? [])) {
      const filing = existing.rows[0];
      if (filing.fulfillment_status === "rejected") {
        res.status(409).json({ error: "Florida rejected this filing; record the resubmission first", code: "filing_rejected", order_id: orderId });
        return;
      }
      if (filing.fulfillment_status !== "transmitted") {
        res.status(409).json({ error: "this filing has not been submitted to Sunbiz", code: "filing_not_submitted", order_id: orderId });
        return;
      }
      const blocker = await findFilingBlocker(pool, filing);
      if (blocker) {
        res.status(409).json({ ...blocker, order_id: orderId });
        return;
      }
      // A person read this on Florida's record: it must be this order's LLC.
      if (hasDiyPackage(filing.line_items ?? [])) {
        const named = await pool.query<{ entity_name_primary: string | null; filing_data: { llc_name?: string } | null }>(
          `SELECT entity_name_primary, filing_data FROM filing_sessions WHERE filing_session_id = $1`,
          [filing.filing_session_id]
        );
        const verifiedName = typeof req.body?.verified_entity_name === "string" ? req.body.verified_entity_name : "";
        const expected = named.rows[0]?.entity_name_primary ?? named.rows[0]?.filing_data?.llc_name;
        if (!sameEntityName(verifiedName, expected)) {
          res.status(400).json({ error: "verified_entity_name must be the name Sunbiz shows for this document number, and match this order", code: "entity_name_not_verified", order_id: orderId });
          return;
        }
      }
      // The card is charged on this value, so it has to be what Florida issues.
      if (!isFloridaLlcDocumentNumber(documentNumber)) {
        res.status(400).json({ error: "document_number must be the Florida LLC document number, such as L26000123456", code: "document_number_invalid", order_id: orderId });
        return;
      }
      const reused = hasDiyPackage(filing.line_items ?? [])
        ? await pool.query(`SELECT 1 FROM orders WHERE upper(proof_of_filing_ref) = $1 AND order_id <> $2 LIMIT 1`, [documentNumber.toUpperCase(), orderId])
        : { rowCount: 0 };
      if (reused.rowCount) {
        res.status(409).json({ error: "this document number is already recorded on another order", code: "document_number_used", order_id: orderId });
        return;
      }
      if (filing.sunbiz_tracking_number && filing.sunbiz_tracking_number.toUpperCase() === documentNumber.toUpperCase()) {
        res.status(400).json({ error: "that is the Sunbiz tracking number, not the document number", code: "document_number_is_tracking_number", order_id: orderId });
        return;
      }
    }
    const { rows } = await pool.query<ProofOrder>(
      `UPDATE orders
       SET proof_of_filing_ref = COALESCE(proof_of_filing_ref, $2), proof_of_filing_at = COALESCE(proof_of_filing_at, now()),
           fulfillment_completed_at = COALESCE(fulfillment_completed_at, now())
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
    const delivery = liveTest ? NO_PROOF_EMAIL_FOR_LIVE_TEST : await deliverProofToCustomer(pool, order.order_id);
    if (!delivery.ok) await alertProofNotDelivered(order.order_id, delivery.error);
    res.status(200).json({ order_id: order.order_id, status: "already_paid", proof_delivered: delivery.ok });
    return;
  }
  if (!["authorized", "released"].includes(order.payment_status) || !order.stripe_payment_intent_id) {
    res.status(409).json({ error: `order payment_status is ${order.payment_status}; nothing held to collect`, order_id: order.order_id });
    return;
  }

  const delivery = liveTest ? NO_PROOF_EMAIL_FOR_LIVE_TEST : await deliverProofToCustomer(pool, order.order_id);
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
          ? await capturePaymentIntent(order.stripe_payment_intent_id, `capture-${order.order_id}-${order.stripe_payment_intent_id}`, collectNowCents)
          : await capturePaymentIntent(order.stripe_payment_intent_id, `capture-${order.order_id}-${order.stripe_payment_intent_id}`);
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
        const customerEmailed = await recordCaptureError(order, err, collectNowCents);
        res.status(502).json({ error: "collection failed", detail: describeError(err), order_id: order.order_id, customer_emailed: customerEmailed });
        return;
      }
      // Hold expired or released, or already captured — checked below.
      holdExpired = code === "charge_expired_for_capture";
    }
  }

  if (liveTest) {
    res.status(409).json({ error: "the test hold could not be captured; a test is never charged to the saved card", code: "live_test_not_captured", order_id: order.order_id });
    return;
  }

  if (order.saved_card_payment_intent_id) {
    res.status(200).json({ order_id: order.order_id, status: "saved_card_charged", payment_intent: order.saved_card_payment_intent_id });
    return;
  }

  let original;
  try {
    original = await retrievePaymentIntent(order.stripe_payment_intent_id);
  } catch (err) {
    const customerEmailed = await recordCaptureError(order, err, collectNowCents);
    res.status(502).json({ error: "saved-card charge failed", detail: describeError(err), order_id: order.order_id, customer_emailed: customerEmailed });
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
    const customerEmailed = await recordCaptureError(order, err, collectNowCents);
    res.status(502).json({ error: "collection failed", detail: describeError(err), order_id: order.order_id, customer_emailed: customerEmailed });
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
  const customerEmailed = await recordCaptureError(order, new Error(attempt.detail), collectNowCents);
  res.status(502).json({ error: "saved-card charge failed", detail: attempt.detail, order_id: order.order_id, customer_emailed: customerEmailed });
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
    deferred_charged_at: Date | null;
    deferred_attempts: number;
    filing_session_id: string;
    currency: string;
  };
  try {
    const { rows } = await pool.query(
      `SELECT order_id, payment_status, stripe_payment_intent_id, deferred_cents, deferred_payment_intent_id, deferred_charged_at, deferred_attempts, filing_session_id, currency
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
  // Paid some other way, so the saved card is off the order.
  if (order.deferred_charged_at) {
    res.status(200).json({ order_id: order.order_id, status: "already_paid" });
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
    const customerEmailed = await askCustomerToArrangePayment(order, order.deferred_cents, "deferred");
    res.status(502).json({ error: "service charge failed", detail: describeError(err), order_id: order.order_id, customer_emailed: customerEmailed });
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
  const customerEmailed = await askCustomerToArrangePayment(order, order.deferred_cents, "deferred");
  if (attempt.kind === "declined") {
    await pool.query(`UPDATE orders SET deferred_attempts = deferred_attempts + 1 WHERE order_id = $1`, [order.order_id]);
    res.status(502).json({ error: "service charge failed", status: "saved_card_declined", detail: attempt.detail, order_id: order.order_id, customer_emailed: customerEmailed });
    return;
  }
  res.status(502).json({ error: "service charge failed", detail: attempt.detail, order_id: order.order_id, customer_emailed: customerEmailed });
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
 * submitted, because Damian has paid Florida by then, and on an order already
 * paid, which is a refund.
 *
 * A rejected filing is the exception: it is back with us, and this is how a
 * customer who won't correct it, or a filing that can't be filed, closes:
 * "we release any hold still in place and you pay nothing." The saved card
 * comes off at the next card sweep.
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
      sunbiz_rejected_at: Date | null;
    }>(
      `SELECT order_id, filing_session_id, payment_status, fulfillment_status, stripe_payment_intent_id, proof_of_filing_at, cancelled_at, crm_deal_id, sunbiz_rejected_at
       FROM orders WHERE order_id = $1`,
      [req.params.orderId]
    );
    if (!rows.length) {
      res.status(404).json({ error: "order not found" });
      return;
    }
    const order = rows[0];
    if (order.proof_of_filing_at || order.fulfillment_status === "transmitted") {
      res.status(409).json({ error: "the filing has been submitted, so this order can no longer be cancelled", code: "filing_submitted", order_id: order.order_id });
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
      const stateRefund = order.sunbiz_rejected_at ? " Florida rejected this filing, so request the state refund." : "";
      await sendOpsAlert("Order cancelled", `Order ${order.order_id}${reason ? `: ${reason}` : ""}. Any hold is released and the customer pays nothing.${stateRefund}`);
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

interface FilingStateOrder {
  order_id: string;
  filing_session_id: string;
  payment_status: string;
  fulfillment_status: string;
  line_items: Array<{ offer_code?: string }> | null;
  cancelled_at: Date | null;
  proof_of_filing_at: Date | null;
  sunbiz_tracking_number: string | null;
  sunbiz_submitted_at: Date | null;
  sunbiz_resubmitted_at: Date | null;
  filing_approved_at: Date | null;
  sunbiz_rejected_at: Date | null;
  sunbiz_rejection_reason: string | null;
  sunbiz_rejection_count: number;
}

const FILING_STATE_COLUMNS = `order_id, filing_session_id, payment_status, fulfillment_status, line_items, cancelled_at, proof_of_filing_at, filing_approved_at,
       sunbiz_tracking_number, sunbiz_submitted_at, sunbiz_resubmitted_at, sunbiz_rejected_at, sunbiz_rejection_reason, sunbiz_rejection_count`;

/** Sunbiz tracking numbers are digits today. Any plain reference fits, so a format change at Sunbiz doesn't stop an order. */
const TRACKING_NUMBER = /^[A-Z0-9-]{4,30}$/i;

const FILABLE_PAYMENT = ["authorized", "released", "paid"];
const DAYS_TO_KEEP_FILING_DATE = 60;

type Refusal = { status: number; body: Record<string, unknown> };

/** A $139 order goes to Florida only on a capturable hold a person cleared. */
function clearanceRefusal(order: FilingStateOrder): Refusal | null {
  if (!hasDiyPackage(order.line_items ?? [])) return null;
  if (order.payment_status !== "authorized") {
    return { status: 409, body: { error: `payment_status is ${order.payment_status}; there is no hold to file on`, code: "hold_not_capturable", order_id: order.order_id } };
  }
  if (!approvalCurrent(order.filing_approved_at, new Date())) {
    return { status: 409, body: { error: "approve this filing first, so Stripe is checked before Florida is paid", code: "filing_not_approved", order_id: order.order_id } };
  }
  return null;
}

/** What stops any filing step on this order, before its own state is looked at. */
function filingRefusal(order: FilingStateOrder): Refusal | null {
  if (order.cancelled_at) return { status: 409, body: { error: "order is cancelled; nothing is filed or collected", code: "order_cancelled", order_id: order.order_id } };
  if (!needsSunbizFiling(order.line_items ?? [])) return { status: 409, body: { error: "order includes no Sunbiz filing", order_id: order.order_id } };
  if (!FILABLE_PAYMENT.includes(order.payment_status)) {
    return { status: 409, body: { error: `order payment_status is ${order.payment_status}; it cannot be filed`, order_id: order.order_id } };
  }
  if (order.proof_of_filing_at) return { status: 409, body: { error: "Florida has already confirmed this filing", code: "filing_confirmed", order_id: order.order_id } };
  return null;
}

/**
 * Runs `step` with the order's row locked, so a filing step and a cancel
 * cannot pass each other. The step commits by returning a value, or leaves
 * the order untouched by returning a refusal.
 */
async function withLockedOrder(
  orderId: string,
  step: (client: PoolClient, order: FilingStateOrder) => Promise<Refusal | { ok: true; body: Record<string, unknown> }>
): Promise<Refusal | { ok: true; body: Record<string, unknown> }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<FilingStateOrder>(`SELECT ${FILING_STATE_COLUMNS} FROM orders WHERE order_id = $1 FOR UPDATE`, [orderId]);
    if (!rows.length) {
      await client.query("ROLLBACK");
      return { status: 404, body: { error: "order not found" } };
    }
    const outcome = await step(client, rows[0]);
    await client.query("ok" in outcome ? "COMMIT" : "ROLLBACK");
    return outcome;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function filingEvent(client: PoolClient, order: FilingStateOrder, eventType: string, payload: Record<string, unknown>): Promise<void> {
  await client.query(`INSERT INTO filing_events (filing_session_id, event_type, payload) VALUES ($1, $2, $3)`, [
    order.filing_session_id,
    eventType,
    JSON.stringify({ order_id: order.order_id, ...payload }),
  ]);
}

/**
 * POST /api/orders/:orderId/approve-filing
 *
 * The step before Damian pays Florida. It asks Stripe, not the order row,
 * whether the hold can be captured and for how long, and refuses a second
 * filing of the same LLC. Submission needs this approval, less than 24 hours
 * old. Its answer also records the hold's real deadline.
 */
ordersRouter.post("/api/orders/:orderId/approve-filing", async (req, res) => {
  if (!operatorAuthorized(req)) {
    res.status(401).json({ error: "operator key required" });
    return;
  }
  try {
    const { rows } = await pool.query<FilingStateOrder & { stripe_payment_intent_id: string | null; total_cents: number; entity_name_primary: string | null }>(
      `SELECT o.order_id, o.filing_session_id, o.payment_status, o.fulfillment_status, o.line_items, o.cancelled_at, o.proof_of_filing_at, o.filing_approved_at,
              o.sunbiz_tracking_number, o.sunbiz_submitted_at, o.sunbiz_resubmitted_at, o.sunbiz_rejected_at, o.sunbiz_rejection_reason, o.sunbiz_rejection_count,
              o.stripe_payment_intent_id, o.total_cents, fs.entity_name_primary
       FROM orders o JOIN filing_sessions fs ON fs.filing_session_id = o.filing_session_id WHERE o.order_id = $1`,
      [req.params.orderId]
    );
    const order = rows[0];
    if (!order) {
      res.status(404).json({ error: "order not found" });
      return;
    }
    const refused = filingRefusal(order);
    if (refused) {
      res.status(refused.status).json(refused.body);
      return;
    }
    if (!hasDiyPackage(order.line_items ?? [])) {
      res.status(409).json({ error: "this approval is for DIY_PACKAGE orders", code: "not_a_diy_package", order_id: order.order_id });
      return;
    }
    if (order.payment_status !== "authorized" || !order.stripe_payment_intent_id) {
      res.status(409).json({ error: `payment_status is ${order.payment_status}; there is no hold to file on`, code: "hold_not_capturable", order_id: order.order_id });
      return;
    }
    const duplicate = await pool.query<{ order_id: string }>(
      `SELECT o.order_id FROM orders o JOIN filing_sessions fs ON fs.filing_session_id = o.filing_session_id
        WHERE o.order_id <> $1 AND o.sunbiz_submitted_at IS NOT NULL AND o.cancelled_at IS NULL
          AND upper(fs.entity_name_primary) = upper($2) LIMIT 1`,
      [order.order_id, order.entity_name_primary ?? ""]
    );
    if (duplicate.rowCount) {
      res.status(409).json({ error: "this LLC name was already submitted on another order", code: "duplicate_filing", other_order_id: duplicate.rows[0].order_id });
      return;
    }
    const pi = await retrievePaymentIntent(order.stripe_payment_intent_id);
    const clearance = clearanceFor(pi, order.total_cents, new Date());
    if (!clearance.cleared) {
      res.status(409).json({ error: clearance.detail, code: clearance.code, order_id: order.order_id });
      return;
    }
    await pool.query(
      `UPDATE orders SET filing_approved_at = now(), capture_before = $2, extended_authorization = $3 WHERE order_id = $1`,
      [order.order_id, clearance.captureBefore, clearance.extended]
    );
    res.status(200).json({ order_id: order.order_id, status: "approved", capture_before: clearance.captureBefore.toISOString() });
  } catch (err) {
    res.status(502).json({ error: "could not confirm the hold with Stripe; do not file", detail: describeError(err) });
  }
});

/**
 * POST /api/orders/:orderId/replace-authorization
 *
 * For a hold about to end with Florida's answer still due. The new hold is
 * placed first and must be capturable before the order moves to it, so the
 * order is never left with nothing. Only then is the old one cancelled, and
 * its cancel event is ignored by the webhook. If the bank refuses or wants
 * the customer present, the old hold stands and the operator is told.
 */
ordersRouter.post("/api/orders/:orderId/replace-authorization", async (req, res) => {
  if (!operatorAuthorized(req)) {
    res.status(401).json({ error: "operator key required" });
    return;
  }
  try {
    const { rows } = await pool.query<{
      order_id: string; payment_status: string; stripe_payment_intent_id: string | null; total_cents: number; currency: string | null;
      line_items: Array<{ offer_code?: string }> | null; cancelled_at: Date | null; proof_of_filing_at: Date | null;
      superseded_payment_intent_ids: string[] | null;
    }>(
      `SELECT order_id, payment_status, stripe_payment_intent_id, total_cents, currency, line_items, cancelled_at, proof_of_filing_at, superseded_payment_intent_ids FROM orders WHERE order_id = $1`,
      [req.params.orderId]
    );
    const order = rows[0];
    if (!order) {
      res.status(404).json({ error: "order not found" });
      return;
    }
    if (!hasDiyPackage(order.line_items ?? [])) {
      res.status(409).json({ error: "this is for DIY_PACKAGE orders", code: "not_a_diy_package" });
      return;
    }
    if (order.cancelled_at || order.proof_of_filing_at || order.payment_status !== "authorized" || !order.stripe_payment_intent_id) {
      res.status(409).json({ error: "this order has no open hold to replace", code: "no_hold_to_replace", payment_status: order.payment_status });
      return;
    }
    const oldId = order.stripe_payment_intent_id;
    const original = await retrievePaymentIntent(oldId);
    if (original.status !== "requires_capture" || !original.customer || !original.payment_method) {
      res.status(409).json({ error: `the hold is ${original.status}, or has no saved card`, code: "hold_not_replaceable" });
      return;
    }
    let replacement;
    try {
      replacement = await placeReplacementHold({
        customerId: original.customer,
        paymentMethodId: original.payment_method,
        amountCents: order.total_cents,
        currency: order.currency || "usd",
        idempotencyKey: `replace-${order.order_id}-${oldId}`,
        metadata: { order_id: order.order_id, kind: "replacement_hold", replaces: oldId },
      });
    } catch (err) {
      await sendOpsAlert("A replacement card hold failed", `Order ${order.order_id}. The current hold ${oldId} still stands. ${describeError(err)}`);
      res.status(402).json({ error: "the bank did not approve a new hold; the current hold still stands", code: "replacement_declined", detail: describeError(err) });
      return;
    }
    if (replacement.status !== "requires_capture") {
      await sendOpsAlert("A replacement card hold needs the customer", `Order ${order.order_id}. New hold ${replacement.id} is ${replacement.status}. The current hold ${oldId} still stands.`);
      res.status(402).json({ error: "the new hold was not capturable; the current hold still stands", code: "replacement_not_capturable", status: replacement.status });
      return;
    }
    const moved = await pool.query(
      `UPDATE orders SET stripe_payment_intent_id = $2, capture_before = NULL, hold_expiry_flagged_at = NULL, hold_final_flagged_at = NULL,
              filing_approved_at = NULL, superseded_payment_intent_ids = $3::jsonb
        WHERE order_id = $1 AND stripe_payment_intent_id = $4 AND payment_status = 'authorized'`,
      [order.order_id, replacement.id, JSON.stringify([...(order.superseded_payment_intent_ids ?? []), oldId]), oldId]
    );
    if (!moved.rowCount) {
      await cancelPaymentIntent(replacement.id, `cancel-replacement-${replacement.id}`);
      res.status(409).json({ error: "the order changed while replacing; the new hold was cancelled", code: "order_changed" });
      return;
    }
    try {
      await cancelPaymentIntent(oldId, `cancel-superseded-${oldId}`);
    } catch (err) {
      await sendOpsAlert("A replaced card hold is still open", `Order ${order.order_id}. Cancel ${oldId} in Stripe: the customer has two holds. ${describeError(err)}`);
      res.status(200).json({ order_id: order.order_id, status: "replaced_old_hold_still_open", payment_intent: replacement.id });
      return;
    }
    res.status(200).json({ order_id: order.order_id, status: "replaced", payment_intent: replacement.id });
  } catch (err) {
    res.status(502).json({ error: "could not replace the hold", detail: describeError(err) });
  }
});

/**
 * POST /api/orders/:orderId/submitted-to-sunbiz
 * Body: { tracking_number: string }
 *
 * Damian has reviewed the order, filed it at Sunbiz and paid Florida. From
 * here "After we submit. Your order can't be cancelled through us." The order
 * must be ready to file: reviewed by the worker, Articles present, and any
 * customer agent accepted. Repeating the call with the same number changes
 * nothing.
 */
ordersRouter.post("/api/orders/:orderId/submitted-to-sunbiz", async (req, res) => {
  if (!operatorAuthorized(req)) {
    res.status(401).json({ error: "operator key required" });
    return;
  }
  const trackingNumber = typeof req.body?.tracking_number === "string" ? req.body.tracking_number.trim() : "";
  if (!TRACKING_NUMBER.test(trackingNumber)) {
    res.status(400).json({ error: "tracking_number is required (the Sunbiz tracking number from the filing confirmation)" });
    return;
  }
  try {
    const outcome = await withLockedOrder(req.params.orderId, async (client, order) => {
      const refused = filingRefusal(order);
      if (refused) return refused;
      if (order.fulfillment_status === "transmitted") {
        if (order.sunbiz_tracking_number === trackingNumber) {
          return { ok: true, body: { order_id: order.order_id, status: "already_submitted", tracking_number: trackingNumber, submitted_at: order.sunbiz_submitted_at } };
        }
        return { status: 409, body: { error: "this order is already submitted under another tracking number", code: "filing_submitted", order_id: order.order_id } };
      }
      if (order.fulfillment_status === "rejected") {
        return { status: 409, body: { error: "Florida rejected this filing; use the resubmission route", code: "filing_rejected", order_id: order.order_id } };
      }
      const notCleared = clearanceRefusal(order);
      if (notCleared) return notCleared;
      const blocker = await findFilingBlocker(client, order);
      if (blocker) return { status: 409, body: { ...blocker, order_id: order.order_id } };
      if (order.fulfillment_status !== "requires_review") {
        return { status: 409, body: { error: `this order is not ready to file (fulfillment_status ${order.fulfillment_status})`, code: "filing_not_ready", order_id: order.order_id } };
      }
      const { rows } = await client.query<{ sunbiz_submitted_at: Date }>(
        `UPDATE orders SET fulfillment_status = 'transmitted', sunbiz_tracking_number = $2, sunbiz_submitted_at = now(), fulfillment_last_error = NULL
         WHERE order_id = $1 RETURNING sunbiz_submitted_at`,
        [order.order_id, trackingNumber]
      );
      await filingEvent(client, order, "sunbiz_submitted", { tracking_number: trackingNumber });
      return { ok: true, body: { order_id: order.order_id, status: "submitted", tracking_number: trackingNumber, submitted_at: rows[0].sunbiz_submitted_at } };
    });
    if ("ok" in outcome) res.status(200).json(outcome.body);
    else res.status(outcome.status).json(outcome.body);
  } catch (err) {
    res.status(500).json({ error: "could not record the submission", detail: describeError(err) });
  }
});

/**
 * POST /api/orders/:orderId/filing-rejected
 * Body: { reason: string }
 *
 * Florida rejected a submitted filing: "we tell you why". The reason goes to
 * the customer as written. The hold or saved card stays as it is, because a
 * correction can still end in a charge. From here the order is resubmitted,
 * or closed through /cancel. Repeating the call sends nothing further.
 */
ordersRouter.post("/api/orders/:orderId/filing-rejected", async (req, res) => {
  if (!operatorAuthorized(req)) {
    res.status(401).json({ error: "operator key required" });
    return;
  }
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 1000) : "";
  if (!reason) {
    res.status(400).json({ error: "reason is required (it is emailed to the customer)" });
    return;
  }
  try {
    let newlyRejected = false;
    const outcome = await withLockedOrder(req.params.orderId, async (client, order) => {
      const refused = filingRefusal(order);
      if (refused) return refused;
      if (order.fulfillment_status === "rejected") {
        return { ok: true, body: { order_id: order.order_id, filing_session_id: order.filing_session_id, status: "already_rejected", rejection: order.sunbiz_rejection_count, reason: order.sunbiz_rejection_reason } };
      }
      if (order.fulfillment_status !== "transmitted") {
        return { status: 409, body: { error: "this filing has not been submitted to Sunbiz", code: "filing_not_submitted", order_id: order.order_id } };
      }
      const rejection = order.sunbiz_rejection_count + 1;
      await client.query(
        `UPDATE orders SET fulfillment_status = 'rejected', sunbiz_rejected_at = now(), sunbiz_rejection_reason = $2, sunbiz_rejection_count = $3 WHERE order_id = $1`,
        [order.order_id, reason, rejection]
      );
      await filingEvent(client, order, "sunbiz_rejected", { rejection, reason });
      newlyRejected = true;
      return { ok: true, body: { order_id: order.order_id, filing_session_id: order.filing_session_id, status: "rejected", rejection, reason } };
    });
    if (!("ok" in outcome)) {
      res.status(outcome.status).json(outcome.body);
      return;
    }
    const { filing_session_id: filingSessionId, reason: recordedReason, ...body } = outcome.body as Record<string, unknown> & { filing_session_id: string; reason: string };
    // Queued after the commit, once per rejection. A repeat call fills in a
    // queueing failure, and the dedupe key stops a second email.
    const { queued } = await queueOrderEmail(pool, {
      orderId: req.params.orderId,
      filingSessionId,
      emailTypes: ["filing_rejected"],
      paymentMode: "hold",
      dedupeKey: `rejection-${String(body.rejection)}`,
      details: { rejection_reason: recordedReason },
    });
    if (newlyRejected) {
      await sendOpsAlert("Florida rejected a filing", `Order ${req.params.orderId}. ${queued ? "The customer is being emailed why." : "The customer email could not be queued."} Correct and resubmit once they approve, or close it with /cancel.`);
    }
    res.status(200).json({ ...body, customer_emailed: queued });
  } catch (err) {
    res.status(500).json({ error: "could not record the rejection", detail: describeError(err) });
  }
});

const CORRECTABLE_FIELDS = ["llc_name", "principal_address", "mailing_address", "authorized_persons", "effective_date_option", "effective_date", "annual_report_due_date", "other_provisions"] as const;

function pickCorrections(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const source = raw as Record<string, unknown>;
  return Object.fromEntries(CORRECTABLE_FIELDS.filter((field) => source[field] !== undefined).map((field) => [field, source[field]]));
}

/**
 * POST /api/orders/:orderId/resubmitted-to-sunbiz
 * Body: { tracking_number?: string, corrections?: { llc_name?, principal_address?, ... } }
 *
 * The corrected filing is back with Florida, so the order is submitted again
 * and /cancel is refused again. Sunbiz keeps the tracking number on a
 * correction, so it is optional. `corrections` records what changed: the
 * filing details are locked once an order stands, and without this the filing
 * confirmation would name what Florida rejected. Corrected Articles are
 * generated and stored before anything changes.
 *
 * Only the operator should call this once the customer has approved any
 * change they were asked for.
 */
ordersRouter.post("/api/orders/:orderId/resubmitted-to-sunbiz", async (req, res) => {
  if (!operatorAuthorized(req)) {
    res.status(401).json({ error: "operator key required" });
    return;
  }
  if (await orderIsLiveTest(pool, req.params.orderId)) {
    res.status(409).json({ error: "order includes no Sunbiz filing", code: "live_test_session" });
    return;
  }
  const trackingNumber = typeof req.body?.tracking_number === "string" ? req.body.tracking_number.trim() : "";
  if (trackingNumber && !TRACKING_NUMBER.test(trackingNumber)) {
    res.status(400).json({ error: "tracking_number is not a Sunbiz tracking number" });
    return;
  }
  const corrections = pickCorrections(req.body?.corrections);
  const correcting = Object.keys(corrections).length > 0;
  const orderId = req.params.orderId;

  try {
    let corrected: { filingData: Record<string, unknown>; pdf: { pdfBytes: Buffer; sha256: string } } | null = null;
    if (correcting) {
      const session = await pool.query<{ filing_data: Record<string, unknown> | null; registered_agent_status: string | null }>(
        `SELECT fs.filing_data, fs.registered_agent_status FROM orders o JOIN filing_sessions fs ON fs.filing_session_id = o.filing_session_id WHERE o.order_id = $1`,
        [orderId]
      );
      if (!session.rows.length) {
        res.status(404).json({ error: "order not found" });
        return;
      }
      const filingData = { ...(session.rows[0].filing_data ?? {}), ...corrections };
      const context = buildPdfContext(filingData as Partial<FilingSessionRecord>, session.rows[0].registered_agent_status);
      if (!context.ok) {
        res.status(422).json({ error: "the corrected Articles cannot be built", code: "filing_data_incomplete", missing_fields: context.missingFields });
        return;
      }
      const pdf = await generateArticlesOfOrganizationPdf(context.context);
      if (!pdf.ok) {
        res.status(502).json({ error: "the corrected Articles could not be generated, so nothing changed", detail: pdf.error });
        return;
      }
      corrected = { filingData, pdf: { pdfBytes: Buffer.from(pdf.pdfBytes), sha256: pdf.sha256 } };
    }

    const outcome = await withLockedOrder(orderId, async (client, order) => {
      const refused = filingRefusal(order);
      if (refused) return refused;
      if (order.fulfillment_status === "transmitted" && order.sunbiz_resubmitted_at && (!trackingNumber || trackingNumber === order.sunbiz_tracking_number) && !correcting) {
        return { ok: true, body: { order_id: order.order_id, status: "already_resubmitted", tracking_number: order.sunbiz_tracking_number } };
      }
      if (order.fulfillment_status !== "rejected") {
        return { status: 409, body: { error: "this filing is not rejected, so there is nothing to resubmit", code: "filing_not_rejected", order_id: order.order_id } };
      }
      if (!trackingNumber && !order.sunbiz_tracking_number) {
        return { status: 400, body: { error: "tracking_number is required" } };
      }
      const blocker = await findFilingBlocker(client, order);
      if (blocker) return { status: 409, body: { ...blocker, order_id: order.order_id } };

      if (corrected) {
        await client.query(`UPDATE filing_sessions SET filing_data = $2, entity_name_primary = COALESCE($3, entity_name_primary) WHERE filing_session_id = $1`, [
          order.filing_session_id,
          JSON.stringify(corrected.filingData),
          typeof corrections.llc_name === "string" ? corrections.llc_name : null,
        ]);
        await client.query(`INSERT INTO filing_documents (filing_session_id, order_id, byte_size, sha256, pdf_bytes) VALUES ($1, $2, $3, $4, $5)`, [
          order.filing_session_id,
          order.order_id,
          corrected.pdf.pdfBytes.length,
          corrected.pdf.sha256,
          corrected.pdf.pdfBytes,
        ]);
      }
      const tracking = trackingNumber || order.sunbiz_tracking_number;
      await client.query(`UPDATE orders SET fulfillment_status = 'transmitted', sunbiz_tracking_number = $2, sunbiz_resubmitted_at = now() WHERE order_id = $1`, [order.order_id, tracking]);
      await filingEvent(client, order, "sunbiz_resubmitted", { tracking_number: tracking, corrected_fields: Object.keys(corrections) });

      const days = order.sunbiz_rejected_at ? (Date.now() - new Date(order.sunbiz_rejected_at).getTime()) / (24 * 3600 * 1000) : 0;
      return { ok: true, body: { order_id: order.order_id, status: "resubmitted", tracking_number: tracking, corrected_fields: Object.keys(corrections), within_60_days: days <= DAYS_TO_KEEP_FILING_DATE } };
    });
    if ("ok" in outcome) res.status(200).json(outcome.body);
    else res.status(outcome.status).json(outcome.body);
  } catch (err) {
    res.status(500).json({ error: "could not record the resubmission", detail: describeError(err) });
  }
});

/**
 * POST /api/orders/:orderId/payment-received
 * Body: { method: string, amount_cents: number, reference?: string }
 *
 * The other half of "we'll email you to arrange another way to pay". Records
 * money received outside Stripe for everything still owed on the order, which
 * closes it: the order is paid, any hold is released, the saved card is
 * detached at the next card sweep and no service charge follows. Nothing is
 * due before Florida confirms, so it is refused until proof of filing. It is
 * also refused if Stripe may have taken the money, to keep one order from
 * being paid twice.
 */
ordersRouter.post("/api/orders/:orderId/payment-received", async (req, res) => {
  if (!operatorAuthorized(req)) {
    res.status(401).json({ error: "operator key required" });
    return;
  }
  const method = typeof req.body?.method === "string" ? req.body.method.trim().slice(0, 60) : "";
  const reference = typeof req.body?.reference === "string" ? req.body.reference.trim().slice(0, 200) : "";
  const amountCents = req.body?.amount_cents;
  if (!method || !Number.isInteger(amountCents) || amountCents <= 0) {
    res.status(400).json({ error: "method and amount_cents are required" });
    return;
  }

  const orderId = req.params.orderId;
  try {
    const { rows } = await pool.query<{
      order_id: string;
      filing_session_id: string;
      payment_status: string;
      stripe_payment_intent_id: string | null;
      total_cents: number;
      deferred_cents: number;
      deferred_payment_intent_id: string | null;
      deferred_charged_at: Date | null;
      saved_card_payment_intent_id: string | null;
      proof_of_filing_at: Date | null;
      cancelled_at: Date | null;
      crm_deal_id: string | null;
    }>(
      `SELECT order_id, filing_session_id, payment_status, stripe_payment_intent_id, total_cents, deferred_cents, deferred_payment_intent_id, deferred_charged_at,
              saved_card_payment_intent_id, proof_of_filing_at, cancelled_at, crm_deal_id
       FROM orders WHERE order_id = $1`,
      [orderId]
    );
    if (!rows.length) {
      res.status(404).json({ error: "order not found" });
      return;
    }
    const order = rows[0];
    if (order.cancelled_at) {
      res.status(409).json({ error: "order is cancelled; nothing is due", code: "order_cancelled", order_id: orderId });
      return;
    }
    if (!order.proof_of_filing_at) {
      res.status(409).json({ error: "nothing is due until Florida confirms the filing", code: "filing_not_confirmed", order_id: orderId });
      return;
    }
    if ((order.saved_card_payment_intent_id && order.payment_status !== "paid") || (order.deferred_payment_intent_id && !order.deferred_charged_at)) {
      res.status(409).json({ error: "a card charge is already in progress on this order", code: "charge_in_progress", order_id: orderId });
      return;
    }
    const deferredOwed = order.deferred_charged_at ? 0 : Math.max(0, Number(order.deferred_cents));
    const amountDue = ["authorized", "released"].includes(order.payment_status) ? order.total_cents : order.payment_status === "paid" ? deferredOwed : 0;
    if (amountDue === 0) {
      res.status(409).json({ error: `nothing is due on this order (payment_status ${order.payment_status})`, code: "nothing_due", order_id: orderId });
      return;
    }
    if (amountCents !== amountDue) {
      res.status(409).json({ error: "amount_cents must match what is due on this order", code: "amount_mismatch", amount_due_cents: amountDue, order_id: orderId });
      return;
    }
    // A capture that failed with no clear answer may still have gone through.
    const heldNow = order.payment_status === "authorized" && !!order.stripe_payment_intent_id;
    if (heldNow) {
      const intent = await retrievePaymentIntent(order.stripe_payment_intent_id as string);
      if (intent.status === "succeeded") {
        res.status(409).json({ error: "Stripe shows this hold was collected, so the card has been charged", code: "already_collected", order_id: orderId });
        return;
      }
    }

    const updated = await pool.query(
      `UPDATE orders
       SET payment_status = 'paid', paid_at = COALESCE(paid_at, now()), capture_error = NULL, deferred_charge_error = NULL,
           deferred_charged_at = CASE WHEN deferred_cents > 0 THEN COALESCE(deferred_charged_at, now()) ELSE deferred_charged_at END,
           other_payment_at = now(), other_payment_method = $2, other_payment_reference = $3, other_payment_cents = $4
       WHERE order_id = $1 AND payment_status = $5`,
      [orderId, method, reference || null, amountCents, order.payment_status]
    );
    if (!updated.rowCount) {
      res.status(409).json({ error: "the order changed while recording this; check it and try again", order_id: orderId });
      return;
    }
    await enqueueDealUpdate(pool as never, order, {
      target_stage: process.env.ZOHO_DEAL_STAGE_ON_CAPTURE || process.env.ZOHO_DEAL_STAGE_ON_PAYMENT || "Closed Won",
      extra_fields: { Payment_Status: "Payment Collected" },
    });

    let holdReleased = !heldNow;
    if (heldNow) {
      try {
        await cancelPaymentIntent(order.stripe_payment_intent_id as string, `release-${orderId}`);
        holdReleased = true;
      } catch (err) {
        const code = err instanceof StripeApiError ? (err.stripeError as { code?: string } | undefined)?.code : undefined;
        holdReleased = holdNoLongerCapturable(code);
        if (!holdReleased) {
          await sendOpsAlert("Hold not released", `Order ${orderId} is paid another way, but its hold was not released: ${describeError(err)}. Release it in Stripe.`);
        }
      }
    }
    await sendOpsAlert("Payment recorded outside Stripe", `Order ${orderId}: ${method}, $${(amountCents / 100).toFixed(2)}. The order is closed and its saved card comes off at the next card sweep.`);
    res.status(200).json({ order_id: orderId, status: "paid_another_way", amount_cents: amountCents, hold_released: holdReleased });
  } catch (err) {
    res.status(500).json({ error: "could not record the payment", detail: describeError(err) });
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

/**
 * Any failure to collect after filing, whatever Stripe answered. "If your
 * card can't be charged, we'll email you", and the promise does not depend on
 * why. Declines go through their own path, which also moves to a new attempt.
 * When Stripe's answer was unclear the charge may yet appear; the email worker
 * then sees a paid order and skips it. Returns whether the email was queued.
 */
async function recordCaptureError(order: { order_id: string; filing_session_id: string }, err: unknown, amountCents: number): Promise<boolean> {
  const orderId = order.order_id;
  try {
    await pool.query(`UPDATE orders SET capture_error = $2 WHERE order_id = $1`, [orderId, describeError(err)]);
  } catch (e) {
    console.error(`[payments] could not record capture error for ${orderId}:`, describeError(e));
  }
  console.error(`[payments] collection problem on order ${orderId}:`, describeError(err));
  const customerEmailed = await askCustomerToArrangePayment(order, amountCents, "fallback");
  await sendOpsAlert(
    "Payment could not be collected",
    `Order ${orderId}: ${describeError(err)}. Proof of filing is recorded; the card was not charged. ${customerEmailed ? "The customer has been emailed to arrange payment." : "The customer email could not be queued."} Calling proof of filing again retries the charge.`
  );
  return customerEmailed;
}
