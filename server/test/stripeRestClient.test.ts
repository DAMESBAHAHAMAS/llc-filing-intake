import { afterEach, describe, expect, it, vi } from "vitest";
import { capturePaymentIntent, createCheckoutSession, listPaymentIntents, retrieveCheckoutSession, retrievePaymentIntent, STRIPE_TIMEOUT_MS, StripeApiError } from "../src/stripe/restClient.js";

/**
 * Proves the hand-rolled Stripe REST client (no `stripe` SDK — see
 * DECISIONS.md) sends requests Stripe's actual API would accept: correct
 * bracket-notation form encoding for nested line_items, Bearer auth, and
 * that non-2xx responses surface as StripeApiError rather than being
 * silently swallowed.
 */

const originalFetch = global.fetch;
const originalKey = process.env.STRIPE_SECRET_KEY;

afterEach(() => {
  global.fetch = originalFetch;
  process.env.STRIPE_SECRET_KEY = originalKey;
});

describe("createCheckoutSession", () => {
  it("encodes nested line_items with Stripe's bracket notation and sets Bearer auth", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ id: "cs_test_123", url: "https://checkout.stripe.com/cs_test_123" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const result = await createCheckoutSession({
      filingSessionId: "fs_abc",
      lineItems: [
        { price: "price_1", quantity: 2 },
        { price: "price_2", quantity: 1 },
      ],
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      customerEmail: "test@example.com",
    });

    expect(result.id).toBe("cs_test_123");
    expect(capturedUrl).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect((capturedInit?.headers as Record<string, string>).Authorization).toBe("Bearer sk_test_fake");

    const body = capturedInit?.body as string;
    expect(body).toContain("line_items%5B0%5D%5Bprice%5D=price_1");
    expect(body).toContain("line_items%5B0%5D%5Bquantity%5D=2");
    expect(body).toContain("line_items%5B1%5D%5Bprice%5D=price_2");
    expect(body).toContain("client_reference_id=fs_abc");
    expect(body).toContain("mode=payment");
    // Card only: a hold cannot sit on a delayed or pay-later method. Cards
    // from any country are type card, so international customers still work.
    expect(new URLSearchParams(body).getAll("payment_method_types[0]")).toEqual(["card"]);
  });

  it("throws StripeApiError with the Stripe error message on a non-2xx response", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "No such price: 'price_bad'" } }), { status: 400 })
    ) as unknown as typeof fetch;

    await expect(
      createCheckoutSession({
        filingSessionId: "fs_abc",
        lineItems: [{ price: "price_bad", quantity: 1 }],
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      })
    ).rejects.toThrow(StripeApiError);
  });

  it("throws if STRIPE_SECRET_KEY is not set", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    await expect(
      createCheckoutSession({
        filingSessionId: "fs_abc",
        lineItems: [{ price: "price_1", quantity: 1 }],
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      })
    ).rejects.toThrow(/STRIPE_SECRET_KEY/);
  });
});

describe("retrieveCheckoutSession", () => {
  it("issues a GET to the correct URL", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    let capturedUrl = "";
    let capturedMethod = "";
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      return new Response(JSON.stringify({ id: "cs_test_123", payment_status: "paid" }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await retrieveCheckoutSession("cs_test_123");
    expect(result.payment_status).toBe("paid");
    expect(capturedUrl).toBe("https://api.stripe.com/v1/checkout/sessions/cs_test_123");
    expect(capturedMethod).toBe("GET");
  });
});

describe("every Stripe call", () => {
  const answering = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

  it("gives up well inside the 3 minute claim on an order", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    expect(STRIPE_TIMEOUT_MS).toBeLessThanOrEqual(20_000);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    global.fetch = answering({ id: "pi_1", data: [] });
    await retrievePaymentIntent("pi_1");
    await capturePaymentIntent("pi_1", "key");
    await listPaymentIntents("cus_1");
    expect(timeout).toHaveBeenCalledTimes(3);
    expect(timeout).toHaveBeenCalledWith(STRIPE_TIMEOUT_MS);
    for (const [, init] of (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls) {
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
    timeout.mockRestore();
  });

  it("rejects when Stripe stalls, and says nothing Stripe said", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => AbortSignal.abort(new DOMException("timed out", "TimeoutError")));
    global.fetch = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) reject(init.signal.reason);
    })) as unknown as typeof fetch;
    const failure = await capturePaymentIntent("pi_1", "key").catch((err) => err);
    expect(failure).not.toBeInstanceOf(StripeApiError);
    expect((failure as Error).name).toBe("TimeoutError");
    timeout.mockRestore();
  });
});

describe("listPaymentIntents", () => {
  it("asks for one customer's PaymentIntents", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    let capturedUrl = "";
    global.fetch = vi.fn(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ data: [{ id: "pi_1", status: "requires_capture", metadata: { order_id: "o" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const found = await listPaymentIntents("cus_1");
    expect(capturedUrl).toBe("https://api.stripe.com/v1/payment_intents?customer=cus_1&limit=100&expand%5B0%5D=data.latest_charge");
    expect(found.map((pi) => pi.id)).toEqual(["pi_1"]);
  });
});
