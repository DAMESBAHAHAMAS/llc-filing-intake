import http from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Operator collection route: money is collected only through proof of
 * filing, the hold is captured once, and an expired hold falls back to
 * the saved card. Database and Stripe are faked; the real round trip is
 * the Stripe test-mode run recorded in DECISIONS.md.
 */
const db = vi.hoisted(() => ({
  order: null as null | Record<string, unknown>,
  queries: [] as string[],
}));
vi.mock("../src/db/pool.js", () => ({
  pool: {
    query: vi.fn(async (sql: string) => {
      db.queries.push(sql);
      if (/^\s*UPDATE orders\s+SET proof_of_filing_ref/.test(sql) || /^\s*SELECT order_id, payment_status/.test(sql)) {
        return { rows: db.order ? [db.order] : [], rowCount: db.order ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    }),
  },
}));

const stripe = vi.hoisted(() => ({
  capture: vi.fn(),
  cancel: vi.fn(),
  charge: vi.fn(),
  retrieve: vi.fn(),
}));
vi.mock("../src/stripe/restClient.js", async (orig) => {
  const actual = await orig<typeof import("../src/stripe/restClient.js")>();
  return {
    ...actual,
    capturePaymentIntent: stripe.capture,
    cancelPaymentIntent: stripe.cancel,
    chargeSavedCard: stripe.charge,
    retrievePaymentIntent: stripe.retrieve,
  };
});

const { ordersRouter } = await import("../src/routes/orders.js");
const { StripeApiError } = await import("../src/stripe/restClient.js");

let server: http.Server;
let base = "";
beforeAll(async () => {
  process.env.OPERATOR_API_KEY = "op-test-key";
  const app = express();
  app.use(express.json());
  app.use(ordersRouter);
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  db.queries = [];
  db.order = {
    order_id: "ord-1",
    payment_status: "authorized",
    stripe_payment_intent_id: "pi_hold",
    total_cents: 49900,
    currency: "usd",
  };
  Object.values(stripe).forEach((f) => f.mockReset());
});

async function post(path: string, body: unknown, key: string | null = "op-test-key") {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "x-operator-key": key } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/orders/:orderId/proof-of-filing", () => {
  it("refuses without the operator key", async () => {
    expect((await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" }, null)).status).toBe(401);
    expect((await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" }, "wrong")).status).toBe(401);
    expect(stripe.capture).not.toHaveBeenCalled();
  });

  it("requires a document number", async () => {
    expect((await post("/api/orders/ord-1/proof-of-filing", {})).status).toBe(400);
  });

  it("records proof, then captures the hold once with an idempotency key", async () => {
    stripe.capture.mockResolvedValue({ id: "pi_hold", status: "succeeded" });
    const r = await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("collection_requested");
    expect(stripe.capture).toHaveBeenCalledWith("pi_hold", "capture-ord-1");
    expect(stripe.charge).not.toHaveBeenCalled();
    // Proof is written before any money moves.
    expect(db.queries[0]).toMatch(/proof_of_filing_ref/);
    // The route never marks the order paid itself — the webhook does.
    expect(db.queries.join("\n")).not.toMatch(/payment_status = 'paid'/);
  });

  it("charges the saved card when the hold has expired", async () => {
    stripe.capture.mockRejectedValue(new StripeApiError("expired", 400, { code: "charge_expired_for_capture" }));
    stripe.retrieve.mockResolvedValue({ id: "pi_hold", customer: "cus_1", payment_method: "pm_1" });
    stripe.charge.mockResolvedValue({ id: "pi_fallback", status: "succeeded" });
    const r = await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("saved_card_charged");
    expect(stripe.charge).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cus_1", paymentMethodId: "pm_1", amountCents: 49900, idempotencyKey: "fallback-ord-1" })
    );
  });

  it("does not fall back on an ordinary capture error", async () => {
    stripe.capture.mockRejectedValue(new StripeApiError("rate limited", 429, { code: "rate_limit" }));
    const r = await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" });
    expect(r.status).toBe(502);
    expect(stripe.charge).not.toHaveBeenCalled();
    expect(db.queries.some((q) => /capture_error/.test(q))).toBe(true);
  });

  it("goes straight to the saved card for an order whose hold was already released", async () => {
    db.order = { ...db.order, payment_status: "released" };
    stripe.retrieve.mockResolvedValue({ id: "pi_hold", customer: "cus_1", payment_method: "pm_1" });
    stripe.charge.mockResolvedValue({ id: "pi_fallback", status: "succeeded" });
    const r = await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" });
    expect(r.json.status).toBe("saved_card_charged");
    expect(stripe.capture).not.toHaveBeenCalled();
  });

  it("does nothing for an order already paid or with nothing held", async () => {
    db.order = { ...db.order, payment_status: "paid" };
    expect((await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" })).json.status).toBe("already_paid");
    db.order = { ...db.order, payment_status: "pending" };
    expect((await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" })).status).toBe(409);
    expect(stripe.capture).not.toHaveBeenCalled();
  });
});

describe("services charged when complete (EIN with a formation order)", () => {
  it("collects only the formation part at proof of filing; the rest of the hold is released", async () => {
    db.order = { ...db.order, total_cents: 79800, deferred_cents: 29900 };
    stripe.capture.mockResolvedValue({ id: "pi_hold", status: "succeeded" });
    const r = await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" });
    expect(r.status).toBe(200);
    expect(stripe.capture).toHaveBeenCalledWith("pi_hold", "capture-ord-1", 49900);
    expect(r.json.collected_cents).toBe(49900);
    expect(r.json.deferred_cents).toBe(29900);
  });

  it("charges the saved card only the formation part when the hold has expired", async () => {
    db.order = { ...db.order, total_cents: 79800, deferred_cents: 29900 };
    stripe.capture.mockRejectedValue(new StripeApiError("expired", 400, { code: "charge_expired_for_capture" }));
    stripe.retrieve.mockResolvedValue({ id: "pi_hold", customer: "cus_1", payment_method: "pm_1" });
    stripe.charge.mockResolvedValue({ id: "pi_fallback", status: "succeeded" });
    await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" });
    expect(stripe.charge).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 49900 }));
  });

  it("charges the deferred part to the saved card once the service is complete", async () => {
    db.order = { ...db.order, payment_status: "paid", deferred_cents: 29900, deferred_payment_intent_id: null };
    stripe.retrieve.mockResolvedValue({ id: "pi_hold", customer: "cus_1", payment_method: "pm_1" });
    stripe.charge.mockResolvedValue({ id: "pi_ein", status: "succeeded" });
    const r = await post("/api/orders/ord-1/service-complete", { service_ref: "12-3456789" });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("deferred_service_charged");
    expect(stripe.charge).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 29900,
        idempotencyKey: "deferred-ord-1",
        metadata: expect.objectContaining({ kind: "deferred_service", order_id: "ord-1" }),
      })
    );
    expect(db.queries.some((q) => /deferred_payment_intent_id = \$3/.test(q))).toBe(true);
  });

  it("refuses before the formation part is collected, never charging early", async () => {
    db.order = { ...db.order, payment_status: "authorized", deferred_cents: 29900, deferred_payment_intent_id: null };
    const r = await post("/api/orders/ord-1/service-complete", { service_ref: "12-3456789" });
    expect(r.status).toBe(409);
    expect(stripe.charge).not.toHaveBeenCalled();
  });

  it("does not charge twice, and refuses orders with nothing deferred or no operator key", async () => {
    db.order = { ...db.order, payment_status: "paid", deferred_cents: 29900, deferred_payment_intent_id: "pi_ein" };
    expect((await post("/api/orders/ord-1/service-complete", { service_ref: "12-3456789" })).json.status).toBe("already_requested");
    db.order = { ...db.order, deferred_cents: 0, deferred_payment_intent_id: null };
    expect((await post("/api/orders/ord-1/service-complete", { service_ref: "12-3456789" })).status).toBe(409);
    expect((await post("/api/orders/ord-1/service-complete", { service_ref: "12-3456789" }, null)).status).toBe(401);
    expect(stripe.charge).not.toHaveBeenCalled();
  });
});

describe("POST /api/orders/:orderId/release-hold", () => {
  it("cancels a hold", async () => {
    stripe.cancel.mockResolvedValue({ id: "pi_hold", status: "canceled" });
    const r = await post("/api/orders/ord-1/release-hold", {});
    expect(r.status).toBe(200);
    expect(stripe.cancel).toHaveBeenCalledWith("pi_hold", "release-ord-1");
  });
});
