import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capturePaymentIntent,
  createPaymentLink,
  cancelPaymentIntent,
  createCheckoutSession,
  holdDetails,
  retrievePaymentIntent,
} from "../src/stripe/restClient.js";

const originalFetch = global.fetch;
const originalKey = process.env.STRIPE_SECRET_KEY;
afterEach(() => {
  global.fetch = originalFetch;
  process.env.STRIPE_SECRET_KEY = originalKey;
});

function captureFetch() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: "obj_1", status: "requires_capture" }), { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

describe("card-hold Checkout Session", () => {
  it("requests manual capture, an extended hold where available, and a saved card", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    const calls = captureFetch();
    await createCheckoutSession({
      filingSessionId: "fs_1",
      lineItems: [{ price: "price_1", quantity: 1 }],
      successUrl: "https://example.com/s",
      cancelUrl: "https://example.com/c",
      captureMode: "hold",
      paymentIntentMetadata: { order_id: "ord_1" },
    });
    const body = decodeURIComponent(calls[0].init?.body as string);
    expect(body).toContain("payment_intent_data[capture_method]=manual");
    expect(body).toContain("payment_intent_data[setup_future_usage]=off_session");
    expect(body).toContain("payment_intent_data[metadata][order_id]=ord_1");
    expect(body).toContain("customer_creation=always");
    expect(body).not.toContain("payment_method_types");
    // Stripe refuses extended holds on this account unless approved — never sent by default.
    expect(body).not.toContain("request_extended_authorization");
  });

  it("requests an extended hold only when switched on", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_EXTENDED_AUTHORIZATION = "if_available";
    const calls = captureFetch();
    await createCheckoutSession({
      filingSessionId: "fs_1",
      lineItems: [{ price: "price_1", quantity: 1 }],
      successUrl: "https://example.com/s",
      cancelUrl: "https://example.com/c",
      captureMode: "hold",
    });
    delete process.env.STRIPE_EXTENDED_AUTHORIZATION;
    expect(decodeURIComponent(calls[0].init?.body as string)).toContain(
      "payment_method_options[card][request_extended_authorization]=if_available"
    );
  });

  it("leaves immediate-capture sessions unchanged apart from order metadata", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    const calls = captureFetch();
    await createCheckoutSession({
      filingSessionId: "fs_1",
      lineItems: [{ price: "price_1", quantity: 1 }],
      successUrl: "https://example.com/s",
      cancelUrl: "https://example.com/c",
      captureMode: "immediate",
      paymentIntentMetadata: { order_id: "ord_1" },
    });
    const body = decodeURIComponent(calls[0].init?.body as string);
    expect(body).not.toContain("capture_method");
    expect(body).not.toContain("request_extended_authorization");
    expect(body).toContain("payment_intent_data[metadata][order_id]=ord_1");
  });
});

describe("collection calls", () => {
  it("captures with an idempotency key", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    const calls = captureFetch();
    await capturePaymentIntent("pi_123", "capture-ord_1");
    expect(calls[0].url).toBe("https://api.stripe.com/v1/payment_intents/pi_123/capture");
    expect((calls[0].init?.headers as Record<string, string>)["Idempotency-Key"]).toBe("capture-ord_1");
  });

  it("cancels a Day-5 hold as abandoned, with an idempotency key", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    const calls = captureFetch();
    await cancelPaymentIntent("pi_123", "day5-release-ord_1", "abandoned");
    expect(calls[0].url).toBe("https://api.stripe.com/v1/payment_intents/pi_123/cancel");
    expect(decodeURIComponent(calls[0].init?.body as string)).toBe("cancellation_reason=abandoned");
    expect((calls[0].init?.headers as Record<string, string>)["Idempotency-Key"]).toBe("day5-release-ord_1");
  });

  it("creates a one-time Payment Link from the order's own Prices, carrying order_id on the PaymentIntent", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    const calls = captureFetch();
    await createPaymentLink({
      lineItems: [{ price: "price_a", quantity: 1 }, { price: "price_b", quantity: 2 }],
      metadata: { order_id: "ord_1" },
      confirmationMessage: "Thanks",
      idempotencyKey: "day5-paylink-ord_1",
    });
    const body = decodeURIComponent(calls[0].init?.body as string);
    expect(calls[0].url).toBe("https://api.stripe.com/v1/payment_links");
    expect(body).toContain("line_items[0][price]=price_a");
    expect(body).toContain("line_items[1][quantity]=2");
    expect(body).toContain("payment_intent_data[metadata][order_id]=ord_1");
    expect(body).toContain("metadata[order_id]=ord_1");
    expect(body).toContain("restrictions[completed_sessions][limit]=1");
    expect(body).toContain("after_completion[type]=hosted_confirmation");
    // A link is paid by the customer; nothing here confirms or charges a card.
    expect(body).not.toMatch(/off_session|confirm=|customer=|payment_method=/);
    expect((calls[0].init?.headers as Record<string, string>)["Idempotency-Key"]).toBe("day5-paylink-ord_1");
  });

  it("expands the latest charge when reading a hold", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    const calls = captureFetch();
    await retrievePaymentIntent("pi_123");
    expect(decodeURIComponent(calls[0].url)).toContain("/payment_intents/pi_123?expand[0]=latest_charge");
  });
});

describe("holdDetails", () => {
  it("reads expiry and extended-hold status from the charge", () => {
    const d = holdDetails({
      id: "pi_1",
      status: "requires_capture",
      amount: 1,
      amount_capturable: 1,
      amount_received: 0,
      currency: "usd",
      customer: "cus_1",
      payment_method: "pm_1",
      latest_charge: {
        id: "ch_1",
        payment_method_details: { card: { capture_before: 1_790_000_000, extended_authorization: { status: "enabled" } } },
      },
    });
    expect(d.captureBefore?.toISOString()).toBe(new Date(1_790_000_000 * 1000).toISOString());
    expect(d.extended).toBe(true);
  });
  it("returns nulls when Stripe has not reported them", () => {
    const d = holdDetails({
      id: "pi_1",
      status: "requires_capture",
      amount: 1,
      amount_capturable: 1,
      amount_received: 0,
      currency: "usd",
      customer: null,
      payment_method: null,
      latest_charge: "ch_1",
    });
    expect(d).toEqual({ captureBefore: null, extended: null });
  });
});
