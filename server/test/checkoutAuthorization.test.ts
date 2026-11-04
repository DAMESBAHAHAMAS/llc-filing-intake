import http from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** POST /api/checkout/create: the filing authorization gate and what a held session asks Stripe for. */
const db = vi.hoisted(() => ({ filingData: null as unknown, inserted: [] as unknown[][], queries: [] as string[] }));
vi.mock("../src/db/pool.js", () => {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    db.queries.push(sql);
    if (/FROM filing_sessions/.test(sql)) return { rows: [{ email: "ana@example.com", crm_deal_id: null, filing_data: db.filingData }], rowCount: 1 };
    if (/INSERT INTO orders/.test(sql)) {
      db.inserted.push(params ?? []);
      return { rows: [{ order_id: "ord-1" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query, connect: vi.fn(async () => ({ query, release: () => undefined })) } };
});
vi.mock("../src/offers/catalog.js", () => ({
  resolveActiveOffers: vi.fn(async (_pool: unknown, codes: string[]) =>
    codes.map((offer_code) => ({
      offer_code,
      offer_version: 1,
      display_name: offer_code,
      stripe_price_id: `price_${offer_code}`,
      unit_amount_cents: offer_code === "EIN_FILING" ? 7500 : 19900,
      crm_intent: "intent",
    }))
  ),
}));
const stripe = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../src/stripe/restClient.js", async (orig) => ({ ...(await orig<typeof import("../src/stripe/restClient.js")>()), createCheckoutSession: stripe.create }));

const { checkoutRouter } = await import("../src/routes/checkout.js");
const { SAVED_CARD_AUTHORIZATION } = await import("../src/offers/payAfterFiling.js");

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
beforeEach(() => {
  db.filingData = {
    llc_name: "Sol Ventures LLC",
    principal_address: "100 Main St, Miami, FL 33101",
    mailing_address: "100 Main St, Miami, FL 33101",
    effective_date_option: "Immediate",
    registered_agent_path: "customer",
    registered_agent_name: "Sam Agent",
    registered_agent_florida_address: "9 Bay Rd, Tampa, Florida 33601",
    authorized_persons: [{ name: "Ana Sol", article_iv_title: "AMBR", address: "100 Main St, Miami, FL 33101" }],
    filing_authorization: { accepted: true, signer_name: "Ana Sol" },
  };
  db.inserted = [];
  stripe.create.mockReset();
  stripe.create.mockResolvedValue({ id: "cs_1", url: "https://checkout.example/cs_1" });
});

async function create(offerCodes: string[]) {
  const res = await fetch(`${base}/api/checkout/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filing_session_id: "fs-1", line_items: offerCodes.map((offer_code) => ({ offer_code })) }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("filing authorization", () => {
  it.each([
    ["no filing data", null],
    ["no authorization", {}],
    ["null authorization", { filing_authorization: null }],
    ["not accepted", { filing_authorization: { accepted: false } }],
    ["a truthy value that is not true", { filing_authorization: { accepted: "true" } }],
  ])("returns 422 for an LLC filing order with %s", async (_name, filingData) => {
    db.filingData = filingData;
    const r = await create(["FASTTRACK"]);
    expect(r.status).toBe(422);
    expect(r.json.code).toBe("filing_authorization_required");
    expect(db.inserted).toHaveLength(0);
    expect(stripe.create).not.toHaveBeenCalled();
  });

  it("applies to every LLC filing product", async () => {
    db.filingData = {};
    expect((await create(["DIY_STATE_FEE", "DIY_SERVICE_FEE"])).status).toBe(422);
  });

  it("allows an accepted LLC filing order", async () => {
    const r = await create(["FASTTRACK"]);
    expect(r.status).toBe(200);
    expect(stripe.create).toHaveBeenCalledTimes(1);
  });

  it("does not apply to an order with no LLC filing", async () => {
    db.filingData = {};
    expect((await create(["REGISTERED_AGENT_3YR"])).status).toBe(200);
    expect((await create(["EIN_FILING"])).status).toBe(200);
  });
});

describe("what checkout records and asks for", () => {
  it("records the capture mode and shows the authorization on a held order", async () => {
    await create(["FASTTRACK"]);
    expect(db.inserted[0]).toContain("hold");
    expect(stripe.create).toHaveBeenCalledWith(expect.objectContaining({ captureMode: "hold", submitMessage: SAVED_CARD_AUTHORIZATION }));
  });

  it("shows no card wording on an order paid at checkout", async () => {
    await create(["REGISTERED_AGENT_3YR"]);
    expect(db.inserted[0]).toContain("immediate");
    expect(stripe.create).toHaveBeenCalledWith(expect.objectContaining({ captureMode: "immediate", submitMessage: undefined, afterSubmitMessage: undefined }));
  });
});
