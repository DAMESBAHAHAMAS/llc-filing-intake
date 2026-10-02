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
  /** Shown above Stripe's pay button (custom_text.submit.message). */
  submitMessage?: string;
}

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  payment_status: string;
  status: string;
  client_reference_id: string | null;
  customer_details?: { email?: string | null; address?: { country?: string | null } | null } | null;
}

/**
 * Creates a Stripe hosted Checkout Session. Deliberately does NOT set
 * payment_method_types — leaving it unset lets Stripe pick eligible
 * methods per the Dashboard configuration and the customer's location,
 * which is what makes non-US billing addresses and international cards
 * work without this code needing to special-case them (frozen rule:
 * international must work end-to-end, nothing here assumes a US ZIP).
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
    metadata: params.metadata,
    ...(params.submitMessage ? { custom_text: { submit: { message: params.submitMessage } } } : {}),
    ...(params.captureMode === "hold"
      ? {
          customer_creation: "always",
          payment_intent_data: {
            capture_method: "manual",
            setup_future_usage: "off_session",
            metadata: params.paymentIntentMetadata,
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

export interface StripePrice {
  id: string;
  active: boolean;
  unit_amount: number | null;
  currency: string;
  product: string;
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

/** Collects a held payment. The idempotency key makes a repeat call
 *  return the first result instead of attempting a second capture. */
/** Collects a hold. With amountToCapture below the held amount, Stripe
 *  collects only that much and releases the rest of the hold. */
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
    },
    params.idempotencyKey
  );
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
