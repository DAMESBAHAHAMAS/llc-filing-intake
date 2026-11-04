import { Router } from "express";
import { closedCodesIn } from "../offers/closedOffers.js";
import { pool } from "../db/pool.js";
import { describeError } from "../db/describeError.js";
import { resolveActiveOffers } from "../offers/catalog.js";
import { createCheckoutSession, expireCheckoutSession, retrieveCheckoutSession, StripeApiError } from "../stripe/restClient.js";
import { getEinExpressAvailability } from "../ein/capacity.js";
import { houseAgentLineMissing } from "../offers/houseAgentRule.js";
import { deferredServiceCents, holdCheckoutText, holdsEnabled, requiresPayAfterFiling } from "../offers/payAfterFiling.js";
import { needsSunbizFiling } from "../offers/sunbizFiling.js";
import { articlesBlockers } from "../pdf/context.js";
import type { FilingSessionRecord } from "../pdf/types.js";
import { findOrderConflict, isUnfinishedCheckout, listSessionOrders, type SessionOrder } from "../payments/openOrders.js";

export const checkoutRouter = Router();

interface RequestedLineItem {
  offer_code: string;
  quantity: number;
}

function parseLineItems(body: Record<string, unknown>): RequestedLineItem[] | null {
  const raw = body.line_items;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const items: RequestedLineItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const offerCode = (entry as Record<string, unknown>).offer_code;
    const quantityRaw = (entry as Record<string, unknown>).quantity ?? 1;
    if (typeof offerCode !== "string" || !offerCode.trim()) return null;
    const quantity = Number(quantityRaw);
    if (!Number.isInteger(quantity) || quantity < 1) return null;
    items.push({ offer_code: offerCode.trim(), quantity });
  }
  return items;
}

/** A crashed request can leave a pending order with no Stripe session behind it. */
const STALE_UNFINISHED_CHECKOUT_MS = 2 * 60 * 1000;

const ORDER_ALREADY_OPEN = (orderId: string) => ({
  error: "this filing already has an order",
  code: "order_already_open",
  order_id: orderId,
});

/**
 * Closes an earlier checkout that was started and never finished, so two open
 * Stripe tabs cannot become two holds. The newest checkout is the one the
 * customer is looking at. Stripe's refusal is what tells us the customer paid
 * in the other tab before its webhook arrived. Returns the state that stops
 * this checkout, if any.
 */
async function closeUnfinishedCheckout(order: SessionOrder): Promise<"closed" | "paid" | "in_progress"> {
  if (order.stripe_checkout_session_id) {
    try {
      await expireCheckoutSession(order.stripe_checkout_session_id);
    } catch (err) {
      const session = await retrieveCheckoutSession(order.stripe_checkout_session_id);
      if (session.status === "complete") return "paid";
      if (session.status !== "expired") throw err;
    }
  } else if (Date.now() - new Date(order.created_at).getTime() < STALE_UNFINISHED_CHECKOUT_MS) {
    return "in_progress";
  }
  await pool.query(`UPDATE orders SET payment_status = 'failed', failure_reason = 'replaced_by_new_checkout' WHERE order_id = $1 AND payment_status = 'pending'`, [order.order_id]);
  return "closed";
}

/**
 * POST /api/checkout/create
 *
 * Body: { filing_session_id: string, line_items: [{ offer_code, quantity? }] }
 *
 * The browser sends offer_code identifiers ONLY — never an amount, price,
 * or total (frozen rule). Every offer_code is resolved server-side
 * against the Offer Master (offers table, status='active' only); a
 * request naming an offer_code that doesn't resolve (unknown, retired,
 * or still 'draft' — e.g. EIN_FILING_EXPRESS pending price confirmation)
 * is rejected outright, not silently dropped from the cart.
 *
 * Order-before-Checkout-Session ordering (frozen rule + standing rule 2):
 * the `orders` row is inserted with checkout_status='pending' BEFORE any
 * call to Stripe. If Stripe's API call then fails, the order row is
 * updated to checkout_status='checkout_failed' with failure_reason set —
 * it is never deleted, and the failure is visible for retry/support.
 *
 * One order per filing: a session whose filing already has an order gets
 * 409 order_already_open, and an unfinished earlier checkout is closed first
 * (payments/openOrders.ts). A filing whose Articles could not be built gets
 * 422 filing_data_incomplete, so no card is held for it.
 */
checkoutRouter.post("/api/checkout/create", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const filingSessionId = typeof body.filing_session_id === "string" ? body.filing_session_id.trim() : "";

  if (!filingSessionId) {
    res.status(400).json({ error: "filing_session_id is required" });
    return;
  }

  const requestedItems = parseLineItems(body);
  if (!requestedItems) {
    res.status(400).json({ error: "line_items must be a non-empty array of { offer_code, quantity? }" });
    return;
  }

  // Offers closed at launch (offers/closedOffers.ts): refused before any
  // database or Stripe work.
  const closedRequested = closedCodesIn(requestedItems.map((i) => i.offer_code));
  if (closedRequested.length > 0) {
    res.status(422).json({ error: "offer not currently available", closed_offer_codes: closedRequested });
    return;
  }

  const frontendBaseUrl = process.env.FRONTEND_BASE_URL;
  if (!frontendBaseUrl) {
    res.status(500).json({ error: "server misconfigured: FRONTEND_BASE_URL not set" });
    return;
  }

  try {
    const session = await pool.query<{
      email: string | null;
      crm_deal_id: string | null;
      filing_data: (Partial<FilingSessionRecord> & { filing_authorization?: { accepted?: unknown } | null }) | null;
    }>(
      "SELECT email, crm_deal_id, filing_data FROM filing_sessions WHERE filing_session_id = $1",
      [filingSessionId]
    );
    if (session.rowCount === 0) {
      res.status(404).json({ error: "unknown filing_session_id — call POST /api/session/stage first" });
      return;
    }

    const uniqueCodes = [...new Set(requestedItems.map((i) => i.offer_code))];

    // An LLC filing order needs the customer's authorization to file and
    // sign for them (filing_data.filing_authorization, written at intake
    // by the website) before the card is touched.
    if (needsSunbizFiling(requestedItems) && session.rows[0].filing_data?.filing_authorization?.accepted !== true) {
      res.status(422).json({
        error: "filing authorization is required before checkout for an LLC filing",
        code: "filing_authorization_required",
      });
      return;
    }

    // The Articles have to be buildable from what was saved. Finding out
    // after the card is held helps nobody.
    if (needsSunbizFiling(requestedItems)) {
      const missingFields = articlesBlockers(session.rows[0].filing_data);
      if (missingFields.length) {
        res.status(422).json({
          error: "the Articles of Organization cannot be built from this filing's details",
          code: "filing_data_incomplete",
          missing_fields: missingFields,
        });
        return;
      }
    }

    // Registered-agent billing rule: choosing Damian as agent means the
    // 3-year agent service must be on the order (routes/../houseAgentRule.ts).
    if (session.rows[0].filing_data?.registered_agent_path === "house") {
      const paidAgent = await pool.query(
        `SELECT 1 FROM orders
          WHERE filing_session_id = $1 AND payment_status IN ('paid', 'authorized')
            AND line_items @> '[{"offer_code":"REGISTERED_AGENT_3YR"}]'::jsonb
          LIMIT 1`,
        [filingSessionId]
      );
      if (houseAgentLineMissing("house", uniqueCodes, (paidAgent.rowCount ?? 0) > 0)) {
        res.status(422).json({
          error: "registered agent service is required when Damian Knowles is the registered agent",
          required_offer_code: "REGISTERED_AGENT_3YR",
        });
        return;
      }
    }
    const resolved = await resolveActiveOffers(pool, uniqueCodes);
    const resolvedByCode = new Map(resolved.map((o) => [o.offer_code, o]));

    const unknownCodes = uniqueCodes.filter((c) => !resolvedByCode.has(c));
    if (unknownCodes.length > 0) {
      res.status(422).json({
        error: "one or more offer_code values do not resolve to a sellable offer",
        unknown_offer_codes: unknownCodes,
      });
      return;
    }

    if (uniqueCodes.includes("EIN_FILING_EXPRESS")) {
      const availability = await getEinExpressAvailability(pool);
      if (!availability.available) {
        res.status(409).json({
          error: "EIN Filing Express is at today's same-day capacity",
          ein_express_availability: availability,
        });
        return;
      }
    }

    const sessionOrders = await listSessionOrders(pool, filingSessionId);
    const conflict = findOrderConflict(requestedItems, sessionOrders);
    if (conflict) {
      res.status(409).json(ORDER_ALREADY_OPEN(conflict.order_id));
      return;
    }
    for (const order of sessionOrders.filter(isUnfinishedCheckout)) {
      const outcome = await closeUnfinishedCheckout(order);
      if (outcome === "paid") {
        res.status(409).json(ORDER_ALREADY_OPEN(order.order_id));
        return;
      }
      if (outcome === "in_progress") {
        res.status(409).json({ error: "a checkout for this filing is already starting", code: "checkout_in_progress" });
        return;
      }
    }

    const lineItemSnapshots = requestedItems.map((item) => {
      const offer = resolvedByCode.get(item.offer_code)!;
      return {
        offer_code: offer.offer_code,
        offer_version: offer.offer_version,
        display_name: offer.display_name,
        stripe_price_id: offer.stripe_price_id,
        unit_amount_cents: offer.unit_amount_cents,
        quantity: item.quantity,
      };
    });

    const totalCents = lineItemSnapshots.reduce((sum, li) => sum + li.unit_amount_cents * li.quantity, 0);
    const primaryOffer = resolvedByCode.get(requestedItems[0].offer_code)!;

    // Pay-after-filing: filing orders place a card hold that is collected
    // only when proof of filing is recorded (routes/orders.ts).
    const captureMode = holdsEnabled() && requiresPayAfterFiling(lineItemSnapshots) ? "hold" : "immediate";
    // Services delivered after the filing (EIN) are charged when complete,
    // not at proof of filing. Only meaningful on a held order.
    const deferredCents = captureMode === "hold" ? deferredServiceCents(lineItemSnapshots) : 0;

    // The session row's lock makes the last check and the insert one step, so
    // two requests at the same moment cannot both pass. It is released before
    // Stripe is called.
    const dbClient = await pool.connect();
    let orderId: string;
    try {
      await dbClient.query("BEGIN");
      await dbClient.query("SELECT filing_session_id FROM filing_sessions WHERE filing_session_id = $1 FOR UPDATE", [filingSessionId]);
      const latest = await listSessionOrders(dbClient, filingSessionId);
      const nowConflicting = findOrderConflict(requestedItems, latest);
      if (nowConflicting || latest.some(isUnfinishedCheckout)) {
        await dbClient.query("ROLLBACK");
        if (nowConflicting) res.status(409).json(ORDER_ALREADY_OPEN(nowConflicting.order_id));
        else res.status(409).json({ error: "a checkout for this filing is already starting", code: "checkout_in_progress" });
        return;
      }
      const orderInsert = await dbClient.query<{ order_id: string }>(
        `INSERT INTO orders (filing_session_id, crm_intent, product, line_items, total_cents, currency, checkout_status, deferred_cents, capture_mode)
         VALUES ($1, $2, $3, $4, $5, 'usd', 'pending', $6, $7)
         RETURNING order_id`,
        [filingSessionId, primaryOffer.crm_intent, primaryOffer.offer_code, JSON.stringify(lineItemSnapshots), totalCents, deferredCents, captureMode]
      );
      orderId = orderInsert.rows[0].order_id;
      await dbClient.query("COMMIT");
    } catch (err) {
      await dbClient.query("ROLLBACK");
      throw err;
    } finally {
      dbClient.release();
    }
    const heldText = captureMode === "hold" ? holdCheckoutText(lineItemSnapshots) : undefined;

    try {
      const stripeSession = await createCheckoutSession({
        filingSessionId,
        lineItems: lineItemSnapshots.map((li) => ({ price: li.stripe_price_id, quantity: li.quantity })),
        successUrl: `${frontendBaseUrl}/checkout/success?filing_session_id=${encodeURIComponent(filingSessionId)}&order_id=${encodeURIComponent(orderId)}&stripe_session_id={CHECKOUT_SESSION_ID}`,
        // /checkout/cancel — matches the route the frontend actually
        // registers (App.tsx). This previously read "/checkout/cancelled",
        // which no frontend route serves, so every customer who abandoned
        // Stripe Checkout would have landed on the 404 page.
        cancelUrl: `${frontendBaseUrl}/checkout/cancel?filing_session_id=${encodeURIComponent(filingSessionId)}&order_id=${encodeURIComponent(orderId)}`,
        customerEmail: session.rows[0].email ?? undefined,
        // Carries a session's existing Deal id, if it has one
        // (filing_sessions.crm_deal_id, see routes/session.ts's
        // POST /api/session/stage), through to the webhook, so it can
        // update that Deal instead of creating a second one. Intake no
        // longer creates Deals (2026-10-23), so a new session has none
        // and the webhook opens the Deal on the verified hold or payment.
        metadata: session.rows[0].crm_deal_id ? { crm_deal_id: session.rows[0].crm_deal_id } : undefined,
        captureMode,
        paymentIntentMetadata: { order_id: orderId, filing_session_id: filingSessionId },
        submitMessage: heldText?.submit,
        afterSubmitMessage: heldText?.afterSubmit,
      });

      await pool.query(
        `UPDATE orders SET checkout_status = 'checkout_created', stripe_checkout_session_id = $2 WHERE order_id = $1`,
        [orderId, stripeSession.id]
      );

      res.status(200).json({
        order_id: orderId,
        checkout_url: stripeSession.url,
        stripe_checkout_session_id: stripeSession.id,
        total_cents: totalCents,
        capture_mode: captureMode,
      });
    } catch (stripeErr) {
      const reason = stripeErr instanceof StripeApiError ? stripeErr.message : describeError(stripeErr);
      await pool.query(
        `UPDATE orders SET checkout_status = 'checkout_failed', failure_reason = $2 WHERE order_id = $1`,
        [orderId, reason]
      );
      res.status(502).json({ error: "checkout session creation failed", order_id: orderId, detail: reason });
    }
  } catch (err) {
    res.status(500).json({ error: "checkout create failed", detail: describeError(err) });
  }
});

/**
 * GET /api/checkout/order/:orderId — polling endpoint for the frontend's
 * "payment succeeded" UI state. Per frozen rule, the browser's success
 * redirect never establishes payment truth by itself; the frontend polls
 * this (or checks it once on landing at the success URL) to read the
 * server's own verified state instead.
 *
 * A released hold is not the end of an order: unless it was cancelled, the
 * saved card is still charged after Florida confirms. `cancelled` is what
 * tells those apart. The reason for a cancellation or a rejection stays out
 * of this response, because anyone with the order id can read it.
 */
checkoutRouter.get("/api/checkout/order/:orderId", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT order_id, filing_session_id, checkout_status, payment_status, failure_reason,
              fulfillment_status, total_cents, currency, proof_of_filing_at, captured_at,
              cancelled_at, sunbiz_submitted_at, sunbiz_rejected_at
       FROM orders WHERE order_id = $1`,
      [req.params.orderId]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "order not found" });
      return;
    }
    res.status(200).json({ ...rows[0], cancelled: rows[0].cancelled_at != null });
  } catch (err) {
    res.status(500).json({ error: "order lookup failed", detail: describeError(err) });
  }
});
