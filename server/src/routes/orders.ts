import { Router, type Request } from "express";
import { timingSafeEqual } from "node:crypto";
import { pool } from "../db/pool.js";
import { describeError } from "../db/describeError.js";
import {
  cancelPaymentIntent,
  capturePaymentIntent,
  chargeSavedCard,
  retrievePaymentIntent,
  StripeApiError,
} from "../stripe/restClient.js";
import { holdNoLongerCapturable } from "../payments/holdState.js";
import { sendOpsAlert } from "../ops/alerts.js";

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

/**
 * POST /api/orders/:orderId/proof-of-filing
 * Body: { document_number: string }
 *
 * Records proof of filing (the Sunbiz document number of the filed
 * Articles) and then collects the held payment. This is the only path
 * that collects money on a held order — Damian's rule: the card is not
 * charged until proof of filing is delivered.
 *
 * If the hold can no longer be collected (it expired or was released),
 * the card saved at checkout is charged instead. Either way the order
 * becomes "paid" only when Stripe's own payment_intent.succeeded webhook
 * arrives — this route never marks an order paid itself.
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
  let order: {
    order_id: string;
    payment_status: string;
    stripe_payment_intent_id: string | null;
    total_cents: number;
    currency: string;
    deferred_cents?: number | null;
  };
  try {
    const { rows } = await pool.query(
      `UPDATE orders
       SET proof_of_filing_ref = COALESCE(proof_of_filing_ref, $2), proof_of_filing_at = COALESCE(proof_of_filing_at, now())
       WHERE order_id = $1
       RETURNING order_id, payment_status, stripe_payment_intent_id, total_cents, currency, deferred_cents`,
      [orderId, documentNumber]
    );
    if (!rows.length) {
      res.status(404).json({ error: "order not found" });
      return;
    }
    order = rows[0];
  } catch (err) {
    res.status(500).json({ error: "could not record proof of filing", detail: describeError(err) });
    return;
  }

  if (order.payment_status === "paid") {
    res.status(200).json({ order_id: order.order_id, status: "already_paid" });
    return;
  }
  if (!["authorized", "released"].includes(order.payment_status) || !order.stripe_payment_intent_id) {
    res.status(409).json({ error: `order payment_status is ${order.payment_status}; nothing held to collect`, order_id: order.order_id });
    return;
  }

  // Services delivered after the filing (EIN) stay uncollected here; they
  // are charged when complete (POST /api/orders/:id/service-complete).
  const deferred = Math.max(0, Number(order.deferred_cents ?? 0));
  const collectNowCents = order.total_cents - deferred;

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
      // Hold expired or released — fall through to the saved card.
    }
  }

  try {
    const original = await retrievePaymentIntent(order.stripe_payment_intent_id);
    if (!original.customer || !original.payment_method) {
      throw new Error("no saved card on the original payment");
    }
    const charged = await chargeSavedCard({
      customerId: original.customer,
      paymentMethodId: original.payment_method,
      amountCents: collectNowCents,
      currency: order.currency || "usd",
      idempotencyKey: `fallback-${order.order_id}`,
      metadata: { order_id: order.order_id, reason: "hold_expired_before_proof_of_filing" },
    });
    res.status(200).json({ order_id: order.order_id, status: "saved_card_charged", payment_intent_status: charged.status });
  } catch (err) {
    await recordCaptureError(order.order_id, err);
    res.status(502).json({ error: "saved-card charge failed", detail: describeError(err), order_id: order.order_id });
  }
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
    currency: string;
  };
  try {
    const { rows } = await pool.query(
      `SELECT order_id, payment_status, stripe_payment_intent_id, deferred_cents, deferred_payment_intent_id, currency
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

  try {
    const original = await retrievePaymentIntent(order.stripe_payment_intent_id);
    if (!original.customer || !original.payment_method) {
      throw new Error("no saved card on the original payment");
    }
    const charged = await chargeSavedCard({
      customerId: original.customer,
      paymentMethodId: original.payment_method,
      amountCents: order.deferred_cents,
      currency: order.currency || "usd",
      idempotencyKey: `deferred-${order.order_id}`,
      metadata: { order_id: order.order_id, kind: "deferred_service", service_ref: serviceRef },
    });
    await pool.query(
      `UPDATE orders SET deferred_service_ref = $2, deferred_payment_intent_id = $3, deferred_requested_at = now(), deferred_charge_error = NULL
       WHERE order_id = $1`,
      [order.order_id, serviceRef, charged.id]
    );
    res.status(200).json({ order_id: order.order_id, status: "deferred_service_charged", payment_intent_status: charged.status, amount_cents: order.deferred_cents });
  } catch (err) {
    const detail = describeError(err);
    await pool
      .query(`UPDATE orders SET deferred_charge_error = $2, deferred_service_ref = COALESCE(deferred_service_ref, $3) WHERE order_id = $1`, [
        order.order_id,
        detail.slice(0, 500),
        serviceRef,
      ])
      .catch(() => undefined);
    await sendOpsAlert(
      `Service charge failed: order ${order.order_id}`,
      `Charging the saved card for the completed service (${serviceRef}) failed: ${detail}. The customer has not been charged for it.`
    ).catch(() => undefined);
    res.status(502).json({ error: "service charge failed", detail, order_id: order.order_id });
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

async function recordCaptureError(orderId: string, err: unknown): Promise<void> {
  try {
    await pool.query(`UPDATE orders SET capture_error = $2 WHERE order_id = $1`, [orderId, describeError(err)]);
  } catch (e) {
    console.error(`[payments] could not record capture error for ${orderId}:`, describeError(e));
  }
  console.error(`[payments] collection problem on order ${orderId}:`, describeError(err));
  await sendOpsAlert("Payment could not be collected", `Order ${orderId}: ${describeError(err)}. Proof of filing is recorded; the card was not charged.`);
}
