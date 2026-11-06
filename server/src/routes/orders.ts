import { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";
import { describeError } from "../db/describeError.js";
import { cancelPaymentIntent, capturePaymentIntent, retrievePaymentIntent, StripeApiError } from "../stripe/restClient.js";
import { holdNoLongerCapturable } from "../payments/holdState.js";
import { enqueueDealUpdate } from "../payments/dealUpdates.js";
import { attemptSavedCardCharge, findCollectedPayment, SAVED_CARD_CHARGE_REASON, stripeResultUnknown } from "../payments/savedCard.js";
import { requiresPayAfterFiling } from "../offers/payAfterFiling.js";
import { needsSunbizFiling } from "../offers/sunbizFiling.js";
import { findFilingBlocker } from "../fulfillment/filingGate.js";
import { hasDiyPackage } from "../offers/diyPackage.js";
import { isLiveTestOrder } from "../offers/liveTest.js";
import { orderIsLiveTest } from "../offers/liveTestSeal.js";
import { APPROVAL_VALID_HOURS, approvalCurrent, clearanceFor, entityNameKey, sameEntityName } from "../payments/filingClearance.js";
import { oneStepAtATime, reconfirmClaim } from "../payments/holdLock.js";
import { closeUntrackedHolds, MAX_REPLACEMENT_ATTEMPTS, replaceHold } from "../payments/replaceHold.js";
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

const oneStep = oneStepAtATime(pool, operatorAuthorized);

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
  collection_unknown_at?: Date | null;
}

/**
 * Whether this step may still move money. It read the order before something
 * slow, and its claim can run out meanwhile, so another step may have closed
 * the order. Checked right before each money call.
 */
async function stepStillStands(res: Response, order: ProofOrder): Promise<boolean> {
  const token = res.locals.orderClaim as string | undefined;
  if (token && !(await reconfirmClaim(pool, order.order_id, token))) return false;
  const { rows } = await pool.query<{ payment_status: string; cancelled_at: Date | null; stripe_payment_intent_id: string | null }>(
    `SELECT order_id, payment_status, cancelled_at, stripe_payment_intent_id FROM orders WHERE order_id = $1`,
    [order.order_id]
  );
  const now = rows[0];
  return Boolean(now) && !now.cancelled_at && ["authorized", "released"].includes(now.payment_status) && now.stripe_payment_intent_id === order.stripe_payment_intent_id;
}

const ORDER_MOVED_ON = (orderId: string) => ({
  error: "the order changed while proof was being delivered, so nothing was collected. Check it, then call this route again",
  code: "order_changed",
  order_id: orderId,
});

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
 * A cancelled order, or one with no filing in it, is refused before anything
 * is recorded. So is a Sunbiz filing that was not submitted: a document number
 * can only be real for a filing that went to Florida. The pre-filing gates are
 * not run again here. Once a filing is recorded Florida has been paid, and the
 * number and name read from Sunbiz are the proof of it, so a gap in the steps
 * before it is raised with a person instead of stopping collection.
 */
ordersRouter.post("/api/orders/:orderId/proof-of-filing", oneStep, async (req, res) => {
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
      stray_capture_pi: string | null;
    }>(
      `SELECT order_id, filing_session_id, payment_status, line_items, cancelled_at, fulfillment_status, sunbiz_tracking_number, proof_of_filing_ref, stray_capture_pi FROM orders WHERE order_id = $1`,
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
    if (existing.rows[0].stray_capture_pi && existing.rows[0].payment_status !== "paid") {
      res.status(409).json({ error: `money landed on ${existing.rows[0].stray_capture_pi}, which this order does not use. Refund it first, or the customer pays twice`, code: "stray_capture_unresolved", order_id: orderId });
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
      // A person read this on Florida's record: it must be this order's LLC.
      if (hasDiyPackage(filing.line_items ?? [])) {
        const named = await pool.query<{ entity_name_primary: string | null; entity_name_backup: string | null; filing_data: { llc_name?: string } | null }>(
          `SELECT entity_name_primary, entity_name_backup, filing_data FROM filing_sessions WHERE filing_session_id = $1`,
          [filing.filing_session_id]
        );
        const verifiedName = typeof req.body?.verified_entity_name === "string" ? req.body.verified_entity_name : "";
        const filed = named.rows[0];
        // The filed name, which is locked once an order stands. Florida may
        // take the backup the customer gave instead.
        if (!sameEntityName(verifiedName, filed?.filing_data?.llc_name || filed?.entity_name_primary) && !sameEntityName(verifiedName, filed?.entity_name_backup)) {
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
      const gap = await findFilingBlocker(pool, filing);
      if (gap && !filing.proof_of_filing_ref) {
        await sendOpsAlert("Proof accepted on a filing with a gap", `Order ${orderId}: ${gap.error}, but Florida has filed it. Collection goes ahead. Check what went to Florida.`);
      }
    }
    const { rows } = await pool.query<ProofOrder>(
      `UPDATE orders
       SET proof_of_filing_ref = COALESCE(proof_of_filing_ref, $2), proof_of_filing_at = COALESCE(proof_of_filing_at, now()),
           fulfillment_completed_at = COALESCE(fulfillment_completed_at, now())
       WHERE order_id = $1
       RETURNING order_id, filing_session_id, payment_status, stripe_payment_intent_id, total_cents, currency,
                 deferred_cents, saved_card_attempts, saved_card_payment_intent_id, collection_unknown_at`,
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

  // Before the money moves, so a stray hold can't cause a decline.
  await closeUntrackedHolds(pool, order.order_id);
  if (!(await stepStillStands(res, order))) {
    res.status(409).json(ORDER_MOVED_ON(order.order_id));
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
      if (order.collection_unknown_at) await pool.query(`UPDATE orders SET collection_unknown_at = NULL WHERE order_id = $1`, [order.order_id]);
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
        const customerEmailed = await recordCaptureError(order, err, collectNowCents, stripeResultUnknown(err));
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
    // The answer above can also mean an earlier capture went through.
    const customerEmailed = await recordCaptureError(order, err, collectNowCents, true);
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
    const customerEmailed = await recordCaptureError(order, err, collectNowCents, true);
    res.status(502).json({ error: "collection failed", detail: describeError(err), order_id: order.order_id, customer_emailed: customerEmailed });
    return;
  }

  if (!(await stepStillStands(res, order))) {
    res.status(409).json(ORDER_MOVED_ON(order.order_id));
    return;
  }
  // The last try got no answer. The key protects a retry only while Stripe
  // keeps it, so look first.
  if (order.collection_unknown_at && original.customer) {
    let landed;
    try {
      landed = await findCollectedPayment(original.customer, order.order_id);
    } catch (err) {
      const customerEmailed = await recordCaptureError(order, err, collectNowCents, true);
      res.status(502).json({ error: "saved-card charge failed", detail: describeError(err), order_id: order.order_id, customer_emailed: customerEmailed });
      return;
    }
    if (landed) {
      await pool.query(`UPDATE orders SET saved_card_payment_intent_id = $2, capture_error = NULL, collection_unknown_at = NULL WHERE order_id = $1`, [order.order_id, landed.id]);
      res.status(200).json({ order_id: order.order_id, status: "saved_card_charged", payment_intent_status: landed.status, collected_cents: collectNowCents, deferred_cents: deferred });
      return;
    }
  }

  const attempt = await attemptSavedCardCharge({
    original,
    orderId: order.order_id,
    prefix: "fallback",
    declinedAttempts: order.saved_card_attempts ?? 0,
    amountCents: collectNowCents,
    currency: order.currency || "usd",
    metadata: { order_id: order.order_id, reason: SAVED_CARD_CHARGE_REASON },
  });

  if (attempt.kind === "charged") {
    await pool.query(`UPDATE orders SET saved_card_payment_intent_id = $2, capture_error = NULL, collection_unknown_at = NULL WHERE order_id = $1`, [order.order_id, attempt.paymentIntentId]);
    res.status(200).json({ order_id: order.order_id, status: "saved_card_charged", payment_intent_status: attempt.status, collected_cents: collectNowCents, deferred_cents: deferred });
    return;
  }
  if (attempt.kind === "declined") {
    await pool.query(`UPDATE orders SET saved_card_attempts = saved_card_attempts + 1, capture_error = $2, collection_unknown_at = NULL WHERE order_id = $1`, [order.order_id, attempt.detail]);
    const customerEmailed = await askCustomerToArrangePayment(order, collectNowCents, "fallback");
    await sendOpsAlert(
      "Saved card declined after filing",
      `Order ${order.order_id}: ${attempt.detail}. Proof of filing is delivered and the card was not charged. ${customerEmailed ? "The customer has been emailed to arrange payment." : "The customer email could not be queued."} Calling proof of filing again retries the card.`
    );
    res.status(502).json({ error: "saved-card charge failed", status: "saved_card_declined", detail: attempt.detail, order_id: order.order_id, customer_emailed: customerEmailed });
    return;
  }
  const customerEmailed = await recordCaptureError(order, new Error(attempt.detail), collectNowCents, attempt.unknown);
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
ordersRouter.post("/api/orders/:orderId/service-complete", oneStep, async (req, res) => {
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

/**
 * POST /api/orders/:orderId/release-hold
 * Body: { confirm_not_filed?: boolean }
 *
 * Cancels a hold without collecting, and leaves the order open. It keeps the
 * same two guards as /cancel: never once a filing is submitted, because Florida
 * has been paid and this hold is what pays for it, and on an order approved
 * with nothing recorded only once the operator says it was not filed.
 */
ordersRouter.post("/api/orders/:orderId/release-hold", oneStep, async (req, res) => {
  if (!operatorAuthorized(req)) {
    res.status(401).json({ error: "operator key required" });
    return;
  }
  try {
    const { rows } = await pool.query(
      `SELECT order_id, payment_status, stripe_payment_intent_id, fulfillment_status, proof_of_filing_at, approved_unrecorded_at, line_items FROM orders WHERE order_id = $1`,
      [req.params.orderId]
    );
    if (!rows.length) {
      res.status(404).json({ error: "order not found" });
      return;
    }
    const order = rows[0];
    const closingTest = isLiveTestOrder(order.line_items);
    if (!closingTest && (order.proof_of_filing_at || order.fulfillment_status === "transmitted")) {
      res.status(409).json({ error: "the filing has been submitted, so Florida has been paid and this hold must stay", code: "filing_submitted", order_id: order.order_id });
      return;
    }
    if (order.payment_status !== "authorized" || !order.stripe_payment_intent_id) {
      res.status(409).json({ error: `order payment_status is ${order.payment_status}; no hold to release` });
      return;
    }
    if (!closingTest && order.approved_unrecorded_at && req.body?.confirm_not_filed !== true) {
      res.status(409).json({ ...APPROVED_NOT_RECORDED, order_id: order.order_id });
      return;
    }
    // A person released this on purpose: nothing may file on it, and the
    // sweep must not renew it.
    await pool.query(`UPDATE orders SET filing_approved_at = NULL, approved_unrecorded_at = NULL, filing_approved_name = NULL, replacement_attempts = $2 WHERE order_id = $1`, [order.order_id, MAX_REPLACEMENT_ATTEMPTS]);
    await closeUntrackedHolds(pool, order.order_id);
    const cancelled = await cancelPaymentIntent(order.stripe_payment_intent_id, `release-${order.order_id}-${order.stripe_payment_intent_id}`);
    res.status(200).json({ order_id: order.order_id, status: "release_requested", payment_intent_status: cancelled.status });
  } catch (err) {
    res.status(502).json({ error: "release failed", detail: describeError(err) });
  }
});

/**
 * POST /api/orders/:orderId/cancel
 * Body: { reason?: string, confirm_not_filed?: boolean }
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
 *
 * After an approval Florida may have been paid with nothing recorded yet, and
 * a filing can be recorded however old its approval is. So until one is
 * recorded the operator must say it was not filed (`confirm_not_filed`), however
 * long ago the approval was and whether or not a renewal has since cleared it.
 */
ordersRouter.post("/api/orders/:orderId/cancel", oneStep, async (req, res) => {
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
      approved_unrecorded_at: Date | null;
      line_items: Array<{ offer_code?: string }> | null;
    }>(
      `SELECT order_id, filing_session_id, payment_status, fulfillment_status, line_items, stripe_payment_intent_id, proof_of_filing_at, cancelled_at, crm_deal_id, sunbiz_rejected_at, approved_unrecorded_at
       FROM orders WHERE order_id = $1`,
      [req.params.orderId]
    );
    if (!rows.length) {
      res.status(404).json({ error: "order not found" });
      return;
    }
    const order = rows[0];
    // A test files nothing, so nothing stops it being closed.
    const closingTest = isLiveTestOrder(order.line_items);
    if (!closingTest && (order.proof_of_filing_at || order.fulfillment_status === "transmitted")) {
      res.status(409).json({ error: "the filing has been submitted, so this order can no longer be cancelled", code: "filing_submitted", order_id: order.order_id });
      return;
    }
    if (![...(closingTest ? ["pending"] : []), "authorized", "released"].includes(order.payment_status)) {
      res.status(409).json({ error: `order payment_status is ${order.payment_status}; no hold to cancel`, order_id: order.order_id });
      return;
    }
    if (!closingTest && !order.cancelled_at && order.approved_unrecorded_at && req.body?.confirm_not_filed !== true) {
      res.status(409).json({ ...APPROVED_NOT_RECORDED, order_id: order.order_id });
      return;
    }

    if (!order.cancelled_at) {
      const marked = await pool.query(
        `UPDATE orders SET cancelled_at = now(), cancellation_reason = $2, fulfillment_status = 'not_ready', approved_unrecorded_at = NULL, filing_approved_name = NULL
          WHERE order_id = $1 AND (fulfillment_status <> 'transmitted' OR $3::boolean)`,
        [order.order_id, reason || null, closingTest]
      );
      // A submission got in first: Florida has been paid, so it stands.
      if (marked.rowCount === 0) {
        res.status(409).json({ error: "the filing has been submitted, so this order can no longer be cancelled", code: "filing_submitted", order_id: order.order_id });
        return;
      }
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

    await closeUntrackedHolds(pool, order.order_id);
    if (order.payment_status === "authorized" && order.stripe_payment_intent_id) {
      try {
        await cancelPaymentIntent(order.stripe_payment_intent_id, `release-${order.order_id}-${order.stripe_payment_intent_id}`);
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

const APPROVED_NOT_RECORDED = {
  error: "this order was approved for filing and no filing is recorded, so Florida may have been paid. Check Sunbiz. If it was filed, record the filing. If not, send confirm_not_filed: true",
  code: "approved_for_filing",
};

const FILABLE_PAYMENT = ["authorized", "released", "paid"];
const DAYS_TO_KEEP_FILING_DATE = 60;

type Refusal = { status: number; body: Record<string, unknown> };

/** What not even a filing that really happened can be recorded on. */
function cannotRecordFiling(order: FilingStateOrder): Refusal | null {
  if (order.cancelled_at) return { status: 409, body: { error: "order is cancelled; nothing is filed or collected", code: "order_cancelled", order_id: order.order_id } };
  if (!needsSunbizFiling(order.line_items ?? [])) return { status: 409, body: { error: "order includes no Sunbiz filing", order_id: order.order_id } };
  if (order.proof_of_filing_at) return { status: 409, body: { error: "Florida has already confirmed this filing", code: "filing_confirmed", order_id: order.order_id } };
  // Never paid for, and orders_fulfillment_requires_paid won't store a filing on it.
  if (order.payment_status === "pending" || order.payment_status === "failed") {
    return { status: 409, body: { error: `order payment_status is ${order.payment_status}; there is no payment to record a filing on`, code: "no_payment_on_order", order_id: order.order_id } };
  }
  return null;
}

/** What stops any filing step on this order, before its own state is looked at. */
function filingRefusal(order: FilingStateOrder): Refusal | null {
  const refused = cannotRecordFiling(order);
  if (refused) return refused;
  if (!FILABLE_PAYMENT.includes(order.payment_status)) {
    return { status: 409, body: { error: `order payment_status is ${order.payment_status}; it cannot be filed`, order_id: order.order_id } };
  }
  return null;
}

const FILING_NOT_APPROVED = (orderId: string): Refusal => ({
  status: 409,
  body: {
    error: "this order has no approval. Approve it before paying Florida. If it was filed anyway, send filed_without_approval_reason",
    code: "filing_not_approved",
    order_id: orderId,
  },
});

/** Why a filing went to Florida with no approval, in the operator's words. */
function filedWithoutApprovalReason(body: unknown): string {
  const reason = (body as { filed_without_approval_reason?: unknown } | undefined)?.filed_without_approval_reason;
  return typeof reason === "string" ? reason.trim().slice(0, 500) : "";
}

/** A filing that happened, and what a person should know about how it went. */
interface RecordedFiling {
  order: FilingStateOrder;
  filedAnyway: string;
  nameClash: string | null;
}

/** Stripe's word on the hold now. Never a reason to refuse: Florida is already paid. */
async function holdProblemNow(orderId: string): Promise<string | null> {
  const { rows } = await pool.query<{ stripe_payment_intent_id: string | null; total_cents: number; stray_capture_pi: string | null }>(
    `SELECT stripe_payment_intent_id, total_cents, stray_capture_pi FROM orders WHERE order_id = $1`,
    [orderId]
  );
  if (rows[0]?.stray_capture_pi) return `money landed on ${rows[0].stray_capture_pi}, which this order does not use, and it must be refunded before anything more is collected`;
  if (!rows[0]?.stripe_payment_intent_id) return "the order has no hold";
  try {
    const clearance = clearanceFor(await retrievePaymentIntent(rows[0].stripe_payment_intent_id), rows[0].total_cents, new Date());
    return clearance.cleared ? null : clearance.detail;
  } catch (err) {
    return `Stripe could not confirm the hold: ${describeError(err)}`;
  }
}

/** After the commit, so nothing here can undo the record. */
async function alertIfFiledOutsideApproval({ order, filedAnyway, nameClash }: RecordedFiling): Promise<void> {
  try {
    const problems: string[] = [];
    if (filedAnyway) problems.push(`it was filed with no approval: ${filedAnyway}`);
    else if (!approvalCurrent(order.filing_approved_at, new Date())) problems.push(`its approval was over ${APPROVAL_VALID_HOURS} hours old`);
    if (nameClash) problems.push(nameClash);
    const gap = await findFilingBlocker(pool, order);
    if (gap) problems.push(gap.error);
    if (hasDiyPackage(order.line_items ?? [])) {
      const hold = await holdProblemNow(order.order_id);
      if (hold) problems.push(hold);
    }
    if (problems.length) {
      await sendOpsAlert("A filing was recorded outside its approval", `Order ${order.order_id}: ${problems.join("; ")}. Florida has been paid. Check how this order will be collected.`);
    }
  } catch (err) {
    console.error(`[payments] could not raise the filing alert for order ${order.order_id}:`, describeError(err));
  }
}

/**
 * One open filing per LLC name. Claimed on the order inside its transaction, so
 * the unique index settles two orders racing for the same name. `name` is a
 * name being corrected in this step.
 */
async function claimFilingName(client: PoolClient, order: FilingStateOrder, name?: string): Promise<Refusal | null> {
  let filed = name;
  if (filed === undefined) {
    const { rows } = await client.query<{ entity_name_primary: string | null; filing_data: { llc_name?: string } | null }>(
      `SELECT entity_name_primary, filing_data FROM filing_sessions WHERE filing_session_id = $1`,
      [order.filing_session_id]
    );
    filed = rows[0]?.filing_data?.llc_name || rows[0]?.entity_name_primary || undefined;
  }
  const key = entityNameKey(filed);
  if (!key) {
    return hasDiyPackage(order.line_items ?? []) ? { status: 409, body: { error: "this order has no LLC name to file", code: "filing_name_missing", order_id: order.order_id } } : null;
  }
  const other = await client.query<{ order_id: string }>(
    `SELECT order_id FROM orders WHERE filing_name_key = $1 AND order_id <> $2 AND cancelled_at IS NULL LIMIT 1`,
    [key, order.order_id]
  );
  if (other.rowCount) {
    return { status: 409, body: { error: "this LLC name is already being filed on another order", code: "duplicate_filing", other_order_id: other.rows[0].order_id } };
  }
  await client.query(`UPDATE orders SET filing_name_key = $2 WHERE order_id = $1`, [order.order_id, key]);
  return null;
}

/** The unique index caught what the check above couldn't see. */
function isDuplicateFiling(err: unknown): boolean {
  return (err as { code?: string }).code === "23505";
}

const DUPLICATE_FILING_BODY = { error: "this LLC name is already being filed on another order", code: "duplicate_filing" };

/**
 * The same claim for a filing that already happened. A clash can't undo it, so
 * it comes back as text for a person. The savepoint keeps a lost race on the
 * unique index from aborting the record.
 */
async function claimNameOfRecordedFiling(client: PoolClient, order: FilingStateOrder, name?: string): Promise<string | null> {
  await client.query("SAVEPOINT filing_name");
  try {
    const refused = await claimFilingName(client, order, name);
    await client.query("RELEASE SAVEPOINT filing_name");
    return refused ? String(refused.body.error) : null;
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT filing_name");
    if (isDuplicateFiling(err)) return DUPLICATE_FILING_BODY.error;
    throw err;
  }
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
 * POST /api/orders/:orderId/correct-document-number
 * Body: { document_number: string, reason: string }
 *
 * A wrong number can be corrected only while nothing was collected and no
 * confirmation went out. The change is recorded on the filing's history.
 */
ordersRouter.post("/api/orders/:orderId/correct-document-number", oneStep, async (req, res) => {
  const documentNumber = typeof req.body?.document_number === "string" ? req.body.document_number.trim().toUpperCase() : "";
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";
  if (!isFloridaLlcDocumentNumber(documentNumber) || !reason) {
    res.status(400).json({ error: "a Florida document number and a reason are required" });
    return;
  }
  try {
    const outcome = await withLockedOrder(req.params.orderId, async (client, order) => {
      const { rows } = await client.query<{ proof_of_filing_ref: string | null; proof_delivered_at: Date | null }>(
        `SELECT proof_of_filing_ref, proof_delivered_at FROM orders WHERE order_id = $1`,
        [order.order_id]
      );
      const wrong = rows[0]?.proof_of_filing_ref;
      if (!wrong || rows[0].proof_delivered_at || order.payment_status === "paid") {
        return { status: 409, body: { error: "this number can no longer be corrected here", code: "document_number_locked" } };
      }
      await client.query(`UPDATE orders SET proof_of_filing_ref = $2 WHERE order_id = $1`, [order.order_id, documentNumber]);
      await filingEvent(client, order, "document_number_corrected", { from: wrong, to: documentNumber, reason });
      return { ok: true, body: { order_id: order.order_id, status: "corrected" } };
    });
    if ("ok" in outcome) res.status(200).json(outcome.body);
    else res.status(outcome.status).json(outcome.body);
  } catch (err) {
    res.status(500).json({ error: "could not correct the number", detail: describeError(err) });
  }
});

/**
 * POST /api/orders/:orderId/approve-filing
 * Body: { llc_name?: string }
 *
 * The last check before Damian pays Florida, so it runs everything that can
 * stop a filing. A tracking number only exists after filing, so nothing later
 * can. It asks Stripe, not the order row, whether the hold can be captured and
 * for how long, and refuses a second filing of the same LLC. Its answer also
 * records the hold's real deadline. An approval covers filing in the next 4
 * hours. On a rejected filing, `llc_name` is a corrected name, so that name is
 * the one checked and claimed before Florida is paid again, and the
 * resubmission files it.
 *
 * An order stays in requires_review until a filing is recorded, so a second
 * approval could send Florida a second payment. It needs `confirm_not_filed`,
 * which goes on the filing's history.
 */
ordersRouter.post("/api/orders/:orderId/approve-filing", oneStep, async (req, res) => {
  if (!operatorAuthorized(req)) {
    res.status(401).json({ error: "operator key required" });
    return;
  }
  try {
    const { rows } = await pool.query<FilingStateOrder & { stripe_payment_intent_id: string | null; total_cents: number; approved_unrecorded_at: Date | null; stray_capture_pi: string | null; entity_name_primary: string | null; filing_data: { llc_name?: string } | null }>(
      `SELECT o.order_id, o.filing_session_id, o.payment_status, o.fulfillment_status, o.line_items, o.cancelled_at, o.proof_of_filing_at, o.filing_approved_at,
              o.sunbiz_tracking_number, o.sunbiz_submitted_at, o.sunbiz_resubmitted_at, o.sunbiz_rejected_at, o.sunbiz_rejection_reason, o.sunbiz_rejection_count,
              o.stripe_payment_intent_id, o.total_cents, o.approved_unrecorded_at, o.stray_capture_pi, fs.entity_name_primary, fs.filing_data
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
    if (order.fulfillment_status !== "requires_review" && order.fulfillment_status !== "rejected") {
      res.status(409).json({ error: `this order is not ready to file (fulfillment_status ${order.fulfillment_status})`, code: "filing_not_ready", order_id: order.order_id });
      return;
    }
    if (order.stray_capture_pi) {
      res.status(409).json({ error: `money landed on ${order.stray_capture_pi}, which this order does not use. Refund it before filing`, code: "stray_capture_unresolved", order_id: order.order_id });
      return;
    }
    const repeat = Boolean(order.approved_unrecorded_at);
    if (repeat && req.body?.confirm_not_filed !== true) {
      res.status(409).json({
        error: "this order was already approved and no filing is recorded, so Florida may have been paid. Check Sunbiz. If it was filed, record it. If not, send confirm_not_filed: true",
        code: "already_approved",
        order_id: order.order_id,
      });
      return;
    }
    const blocker = await findFilingBlocker(pool, order);
    if (blocker) {
      res.status(409).json({ ...blocker, order_id: order.order_id });
      return;
    }
    const correctedName = order.fulfillment_status === "rejected" && typeof req.body?.llc_name === "string" ? req.body.llc_name : "";
    const nameKey = entityNameKey(correctedName || order.filing_data?.llc_name || order.entity_name_primary);
    if (!nameKey) {
      res.status(409).json({ error: "this order has no LLC name to file", code: "filing_name_missing", order_id: order.order_id });
      return;
    }
    const duplicate = await pool.query<{ order_id: string }>(
      `SELECT order_id FROM orders WHERE filing_name_key = $1 AND order_id <> $2 AND cancelled_at IS NULL LIMIT 1`,
      [nameKey, order.order_id]
    );
    if (duplicate.rowCount) {
      res.status(409).json({ error: "this LLC name is already being filed on another order", code: "duplicate_filing", other_order_id: duplicate.rows[0].order_id });
      return;
    }
    const pi = await retrievePaymentIntent(order.stripe_payment_intent_id);
    const clearance = clearanceFor(pi, order.total_cents, new Date());
    if (!clearance.cleared) {
      res.status(409).json({ error: clearance.detail, code: clearance.code, order_id: order.order_id });
      return;
    }
    try {
      // The clearance is for the hold read above, and only that hold.
      const approved = await pool.query(
        `UPDATE orders SET filing_approved_at = now(), approved_unrecorded_at = now(), filing_approved_name = $6, capture_before = $2, extended_authorization = $3, filing_name_key = $4
          WHERE order_id = $1 AND stripe_payment_intent_id = $5 AND payment_status = 'authorized' AND cancelled_at IS NULL`,
        [order.order_id, clearance.captureBefore, clearance.extended, nameKey, order.stripe_payment_intent_id, correctedName || null]
      );
      if (!approved.rowCount) {
        res.status(409).json({ error: "the order changed during this check; do not file, and approve it again", code: "order_changed", order_id: order.order_id });
        return;
      }
    } catch (err) {
      if (isDuplicateFiling(err)) {
        res.status(409).json(DUPLICATE_FILING_BODY);
        return;
      }
      throw err;
    }
    await pool.query(`INSERT INTO filing_events (filing_session_id, event_type, payload) VALUES ($1, 'filing_approved', $2)`, [
      order.filing_session_id,
      JSON.stringify({ order_id: order.order_id, ...(repeat ? { confirmed_not_filed: order.approved_unrecorded_at } : {}), ...(correctedName ? { llc_name: correctedName } : {}) }),
    ]);
    res.status(200).json({ order_id: order.order_id, status: "approved", capture_before: clearance.captureBefore.toISOString() });
  } catch (err) {
    res.status(502).json({ error: "could not confirm the hold with Stripe; do not file", detail: describeError(err) });
  }
});

/**
 * POST /api/orders/:orderId/replace-authorization
 * Body: { customer_agreed?: string }
 *
 * For a hold about to end with Florida's answer still due. The new hold is
 * placed first and must be capturable before the order moves to it, so the
 * order is never left with nothing. Only then is the old one cancelled, and
 * its cancel event is ignored by the webhook. If the bank refuses or wants
 * the customer present, the old hold stands and the operator is told.
 *
 * A hold that has already ended is renewed only here, not by the sweep, and
 * needs `customer_agreed`, saying how the customer agreed. That covers an
 * order not yet submitted, and a rejected filing the customer is correcting.
 */
ordersRouter.post("/api/orders/:orderId/replace-authorization", async (req, res) => {
  if (!operatorAuthorized(req)) {
    res.status(401).json({ error: "operator key required" });
    return;
  }
  const customerAgreed = typeof req.body?.customer_agreed === "string" ? req.body.customer_agreed.trim().slice(0, 500) : "";
  try {
    const outcome = await replaceHold(pool, req.params.orderId, undefined, customerAgreed || undefined);
    if (outcome.kind === "replaced") {
      res.status(200).json({ order_id: req.params.orderId, status: outcome.oldHoldStillOpen ? "replaced_old_hold_still_open" : "replaced", payment_intent: outcome.paymentIntentId });
    } else if (outcome.kind === "failed") {
      const unknown = outcome.code === "replacement_result_unknown";
      res.status(unknown ? 502 : 402).json({ error: unknown ? "Stripe gave no answer, so a new hold may exist. The order has not moved, and the next attempt looks for it" : "no new hold was placed", code: outcome.code, detail: outcome.detail, attempts: outcome.attempts });
    } else {
      res.status(outcome.code === "order_not_found" ? 404 : 409).json({ error: outcome.detail, code: outcome.code });
    }
  } catch (err) {
    res.status(502).json({ error: "could not replace the hold", detail: describeError(err) });
  }
});

/**
 * POST /api/orders/:orderId/withdraw-approval
 * Body: { confirm_not_filed: true }
 *
 * The approval will not be used, and Florida was not paid: for an order that
 * must change first, such as a new registered agent. The operator has to say so.
 * The order's name stays claimed, and it must be approved again to file.
 */
ordersRouter.post("/api/orders/:orderId/withdraw-approval", oneStep, async (req, res) => {
  if (!operatorAuthorized(req)) {
    res.status(401).json({ error: "operator key required" });
    return;
  }
  if (req.body?.confirm_not_filed !== true) {
    res.status(400).json({ error: "confirm_not_filed: true is required. Check Sunbiz first. If it was filed, record the filing instead" });
    return;
  }
  try {
    const outcome = await withLockedOrder(req.params.orderId, async (client, order) => {
      const { rowCount } = await client.query(
        `UPDATE orders SET filing_approved_at = NULL, approved_unrecorded_at = NULL, filing_approved_name = NULL WHERE order_id = $1 AND approved_unrecorded_at IS NOT NULL`,
        [order.order_id]
      );
      if (!rowCount) return { status: 409, body: { error: "this order has no approval waiting on a filing", code: "no_open_approval", order_id: order.order_id } };
      await filingEvent(client, order, "filing_approval_withdrawn", {});
      return { ok: true, body: { order_id: order.order_id, status: "approval_withdrawn" } };
    });
    if ("ok" in outcome) res.status(200).json(outcome.body);
    else res.status(outcome.status).json(outcome.body);
  } catch (err) {
    res.status(500).json({ error: "could not withdraw the approval", detail: describeError(err) });
  }
});

/**
 * POST /api/orders/:orderId/retry-articles
 *
 * An order whose Articles gave up has no other way back to the queue. Use it
 * once the cause is fixed. The attempts start again.
 */
ordersRouter.post("/api/orders/:orderId/retry-articles", oneStep, async (req, res) => {
  if (!operatorAuthorized(req)) {
    res.status(401).json({ error: "operator key required" });
    return;
  }
  try {
    const { rowCount } = await pool.query(
      `UPDATE orders SET fulfillment_status = 'ready', fulfillment_ready_at = now(), fulfillment_attempts = 0, fulfillment_run_after = NULL, fulfillment_last_error = NULL
        WHERE order_id = $1 AND fulfillment_status = 'failed' AND cancelled_at IS NULL`,
      [req.params.orderId]
    );
    if (!rowCount) {
      res.status(409).json({ error: "only an order whose Articles gave up can be retried", code: "articles_not_failed", order_id: req.params.orderId });
      return;
    }
    res.status(200).json({ order_id: req.params.orderId, status: "queued" });
  } catch (err) {
    res.status(500).json({ error: "could not queue the order", detail: describeError(err) });
  }
});

/**
 * POST /api/orders/:orderId/submitted-to-sunbiz
 * Body: { tracking_number: string, filed_without_approval_reason?: string }
 *
 * Damian has filed the order at Sunbiz and paid Florida. From here "After we
 * submit. Your order can't be cancelled through us." The tracking number only
 * exists after filing, so for a $139 order this is a record, not a gate: the
 * gate is approve-filing. With an approval it records the filing, even if the
 * approval is old or the hold has since ended, and tells a person. With none it
 * refuses, unless `filed_without_approval_reason` says why it was filed anyway.
 *
 * Other packages have no approval step, so they must be ready to file here:
 * reviewed by the worker, Articles present, and any customer agent accepted.
 * Repeating the call with the same number changes nothing.
 */
ordersRouter.post("/api/orders/:orderId/submitted-to-sunbiz", oneStep, async (req, res) => {
  if (!operatorAuthorized(req)) {
    res.status(401).json({ error: "operator key required" });
    return;
  }
  const trackingNumber = typeof req.body?.tracking_number === "string" ? req.body.tracking_number.trim() : "";
  if (!TRACKING_NUMBER.test(trackingNumber)) {
    res.status(400).json({ error: "tracking_number is required (the Sunbiz tracking number from the filing confirmation)" });
    return;
  }
  const filedAnyway = filedWithoutApprovalReason(req.body);
  try {
    let recorded: RecordedFiling | null = null;
    const outcome = await withLockedOrder(req.params.orderId, async (client, order) => {
      const diy = hasDiyPackage(order.line_items ?? []);
      const alreadyHappened = (diy && Boolean(order.filing_approved_at)) || Boolean(filedAnyway);
      const refused = alreadyHappened ? cannotRecordFiling(order) : filingRefusal(order);
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
      let nameClash: string | null = null;
      if (alreadyHappened) {
        nameClash = await claimNameOfRecordedFiling(client, order);
      } else {
        if (diy) return FILING_NOT_APPROVED(order.order_id);
        const blocker = await findFilingBlocker(client, order);
        if (blocker) return { status: 409, body: { ...blocker, order_id: order.order_id } };
        if (order.fulfillment_status !== "requires_review") {
          return { status: 409, body: { error: `this order is not ready to file (fulfillment_status ${order.fulfillment_status})`, code: "filing_not_ready", order_id: order.order_id } };
        }
        const nameTaken = await claimFilingName(client, order);
        if (nameTaken) return nameTaken;
      }
      const { rows } = await client.query<{ sunbiz_submitted_at: Date }>(
        `UPDATE orders SET fulfillment_status = 'transmitted', sunbiz_tracking_number = $2, sunbiz_submitted_at = now(), fulfillment_last_error = NULL, approved_unrecorded_at = NULL
         WHERE order_id = $1 RETURNING sunbiz_submitted_at`,
        [order.order_id, trackingNumber]
      );
      await filingEvent(client, order, "sunbiz_submitted", { tracking_number: trackingNumber, ...(filedAnyway ? { filed_without_approval_reason: filedAnyway } : {}) });
      if (alreadyHappened) recorded = { order, filedAnyway, nameClash };
      return { ok: true, body: { order_id: order.order_id, status: "submitted", tracking_number: trackingNumber, submitted_at: rows[0].sunbiz_submitted_at } };
    });
    if (recorded) await alertIfFiledOutsideApproval(recorded);
    if ("ok" in outcome) res.status(200).json(outcome.body);
    else res.status(outcome.status).json(outcome.body);
  } catch (err) {
    if (isDuplicateFiling(err)) {
      res.status(409).json(DUPLICATE_FILING_BODY);
      return;
    }
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
ordersRouter.post("/api/orders/:orderId/filing-rejected", oneStep, async (req, res) => {
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
        `UPDATE orders SET filing_approved_at = NULL, approved_unrecorded_at = NULL, filing_approved_name = NULL, fulfillment_status = 'rejected', sunbiz_rejected_at = now(), sunbiz_rejection_reason = $2, sunbiz_rejection_count = $3 WHERE order_id = $1`,
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
      await closeUntrackedHolds(pool, req.params.orderId);
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

interface CorrectedFiling {
  filingData: Record<string, unknown>;
  pdf: { pdfBytes: Buffer; sha256: string };
}

/** Everything that can fail, done before the order is touched. */
async function buildCorrectedFiling(orderId: string, corrections: Record<string, unknown>): Promise<CorrectedFiling | Refusal> {
  const session = await pool.query<{ filing_data: Record<string, unknown> | null; registered_agent_status: string | null }>(
    `SELECT fs.filing_data, fs.registered_agent_status FROM orders o JOIN filing_sessions fs ON fs.filing_session_id = o.filing_session_id WHERE o.order_id = $1`,
    [orderId]
  );
  if (!session.rows.length) return { status: 404, body: { error: "order not found" } };
  const filingData = { ...(session.rows[0].filing_data ?? {}), ...corrections };
  const context = buildPdfContext(filingData as Partial<FilingSessionRecord>, session.rows[0].registered_agent_status);
  if (!context.ok) return { status: 422, body: { error: "the corrected Articles cannot be built", code: "filing_data_incomplete", missing_fields: context.missingFields } };
  const pdf = await generateArticlesOfOrganizationPdf(context.context);
  if (!pdf.ok) return { status: 502, body: { error: "the corrected Articles could not be generated, so nothing changed", detail: pdf.error } };
  return { filingData, pdf: { pdfBytes: Buffer.from(pdf.pdfBytes), sha256: pdf.sha256 } };
}

async function storeCorrectedFiling(client: PoolClient, order: FilingStateOrder, corrected: CorrectedFiling, name: string | undefined): Promise<void> {
  await client.query(`UPDATE filing_sessions SET filing_data = $2, entity_name_primary = COALESCE($3, entity_name_primary) WHERE filing_session_id = $1`, [
    order.filing_session_id,
    JSON.stringify(corrected.filingData),
    name ?? null,
  ]);
  await client.query(`INSERT INTO filing_documents (filing_session_id, order_id, byte_size, sha256, pdf_bytes) VALUES ($1, $2, $3, $4, $5)`, [
    order.filing_session_id,
    order.order_id,
    corrected.pdf.pdfBytes.length,
    corrected.pdf.sha256,
    corrected.pdf.pdfBytes,
  ]);
}

/**
 * POST /api/orders/:orderId/correct-filing-name
 * Body: { llc_name: string, reason: string }
 *
 * The filing is with Florida under a name this order does not hold, so proof
 * can't verify it. This puts the name on the order, claims it and stores
 * matching Articles. No false rejection is needed, and the customer hears
 * nothing. The change is recorded on the filing's history.
 */
ordersRouter.post("/api/orders/:orderId/correct-filing-name", oneStep, async (req, res) => {
  if (!operatorAuthorized(req)) {
    res.status(401).json({ error: "operator key required" });
    return;
  }
  const llcName = typeof req.body?.llc_name === "string" ? req.body.llc_name.trim() : "";
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";
  if (!entityNameKey(llcName) || !reason) {
    res.status(400).json({ error: "llc_name and reason are required" });
    return;
  }
  try {
    const orderId = req.params.orderId;
    const state = await pool.query<FilingStateOrder>(`SELECT ${FILING_STATE_COLUMNS} FROM orders WHERE order_id = $1`, [orderId]);
    if (!state.rows.length) {
      res.status(404).json({ error: "order not found" });
      return;
    }
    const notNow = (order: FilingStateOrder): Refusal | null =>
      cannotRecordFiling(order) ?? (order.fulfillment_status === "transmitted" ? null : { status: 409, body: { error: "only a filing with Florida is corrected here. A rejected filing is corrected when it is resubmitted", code: "filing_not_submitted", order_id: orderId } });
    const early = notNow(state.rows[0]);
    if (early) {
      res.status(early.status).json(early.body);
      return;
    }
    const built = await buildCorrectedFiling(orderId, { llc_name: llcName });
    if ("status" in built) {
      res.status(built.status).json(built.body);
      return;
    }
    const outcome = await withLockedOrder(orderId, async (client, order) => {
      const refused = notNow(order);
      if (refused) return refused;
      const nameTaken = await claimFilingName(client, order, llcName);
      if (nameTaken) return nameTaken;
      await storeCorrectedFiling(client, order, built, llcName);
      await filingEvent(client, order, "filing_name_corrected", { llc_name: llcName, reason });
      return { ok: true, body: { order_id: order.order_id, status: "corrected", llc_name: llcName } };
    });
    if ("ok" in outcome) res.status(200).json(outcome.body);
    else res.status(outcome.status).json(outcome.body);
  } catch (err) {
    if (isDuplicateFiling(err)) {
      res.status(409).json(DUPLICATE_FILING_BODY);
      return;
    }
    res.status(500).json({ error: "could not correct the name", detail: describeError(err) });
  }
});

/**
 * POST /api/orders/:orderId/resubmitted-to-sunbiz
 * Body: { tracking_number?: string, corrections?: { llc_name?, principal_address?, ... }, filed_without_approval_reason?: string }
 *
 * The corrected filing is back with Florida, so the order is submitted again
 * and /cancel is refused again. Like the first submission, on a $139 order this
 * records what happened: approve-filing is the gate. Sunbiz keeps the tracking number on a
 * correction, so it is optional. `corrections` records what changed: the
 * filing details are locked once an order stands, and without this the filing
 * confirmation would name what Florida rejected. A name given to approve-filing
 * is carried here, so leaving it out of `corrections` can't file the old one.
 * Corrected Articles are generated and stored before anything changes.
 *
 * Only the operator should call this once the customer has approved any
 * change they were asked for.
 */
ordersRouter.post("/api/orders/:orderId/resubmitted-to-sunbiz", oneStep, async (req, res) => {
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
  const orderId = req.params.orderId;
  const filedAnyway = filedWithoutApprovalReason(req.body);

  try {
    let recorded: RecordedFiling | null = null;
    const approved = await pool.query<{ filing_approved_name: string | null; fulfillment_status: string; filing_data: { llc_name?: string } | null }>(
      `SELECT o.filing_approved_name, o.fulfillment_status, fs.filing_data FROM orders o JOIN filing_sessions fs ON fs.filing_session_id = o.filing_session_id WHERE o.order_id = $1`,
      [orderId]
    );
    const approvedName = approved.rows[0]?.filing_approved_name;
    if (approvedName && corrections.llc_name === undefined && approved.rows[0].fulfillment_status === "rejected" && !sameEntityName(approvedName, approved.rows[0].filing_data?.llc_name)) {
      corrections.llc_name = approvedName;
    }
    const correcting = Object.keys(corrections).length > 0;
    let corrected: CorrectedFiling | null = null;
    if (correcting) {
      const built = await buildCorrectedFiling(orderId, corrections);
      if ("status" in built) {
        res.status(built.status).json(built.body);
        return;
      }
      corrected = built;
    }

    const outcome = await withLockedOrder(orderId, async (client, order) => {
      const diy = hasDiyPackage(order.line_items ?? []);
      const alreadyHappened = (diy && Boolean(order.filing_approved_at)) || Boolean(filedAnyway);
      const refused = alreadyHappened ? cannotRecordFiling(order) : filingRefusal(order);
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
      const correctedName = typeof corrections.llc_name === "string" ? corrections.llc_name : undefined;
      let nameClash: string | null = null;
      if (alreadyHappened) {
        nameClash = await claimNameOfRecordedFiling(client, order, correctedName);
      } else {
        if (diy) return FILING_NOT_APPROVED(order.order_id);
        const blocker = await findFilingBlocker(client, order);
        if (blocker) return { status: 409, body: { ...blocker, order_id: order.order_id } };
        const nameTaken = await claimFilingName(client, order, correctedName);
        if (nameTaken) return nameTaken;
      }

      if (corrected) await storeCorrectedFiling(client, order, corrected, correctedName);
      const tracking = trackingNumber || order.sunbiz_tracking_number;
      await client.query(`UPDATE orders SET fulfillment_status = 'transmitted', sunbiz_tracking_number = $2, sunbiz_resubmitted_at = now(), approved_unrecorded_at = NULL, filing_approved_name = NULL WHERE order_id = $1`, [order.order_id, tracking]);
      await filingEvent(client, order, "sunbiz_resubmitted", { tracking_number: tracking, corrected_fields: Object.keys(corrections), ...(filedAnyway ? { filed_without_approval_reason: filedAnyway } : {}) });
      if (alreadyHappened) recorded = { order, filedAnyway, nameClash };

      const days = order.sunbiz_rejected_at ? (Date.now() - new Date(order.sunbiz_rejected_at).getTime()) / (24 * 3600 * 1000) : 0;
      return { ok: true, body: { order_id: order.order_id, status: "resubmitted", tracking_number: tracking, corrected_fields: Object.keys(corrections), within_60_days: days <= DAYS_TO_KEEP_FILING_DATE } };
    });
    if (recorded) await alertIfFiledOutsideApproval(recorded);
    if ("ok" in outcome) res.status(200).json(outcome.body);
    else res.status(outcome.status).json(outcome.body);
  } catch (err) {
    if (isDuplicateFiling(err)) {
      res.status(409).json(DUPLICATE_FILING_BODY);
      return;
    }
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
 * being paid twice: while a charge has no clear answer, which calling proof of
 * filing again settles, or if Stripe lists a payment for this order.
 */
ordersRouter.post("/api/orders/:orderId/payment-received", oneStep, async (req, res) => {
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
      collection_unknown_at: Date | null;
    }>(
      `SELECT order_id, filing_session_id, payment_status, stripe_payment_intent_id, total_cents, deferred_cents, deferred_payment_intent_id, deferred_charged_at,
              saved_card_payment_intent_id, proof_of_filing_at, cancelled_at, crm_deal_id, collection_unknown_at
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
    if (order.collection_unknown_at) {
      res.status(409).json({ error: "a card charge on this order got no clear answer, so the customer may have paid. Call proof of filing again to settle it first", code: "collection_unknown", order_id: orderId });
      return;
    }
    // A charge that failed with no clear answer may still have gone through.
    // Only the first $139 is checked: a paid order's own payment is listed too.
    const heldNow = order.payment_status === "authorized" && !!order.stripe_payment_intent_id;
    if (["authorized", "released"].includes(order.payment_status) && order.stripe_payment_intent_id) {
      const intent = await retrievePaymentIntent(order.stripe_payment_intent_id);
      if (intent.status === "succeeded") {
        res.status(409).json({ error: "Stripe shows this hold was collected, so the card has been charged", code: "already_collected", order_id: orderId });
        return;
      }
      const landed = intent.customer ? await findCollectedPayment(intent.customer, orderId) : null;
      if (landed) {
        res.status(409).json({ error: `Stripe shows ${landed.id} was collected for this order, so the card has been charged`, code: "already_collected", payment_intent: landed.id, order_id: orderId });
        return;
      }
    }

    const updated = await pool.query(
      `UPDATE orders
       SET payment_status = 'paid', paid_at = COALESCE(paid_at, now()), capture_error = NULL, collection_unknown_at = NULL, deferred_charge_error = NULL,
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

    await closeUntrackedHolds(pool, orderId);
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
 *
 * With no clear answer (`unknown`) the money may have moved, so nobody is told
 * it did not. The customer is not asked to pay another way, and the order
 * remembers, until calling proof of filing again settles it: a decline then
 * sends the email. Returns whether the email was queued.
 */
async function recordCaptureError(order: { order_id: string; filing_session_id: string }, err: unknown, amountCents: number, unknown: boolean): Promise<boolean> {
  const orderId = order.order_id;
  try {
    await pool.query(`UPDATE orders SET capture_error = $2, collection_unknown_at = $3 WHERE order_id = $1`, [orderId, describeError(err), unknown ? new Date() : null]);
  } catch (e) {
    console.error(`[payments] could not record capture error for ${orderId}:`, describeError(e));
  }
  console.error(`[payments] collection problem on order ${orderId}:`, describeError(err));
  if (unknown) {
    await sendOpsAlert(
      "Payment result unknown",
      `Order ${orderId}: ${describeError(err)}. Proof of filing is recorded. Stripe gave no clear answer, so the card may have been charged. Call proof of filing again to settle it. Do not ask the customer for another payment until then.`
    );
    return false;
  }
  const customerEmailed = await askCustomerToArrangePayment(order, amountCents, "fallback");
  await sendOpsAlert(
    "Payment could not be collected",
    `Order ${orderId}: ${describeError(err)}. Proof of filing is recorded; the card was not charged. ${customerEmailed ? "The customer has been emailed to arrange payment." : "The customer email could not be queued."} Calling proof of filing again retries the charge.`
  );
  return customerEmailed;
}
