import Stripe from "stripe";

export interface CreateCheckoutSessionInput {
  lineItems: { price: string; quantity: number }[];
  filingSessionId: string;
  crmIntent: string;
  /** This service's own order id, set as Stripe metadata so the Checkout
   *  Session carries it directly (in addition to the existing
   *  orders.stripe_checkout_session_id -> orders lookup the webhook
   *  actually uses — see webhook/stripeWebhookService.ts). */
  orderId: string;
  /** The Zoho Deal this filing session is already associated with
   *  (filing_sessions.crm_deal_id — Gate 1, migration 0001), when one
   *  exists. Carried through Stripe metadata so the webhook can write it
   *  onto orders.crm_deal_id and enqueue a Deal-stage update at the
   *  moment payment is confirmed, without a second DB round-trip back to
   *  filing_sessions inside that transaction. Nothing populates
   *  filing_sessions.crm_deal_id today (see checkoutService.ts's own
   *  comment) — this is the plumbing for when something does, not a
   *  currently-exercised path. */
  crmDealId?: string | null;
}

export interface CreateCheckoutSessionResult {
  id: string;
  url: string | null;
}

/** The fields the webhook needs to authoritatively verify payment —
 *  fetched fresh from Stripe by session id, never trusted from a webhook
 *  payload alone. Mirrors (a strict subset of) Stripe.Checkout.Session. */
export interface RetrievedCheckoutSession {
  id: string;
  paymentStatus: string;
  amountTotal: number | null;
  currency: string | null;
  metadata: Record<string, string> | null;
}

export interface StripeCheckoutClient {
  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CreateCheckoutSessionResult>;
  retrieveCheckoutSession(id: string): Promise<RetrievedCheckoutSession>;
}

/**
 * Real Stripe implementation. The client is instantiated lazily, on
 * first use, not at module load — mirrors zoho/client.ts's
 * getZohoAccessToken (fails clearly when actually called if unconfigured,
 * rather than crashing the whole process at import time just because
 * some other route imports this module). Before this, checkout.ts threw
 * at import — meaning the server couldn't start at all without
 * STRIPE_SECRET_KEY set, even to serve /health or /api/session/stage
 * (GATE2-CHECKOUT-STATUS.md §1).
 */
let stripeSingleton: Stripe | null = null;
/** Exported so the webhook route (server/src/routes/stripeWebhook.ts) can
 *  reuse the same lazily-instantiated client for `stripe.webhooks.constructEvent` —
 *  that call is pure local signature verification, not a network call, so
 *  sharing the singleton is just avoiding a second `new Stripe(...)`. */
export function getStripe(): Stripe {
  if (stripeSingleton) return stripeSingleton;
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    throw new Error("STRIPE_SECRET_KEY is not set. See .env.example.");
  }
  stripeSingleton = new Stripe(stripeSecretKey);
  return stripeSingleton;
}

export const realStripeCheckoutClient: StripeCheckoutClient = {
  async createCheckoutSession({ lineItems, filingSessionId, crmIntent, orderId, crmDealId }) {
    const session = await getStripe().checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      // Ties the Checkout Session back to the filing_sessions row — this
      // is what the webhook handler reads (via client_reference_id AND
      // metadata.filing_session_id) as a human-diagnosable cross-check,
      // though the actual order lookup it performs is by
      // orders.stripe_checkout_session_id = session.id (set right after
      // this call returns, in checkoutService.ts) — that's the one
      // relationship the webhook actually depends on for correctness.
      client_reference_id: filingSessionId,
      // Keyed on Stripe's own {CHECKOUT_SESSION_ID} placeholder — not on
      // filing_session_id/order_id in the path — so the return routes
      // (routes/checkout.ts's GET /checkout/session-status, and the
      // frontend pages that call it) look a customer's order up by a
      // high-entropy Stripe-generated id, never by a client-editable path
      // segment. See GATE2-STRIPE-RETURN-ROUTES-STATUS.md §8.
      success_url: `${process.env.APP_BASE_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_BASE_URL}/checkout/cancel?session_id={CHECKOUT_SESSION_ID}`,
      metadata: {
        filing_session_id: filingSessionId,
        crm_intent: crmIntent,
        order_id: orderId,
        // Stripe metadata values must be strings and the object can't
        // hold an explicit undefined — omitted entirely when there's no
        // Deal yet, rather than sent as the literal string "null".
        ...(crmDealId ? { crm_deal_id: crmDealId } : {}),
      },
    });
    return { id: session.id, url: session.url };
  },

  async retrieveCheckoutSession(id) {
    const session = await getStripe().checkout.sessions.retrieve(id);
    return {
      id: session.id,
      paymentStatus: session.payment_status,
      amountTotal: session.amount_total,
      currency: session.currency,
      metadata: session.metadata,
    };
  },
};
