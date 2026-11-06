import { randomUUID } from "node:crypto";
import { Router } from "express";
import { pool } from "../db/pool.js";
import { describeError } from "../db/describeError.js";
import { DIY_PACKAGE_OFFER_CODE, DIY_PACKAGE_TOTAL_CENTS, livePriceProblems } from "../offers/diyPackage.js";
import { LIVE_TEST_OFFER_CODE, liveTestEmail } from "../offers/liveTest.js";
import { holdCheckoutText } from "../offers/payAfterFiling.js";
import { createCheckoutSession, retrievePrice } from "../stripe/restClient.js";
import { operatorAuthorized } from "./orders.js";

export const liveTestRouter = Router();

/**
 * POST /api/operator/live-test/checkout
 *
 * Starts the one controlled payment test: the real $139 Price, a real hold,
 * no filing. It is off unless LIVE_TEST_ENABLED and LIVE_TEST_EMAIL are set,
 * needs the operator key, and allows one open test at a time. The hold is
 * collected through POST /api/orders/:id/proof-of-filing, the same route a
 * real order uses. See offers/liveTest.ts for why this order cannot file.
 */
liveTestRouter.post("/api/operator/live-test/checkout", async (req, res) => {
  if (!operatorAuthorized(req)) {
    res.status(401).json({ error: "operator key required" });
    return;
  }
  const email = liveTestEmail();
  if (!email) {
    res.status(404).json({ error: "the live test is off" });
    return;
  }
  const frontendBaseUrl = process.env.FRONTEND_BASE_URL;
  if (!frontendBaseUrl) {
    res.status(500).json({ error: "server misconfigured: FRONTEND_BASE_URL not set" });
    return;
  }

  try {
    const open = await pool.query<{ order_id: string }>(
      `SELECT order_id FROM orders
        WHERE line_items @> $1::jsonb AND payment_status IN ('pending', 'authorized', 'released') AND cancelled_at IS NULL
        LIMIT 1`,
      [JSON.stringify([{ offer_code: LIVE_TEST_OFFER_CODE }])]
    );
    if (open.rowCount) {
      res.status(409).json({ error: "a live test is already open", order_id: open.rows[0].order_id });
      return;
    }

    const offer = await pool.query<{ stripe_price_id: string; unit_amount_cents: number }>(
      `SELECT stripe_price_id, unit_amount_cents FROM offers
        WHERE offer_code = $1 AND status IN ('draft', 'active') ORDER BY created_at DESC LIMIT 1`,
      [DIY_PACKAGE_OFFER_CODE]
    );
    if (!offer.rowCount) {
      res.status(409).json({ error: "the DIY_PACKAGE offer is not in the catalog; run migration 0020" });
      return;
    }
    const priceId = offer.rows[0].stripe_price_id;
    const price = await retrievePrice(priceId);
    const problems = livePriceProblems(price);
    if (problems.length || offer.rows[0].unit_amount_cents !== DIY_PACKAGE_TOTAL_CENTS) {
      res.status(409).json({ error: "the Price is not an active live $139 Price", problems });
      return;
    }

    const lineItems = [
      {
        offer_code: LIVE_TEST_OFFER_CODE,
        offer_version: "v1",
        display_name: "Internal live payment test, no filing",
        stripe_price_id: priceId,
        unit_amount_cents: DIY_PACKAGE_TOTAL_CENTS,
        quantity: 1,
      },
    ];

    const filingSessionId = randomUUID();
    await pool.query(
      `INSERT INTO filing_sessions (filing_session_id, email, full_name, filing_data) VALUES ($1, $2, 'Live payment test', $3)`,
      [filingSessionId, email, JSON.stringify({ live_test: true })]
    );

    const order = await pool.query<{ order_id: string }>(
      `INSERT INTO orders (filing_session_id, crm_intent, product, line_items, total_cents, currency, checkout_status, deferred_cents, capture_mode)
       VALUES ($1, 'LIVE_TEST', $2, $3, $4, 'usd', 'pending', 0, 'hold')
       RETURNING order_id`,
      [filingSessionId, LIVE_TEST_OFFER_CODE, JSON.stringify(lineItems), DIY_PACKAGE_TOTAL_CENTS]
    );
    const orderId = order.rows[0].order_id;

    const text = holdCheckoutText(lineItems);
    let stripeSession;
    try {
      stripeSession = await createCheckoutSession({
        filingSessionId,
        lineItems: [{ price: priceId, quantity: 1 }],
        successUrl: `${frontendBaseUrl}/`,
        cancelUrl: `${frontendBaseUrl}/`,
        customerEmail: email,
        captureMode: "hold",
        metadata: { order_id: orderId, live_test: "true" },
        paymentIntentMetadata: { order_id: orderId, live_test: "true" },
        submitMessage: text.submit,
      });
    } catch (err) {
      // Stripe took nothing, so this attempt must not block the next one.
      await pool.query(`UPDATE orders SET payment_status = 'failed' WHERE order_id = $1`, [orderId]);
      throw err;
    }
    await pool.query(`UPDATE orders SET checkout_status = 'checkout_created', stripe_checkout_session_id = $2 WHERE order_id = $1`, [orderId, stripeSession.id]);

    res.status(201).json({ order_id: orderId, checkout_url: stripeSession.url, capture_mode: "hold" });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      res.status(409).json({ error: "a live test is already open" });
      return;
    }
    res.status(502).json({ error: "the live test could not start", detail: describeError(err) });
  }
});
