import { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { pool } from "../db/pool.js";
import { describeError } from "../db/describeError.js";
import { cancelPaymentIntent, capturePaymentIntent, deactivatePaymentLink, StripeApiError } from "../stripe/restClient.js";
import { holdNoLongerCapturable } from "../payments/holdState.js";
import { sendOpsAlert } from "../ops/alerts.js";
import { effectiveDateProblem, floridaToday, windowForFilingDate } from "../filing/effectiveDateWindow.js";
import { alertEmailsNotQueued, enqueueCustomerEmails, listOrderEmails } from "../orderEmails/worker.js";
import { saveSunbizFilingDate } from "../formation/operatingAgreementJob.js";

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

interface ProofOrder {
  order_id: string;
  filing_session_id: string;
  payment_status: string;
  stripe_payment_intent_id: string | null;
  total_cents: number;
  currency: string;
}

/** Records the proof and queues the filing confirmation in one transaction.
 *  The UPDATE's row lock is what enqueueCustomerEmails relies on. Orders
 *  with nothing paid or held get no email. */
async function recordProofAndQueueConfirmation(orderId: string, documentNumber: string): Promise<ProofOrder | null> {
  const client = await pool.connect();
  let order: ProofOrder | null = null;
  let emailQueued = true;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<ProofOrder>(
      `UPDATE orders
       SET proof_of_filing_ref = COALESCE(proof_of_filing_ref, $2), proof_of_filing_at = COALESCE(proof_of_filing_at, now())
       WHERE order_id = $1
       RETURNING order_id, filing_session_id, payment_status, stripe_payment_intent_id, total_cents, currency`,
      [orderId, documentNumber]
    );
    order = rows[0] ?? null;
    if (order && ["authorized", "released", "paid"].includes(order.payment_status)) {
      emailQueued = await enqueueCustomerEmails(client, {
        orderId: order.order_id,
        filingSessionId: order.filing_session_id,
        emailTypes: ["filing_confirmation"],
        paymentMode: order.payment_status === "paid" ? "paid" : order.payment_status === "released" ? "released" : "hold",
      });
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  if (!emailQueued) {
    await alertEmailsNotQueued(orderId, "the filing confirmation email");
  }
  return order;
}

/**
 * POST /api/orders/:orderId/proof-of-filing
 * Body: { document_number: string }
 *
 * Records proof of filing (the Sunbiz document number of the filed
 * Articles) and collects the held payment if it was not already collected
 * at submission. Under the owner's final hold rule (25 Nov 2026) the hold is
 * captured when the Articles are SUBMITTED to Sunbiz, through
 * POST /api/orders/:orderId/sunbiz-submitted below; this route is the
 * fallback for an order whose submission was not recorded. Both use the same
 * Stripe idempotency key, so the hold is never captured twice.
 *
 * If the hold can no longer be collected (it expired or was released),
 * NOTHING is charged (owner's final hold rule, 25 Nov 2026: a lapsed hold is
 * never auto-charged; the off-session saved-card charge that used to run here
 * is removed). The route answers 409 fresh_consent_required and alerts ops.
 * A hold released by the Day-5 job (payments/holdRelease.ts) already sent the
 * customer a Payment Link for the same amount. The order becomes "paid" only
 * when Stripe's own payment_intent.succeeded webhook arrives — this route
 * never marks an order paid itself.
 *
 * The customer's filing confirmation is queued with the proof, before
 * collection is requested, so a collection problem cannot hold back the
 * news that the LLC is filed. A repeat call does not queue it again.
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

  // T144 D10: optional Sunbiz filing date of the Articles (YYYY-MM-DD), used by
  // the Operating Agreement. Stored separately below; nothing about recording the
  // proof or collecting the hold depends on it.
  const filingDate = typeof req.body?.filing_date === "string" ? req.body.filing_date.trim() : undefined;
  if (filingDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(filingDate)) {
    res.status(400).json({ error: "filing_date must be YYYY-MM-DD (the date Sunbiz filed the Articles)" });
    return;
  }

  const orderId = req.params.orderId;
  let order: ProofOrder;
  try {
    const recorded = await recordProofAndQueueConfirmation(orderId, documentNumber);
    if (!recorded) {
      res.status(404).json({ error: "order not found" });
      return;
    }
    order = recorded;
  } catch (err) {
    res.status(500).json({ error: "could not record proof of filing", detail: describeError(err) });
    return;
  }
  if (filingDate) {
    // Best effort, never blocks collection: before migration 0036 the column does not exist.
    await saveSunbizFilingDate(pool, order.order_id, filingDate).catch((err) => {
      console.error(`[proof of filing] Sunbiz filing date not saved for order ${order.order_id}:`, err);
    });
  }

  await collectHeldPayment(order, "Proof of filing is recorded", res);
});

/**
 * Captures a held order's payment, or reports why nothing can be collected.
 * Shared by the Sunbiz-submission and proof-of-filing routes; the idempotency
 * key is the same for both, so a retry or the second route never captures twice.
 * An expired or released hold charges nothing: 409 fresh_consent_required.
 */
async function collectHeldPayment(
  order: { order_id: string; payment_status: string; stripe_payment_intent_id: string | null },
  context: string,
  res: Response
): Promise<void> {
  if (order.payment_status === "paid") {
    res.status(200).json({ order_id: order.order_id, status: "already_paid" });
    return;
  }
  if (!["authorized", "released"].includes(order.payment_status) || !order.stripe_payment_intent_id) {
    res.status(409).json({ error: `order payment_status is ${order.payment_status}; nothing held to collect`, order_id: order.order_id });
    return;
  }

  if (order.payment_status === "authorized") {
    try {
      const captured = await capturePaymentIntent(order.stripe_payment_intent_id, `capture-${order.order_id}`);
      res.status(200).json({ order_id: order.order_id, status: "collection_requested", payment_intent_status: captured.status });
      return;
    } catch (err) {
      const code = err instanceof StripeApiError ? (err.stripeError as { code?: string } | undefined)?.code : undefined;
      if (!holdNoLongerCapturable(code)) {
        await recordCaptureError(order.order_id, err, context);
        res.status(502).json({ error: "collection failed", detail: describeError(err), order_id: order.order_id });
        return;
      }
      // Hold expired or released: fall through. Fresh consent is required.
    }
  }

  // An expired or released hold charges nothing here. The order is flagged and
  // ops is alerted so the customer can approve a new payment.
  const reason = order.payment_status === "released" ? "hold_released" : "hold_expired";
  const paymentLinkUrl = await flagFreshConsentRequired(order.order_id, reason, context);
  res.status(409).json({
    order_id: order.order_id,
    status: "fresh_consent_required",
    reason,
    payment_link_url: paymentLinkUrl,
    detail: paymentLinkUrl
      ? "The card hold can no longer be collected. Nothing was charged. The customer was already emailed a payment link for the same amount."
      : "The card hold can no longer be collected. Nothing was charged. Ask the customer to approve a new payment.",
  });
}

/**
 * POST /api/orders/:orderId/sunbiz-submitted (operator)
 * Body: { tracking_ref: string } (the Sunbiz tracking/confirmation number of the submission)
 *
 * Rule 1 of the owner's final hold rule (25 Nov 2026): the hold is captured
 * when the Articles are SUBMITTED to Sunbiz, never later (Florida's approval
 * can take longer than the hold lasts). Records the submission
 * (sunbiz_submitted_at, sunbiz_submission_ref; migration 0038) and captures the
 * hold. The Day-5 job never releases a submitted order. No customer email is
 * sent here: the filing confirmation goes out with the document number
 * (proof-of-filing). Repeat calls are safe (same capture idempotency key).
 */
ordersRouter.post("/api/orders/:orderId/sunbiz-submitted", async (req, res) => {
  if (!operatorAuthorized(req)) {
    res.status(401).json({ error: "operator key required" });
    return;
  }
  const trackingRef = typeof req.body?.tracking_ref === "string" ? req.body.tracking_ref.trim() : "";
  if (!/^[A-Z0-9-]{4,30}$/i.test(trackingRef)) {
    res.status(400).json({ error: "tracking_ref is required (the Sunbiz tracking or confirmation number of the submission)" });
    return;
  }
  let order: { order_id: string; payment_status: string; stripe_payment_intent_id: string | null };
  try {
    const { rows } = await pool.query<{ order_id: string; payment_status: string; stripe_payment_intent_id: string | null }>(
      `UPDATE orders
       SET sunbiz_submitted_at = COALESCE(sunbiz_submitted_at, now()), sunbiz_submission_ref = COALESCE(sunbiz_submission_ref, $2)
       WHERE order_id = $1
       RETURNING order_id, payment_status, stripe_payment_intent_id`,
      [req.params.orderId, trackingRef]
    );
    if (!rows.length) {
      res.status(404).json({ error: "order not found" });
      return;
    }
    order = rows[0];
  } catch (err) {
    const missing = (err as { code?: string })?.code === "42703";
    res.status(missing ? 503 : 500).json({
      error: missing ? "apply migration 0038 first (sunbiz_submitted_at)" : "could not record the Sunbiz submission",
      detail: describeError(err),
    });
    return;
  }
  await collectHeldPayment(order, "The filing is submitted to Sunbiz", res);
});

/**
 * POST /api/orders/:orderId/close-payment-link (operator)
 *
 * Deactivates the Day-5 Payment Link (the customer asked to close the order,
 * was refunded, or paid another way), so it can no longer be paid.
 */
ordersRouter.post("/api/orders/:orderId/close-payment-link", async (req, res) => {
  if (!operatorAuthorized(req)) {
    res.status(401).json({ error: "operator key required" });
    return;
  }
  try {
    const { rows } = await pool.query<{ payment_link_id: string | null; payment_status: string }>(
      `SELECT payment_link_id, payment_status FROM orders WHERE order_id = $1`,
      [req.params.orderId]
    );
    if (!rows.length) {
      res.status(404).json({ error: "order not found" });
      return;
    }
    if (!rows[0].payment_link_id) {
      res.status(409).json({ error: "this order has no Day-5 payment link" });
      return;
    }
    const link = await deactivatePaymentLink(rows[0].payment_link_id, `close-paylink-${req.params.orderId}`);
    await pool.query(`UPDATE orders SET payment_link_closed_at = COALESCE(payment_link_closed_at, now()) WHERE order_id = $1`, [req.params.orderId]);
    res.status(200).json({ order_id: req.params.orderId, payment_link_id: link.id, active: link.active, payment_status: rows[0].payment_status });
  } catch (err) {
    res.status(502).json({ error: "could not close the payment link", detail: describeError(err) });
  }
});

/** Records why nothing was collected and alerts ops. Returns the Day-5 Payment Link, if one was sent. */
async function flagFreshConsentRequired(orderId: string, reason: string, context: string): Promise<string | null> {
  let paymentLinkUrl: string | null = null;
  try {
    await pool.query(`UPDATE orders SET capture_error = $2 WHERE order_id = $1`, [orderId, `fresh_consent_required:${reason}`]);
  } catch (e) {
    console.error(`[payments] could not flag fresh consent for ${orderId}:`, describeError(e));
  }
  try {
    const { rows } = await pool.query<{ payment_link_url: string | null }>(`SELECT payment_link_url FROM orders WHERE order_id = $1`, [orderId]);
    paymentLinkUrl = rows[0]?.payment_link_url ?? null;
  } catch {
    // Before migration 0038 the column does not exist: no link was sent.
  }
  await sendOpsAlert(
    "New payment approval needed",
    `Order ${orderId}: ${context.charAt(0).toLowerCase() + context.slice(1)} but the card hold is ${reason === "hold_released" ? "released" : "expired"}. Nothing was charged. ` +
      (paymentLinkUrl
        ? `The customer was emailed a payment link for the same amount at Day 5: ${paymentLinkUrl}`
        : "Ask the customer to approve a new payment.")
  );
  return paymentLinkUrl;
}

/**
 * POST /api/orders/:orderId/effective-date-check (operator)
 *
 * ST08: run right before submitting the Articles to Sunbiz. Re-checks a
 * chosen effective date against Florida's window for a filing made today.
 * Out of range: the order is paused (requires_review, with the reason) and
 * the answer is 409, so the date is not filed; ask the customer for a new
 * date. No payment is touched.
 */
ordersRouter.post("/api/orders/:orderId/effective-date-check", async (req, res) => {
  if (!operatorAuthorized(req)) {
    res.status(401).json({ error: "operator key required" });
    return;
  }
  try {
    const { rows } = await pool.query<{ filing_data: { effective_date_option?: string; effective_date?: string } | null }>(
      `SELECT fs.filing_data FROM orders o JOIN filing_sessions fs ON fs.filing_session_id = o.filing_session_id
       WHERE o.order_id = $1`,
      [req.params.orderId]
    );
    if (!rows.length) {
      res.status(404).json({ error: "order not found" });
      return;
    }
    const today = floridaToday();
    const problem = effectiveDateProblem(rows[0].filing_data ?? {}, today);
    if (problem) {
      await pool.query(
        `UPDATE orders SET fulfillment_status = 'requires_review', fulfillment_last_error = $2 WHERE order_id = $1`,
        [req.params.orderId, problem]
      );
      res.status(409).json({ ok: false, error: problem });
      return;
    }
    res.status(200).json({ ok: true, submission_date: today, window: windowForFilingDate(today) });
  } catch (err) {
    res.status(500).json({ error: "effective date check failed", detail: describeError(err) });
  }
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

async function recordCaptureError(orderId: string, err: unknown, context: string): Promise<void> {
  try {
    await pool.query(`UPDATE orders SET capture_error = $2 WHERE order_id = $1`, [orderId, describeError(err)]);
  } catch (e) {
    console.error(`[payments] could not record capture error for ${orderId}:`, describeError(e));
  }
  console.error(`[payments] collection problem on order ${orderId}:`, describeError(err));
  await sendOpsAlert("Payment could not be collected", `Order ${orderId}: ${describeError(err)}. ${context}; the card was not charged.`);
}
