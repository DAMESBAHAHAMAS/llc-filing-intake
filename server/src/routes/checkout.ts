import { Router } from "express";
import { pool } from "../db/pool.js";
import { createCheckoutSession, getCheckoutSessionStatus } from "../checkout/checkoutService.js";
import { realStripeCheckoutClient } from "../checkout/stripeCheckoutClient.js";

export const checkoutRouter = Router();

/**
 * POST /checkout/session
 *
 * Thin HTTP wrapper around checkoutService.createCheckoutSession — see
 * that module for the actual gate / order-persistence / Stripe-call
 * sequencing and failure handling. This layer only maps the result to
 * status codes, preserving the original checkout.ts's codes (Gate 2
 * checkout-session-endpoint branch): 400 for bad input, 409 for "not
 * ready for checkout", 500 for a DB failure, 502 for a Stripe failure.
 */
checkoutRouter.post("/checkout/session", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const filingSessionId = typeof body.filing_session_id === "string" ? body.filing_session_id : "";
  const crmIntent = typeof body.crm_intent === "string" ? body.crm_intent : "";

  if (!filingSessionId || !crmIntent) {
    res.status(400).json({ error: "filing_session_id and crm_intent are required" });
    return;
  }

  const result = await createCheckoutSession(pool, realStripeCheckoutClient, {
    filingSessionId,
    crmIntent,
  });

  if (result.ok) {
    res.status(200).json({ checkout_url: result.checkoutUrl, order_id: result.orderId, reused_order: result.reusedOrder });
    return;
  }

  switch (result.reason) {
    case "missing_fields":
      res.status(400).json({ error: "filing_session_id and crm_intent are required" });
      return;
    case "unknown_crm_intent":
      res.status(400).json({ error: `Unknown crm_intent: ${crmIntent}` });
      return;
    case "session_not_ready":
    case "stage_not_complete":
      res.status(409).json({ error: "Filing session is not ready for checkout" });
      return;
    case "session_lookup_failed":
      res.status(500).json({ error: "filing session lookup failed", detail: result.detail });
      return;
    case "order_persist_failed":
      res.status(500).json({ error: "order creation failed", detail: result.detail });
      return;
    case "stripe_failed":
      console.error("Stripe Checkout Session creation failed:", result.detail);
      res.status(502).json({ error: "Unable to create checkout session", order_id: result.orderId });
      return;
  }
});

/**
 * GET /checkout/session-status?session_id=cs_test_...
 *
 * Read-only lookup for the frontend's /checkout/success and /checkout/cancel
 * pages (Gate 2 return-routes task). Never writes anything — payment state
 * is established exclusively by the verified webhook
 * (webhook/stripeWebhookService.ts), never by a customer landing on or
 * refreshing a return page. See checkoutService.getCheckoutSessionStatus's
 * own comment for why this is keyed on the Stripe session id, not on a
 * client-supplied order_id/filing_session_id, and for the fields
 * deliberately excluded from the response.
 */
checkoutRouter.get("/checkout/session-status", async (req, res) => {
  const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : "";
  if (!sessionId) {
    res.status(400).json({ error: "session_id is required" });
    return;
  }

  const status = await getCheckoutSessionStatus(pool, sessionId);
  if (!status.found) {
    res.status(404).json({ found: false });
    return;
  }

  res.status(200).json({
    found: true,
    order_id: status.orderId,
    filing_session_id: status.filingSessionId,
    crm_intent: status.crmIntent,
    product: status.product,
    checkout_status: status.checkoutStatus,
    payment_status: status.paymentStatus,
    total_cents: status.totalCents,
    currency: status.currency,
  });
});
