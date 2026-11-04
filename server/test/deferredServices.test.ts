import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deferredServiceCents,
  holdCheckoutText,
  HOLD_CHECKOUT_MESSAGE,
  LATER_SERVICES_LINE,
  SAVED_CARD_AUTHORIZATION,
  SAVED_CARD_AUTHORIZATION_EIN_ONLY,
} from "../src/offers/payAfterFiling.js";
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

  it("shows the saved-card authorization above the pay button and the hold line below it", async () => {
    const calls = captureFetch();
    const text = holdCheckoutText([{ offer_code: "FASTTRACK", unit_amount_cents: 49900, quantity: 1 }]);
    await createCheckoutSession({
      filingSessionId: "fs",
      lineItems: [{ price: "price_1", quantity: 1 }],
      successUrl: "https://e/s",
      cancelUrl: "https://e/c",
      captureMode: "hold",
      submitMessage: text.submit,
      afterSubmitMessage: text.afterSubmit,
    });
    const body = new URLSearchParams(calls[0].body);
    expect(body.get("custom_text[submit][message]")).toBe(SAVED_CARD_AUTHORIZATION);
    expect(body.get("custom_text[after_submit][message]")).toBe(HOLD_CHECKOUT_MESSAGE);
    expect(SAVED_CARD_AUTHORIZATION).toBe(
      "By completing checkout, you authorize us to keep your card on file with Stripe. If your hold ends before Florida confirms your filing, you authorize us to charge that card once, without contacting you first, for the order total shown at checkout, after Florida confirms it. We use the saved card only for this order."
    );
    expect(SAVED_CARD_AUTHORIZATION.length).toBeLessThanOrEqual(1200);
  });

  it("takes cards only, for every session", async () => {
    const calls = captureFetch();
    for (const captureMode of ["hold", "immediate"] as const) {
      await createCheckoutSession({ filingSessionId: "fs", lineItems: [{ price: "p", quantity: 1 }], successUrl: "https://e/s", cancelUrl: "https://e/c", captureMode });
    }
    for (const call of calls) {
      const body = new URLSearchParams(call.body);
      expect(body.getAll("payment_method_types[0]")).toEqual(["card"]);
      expect(body.has("payment_method_types[1]")).toBe(false);
    }
  });

  it("adds the approved later-services line when an EIN is deferred", () => {
    const text = holdCheckoutText([
      { offer_code: "FASTTRACK", unit_amount_cents: 49900, quantity: 1 },
      { offer_code: "EIN_FILING", unit_amount_cents: 7500, quantity: 1 },
    ]);
    expect(text.afterSubmit).toBe(`${HOLD_CHECKOUT_MESSAGE} ${LATER_SERVICES_LINE}`);
    expect(text.afterSubmit!.length).toBeLessThanOrEqual(1200);
  });

  it("does not tell an EIN-only customer that Florida will confirm anything", () => {
    const text = holdCheckoutText([{ offer_code: "EIN_FILING", unit_amount_cents: 7500, quantity: 1 }]);
    expect(text.submit).toBe(SAVED_CARD_AUTHORIZATION_EIN_ONLY);
    expect(text.submit).not.toContain("Florida");
    expect(text.afterSubmit).toBeUndefined();
  });

  it("captures part of a hold with amount_to_capture", async () => {
    const calls = captureFetch();
    await capturePaymentIntent("pi_1", "k", 49900);
    expect(calls[0].url).toMatch(/\/payment_intents\/pi_1\/capture$/);
    expect(new URLSearchParams(calls[0].body).get("amount_to_capture")).toBe("49900");
  });
});
