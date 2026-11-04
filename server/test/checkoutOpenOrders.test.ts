import { randomUUID } from "node:crypto";
import http from "node:http";
import express from "express";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrderEmailDb } from "./helpers/orderEmailDb.js";

/** POST /api/checkout/create: one order per filing, and no card held for Articles that can't be built. */
const state = vi.hoisted(() => ({ db: null as unknown as Pool }));
vi.mock("../src/db/pool.js", () => ({
  pool: {
    query: (sql: string, params?: unknown[]) => state.db.query(sql, params as never),
    connect: () => state.db.connect(),
  },
}));
vi.mock("../src/offers/catalog.js", () => ({
  resolveActiveOffers: vi.fn(async (_pool: unknown, codes: string[]) =>
    codes.map((offer_code) => ({ offer_code, offer_version: 1, display_name: offer_code, stripe_price_id: `price_${offer_code}`, unit_amount_cents: 19900, crm_intent: "intent" }))
  ),
}));
const stripe = vi.hoisted(() => ({ create: vi.fn(), expire: vi.fn(), retrieve: vi.fn() }));
vi.mock("../src/stripe/restClient.js", async (orig) => ({
  ...(await orig<typeof import("../src/stripe/restClient.js")>()),
  createCheckoutSession: stripe.create,
  expireCheckoutSession: stripe.expire,
  retrieveCheckoutSession: stripe.retrieve,
}));

const { checkoutRouter } = await import("../src/routes/checkout.js");
const { StripeApiError } = await import("../src/stripe/restClient.js");

let server: http.Server;
let base = "";
beforeAll(async () => {
  process.env.FRONTEND_BASE_URL = "https://example.com";
  const app = express();
  app.use(express.json());
  app.use(checkoutRouter);
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const FILING = {
  llc_name: "Sol Ventures LLC",
  principal_address: "100 Main St, Miami, FL 33101",
  mailing_address: "100 Main St, Miami, FL 33101",
  effective_date_option: "Immediate",
  registered_agent_path: "customer",
  registered_agent_name: "Sam Agent",
  registered_agent_florida_address: "9 Bay Rd, Tampa, Florida 33601",
  authorized_persons: [{ name: "Ana Sol", article_iv_title: "AMBR", address: "100 Main St, Miami, FL 33101" }],
  filing_authorization: { accepted: true },
};
let filingSessionId: string;

async function session(filingData: Record<string, unknown> = FILING) {
  filingSessionId = randomUUID();
  await state.db.query(`INSERT INTO filing_sessions (filing_session_id, email, filing_data, registered_agent_status) VALUES ($1, 'ana@example.com', $2, 'pending')`, [filingSessionId, JSON.stringify(filingData)]);
}
async function existingOrder(paymentStatus: string, over: { cs?: string | null; checkoutStatus?: string; cancelled?: boolean; items?: unknown[]; ageMs?: number } = {}) {
  const orderId = randomUUID();
  await state.db.query(
    `INSERT INTO orders (order_id, filing_session_id, crm_intent, product, line_items, total_cents, payment_status, checkout_status, stripe_checkout_session_id, cancelled_at, created_at)
     VALUES ($1, $2, 'x', 'FASTTRACK', $3, 19900, $4, $5, $6, $7, $8)`,
    [
      orderId,
      filingSessionId,
      JSON.stringify(over.items ?? [{ offer_code: "FASTTRACK" }]),
      paymentStatus,
      over.checkoutStatus ?? "checkout_created",
      over.cs === undefined ? "cs_old" : over.cs,
      over.cancelled ? new Date() : null,
      new Date(Date.now() - (over.ageMs ?? 0)),
    ]
  );
  return orderId;
}
async function create(codes = ["FASTTRACK"]) {
  const res = await fetch(`${base}/api/checkout/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filing_session_id: filingSessionId, line_items: codes.map((offer_code) => ({ offer_code })) }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}
const orderCount = async () => (await state.db.query(`SELECT order_id FROM orders`)).rows.length;

beforeEach(async () => {
  state.db = await createOrderEmailDb();
  Object.values(stripe).forEach((f) => f.mockReset());
  stripe.create.mockResolvedValue({ id: "cs_new", url: "https://checkout.example/new" });
  stripe.expire.mockResolvedValue({ id: "cs_old", status: "expired" });
  await session();
});

describe("a second order on a filing", () => {
  it.each(["authorized", "paid", "released"])("is refused over a %s order, before Stripe is called", async (status) => {
    const orderId = await existingOrder(status);
    const r = await create();
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: "order_already_open", order_id: orderId });
    expect(stripe.create).not.toHaveBeenCalled();
    expect(await orderCount()).toBe(1);
  });

  it("is allowed after a cancellation", async () => {
    await existingOrder("released", { cancelled: true });
    expect((await create()).status).toBe(200);
  });

  it("allows the agent service alone, which is how a customer switches to Damian", async () => {
    await existingOrder("authorized");
    expect((await create(["REGISTERED_AGENT_3YR"])).status).toBe(200);
  });

  it("closes an unfinished checkout, so two open tabs cannot make two holds", async () => {
    const earlier = await existingOrder("pending");
    expect((await create()).status).toBe(200);
    expect(stripe.expire).toHaveBeenCalledWith("cs_old");
    const { rows } = await state.db.query(`SELECT payment_status, failure_reason FROM orders WHERE order_id = $1`, [earlier]);
    expect(rows[0]).toEqual({ payment_status: "failed", failure_reason: "replaced_by_new_checkout" });
  });

  it("does not close the earlier checkout for a request that gets refused", async () => {
    await session({ ...FILING, authorized_persons: [] });
    await existingOrder("pending");
    expect((await create()).status).toBe(422);
    expect(stripe.expire).not.toHaveBeenCalled();
  });

  it("is refused when the customer paid in the other tab and the webhook has not arrived", async () => {
    const earlier = await existingOrder("pending");
    stripe.expire.mockRejectedValue(new StripeApiError("session is not open", 400, {}));
    stripe.retrieve.mockResolvedValue({ id: "cs_old", status: "complete" });
    const r = await create();
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: "order_already_open", order_id: earlier });
    expect(stripe.create).not.toHaveBeenCalled();
    const { rows } = await state.db.query(`SELECT payment_status FROM orders WHERE order_id = $1`, [earlier]);
    expect(rows[0].payment_status).toBe("pending");
  });

  it("carries on if Stripe had already expired the earlier session", async () => {
    await existingOrder("pending");
    stripe.expire.mockRejectedValue(new StripeApiError("session is not open", 400, {}));
    stripe.retrieve.mockResolvedValue({ id: "cs_old", status: "expired" });
    expect((await create()).status).toBe(200);
  });

  it("does not treat an unclear Stripe answer as closed", async () => {
    await existingOrder("pending");
    stripe.expire.mockRejectedValue(new Error("stripe down"));
    stripe.retrieve.mockResolvedValue({ id: "cs_old", status: "open" });
    expect((await create()).status).toBe(500);
    expect(stripe.create).not.toHaveBeenCalled();
  });

  it("is refused while another request is starting a checkout, and recovers from a crashed one", async () => {
    await existingOrder("pending", { cs: null, checkoutStatus: "pending" });
    expect((await create()).json.code).toBe("checkout_in_progress");
    await session();
    await existingOrder("pending", { cs: null, checkoutStatus: "pending", ageMs: 5 * 60 * 1000 });
    expect((await create()).status).toBe(200);
  });

  it("ignores a checkout Stripe refused to create", async () => {
    await existingOrder("pending", { cs: null, checkoutStatus: "checkout_failed" });
    expect((await create()).status).toBe(200);
    expect(stripe.expire).not.toHaveBeenCalled();
  });
});

describe("Articles that cannot be built", () => {
  it.each([
    ["a blank member address", { authorized_persons: [{ name: "Ana", article_iv_title: "AMBR", address: " " }] }, "authorized_persons[0].address"],
    ["no members", { authorized_persons: [] }, "authorized_persons (at least one required)"],
    ["no principal address", { principal_address: "" }, "principal_address"],
    ["no agent choice", { registered_agent_path: undefined }, "registered_agent_path (must be 'house' or 'customer')"],
    ["a P.O. Box for the agent", { registered_agent_florida_address: "P. O. Box 9, Tampa" }, "registered_agent_florida_address (a physical street address, no P.O. Box)"],
  ])("refuses %s with a clear code, and holds no card", async (_name, change, field) => {
    await session({ ...FILING, ...change });
    const r = await create();
    expect(r.status).toBe(422);
    expect(r.json.code).toBe("filing_data_incomplete");
    expect(r.json.missing_fields).toContain(field);
    expect(stripe.create).not.toHaveBeenCalled();
    expect(await orderCount()).toBe(0);
  });

  it("does not wait for the customer's agent, who is asked only after the hold", async () => {
    expect((await create()).status).toBe(200);
  });

  it("does not apply to an order with no LLC filing", async () => {
    await session({});
    expect((await create(["REGISTERED_AGENT_3YR"])).status).toBe(200);
  });
});
