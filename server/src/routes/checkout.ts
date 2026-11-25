import { Router } from "express";
import { closedCodesIn } from "../offers/closedOffers.js";
import { pool } from "../db/pool.js";
import { describeError } from "../db/describeError.js";
import { resolveActiveOffers } from "../offers/catalog.js";
import { createCheckoutSession, StripeApiError } from "../stripe/restClient.js";
import { getEinExpressAvailability } from "../ein/capacity.js";
import { agentLineIssue, coversHouseAgent, dropBundledAgentLine, HOUSE_AGENT_OFFER_CODE, houseAgentLineMissing } from "../offers/houseAgentRule.js";
import { einLineIssue } from "../offers/einBundleRule.js";
import { getEinUpsell, orderedOfferCodes } from "../offers/einUpsell.js";
import { holdsEnabled, requiresPayAfterFiling } from "../offers/payAfterFiling.js";
import {
  KICKOFF_HOLD_CODES,
  KICKOFF_PAYMENT_PLAN,
  buildKickoffLines,
  isKickoffCart,
  kickoffDisclosure,
  kickoffEnabled,
  type KickoffLine,
} from "../offers/financeReadyKickoff.js";
import { einIncluded, einPortalConfig, invitesEnabled, packageFromCodes, portalUrlFor } from "../ein/onboarding.js";
import { einInviteExpected } from "../ein/portalJobs.js";

export const checkoutRouter = Router();

/**
 * ST17: the portal link the success page may show: only once invites go out, and only
 * when this customer's invite can actually be sent (ein/portalJobs.ts einInviteExpected),
 * because the page tells them an invitation is on its way.
 */
async function successPagePortalUrl(filingSessionId: string): Promise<string | null> {
  const cfg = einPortalConfig();
  if (!invitesEnabled(cfg)) return null;
  return (await einInviteExpected(pool, { filingSessionId })) ? portalUrlFor(cfg) : null;
}
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
 * Body: { filing_session_id: string, line_items: [{ offer_code, quantity? }], payment_plan? }
 *
 * payment_plan "finance_ready_kickoff" (offers/financeReadyKickoff.ts) is the only
 * plan: line_items must then be exactly [{ offer_code: "PREMIUM" }], and the order
 * is a card hold for the base Florida filing, with the rest of the Finance-Ready
 * price left for Damian's scope review. Full-price PREMIUM stays closed.
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

  const parsedItems = parseLineItems(body);
  if (!parsedItems) {
    res.status(400).json({ error: "line_items must be a non-empty array of { offer_code, quantity? }" });
    return;
  }
  // Bank-Ready and Finance-Ready include the 3-year registered agent (25 Nov 2026).
  // A website build from before that still adds the $98 line beside them; it is
  // dropped here, not refused, so the customer is charged the package price only.
  const requestedItems = dropBundledAgentLine(parsedItems);
  if (requestedItems.length !== parsedItems.length) {
    console.log(`[checkout] dropped ${HOUSE_AGENT_OFFER_CODE}: included in ${requestedItems.map((i) => i.offer_code).join(", ")}`);
  }

  // Finance-Ready kickoff hold: validated before any database or Stripe work.
  const paymentPlan = body.payment_plan;
  const kickoff = paymentPlan !== undefined && paymentPlan !== null;
  if (kickoff) {
    if (paymentPlan !== KICKOFF_PAYMENT_PLAN) {
      res.status(400).json({ error: "unknown payment_plan", allowed_payment_plans: [KICKOFF_PAYMENT_PLAN] });
      return;
    }
    if (!kickoffEnabled()) {
      res.status(422).json({ error: "offer not currently available", payment_plan: KICKOFF_PAYMENT_PLAN });
      return;
    }
    if (!isKickoffCart(requestedItems)) {
      res.status(422).json({ error: "the Finance-Ready kickoff takes exactly one PREMIUM line and nothing else" });
      return;
    }
    // The customer is told the amount is authorized, not collected, so the
    // kickoff never runs with holds switched off (PAYMENT_CAPTURE_MODE=immediate).
    if (!holdsEnabled()) {
      res.status(503).json({ error: "card holds are switched off, so the Finance-Ready kickoff is unavailable" });
      return;
    }
  }

  // Offers closed at launch (offers/closedOffers.ts): refused before any
  // database or Stripe work. The kickoff is the one way PREMIUM is sold online.
  const closedRequested = kickoff ? [] : closedCodesIn(requestedItems.map((i) => i.offer_code));
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
    const session = await pool.query<{ email: string | null; crm_deal_id: string | null; filing_data: { registered_agent_path?: string } | null }>(
      "SELECT email, crm_deal_id, filing_data FROM filing_sessions WHERE filing_session_id = $1",
      [filingSessionId]
    );
    if (session.rowCount === 0) {
      res.status(404).json({ error: "unknown filing_session_id — call POST /api/session/stage first" });
      return;
    }

    const uniqueCodes = [...new Set(requestedItems.map((i) => i.offer_code))];

    // Offer codes on this session's held or paid orders: what it already has.
    const previousCodes = await orderedOfferCodes(pool, filingSessionId);

    // Registered-agent billing rule (offers/houseAgentRule.ts): choosing Damian as
    // agent needs the 3-year agent service, which Bank-Ready and Finance-Ready
    // (including the kickoff) include and File It buys as the $98 line.
    if (houseAgentLineMissing(session.rows[0].filing_data?.registered_agent_path, uniqueCodes, coversHouseAgent(previousCodes))) {
      res.status(422).json({
        error: "registered agent service is required when Damian Knowles is the registered agent",
        required_offer_code: "REGISTERED_AGENT_3YR",
      });
      return;
    }
    // ...and the $98 line is never sold on top of a package that includes it
    // (in the cart it was dropped above; this refuses it after an earlier order).
    const agentIssue = agentLineIssue(uniqueCodes, previousCodes);
    if (agentIssue) {
      res.status(422).json({
        error: "registered agent service is already included in this order or a previous one; it cannot be purchased again",
        reason: agentIssue,
      });
      return;
    }
    // EIN billing rule (2026-11-22): the EIN is an add-on to File It only. Bank-Ready
    // and Premium include it, so selling it again would charge the customer twice.
    const einIssue = einLineIssue(uniqueCodes, previousCodes);
    if (einIssue) {
      res.status(422).json({
        error: "EIN is already included in this order or a previous one; it cannot be purchased again",
        reason: einIssue,
      });
      return;
    }
    const codesToResolve = kickoff ? [...uniqueCodes, ...KICKOFF_HOLD_CODES] : uniqueCodes;
    const resolved = await resolveActiveOffers(pool, codesToResolve);
    const resolvedByCode = new Map(resolved.map((o) => [o.offer_code, o]));

    const unknownCodes = codesToResolve.filter((c) => !resolvedByCode.has(c));
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

    const kickoffPlan = kickoff ? buildKickoffLines(resolvedByCode) : null;
    if (kickoffPlan && !kickoffPlan.ok) {
      res.status(422).json({ error: kickoffPlan.error });
      return;
    }
    const lineItemSnapshots: KickoffLine[] = kickoffPlan?.ok
      ? kickoffPlan.lines
      : requestedItems.map((item) => {
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
    const kickoffTerms = kickoffPlan?.ok
      ? {
          selected_package: "PREMIUM",
          package_price_cents: kickoffPlan.packagePriceCents,
          initial_hold_cents: kickoffPlan.holdCents,
          remaining_balance_cents: kickoffPlan.remainingCents,
          disclosure: kickoffDisclosure(kickoffPlan.holdCents, kickoffPlan.remainingCents),
        }
      : null;

    const totalCents = lineItemSnapshots.reduce((sum, li) => sum + li.unit_amount_cents * li.quantity, 0);
    const primaryOffer = resolvedByCode.get(requestedItems[0].offer_code)!;

    const orderInsert = await pool.query<{ order_id: string }>(
      `INSERT INTO orders (filing_session_id, crm_intent, product, line_items, total_cents, currency, checkout_status)
       VALUES ($1, $2, $3, $4, $5, 'usd', 'pending')
       RETURNING order_id`,
      [filingSessionId, primaryOffer.crm_intent, primaryOffer.offer_code, JSON.stringify(lineItemSnapshots), totalCents]
    );
    const orderId = orderInsert.rows[0].order_id;

    // Pay-after-filing: filing orders place a card hold that is collected
    // only when proof of filing is recorded (routes/orders.ts).
    const captureMode = kickoff || (holdsEnabled() && requiresPayAfterFiling(lineItemSnapshots)) ? "hold" : "immediate";

    try {
      const stripeSession = await createCheckoutSession({
        filingSessionId,
        // Only priced lines go to Stripe; the kickoff's selected-package line is a record.
        lineItems: lineItemSnapshots
          .filter((li): li is KickoffLine & { stripe_price_id: string } => typeof li.stripe_price_id === "string")
          .map((li) => ({ price: li.stripe_price_id, quantity: li.quantity })),
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
        captureMode,
        paymentIntentMetadata: {
          order_id: orderId,
          filing_session_id: filingSessionId,
          ...(kickoffTerms
            ? {
                selected_package: "Finance-Ready",
                initial_hold_cents: String(kickoffTerms.initial_hold_cents),
                remaining_balance_cents: String(kickoffTerms.remaining_balance_cents),
              }
            : {}),
        },
        customText: kickoffTerms?.disclosure,
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
        ...(kickoffTerms ? { payment_plan: KICKOFF_PAYMENT_PLAN, kickoff: kickoffTerms } : {}),
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
      `SELECT order_id, filing_session_id, product, checkout_status, payment_status, failure_reason,
              fulfillment_status, total_cents, currency, proof_of_filing_at, captured_at
       FROM orders WHERE order_id = $1`,
      [req.params.orderId]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "order not found" });
      return;
    }
    // The post-payment EIN upsell is decided here, not in the browser. A failure to work it
    // out must never break payment confirmation, so it degrades to no offer.
    let einUpsell = null;
    try {
      einUpsell = await getEinUpsell(pool, rows[0]);
    } catch (upsellErr) {
      console.error("[checkout] EIN upsell eligibility failed:", describeError(upsellErr));
    }
    // ST17: the package and whether the EIN is included come from the session's held or
    // paid orders, so the success page never reads them from the URL. ein_portal_url is
    // the Zoho CRM Portal sign-in (the same for every customer, no customer data), set
    // only for an order that includes the EIN and only once invites go out (the page
    // tells the customer an invitation is on its way).
    // Like the upsell, a failure here never breaks the page.
    let ein: { package: string | null; ein_included: boolean; ein_portal_url: string | null } = {
      package: null,
      ein_included: false,
      ein_portal_url: null,
    };
    try {
      if (rows[0].payment_status === "authorized" || rows[0].payment_status === "paid") {
        const codes = await orderedOfferCodes(pool, rows[0].filing_session_id);
        const included = einIncluded(codes);
        ein = {
          package: packageFromCodes(codes),
          ein_included: included,
          ein_portal_url: included ? await successPagePortalUrl(rows[0].filing_session_id) : null,
        };
      }
    } catch (einErr) {
      console.error("[checkout] EIN package lookup failed:", describeError(einErr));
    }
    res.status(200).json({ ...rows[0], ein_upsell: einUpsell, ...ein });
  } catch (err) {
    res.status(500).json({ error: "order lookup failed", detail: describeError(err) });
  }
});
