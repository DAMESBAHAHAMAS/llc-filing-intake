import { afterEach, describe, expect, it, vi } from "vitest";
import { deferredServiceCents, HOLD_CHECKOUT_MESSAGE } from "../src/offers/payAfterFiling.js";
import { capturePaymentIntent, createCheckoutSession } from "../src/stripe/restClient.js";

/**
 * Decision 3 (Damian, 2 Oct 2026): services delivered after the LLC filing
 * (EIN) are charged when complete, so they are deferred out of the amount
 * collected at proof of filing. Plus the approved hold line at checkout.
 */
describe("deferredServiceCents", () => {
  it("defers the EIN on a formation order", () => {
    expect(
      deferredServiceCents([
        { offer_code: "FASTTRACK", unit_amount_cents: 49900, quantity: 1 },
        { offer_code: "EIN_FILING", unit_amount_cents: 29900, quantity: 1 },
      ])
    ).toBe(29900);
  });
  it("defers nothing on a formation order without an EIN", () => {
    expect(
      deferredServiceCents([
        { offer_code: "DIY_STATE_FEE", unit_amount_cents: 12500, quantity: 1 },
        { offer_code: "DIY_SERVICE_FEE", unit_amount_cents: 900, quantity: 1 },
        { offer_code: "DIY_CERT_OF_STATUS", unit_amount_cents: 500, quantity: 1 },
      ])
    ).toBe(0);
  });
  it("defers nothing on an EIN-only order (its whole total is collected when the EIN is issued)", () => {
    expect(deferredServiceCents([{ offer_code: "EIN_FILING", unit_amount_cents: 29900, quantity: 1 }])).toBe(0);
  });
});

describe("Stripe requests", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });
  function captureFetch() {
    const calls: { url: string; body: string }[] = [];
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ id: "x", url: null, status: "succeeded" }), { status: 200 });
    }) as unknown as typeof fetch;
    return calls;
  }

  it("puts the approved hold line above the pay button", async () => {
    const calls = captureFetch();
    await createCheckoutSession({
      filingSessionId: "fs",
      lineItems: [{ price: "price_1", quantity: 1 }],
      successUrl: "https://e/s",
      cancelUrl: "https://e/c",
      captureMode: "hold",
      submitMessage: HOLD_CHECKOUT_MESSAGE,
    });
    const body = new URLSearchParams(calls[0].body);
    expect(body.get("custom_text[submit][message]")).toBe(HOLD_CHECKOUT_MESSAGE);
    expect(HOLD_CHECKOUT_MESSAGE.length).toBeLessThanOrEqual(1200);
  });

  it("captures part of a hold with amount_to_capture", async () => {
    const calls = captureFetch();
    await capturePaymentIntent("pi_1", "k", 49900);
    expect(calls[0].url).toMatch(/\/payment_intents\/pi_1\/capture$/);
    expect(new URLSearchParams(calls[0].body).get("amount_to_capture")).toBe("49900");
  });
});
