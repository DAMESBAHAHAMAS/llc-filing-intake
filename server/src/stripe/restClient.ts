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

async function stripeRequest<T>(method: "GET" | "POST", path: string, params?: Record<string, unknown>): Promise<T> {
  const url = method === "GET" && params ? `${STRIPE_API_BASE}${path}?${toFormBody(params).toString()}` : `${STRIPE_API_BASE}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${getSecretKey()}`,
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
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
  });
}

export async function retrieveCheckoutSession(sessionId: string): Promise<StripeCheckoutSession> {
  return stripeRequest<StripeCheckoutSession>("GET", `/checkout/sessions/${encodeURIComponent(sessionId)}`);
}
