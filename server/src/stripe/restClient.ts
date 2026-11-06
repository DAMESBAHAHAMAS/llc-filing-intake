/**
 * Minimal, hand-rolled Stripe REST client — deliberately NOT the `stripe`
 * npm package. See DECISIONS.md ("Stripe integration built via direct
 * REST calls, not the official SDK"): adding `stripe` would be a new
 * third-party dependency on a live financial code path, which standing
 * rule 5 requires listing and waiting for approval before adding — this
 * is an autonomous session with no synchronous way to get that approval.
 * The actual surface area Gate 2 needs (create a Checkout Session,
 * retrieve one, verify a webhook signature) is small and Stripe's REST
 * API + signature scheme are simple and stable enough to implement
 * directly with Node's built-ins (fetch, crypto). If reviewed and the
 * SDK is preferred instead, swapping it in is a contained change behind
 * this same module's exported functions — nothing else in the codebase
 * talks to Stripe directly.
 */

const STRIPE_API_BASE = "https://api.stripe.com/v1";

/**
 * Well inside the 3 minute claim on an order (payments/holdLock.ts), so a
 * stalled call can't outlive it. A timeout says nothing about what Stripe did:
 * callers treat it as an unknown result, never as a refusal.
 */
export const STRIPE_TIMEOUT_MS = 20_000;

function getSecretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set. See .env.example.");
  return key;
}

/**
 * Stripe's form-encoded API uses PHP-style bracket notation for nested
 * objects/arrays, e.g. line_items[0][price]=price_x&line_items[0][quantity]=1.
 * This flattens an arbitrarily-nested plain object/array into that shape.
 */
function flattenToFormParams(value: unknown, prefix: string, out: URLSearchParams): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => flattenToFormParams(item, `${prefix}[${i}]`, out));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flattenToFormParams(v, prefix ? `${prefix}[${k}]` : k, out);
    }
    return;
  }
  out.append(prefix, String(value));
}

function toFormBody(params: Record<string, unknown>): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    flattenToFormParams(v, k, out);
  }
  return out;
}

export class StripeApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly stripeError: unknown
  ) {
    super(message);
    this.name = "StripeApiError";
  }
}

async function stripeRequest<T>(
  method: "GET" | "POST",
  path: string,
  params?: Record<string, unknown>,
  idempotencyKey?: string
): Promise<T> {
  const url = method === "GET" && params ? `${STRIPE_API_BASE}${path}?${toFormBody(params).toString()}` : `${STRIPE_API_BASE}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${getSecretKey()}`,
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      // Stripe replays the original response for a repeated key instead of
      // performing the action twice — the guard against double captures
      // when an operator retries or two workers race.
      ...(method === "POST" && idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: method === "POST" && params ? toFormBody(params).toString() : undefined,
    signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
  });

  const body = (await res.json()) as unknown;
  if (!res.ok) {
    const message = (body as { error?: { message?: string } })?.error?.message ?? `Stripe API error (${res.status})`;
    throw new StripeApiError(message, res.status, (body as { error?: unknown })?.error);
  }
  return body as T;
}

export interface StripeCheckoutSessionLineItem {
  price: string;
  quantity: number;
}

export interface CreateCheckoutSessionParams {
  filingSessionId: string;
  lineItems: StripeCheckoutSessionLineItem[];
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
  /** Carried through to the Checkout Session's own metadata and read
   *  back by routes/webhooksStripe.ts from the (already signature-
   *  verified) webhook event body — no extra Stripe round-trip needed,
   *  since this client already trusts the embedded event object for
   *  payment_status too. Used today for crm_deal_id (see that file's
   *  comment on the Zoho Deal lifecycle this threads into). */
  metadata?: Record<string, string>;
  /**
   * "hold" (default for LLC orders — Damian's rule, 29 Sep 2026: the card
   * is not charged until proof of filing is delivered) authorizes the
   * card without collecting: Stripe manual capture (a 7-day hold; longer
   * only if STRIPE_EXTENDED_AUTHORIZATION is enabled), and the card saved to a
   * Customer so it can still be charged after proof if the hold expires
   * first. "immediate" is the previous behavior, kept for rollback.
   */
  captureMode?: "hold" | "immediate";
  /** Written onto the PaymentIntent so payment_intent.* webhook events
   *  map back to the order without another Stripe call. */
  paymentIntentMetadata?: Record<string, string>;
  /** Where Stripe sends the receipt when the money is collected. */
  receiptEmail?: string;
  /** Shown above Stripe's pay button (custom_text.submit.message). */
  submitMessage?: string;
  /** Shown below Stripe's pay button (custom_text.after_submit.message). */
  afterSubmitMessage?: string;
}

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  payment_status: string;
  status: string;
  client_reference_id: string | null;
  customer_details?: { email?: string | null; address?: { country?: string | null } | null } | null;
  payment_method_types?: string[];
}

/**
 * Creates a Stripe hosted Checkout Session, card only. A hold needs a card:
 * manual capture and off-session reuse do not work on delayed or
 * buy-now-pay-later methods, and the Dashboard otherwise offers them. Cards
 * from any country, Apple Pay and Google Pay are all type card, so
 * international customers are not affected (frozen rule: international
 * must work end-to-end, nothing here assumes a US ZIP).
 */
export async function createCheckoutSession(params: CreateCheckoutSessionParams): Promise<StripeCheckoutSession> {
  return stripeRequest<StripeCheckoutSession>("POST", "/checkout/sessions", {
    mode: "payment",
    client_reference_id: params.filingSessionId,
    line_items: params.lineItems,
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    customer_email: params.customerEmail,
    billing_address_collection: "required",
    payment_method_types: ["card"],
    metadata: params.metadata,
    ...(params.submitMessage || params.afterSubmitMessage
      ? {
          custom_text: {
            ...(params.submitMessage ? { submit: { message: params.submitMessage } } : {}),
            ...(params.afterSubmitMessage ? { after_submit: { message: params.afterSubmitMessage } } : {}),
          },
        }
      : {}),
    ...(params.captureMode === "hold"
      ? {
          customer_creation: "always",
          payment_intent_data: {
            capture_method: "manual",
            setup_future_usage: "off_session",
            metadata: params.paymentIntentMetadata,
            ...(params.receiptEmail ? { receipt_email: params.receiptEmail } : {}),
          },
          // Extended holds (up to 30 days) are opt-in: Stripe rejected the
          // request on this account on 30 Sep 2026 ("This account is not
          // eligible for the requested card features") — they need IC+
          // pricing or Stripe's approval. Without it a card hold lasts 7
          // days, and the saved card covers a filing that takes longer.
          ...(process.env.STRIPE_EXTENDED_AUTHORIZATION === "if_available"
            ? { payment_method_options: { card: { request_extended_authorization: "if_available" } } }
            : {}),
        }
      : params.paymentIntentMetadata
        ? { payment_intent_data: { metadata: params.paymentIntentMetadata } }
        : {}),
  });
}

export async function retrieveCheckoutSession(sessionId: string): Promise<StripeCheckoutSession> {
  return stripeRequest<StripeCheckoutSession>("GET", `/checkout/sessions/${encodeURIComponent(sessionId)}`);
}

/** Closes an open Checkout Session so it can no longer be paid. Stripe
 *  refuses this once the session is complete or already expired. */
export async function expireCheckoutSession(sessionId: string): Promise<StripeCheckoutSession> {
  return stripeRequest<StripeCheckoutSession>("POST", `/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {});
}

export interface StripePrice {
  id: string;
  active: boolean;
  unit_amount: number | null;
  currency: string;
  product: string;
  livemode?: boolean;
}

/** Read-only; used by scripts/verifyPriceParity.ts. */
export async function retrievePrice(priceId: string): Promise<StripePrice> {
  return stripeRequest<StripePrice>("GET", `/prices/${encodeURIComponent(priceId)}`);
}

export interface StripePaymentIntent {
  id: string;
  status: string;
  amount: number;
  amount_capturable: number;
  amount_received: number;
  currency: string;
  customer: string | null;
  payment_method: string | null;
  receipt_email?: string | null;
  metadata?: Record<string, string>;
  latest_charge?:
    | string
    | {
        id: string;
        captured?: boolean;
        payment_method_details?: {
          card?: {
            capture_before?: number | null;
            extended_authorization?: { status?: string } | null;
          } | null;
        } | null;
      }
    | null;
}

/** Retrieves a PaymentIntent with its latest Charge expanded, which is
 *  where Stripe reports the hold's expiry (capture_before). */
export async function retrievePaymentIntent(paymentIntentId: string): Promise<StripePaymentIntent> {
  return stripeRequest<StripePaymentIntent>("GET", `/payment_intents/${encodeURIComponent(paymentIntentId)}`, {
    expand: ["latest_charge"],
  });
}

/** A Customer's PaymentIntents, newest first. Checkout makes a Customer per
 *  order, so the first page holds all of them. */
export async function listPaymentIntents(customerId: string): Promise<StripePaymentIntent[]> {
  const page = await stripeRequest<{ data: StripePaymentIntent[] }>("GET", "/payment_intents", { customer: customerId, limit: 100 });
  return page.data;
}

/** Collects a held payment. The idempotency key makes a repeat call
 *  return the first result instead of attempting a second capture. With
 *  amountToCapture below the held amount, Stripe collects only that much
 *  and releases the rest of the hold. */
export async function capturePaymentIntent(
  paymentIntentId: string,
  idempotencyKey: string,
  amountToCapture?: number
): Promise<StripePaymentIntent> {
  return stripeRequest<StripePaymentIntent>(
    "POST",
    `/payment_intents/${encodeURIComponent(paymentIntentId)}/capture`,
    amountToCapture !== undefined ? { amount_to_capture: amountToCapture } : {},
    idempotencyKey
  );
}

/** Releases a hold without collecting anything. */
export async function cancelPaymentIntent(paymentIntentId: string, idempotencyKey: string): Promise<StripePaymentIntent> {
  return stripeRequest<StripePaymentIntent>(
    "POST",
    `/payment_intents/${encodeURIComponent(paymentIntentId)}/cancel`,
    { cancellation_reason: "requested_by_customer" },
    idempotencyKey
  );
}

/**
 * A new hold on the saved card, for an order whose hold is about to end and
 * whose filing is not confirmed. Manual capture, so nothing is collected.
 * The idempotency key names the hold it replaces, so a retry cannot place a
 * second one, and metadata ties the hold to its order, so one whose response
 * was lost can be found again. The bank can refuse or ask for the customer: the caller then
 * keeps the old hold and raises it with a person.
 */
export async function placeReplacementHold(params: {
  customerId: string;
  paymentMethodId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  metadata?: Record<string, string>;
  receiptEmail?: string | null;
}): Promise<StripePaymentIntent> {
  return stripeRequest<StripePaymentIntent>(
    "POST",
    "/payment_intents",
    {
      amount: params.amountCents,
      currency: params.currency,
      customer: params.customerId,
      payment_method: params.paymentMethodId,
      capture_method: "manual",
      off_session: true,
      confirm: true,
      metadata: params.metadata,
      ...(params.receiptEmail ? { receipt_email: params.receiptEmail } : {}),
    },
    params.idempotencyKey
  );
}

/**
 * Fallback when a hold expired before proof of filing existed: charges the
 * card saved at checkout, off-session, for the same amount. Only ever
 * called after proof of filing is recorded, so the pay-after-filing rule
 * still holds. Can be declined by the bank — the caller records that.
 */
export async function chargeSavedCard(params: {
  customerId: string;
  paymentMethodId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  metadata?: Record<string, string>;
  receiptEmail?: string | null;
}): Promise<StripePaymentIntent> {
  return stripeRequest<StripePaymentIntent>(
    "POST",
    "/payment_intents",
    {
      amount: params.amountCents,
      currency: params.currency,
      customer: params.customerId,
      payment_method: params.paymentMethodId,
      off_session: true,
      confirm: true,
      metadata: params.metadata,
      ...(params.receiptEmail ? { receipt_email: params.receiptEmail } : {}),
    },
    params.idempotencyKey
  );
}

/** Removes a saved card from its Customer, so it cannot be charged again.
 *  Refunds on earlier charges still work after this. */
export async function detachPaymentMethod(paymentMethodId: string): Promise<{ id: string }> {
  return stripeRequest<{ id: string }>("POST", `/payment_methods/${encodeURIComponent(paymentMethodId)}/detach`, {});
}

/** Reads the hold expiry and extended-hold status from an expanded
 *  PaymentIntent. Returns nulls when Stripe hasn't reported them. */
export function holdDetails(pi: StripePaymentIntent): { captureBefore: Date | null; extended: boolean | null } {
  const charge = typeof pi.latest_charge === "object" && pi.latest_charge ? pi.latest_charge : null;
  const card = charge?.payment_method_details?.card ?? null;
  const ts = card?.capture_before ?? null;
  const status = card?.extended_authorization?.status ?? null;
  return {
    captureBefore: typeof ts === "number" ? new Date(ts * 1000) : null,
    extended: status === null ? null : status === "enabled",
  };
}
