import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import express from "express";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrderEmailDb } from "./helpers/orderEmailDb.js";

/**
 * The Zoho Deal must carry the amount the customer was charged at
 * checkout. This drives a signed Stripe event through the real webhook
 * route and the real CRM sync worker and Zoho client, with only Zoho's
 * HTTP API stubbed, then compares what reaches Zoho with the checkout
 * amount. The checkout amount is worked out here from the line items,
 * the way routes/checkout.ts adds them up, not read back from the code
 * under test.
 *
 * It also checks the Cloudflare intake worker (llc-worker.js) sends no
 * price at all, since the package is chosen after intake.
 */
const state = vi.hoisted(() => ({ db: null as unknown as Pool }));
vi.mock("../src/db/pool.js", () => ({
  pool: {
    query: (sql: string, params?: unknown[]) => state.db.query(sql, params as never),
    connect: () => state.db.connect(),
  },
}));
vi.mock("../src/ops/alerts.js", () => ({ sendOpsAlert: vi.fn(async () => ({ channel: "log", ok: true })), notifyOrderEvent: vi.fn(async () => undefined) }));
vi.mock("../src/registeredAgent/acceptanceEmail.js", () => ({ dispatchAcceptanceEmail: vi.fn(async () => ({ ok: true })) }));

const { stripeWebhookRouter } = await import("../src/routes/webhooksStripe.js");
const syncWorker = await import("../src/sync/worker.js");
const { realZohoClient } = await import("../src/zoho/client.js");

const WEBHOOK_SECRET = "whsec_deal_amount_test";
const CUSTOMER = "jordan@example.com";
const INTAKE_DEAL_ID = "2654294000040595002";

// The test order from 24 Nov 2026 (order 6b4cbf53): DIY filing with the
// house registered agent, Offer Master prices at the time.
const DIY_WITH_AGENT = [
  { offer_code: "DIY_STATE_FEE", display_name: "Florida LLC State Filing Fee", unit_amount_cents: 12500, quantity: 1 },
  { offer_code: "DIY_SERVICE_FEE", display_name: "DIY Processing / Service Fee", unit_amount_cents: 900, quantity: 1 },
  { offer_code: "DIY_CERT_OF_STATUS", display_name: "Certificate of Status (Included)", unit_amount_cents: 500, quantity: 1 },
  { offer_code: "REGISTERED_AGENT_3YR", display_name: "Florida Registered Agent Service — 3 Years", unit_amount_cents: 9800, quantity: 1 },
];
/** What the customer pays at checkout, in dollars. */
const checkoutDollars = (items: typeof DIY_WITH_AGENT) => items.reduce((s, li) => s + li.unit_amount_cents * li.quantity, 0) / 100;

let server: http.Server;
let base = "";
beforeAll(async () => {
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  const app = express();
  app.use("/api/webhooks/stripe", express.raw({ type: "application/json" }));
  app.use(stripeWebhookRouter);
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/** Zoho calls the client makes, with their parsed bodies. */
let zohoCalls: Array<{ method: string; url: string; body: Record<string, unknown> | null }>;
/** Per-test Zoho reply, checked before the defaults below. */
let zohoOverride: ((method: string, url: string) => unknown | undefined) | null;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  process.env.ZOHO_CLIENT_ID = "test-client";
  process.env.ZOHO_CLIENT_SECRET = "test-secret";
  process.env.ZOHO_REFRESH_TOKEN = "test-refresh";
  delete process.env.ZOHO_DEAL_STAGE_ON_HOLD;
  delete process.env.ZOHO_DEAL_STAGE_ON_PAYMENT;
  state.db = await createOrderEmailDb();
  zohoCalls = [];
  zohoOverride = null;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes("zoho")) return realFetch(input, init);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    zohoCalls.push({ method, url, body });
    const reply = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.includes("/oauth/v2/token")) return reply({ access_token: "test-access" });
    const custom = zohoOverride?.(method, url);
    if (custom !== undefined) return reply(custom);
    if (method === "GET" && url.includes("/Deals/")) return reply({ data: [{ Contact_Name: { id: "contact-1" } }] });
    if (method === "GET" && url.includes("/Contacts/")) return reply({ data: [{ Email: CUSTOMER }] });
    return reply({ data: [{ code: "SUCCESS", details: { id: "deal-created-at-payment" } }] });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function placeOrder(
  items: Array<Record<string, unknown>>,
  totalCents: number,
  crmDealId: string | null,
  opts: { filingSessionId?: string; product?: string } = {}
) {
  const filingSessionId = opts.filingSessionId ?? randomUUID();
  const product = opts.product ?? "DIY_STATE_FEE";
  const checkoutSessionId = `cs_test_${randomUUID()}`;
  if (!opts.filingSessionId) {
    await state.db.query(
      `INSERT INTO filing_sessions (filing_session_id, email, full_name, entity_name_primary, filing_data, registered_agent_status, crm_deal_id)
       VALUES ($1, $2, 'Jordan Rivera', 'SUNSHINE VENTURES LLC', $3, 'accepted', $4)`,
      [filingSessionId, CUSTOMER, JSON.stringify({ llc_name: "SUNSHINE VENTURES LLC", registered_agent_path: "house" }), crmDealId]
    );
  }
  await state.db.query(
    `INSERT INTO orders (order_id, filing_session_id, crm_intent, product, line_items, total_cents, stripe_checkout_session_id)
     VALUES ($1, $2, $3, $3, $4, $5, $6)`,
    [randomUUID(), filingSessionId, product, JSON.stringify(items), totalCents, checkoutSessionId]
  );
  return { checkoutSessionId, filingSessionId };
}

async function pay(checkoutSessionId: string, crmDealId: string | null, mode: "hold" | "immediate" = "hold") {
  const event = {
    id: `evt_${randomUUID()}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: checkoutSessionId,
        payment_status: mode === "hold" ? "unpaid" : "paid",
        payment_intent: mode === "hold" ? "pi_hold" : "pi_paid",
        metadata: crmDealId ? { crm_deal_id: crmDealId } : {},
      },
    },
  };
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${body}`, "utf8").digest("hex");
  const res = await fetch(`${base}/api/webhooks/stripe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${t},v1=${v1}` },
    body,
  });
  expect(res.status).toBe(200);
  await syncWorker.runOnce(state.db, realZohoClient);
}

/** The Deal record the client wrote to Zoho (PUT for the intake Deal, POST for a new one). */
const dealWrite = (method: "PUT" | "POST", nth = 0) => {
  const call = zohoCalls.filter((c) => c.method === method && /\/crm\/v2\/Deals/.test(c.url))[nth];
  expect(call, `no ${method} to Zoho Deals`).toBeTruthy();
  return (call!.body!.data as Array<Record<string, unknown>>)[0];
};

describe("Zoho Deal amount after checkout", () => {
  it("updates the intake Deal with the checkout amount, package and name", async () => {
    const total = Math.round(checkoutDollars(DIY_WITH_AGENT) * 100);
    await pay((await placeOrder(DIY_WITH_AGENT, total, INTAKE_DEAL_ID)).checkoutSessionId, INTAKE_DEAL_ID);

    const deal = dealWrite("PUT");
    expect(deal.Amount).toBe(checkoutDollars(DIY_WITH_AGENT));
    expect(deal.Amount).toBe(237);
    expect(deal.Package).toBe("DIY");
    expect(deal.Deal_Name).toBe("SUNSHINE VENTURES LLC — DIY ($237.00)");
    expect(deal.Manual_Review_Required).toBeUndefined();
    expect(deal.Stage).toBe("SERVICE REQUESTED");
    expect(JSON.stringify(deal)).not.toMatch(/349|Standard/);
  });

  it("creates the Deal at payment with the checkout amount when intake made none", async () => {
    const total = Math.round(checkoutDollars(DIY_WITH_AGENT) * 100);
    await pay((await placeOrder(DIY_WITH_AGENT, total, null)).checkoutSessionId, null);

    const deal = dealWrite("POST");
    expect(deal.Amount).toBe(checkoutDollars(DIY_WITH_AGENT));
    expect(deal.Package).toBe("DIY");
    expect(deal.Deal_Name).toBe("SUNSHINE VENTURES LLC — DIY ($237.00)");
  });

  it("writes no amount and flags manual review when the order total does not match its line items", async () => {
    await pay((await placeOrder(DIY_WITH_AGENT, 34900, INTAKE_DEAL_ID)).checkoutSessionId, INTAKE_DEAL_ID);

    const deal = dealWrite("PUT");
    expect(deal.Amount).toBeUndefined();
    expect(deal.Manual_Review_Required).toBe(true);
    expect(deal.Deal_Name).toBe("SUNSHINE VENTURES LLC — price not found, needs review");
  });

  it("writes no amount and flags manual review when the order has no line items", async () => {
    await pay((await placeOrder([], 23700, INTAKE_DEAL_ID)).checkoutSessionId, INTAKE_DEAL_ID);

    const deal = dealWrite("PUT");
    expect(deal.Amount).toBeUndefined();
    expect(deal.Manual_Review_Required).toBe(true);
  });

  it("adds a follow-up order (EIN upsell) to the Deal instead of replacing the first order", async () => {
    const first = await placeOrder(DIY_WITH_AGENT, 23700, INTAKE_DEAL_ID);
    await pay(first.checkoutSessionId, INTAKE_DEAL_ID);
    const EIN = [{ offer_code: "EIN_FILING", display_name: "EIN Filing Service (Standard)", unit_amount_cents: 29900, quantity: 1 }];
    const second = await placeOrder(EIN, 29900, INTAKE_DEAL_ID, { filingSessionId: first.filingSessionId, product: "EIN_FILING" });
    await pay(second.checkoutSessionId, INTAKE_DEAL_ID);

    const deal = dealWrite("PUT", 1);
    expect(deal.Amount).toBe(checkoutDollars(DIY_WITH_AGENT) + checkoutDollars(EIN));
    expect(deal.Amount).toBe(536);
    expect(deal.Package).toBe("DIY");
    expect(deal.Deal_Name).toBe("SUNSHINE VENTURES LLC — DIY + EIN Filing ($536.00)");
  });

  it("prices the intake Deal when the order is charged immediately (no hold)", async () => {
    const RA_ONLY = [{ offer_code: "REGISTERED_AGENT_3YR", display_name: "Florida Registered Agent Service — 3 Years", unit_amount_cents: 9800, quantity: 1 }];
    await pay((await placeOrder(RA_ONLY, 9800, INTAKE_DEAL_ID, { product: "REGISTERED_AGENT_3YR" })).checkoutSessionId, INTAKE_DEAL_ID, "immediate");

    const deal = dealWrite("PUT");
    expect(deal.Amount).toBe(checkoutDollars(RA_ONLY));
    expect(deal.Package).toBe("Registered Agent 3-Year");
    expect(deal.Stage).toBe("Closed Won");
  });
});

describe("the Cloudflare intake worker (llc-worker.js)", () => {
  async function submitIntake() {
    const worker = (await import(new URL("../../llc-worker.js", import.meta.url).href)) as {
      default: { fetch: (req: Request, env: Record<string, string>) => Promise<Response> };
    };
    const request = new Request("https://llc-worker.example/intake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lead_type: "intake_complete",
        llc_name: "SUNSHINE VENTURES LLC",
        first_name: "Jordan",
        last_name: "Rivera",
        email: CUSTOMER,
        package: "standard",
      }),
    });
    const res = await worker.default.fetch(request, { ZOHO_CLIENT_ID: "id", ZOHO_CLIENT_SECRET: "s", ZOHO_REFRESH_TOKEN: "r" });
    return (await res.json()) as Record<string, unknown>;
  }

  it("creates the Deal with no amount and no package", async () => {
    const out = await submitIntake();
    expect(out.success).toBe(true);
    expect(out.deal_id).toBe("deal-created-at-payment");

    const deal = dealWrite("POST");
    expect(deal).not.toHaveProperty("Amount");
    expect(deal).not.toHaveProperty("Package");
    expect(deal.Deal_Name).toBe("SUNSHINE VENTURES LLC — package not chosen yet");
    expect(deal.Stage).toBe("Intake Received");
    expect(deal.Contact_Name).toEqual({ id: "deal-created-at-payment" });
    expect(JSON.stringify(deal)).not.toMatch(/\$|349|Standard/);
  });

  it("reuses the open intake Deal when the interview is completed again", async () => {
    zohoOverride = (method, url) =>
      method === "GET" && /\/Contacts\/[^/]+\/Deals/.test(url)
        ? { data: [{ id: "deal-intake-1", Stage: "Intake Received", Deal_Name: "SUNSHINE VENTURES LLC — package not chosen yet" }] }
        : undefined;
    const out = await submitIntake();
    expect(out.deal_id).toBe("deal-intake-1");
    expect(zohoCalls.some((c) => c.method === "POST" && /\/crm\/v2\/Deals$/.test(c.url))).toBe(false);
    const put = zohoCalls.find((c) => c.method === "PUT" && c.url.endsWith("/Deals/deal-intake-1"));
    expect(put).toBeTruthy();
    expect((put!.body!.data as Array<Record<string, unknown>>)[0]).not.toHaveProperty("Amount");
  });
});
