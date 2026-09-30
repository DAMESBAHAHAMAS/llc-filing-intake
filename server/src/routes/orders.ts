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
  };
  try {
    const { rows } = await pool.query(
      `UPDATE orders
       SET proof_of_filing_ref = COALESCE(proof_of_filing_ref, $2), proof_of_filing_at = COALESCE(proof_of_filing_at, now())
       WHERE order_id = $1
       RETURNING order_id, payment_status, stripe_payment_intent_id, total_cents, currency`,
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

  if (order.payment_status === "authorized") {
    try {
      const captured = await capturePaymentIntent(order.stripe_payment_intent_id, `capture-${order.order_id}`);
      res.status(200).json({ order_id: order.order_id, status: "collection_requested", payment_intent_status: captured.status });
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
      amountCents: order.total_cents,
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
}
