import http from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Operator collection route: money is collected only through proof of
 * filing, the hold is captured once, and an expired or released hold is
 * NEVER charged (owner's final hold rule, 25 Nov 2026; adapted from open
 * PR #15). Database and Stripe are faked; the real round trip is
 * the Stripe test-mode run recorded in DECISIONS.md.
 */
const db = vi.hoisted(() => ({
  order: null as null | Record<string, unknown>,
  queries: [] as string[],
  failEmailQueue: false,
  paymentLinkUrl: null as string | null,
  params: [] as unknown[][],
}));
const alerts = vi.hoisted(() => ({ send: vi.fn(async () => ({ channel: "log", ok: true })) }));
vi.mock("../src/ops/alerts.js", () => ({ sendOpsAlert: alerts.send }));
vi.mock("../src/db/pool.js", () => {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    db.queries.push(sql);
    db.params.push(params);
    if (/SELECT payment_link_url FROM orders/.test(sql)) return { rows: [{ payment_link_url: db.paymentLinkUrl }], rowCount: 1 };
    if (db.failEmailQueue && /INSERT INTO crm_sync_queue/.test(sql)) throw new Error("queue unavailable");
    if (/SELECT payment_link_id, payment_status FROM orders/.test(sql)) return { rows: db.order ? [{ payment_link_id: db.order.payment_link_id ?? null, payment_status: db.order.payment_status }] : [], rowCount: db.order ? 1 : 0 };
    if (/^\s*UPDATE orders\s+SET (proof_of_filing_ref|sunbiz_submitted_at)/.test(sql) || /^\s*SELECT order_id, payment_status/.test(sql)) {
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
  deactivate: vi.fn(),
}));
vi.mock("../src/stripe/restClient.js", async (orig) => {
  const actual = await orig<typeof import("../src/stripe/restClient.js")>();
  return {
    ...actual,
    capturePaymentIntent: stripe.capture,
    cancelPaymentIntent: stripe.cancel,
    chargeSavedCard: stripe.charge,
    retrievePaymentIntent: stripe.retrieve,
    deactivatePaymentLink: stripe.deactivate,
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
  db.failEmailQueue = false;
  db.paymentLinkUrl = null;
  db.params = [];
  alerts.send.mockClear();
  db.order = {
    order_id: "ord-1",
    filing_session_id: "fs-1",
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
    expect(db.queries.find((q) => !/^BEGIN/.test(q))).toMatch(/proof_of_filing_ref/);
    // The route never marks the order paid itself — the webhook does.
    expect(db.queries.join("\n")).not.toMatch(/payment_status = 'paid'/);
  });

  it("still collects the payment when the filing confirmation cannot be queued", async () => {
    db.failEmailQueue = true;
    stripe.capture.mockResolvedValue({ id: "pi_hold", status: "requires_capture" });
    const r = await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("collection_requested");
    expect(stripe.capture).toHaveBeenCalledTimes(1);
    expect(db.queries).toContain("ROLLBACK TO SAVEPOINT customer_emails");
    expect(db.queries).toContain("COMMIT");
    expect(alerts.send).toHaveBeenCalledWith("Customer emails not queued", expect.stringContaining("ord-1"));
  });

  it("charges nothing and asks for fresh consent when the hold has expired", async () => {
    stripe.capture.mockRejectedValue(new StripeApiError("expired", 400, { code: "charge_expired_for_capture" }));
    const r = await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" });
    expect(r.status).toBe(409);
    expect(r.json.status).toBe("fresh_consent_required");
    expect(r.json.reason).toBe("hold_expired");
    expect(stripe.charge).not.toHaveBeenCalled();
    expect(stripe.retrieve).not.toHaveBeenCalled();
    expect(db.queries.some((q) => /capture_error/.test(q))).toBe(true);
    expect(alerts.send).toHaveBeenCalledWith("New payment approval needed", expect.stringContaining("Nothing was charged"));
  });

  it("does not fall back on an ordinary capture error", async () => {
    stripe.capture.mockRejectedValue(new StripeApiError("rate limited", 429, { code: "rate_limit" }));
    const r = await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" });
    expect(r.status).toBe(502);
    expect(stripe.charge).not.toHaveBeenCalled();
    expect(db.queries.some((q) => /capture_error/.test(q))).toBe(true);
  });

  it("charges nothing for an order whose hold was already released, and points to the Day-5 payment link", async () => {
    db.order = { ...db.order, payment_status: "released" };
    db.paymentLinkUrl = "https://buy.stripe.com/test_link";
    const r = await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" });
    expect(r.status).toBe(409);
    expect(r.json.status).toBe("fresh_consent_required");
    expect(r.json.reason).toBe("hold_released");
    expect(r.json.payment_link_url).toBe("https://buy.stripe.com/test_link");
    expect(stripe.capture).not.toHaveBeenCalled();
    expect(stripe.charge).not.toHaveBeenCalled();
    // The filing confirmation says nothing was charged (payment mode "released").
    const queued = db.params.find((p) => typeof p[2] === "string" && p[2] === "customer_email_filing_confirmation");
    expect(queued?.[3]).toBe(JSON.stringify({ payment_mode: "released" }));
  });

  it("does nothing for an order already paid or with nothing held", async () => {
    db.order = { ...db.order, payment_status: "paid" };
    expect((await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" })).json.status).toBe("already_paid");
    db.order = { ...db.order, payment_status: "pending" };
    expect((await post("/api/orders/ord-1/proof-of-filing", { document_number: "L26000123456" })).status).toBe(409);
    expect(stripe.capture).not.toHaveBeenCalled();
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

describe("POST /api/orders/:orderId/sunbiz-submitted (rule 1: capture at Sunbiz submission)", () => {
  it("refuses without the operator key or a tracking reference", async () => {
    expect((await post("/api/orders/ord-1/sunbiz-submitted", { tracking_ref: "100123456789" }, null)).status).toBe(401);
    expect((await post("/api/orders/ord-1/sunbiz-submitted", {})).status).toBe(400);
    expect(stripe.capture).not.toHaveBeenCalled();
  });

  it("records the submission, then captures the hold with the same key as proof of filing, and emails nobody", async () => {
    stripe.capture.mockResolvedValue({ id: "pi_hold", status: "succeeded" });
    const r = await post("/api/orders/ord-1/sunbiz-submitted", { tracking_ref: "100123456789" });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("collection_requested");
    expect(stripe.capture).toHaveBeenCalledWith("pi_hold", "capture-ord-1");
    expect(db.queries[0]).toMatch(/sunbiz_submitted_at = COALESCE\(sunbiz_submitted_at, now\(\)\)/);
    expect(db.params[0]).toEqual(["ord-1", "100123456789"]);
    expect(db.queries.join("\n")).not.toMatch(/crm_sync_queue|payment_status = 'paid'/);
  });

  it("charges nothing when the hold can no longer be captured", async () => {
    stripe.capture.mockRejectedValue(new StripeApiError("expired", 400, { code: "charge_expired_for_capture" }));
    const r = await post("/api/orders/ord-1/sunbiz-submitted", { tracking_ref: "100123456789" });
    expect(r.status).toBe(409);
    expect(r.json.status).toBe("fresh_consent_required");
    expect(alerts.send).toHaveBeenCalledWith("New payment approval needed", expect.stringContaining("submitted to Sunbiz"));
  });

  it("answers already_paid for a paid order without touching Stripe", async () => {
    db.order = { ...db.order, payment_status: "paid" };
    const r = await post("/api/orders/ord-1/sunbiz-submitted", { tracking_ref: "100123456789" });
    expect(r.json.status).toBe("already_paid");
    expect(stripe.capture).not.toHaveBeenCalled();
  });
});

describe("POST /api/orders/:orderId/close-payment-link", () => {
  it("deactivates the Day-5 payment link", async () => {
    db.order = { ...db.order, payment_status: "released", payment_link_id: "plink_1" };
    stripe.deactivate.mockResolvedValue({ id: "plink_1", url: "https://buy.stripe.com/x", active: false });
    const r = await post("/api/orders/ord-1/close-payment-link", {});
    expect(r.status).toBe(200);
    expect(r.json.active).toBe(false);
    expect(stripe.deactivate).toHaveBeenCalledWith("plink_1", "close-paylink-ord-1");
    expect(db.queries.some((q) => /payment_link_closed_at/.test(q))).toBe(true);
  });

  it("answers 409 when the order has no link", async () => {
    const r = await post("/api/orders/ord-1/close-payment-link", {});
    expect(r.status).toBe(409);
    expect(stripe.deactivate).not.toHaveBeenCalled();
  });
});
