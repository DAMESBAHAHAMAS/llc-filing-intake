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
  failEmailQueue: false,
}));
vi.mock("../src/db/pool.js", () => {
  const query = vi.fn(async (sql: string) => {
    db.queries.push(sql);
    if (db.failEmailQueue && /INSERT INTO crm_sync_queue/.test(sql)) throw new Error("queue unavailable");
    if (/^\s*UPDATE orders\s+SET proof_of_filing_ref/.test(sql) || /^\s*SELECT order_id, (filing_session_id, )?payment_status/.test(sql)) {
      return { rows: db.order ? [db.order] : [], rowCount: db.order ? 1 : 0 };
    }
    return { rows: [], rowCount: 1 };
  });
  return { pool: { query, connect: vi.fn(async () => ({ query, release: () => undefined })) } };
});

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

const delivery = vi.hoisted(() => ({ deliver: vi.fn(), alert: vi.fn() }));
vi.mock("../src/proofDelivery/deliverProof.js", () => ({ deliverProofToCustomer: delivery.deliver }));
vi.mock("../src/ops/alerts.js", () => ({ sendOpsAlert: delivery.alert }));

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
  db.failEmailQueue = false;
  db.order = {
    order_id: "ord-1",
    filing_session_id: "fs-1",
    payment_status: "authorized",
    stripe_payment_intent_id: "pi_hold",
    total_cents: 49900,
    currency: "usd",
    line_items: [{ offer_code: "FASTTRACK" }],
  };
  Object.values(stripe).forEach((f) => f.mockReset());
  delivery.alert.mockReset();
  delivery.deliver.mockReset();
  delivery.deliver.mockResolvedValue({ ok: true, alreadyDelivered: false });
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
    expect(db.queries.find((q) => /^\s*UPDATE/.test(q))).toMatch(/proof_of_filing_ref/);
    // The route never marks the order paid itself — the webhook does.
    expect(db.queries.join("\n")).not.toMatch(/payment_status = 'paid'/);
  });

  it("delivers proof to the customer before any money moves", async () => {
    const order: string[] = [];
    delivery.deliver.mockImplementation(async () => {
      order.push("delivered");
      return { ok: true, alreadyDelivered: false };
    });
    stripe.capture.mockImplementation(async () => {
      order.push("captured");
      return { id: "pi_hold", status: "succeeded" };
    });
    await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" });
    expect(order).toEqual(["delivered", "captured"]);
  });

  it("collects nothing when proof cannot be delivered, and says why", async () => {
    delivery.deliver.mockResolvedValue({ ok: false, error: "Resend not configured" });
    const r = await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" });
    expect(r.status).toBe(502);
    expect(r.json).toMatchObject({ detail: "Resend not configured", order_id: "ord-1" });
    expect(String(r.json.error)).toMatch(/nothing was collected/);
    expect(stripe.capture).not.toHaveBeenCalled();
    expect(stripe.charge).not.toHaveBeenCalled();
    expect(stripe.retrieve).not.toHaveBeenCalled();
    expect(delivery.alert).toHaveBeenCalledTimes(1);
    // The proof itself stays recorded, so the retry below can pick it up.
    expect(db.queries.find((q) => /^\s*UPDATE/.test(q))).toMatch(/proof_of_filing_ref/);
  });

  it("does not charge the saved card either when an expired hold's proof cannot be delivered", async () => {
    db.order = { ...db.order, payment_status: "released" };
    delivery.deliver.mockResolvedValue({ ok: false, error: "no customer email" });
    const r = await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" });
    expect(r.status).toBe(502);
    expect(stripe.charge).not.toHaveBeenCalled();
  });

  it("collects on the retry once delivery succeeds", async () => {
    delivery.deliver.mockResolvedValueOnce({ ok: false, error: "provider down" });
    stripe.capture.mockResolvedValue({ id: "pi_hold", status: "succeeded" });
    expect((await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" })).status).toBe(502);
    const retry = await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" });
    expect(retry.status).toBe(200);
    expect(retry.json.status).toBe("collection_requested");
    expect(stripe.capture).toHaveBeenCalledTimes(1);
  });

  it("still gives an already-paid customer their proof, and a failed send changes nothing", async () => {
    db.order = { ...db.order, payment_status: "paid" };
    expect((await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" })).json).toMatchObject({
      status: "already_paid",
      proof_delivered: true,
    });
    delivery.deliver.mockResolvedValue({ ok: false, error: "provider down" });
    const r = await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "already_paid", proof_delivered: false });
    expect(delivery.alert).toHaveBeenCalledTimes(1);
    expect(stripe.capture).not.toHaveBeenCalled();
  });

  it("emails nothing for an order with nothing held", async () => {
    db.order = { ...db.order, payment_status: "pending" };
    expect((await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" })).status).toBe(409);
    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it("charges the saved card when the hold has expired", async () => {
    stripe.capture.mockRejectedValue(new StripeApiError("expired", 400, { code: "charge_expired_for_capture" }));
    stripe.retrieve.mockResolvedValue({ id: "pi_hold", status: "canceled", customer: "cus_1", payment_method: "pm_1" });
    stripe.charge.mockResolvedValue({ id: "pi_fallback", status: "succeeded" });
    const r = await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("saved_card_charged");
    expect(stripe.charge).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cus_1", paymentMethodId: "pm_1", amountCents: 49900, idempotencyKey: "fallback-ord-1-1" })
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
    stripe.retrieve.mockResolvedValue({ id: "pi_hold", status: "canceled", customer: "cus_1", payment_method: "pm_1" });
    stripe.charge.mockResolvedValue({ id: "pi_fallback", status: "succeeded" });
    const r = await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" });
    expect(r.json.status).toBe("saved_card_charged");
    expect(stripe.capture).not.toHaveBeenCalled();
  });

  it("never charges the saved card when the hold was in fact already captured", async () => {
    stripe.capture.mockRejectedValue(new StripeApiError("already captured", 400, { code: "payment_intent_unexpected_state" }));
    stripe.retrieve.mockResolvedValue({ id: "pi_hold", status: "succeeded", customer: "cus_1", payment_method: "pm_1" });
    const r = await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("collection_requested");
    expect(stripe.charge).not.toHaveBeenCalled();
  });

  it("does not charge the saved card while the hold is still in place", async () => {
    stripe.capture.mockRejectedValue(new StripeApiError("odd state", 400, { code: "payment_intent_unexpected_state" }));
    stripe.retrieve.mockResolvedValue({ id: "pi_hold", status: "requires_capture", customer: "cus_1", payment_method: "pm_1" });
    expect((await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" })).status).toBe(502);
    expect(stripe.charge).not.toHaveBeenCalled();
  });

  it("does not charge twice once a saved-card charge has gone through", async () => {
    db.order = { ...db.order, payment_status: "released", saved_card_payment_intent_id: "pi_fallback" };
    const r = await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" });
    expect(r.json.status).toBe("saved_card_charged");
    expect(stripe.charge).not.toHaveBeenCalled();
  });

  it("refuses a cancelled order and records nothing", async () => {
    db.order = { ...db.order, payment_status: "released", cancelled_at: new Date() };
    const r = await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" });
    expect(r.status).toBe(409);
    expect(db.queries.join("\n")).not.toMatch(/SET proof_of_filing_ref/);
    expect(stripe.charge).not.toHaveBeenCalled();
    expect(delivery.deliver).not.toHaveBeenCalled();
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
    stripe.retrieve.mockResolvedValue({ id: "pi_hold", status: "canceled", customer: "cus_1", payment_method: "pm_1" });
    stripe.charge.mockResolvedValue({ id: "pi_fallback", status: "succeeded" });
    await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" });
    expect(stripe.charge).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 49900 }));
  });

  it("charges the deferred part to the saved card once the service is complete", async () => {
    db.order = { ...db.order, payment_status: "paid", deferred_cents: 29900, deferred_payment_intent_id: null };
    stripe.retrieve.mockResolvedValue({ id: "pi_hold", status: "canceled", customer: "cus_1", payment_method: "pm_1" });
    stripe.charge.mockResolvedValue({ id: "pi_ein", status: "succeeded" });
    const r = await post("/api/orders/ord-1/service-complete", { service_ref: "12-3456789" });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("deferred_service_charged");
    expect(stripe.charge).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 29900,
        idempotencyKey: "deferred-ord-1-1",
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

describe("a saved card that fails after filing", () => {
  const declined = () => new StripeApiError("Your card was declined.", 402, { code: "card_declined", decline_code: "generic_decline" });
  const released = (over: Record<string, unknown> = {}) => {
    db.order = { ...db.order, payment_status: "released", saved_card_attempts: 0, ...over };
    stripe.retrieve.mockResolvedValue({ id: "pi_hold", status: "canceled", customer: "cus_1", payment_method: "pm_1" });
  };
  const fileProof = () => post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" });

  it("emails the customer to arrange payment and alerts ops", async () => {
    released();
    stripe.charge.mockRejectedValue(declined());
    const r = await fileProof();
    expect(r.status).toBe(502);
    expect(r.json).toMatchObject({ status: "saved_card_declined", customer_emailed: true });
    const queued = db.queries.find((q) => /INSERT INTO crm_sync_queue/.test(q));
    expect(queued).toBeTruthy();
    expect(delivery.alert).toHaveBeenCalledWith("Saved card declined after filing", expect.stringContaining("ord-1"));
    expect(db.queries.some((q) => /saved_card_attempts = saved_card_attempts \+ 1/.test(q))).toBe(true);
  });

  it("uses a new idempotency key per attempt, so a retry does not replay the decline", async () => {
    released();
    stripe.charge.mockRejectedValue(declined());
    await fileProof();
    released({ saved_card_attempts: 1 });
    stripe.charge.mockResolvedValue({ id: "pi_second", status: "succeeded" });
    const r = await fileProof();
    expect(r.json.status).toBe("saved_card_charged");
    expect(stripe.charge.mock.calls.map(([params]) => params.idempotencyKey)).toEqual(["fallback-ord-1-1", "fallback-ord-1-2"]);
  });

  it("keeps the same key when the outcome is unknown, so nobody is charged twice", async () => {
    released();
    stripe.charge.mockRejectedValue(new Error("socket hang up"));
    expect((await fileProof()).status).toBe(502);
    expect(db.queries.some((q) => /saved_card_attempts \+ 1/.test(q))).toBe(false);
    expect(db.queries.some((q) => /INSERT INTO crm_sync_queue/.test(q))).toBe(false);
    expect(delivery.alert).toHaveBeenCalledWith("Payment could not be collected", expect.any(String));
    await fileProof();
    expect(stripe.charge.mock.calls.map(([params]) => params.idempotencyKey)).toEqual(["fallback-ord-1-1", "fallback-ord-1-1"]);
  });

  it("treats a declined service charge the same way, and keeps the EIN out of Stripe and alerts", async () => {
    db.order = { ...db.order, payment_status: "paid", deferred_cents: 29900, deferred_payment_intent_id: null, deferred_attempts: 0 };
    stripe.retrieve.mockResolvedValue({ id: "pi_hold", status: "succeeded", customer: "cus_1", payment_method: "pm_1" });
    stripe.charge.mockRejectedValue(declined());
    const r = await post("/api/orders/ord-1/service-complete", { service_ref: "12-3456789" });
    expect(r.status).toBe(502);
    expect(r.json).toMatchObject({ status: "saved_card_declined", customer_emailed: true });
    const params = stripe.charge.mock.calls[0][0];
    expect(params.idempotencyKey).toBe("deferred-ord-1-1");
    expect(JSON.stringify(params.metadata)).not.toContain("3456789");
    expect(JSON.stringify(delivery.alert.mock.calls)).not.toContain("3456789");
  });
});

describe("POST /api/orders/:orderId/cancel", () => {
  const cancel = (body: unknown = { reason: "customer changed their mind" }, key: string | null = "op-test-key") => post("/api/orders/ord-1/cancel", body, key);

  it("needs the operator key", async () => {
    expect((await cancel({}, null)).status).toBe(401);
  });

  it("releases a hold, stops filing, and tells the customer", async () => {
    stripe.cancel.mockResolvedValue({ id: "pi_hold", status: "canceled" });
    const r = await cancel();
    expect(r.json).toMatchObject({ status: "cancelled" });
    expect(stripe.cancel).toHaveBeenCalledWith("pi_hold", "release-ord-1");
    const sql = db.queries.join("\n");
    expect(sql).toMatch(/cancelled_at = now\(\)/);
    expect(sql).toMatch(/fulfillment_status = 'not_ready'/);
    expect(sql).toMatch(/registered_agent_acceptances SET status = 'expired'/);
    expect(sql).toMatch(/INSERT INTO crm_sync_queue/);
    expect(delivery.alert).toHaveBeenCalledWith("Order cancelled", expect.stringContaining("ord-1"));
  });

  it("marks the order before Stripe is called, so nothing can file or charge it meanwhile", async () => {
    stripe.cancel.mockImplementation(async () => {
      expect(db.queries.join("\n")).toMatch(/cancelled_at = now\(\)/);
      return { id: "pi_hold", status: "canceled" };
    });
    await cancel();
    expect(stripe.cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels an order whose hold already ended, without calling Stripe", async () => {
    db.order = { ...db.order, payment_status: "released" };
    expect((await cancel()).status).toBe(200);
    expect(stripe.cancel).not.toHaveBeenCalled();
  });

  it("accepts a hold that ended between the read and the release", async () => {
    stripe.cancel.mockRejectedValue(new StripeApiError("already canceled", 400, { code: "payment_intent_unexpected_state" }));
    expect((await cancel()).status).toBe(200);
  });

  it("reports a release that failed, and a repeat call retries it without repeating the rest", async () => {
    stripe.cancel.mockRejectedValue(new Error("stripe unavailable"));
    expect((await cancel()).status).toBe(502);
    expect(delivery.alert).toHaveBeenCalledWith("Hold not released", expect.any(String));
    db.order = { ...db.order, cancelled_at: new Date() };
    db.queries = [];
    stripe.cancel.mockResolvedValue({ id: "pi_hold", status: "canceled" });
    expect((await cancel()).status).toBe(200);
    expect(db.queries.join("\n")).not.toMatch(/INSERT INTO crm_sync_queue/);
  });

  it("refuses once the filing is submitted, and a paid order", async () => {
    db.order = { ...db.order, proof_of_filing_at: new Date() };
    expect((await cancel()).status).toBe(409);
    db.order = { ...db.order, proof_of_filing_at: null, fulfillment_status: "transmitted" };
    expect((await cancel()).status).toBe(409);
    db.order = { ...db.order, fulfillment_status: "ready", payment_status: "paid" };
    expect((await cancel()).status).toBe(409);
    expect(stripe.cancel).not.toHaveBeenCalled();
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
