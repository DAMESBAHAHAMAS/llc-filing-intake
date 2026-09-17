import { Router } from "express";
import { pool } from "../db/pool.js";
import { describeError } from "../db/describeError.js";
import { resolveActiveOffers } from "../offers/catalog.js";
import { createCheckoutSession, StripeApiError } from "../stripe/restClient.js";
import { getEinExpressAvailability } from "../ein/capacity.js";

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

  const frontendBaseUrl = process.env.FRONTEND_BASE_URL;
  if (!frontendBaseUrl) {
    res.status(500).json({ error: "server misconfigured: FRONTEND_BASE_URL not set" });
    return;
  }

  try {
    const session = await pool.query<{ email: string | null; crm_deal_id: string | null }>(
      "SELECT email, crm_deal_id FROM filing_sessions WHERE filing_session_id = $1",
      [filingSessionId]
    );
    if (session.rowCount === 0) {
      res.status(404).json({ error: "unknown filing_session_id — call POST /api/session/stage first" });
      return;
    }

    const uniqueCodes = [...new Set(requestedItems.map((i) => i.offer_code))];
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

    const orderInsert = await pool.query<{ order_id: string }>(
      `INSERT INTO orders (filing_session_id, crm_intent, product, line_items, total_cents, currency, checkout_status)
       VALUES ($1, $2, $3, $4, $5, 'usd', 'pending')
       RETURNING order_id`,
      [filingSessionId, primaryOffer.crm_intent, primaryOffer.offer_code, JSON.stringify(lineItemSnapshots), totalCents]
    );
    const orderId = orderInsert.rows[0].order_id;

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
        // Carries the Cloudflare Worker's intake-time Deal id (when
        // known — filing_sessions.crm_deal_id, see routes/session.ts's
        // POST /api/session/stage) through to the webhook, so it can
        // update that existing Deal's stage instead of creating a
        // second one. See zoho/client.ts's updateDealStage comment.
        metadata: session.rows[0].crm_deal_id ? { crm_deal_id: session.rows[0].crm_deal_id } : undefined,
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
 */
checkoutRouter.get("/api/checkout/order/:orderId", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT order_id, filing_session_id, checkout_status, payment_status, failure_reason,
              fulfillment_status, total_cents, currency
       FROM orders WHERE order_id = $1`,
      [req.params.orderId]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "order not found" });
      return;
    }
    res.status(200).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: "order lookup failed", detail: describeError(err) });
  }
});
