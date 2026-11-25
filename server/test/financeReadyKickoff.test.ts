import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrderEmailDb } from "./helpers/orderEmailDb.js";
import {
  buildKickoffLines,
  isKickoffCart,
  kickoffDealFields,
  kickoffDisclosure,
  kickoffEnabled,
  type KickoffOffer,
} from "../src/offers/financeReadyKickoff.js";

/**
 * Finance-Ready ($997) kickoff hold (A6Y2-T144 Dispatch 8): checkout holds the
 * $139 base filing, records the package and the $858 balance on the order, and
 * tags the Zoho Deal. Drives the real checkout route, the real webhook route,
 * the CRM sync worker and the Zoho client; only Stripe's and Zoho's HTTP APIs
 * and the Offer Master lookup are stubbed. No real Stripe call is made.
 */

/** The owner-approved disclosure, character for character. */
const DISCLOSURE =
  "$139.00 authorized today (captured on Sunbiz submission). Remaining $858.00 balance is not collected until Damian reviews your build parameters with you and resets your custom scope.";

// Live Offer Master rows (GET /api/offers, 25 Nov 2026) with stand-in Price ids.
const CATALOG: Record<string, KickoffOffer & { crm_intent: string }> = {
  DIY_STATE_FEE: { offer_code: "DIY_STATE_FEE", offer_version: "v1", display_name: "Florida LLC State Filing Fee", stripe_price_id: "price_state", unit_amount_cents: 12500, crm_intent: "LLC_FORMATION_DIY" },
  DIY_SERVICE_FEE: { offer_code: "DIY_SERVICE_FEE", offer_version: "v2", display_name: "DIY Processing / Service Fee", stripe_price_id: "price_service", unit_amount_cents: 900, crm_intent: "LLC_FORMATION_DIY" },
  DIY_CERT_OF_STATUS: { offer_code: "DIY_CERT_OF_STATUS", offer_version: "v1", display_name: "Certificate of Status (Included)", stripe_price_id: "price_cos", unit_amount_cents: 500, crm_intent: "LLC_FORMATION_DIY" },
  PREMIUM: { offer_code: "PREMIUM", offer_version: "v3", display_name: "Florida LLC Formation — Finance-Ready", stripe_price_id: "price_premium_997", unit_amount_cents: 99700, crm_intent: "LLC_FORMATION_PREMIUM" },
  FASTTRACK: { offer_code: "FASTTRACK", offer_version: "v3", display_name: "Florida LLC Formation — Bank-Ready", stripe_price_id: "price_bank_499", unit_amount_cents: 49900, crm_intent: "LLC_FORMATION_FASTTRACK" },
  REGISTERED_AGENT_3YR: { offer_code: "REGISTERED_AGENT_3YR", offer_version: "v2", display_name: "Florida Registered Agent Service — 3 Years", stripe_price_id: "price_ra", unit_amount_cents: 9800, crm_intent: "REGISTERED_AGENT" },
};

const state = vi.hoisted(() => ({ db: null as unknown as Pool }));
/** checkout.ts inserts orders relying on the real table's order_id default, which pg-mem lacks. */
function withOrderId(sql: string): string {
  return sql.replace(
    /INSERT INTO orders \(filing_session_id,([^)]*)\)\s*VALUES \(\$1,/,
    (_m, cols) => `INSERT INTO orders (order_id, filing_session_id,${cols}) VALUES ('${randomUUID()}', $1,`
  );
}
vi.mock("../src/db/pool.js", () => ({
  pool: {
    query: (sql: string, params?: unknown[]) => state.db.query(withOrderId(sql), params as never),
    connect: () => state.db.connect(),
  },
}));
vi.mock("../src/offers/catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/offers/catalog.js")>()),
  resolveActiveOffers: vi.fn(async (_pool: unknown, codes: string[]) =>
    codes.filter((c) => CATALOG[c]).map((c, i) => ({ id: i + 1, currency: "usd", status: "active", stripe_product_id: `prod_${c}`, ...CATALOG[c] }))
  ),
}));
vi.mock("../src/ops/alerts.js", () => ({ sendOpsAlert: vi.fn(async () => ({ channel: "log", ok: true })), notifyOrderEvent: vi.fn(async () => undefined) }));
vi.mock("../src/registeredAgent/acceptanceEmail.js", () => ({ dispatchAcceptanceEmail: vi.fn(async () => ({ ok: true })) }));

const { checkoutRouter } = await import("../src/routes/checkout.js");
const { stripeWebhookRouter } = await import("../src/routes/webhooksStripe.js");
const syncWorker = await import("../src/sync/worker.js");
const { realZohoClient } = await import("../src/zoho/client.js");

const WEBHOOK_SECRET = "whsec_kickoff_test";
const CUSTOMER = "jordan@example.com";
const INTAKE_DEAL_ID = "2654294000040595002";

let server: http.Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use("/api/webhooks/stripe", express.raw({ type: "application/json" }));
  app.use(express.json());
  app.use(checkoutRouter);
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

let stripeBodies: string[];
/** The form-encoded bodies exactly as sent. */
let stripeRaw: string[];
let zohoCalls: Array<{ method: string; url: string; body: Record<string, unknown> | null }>;
const realFetch = globalThis.fetch;
const ENV_KEYS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "FRONTEND_BASE_URL", "FINANCE_READY_KICKOFF", "PAYMENT_CAPTURE_MODE", "CLOSED_OFFER_CODES", "ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN"];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.STRIPE_SECRET_KEY = "sk_test_fake_never_sent";
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.FRONTEND_BASE_URL = "https://damianknowles.com";
  process.env.ZOHO_CLIENT_ID = "test-client";
  process.env.ZOHO_CLIENT_SECRET = "test-secret";
  process.env.ZOHO_REFRESH_TOKEN = "test-refresh";
  for (const k of ["FINANCE_READY_KICKOFF", "PAYMENT_CAPTURE_MODE", "CLOSED_OFFER_CODES"]) delete process.env[k];
  state.db = await createOrderEmailDb();
  await state.db.query("ALTER TABLE orders ADD COLUMN checkout_status text");
  await state.db.query("ALTER TABLE orders ADD COLUMN failure_reason text");
  stripeBodies = [];
  stripeRaw = [];
  zohoCalls = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const reply = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.startsWith("https://api.stripe.com/")) {
      stripeRaw.push(String(init?.body ?? ""));
      stripeBodies.push(decodeURIComponent(String(init?.body ?? "")));
      return reply({ id: "cs_test_kickoff", url: "https://checkout.stripe.com/c/pay/cs_test_kickoff", payment_status: "unpaid", status: "open" });
    }
    if (!url.includes("zoho")) return realFetch(input, init);
    const method = init?.method ?? "GET";
    zohoCalls.push({ method, url, body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null });
    if (url.includes("/oauth/v2/token")) return reply({ access_token: "test-access" });
    if (method === "GET" && url.includes("/Deals/")) return reply({ data: [{ Contact_Name: { id: "contact-1" } }] });
    if (method === "GET" && url.includes("/Contacts/")) return reply({ data: [{ Email: CUSTOMER }] });
    return reply({ data: [{ code: "SUCCESS", details: { id: "deal-created-at-payment" } }] });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

async function newSession(crmDealId: string | null = INTAKE_DEAL_ID, agentPath = "house"): Promise<string> {
  const id = randomUUID();
  await state.db.query(
    `INSERT INTO filing_sessions (filing_session_id, email, full_name, entity_name_primary, filing_data, registered_agent_status, crm_deal_id)
     VALUES ($1, $2, 'Jordan Rivera', 'SUNSHINE VENTURES LLC', $3, 'accepted', $4)`,
    [id, CUSTOMER, JSON.stringify({ llc_name: "SUNSHINE VENTURES LLC", registered_agent_path: agentPath }), crmDealId]
  );
  return id;
}

/** The request body the website sends for Finance-Ready (src/lib/offerTiers.ts buildCheckoutRequest). */
const kickoffBody = (filingSessionId: string) => ({
  filing_session_id: filingSessionId,
  line_items: [{ offer_code: "PREMIUM", quantity: 1 }],
  payment_plan: "finance_ready_kickoff",
});

async function create(body: unknown) {
  const res = await fetch(`${base}/api/checkout/create`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function completeHold(crmDealId: string | null) {
  const event = {
    id: `evt_${randomUUID()}`,
    type: "checkout.session.completed",
    data: { object: { id: "cs_test_kickoff", payment_status: "unpaid", payment_intent: "pi_hold", metadata: crmDealId ? { crm_deal_id: crmDealId } : {} } },
  };
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${body}`, "utf8").digest("hex");
  const res = await fetch(`${base}/api/webhooks/stripe`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${t},v1=${v1}` }, body });
  expect(res.status).toBe(200);
  await syncWorker.runOnce(state.db, realZohoClient);
}

describe("Finance-Ready kickoff: pure rules", () => {
  it("states the disclosure exactly as the owner approved it", () => {
    expect(kickoffDisclosure(13900, 85800)).toBe(DISCLOSURE);
  });

  it("holds the $139 base filing and leaves $858 of the $997 for scope review", () => {
    const plan = buildKickoffLines(new Map(Object.entries(CATALOG)));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.holdCents).toBe(13900);
    expect(plan.remainingCents).toBe(85800);
    expect(plan.packagePriceCents).toBe(99700);
    expect(plan.lines.reduce((s, l) => s + l.unit_amount_cents * l.quantity, 0)).toBe(13900);
    expect(plan.lines.filter((l) => l.stripe_price_id).map((l) => l.stripe_price_id)).toEqual(["price_state", "price_service", "price_cos"]);
    const pkg = plan.lines.find((l) => l.role === "selected_package");
    expect(pkg).toMatchObject({ offer_code: "PREMIUM", unit_amount_cents: 0, stripe_price_id: null, remaining_balance_status: "pending_scope_review" });
  });

  it("refuses when a base offer is missing or the package does not exceed the hold", () => {
    const missing = new Map(Object.entries(CATALOG));
    missing.delete("DIY_SERVICE_FEE");
    expect(buildKickoffLines(missing).ok).toBe(false);
    const cheap = new Map(Object.entries(CATALOG));
    cheap.set("PREMIUM", { ...CATALOG.PREMIUM, unit_amount_cents: 13900 });
    expect(buildKickoffLines(cheap).ok).toBe(false);
  });

  it("accepts only a single PREMIUM line as the kickoff cart", () => {
    expect(isKickoffCart([{ offer_code: "PREMIUM", quantity: 1 }])).toBe(true);
    expect(isKickoffCart([{ offer_code: "PREMIUM", quantity: 2 }])).toBe(false);
    expect(isKickoffCart([{ offer_code: "PREMIUM", quantity: 1 }, { offer_code: "REGISTERED_AGENT_3YR", quantity: 1 }])).toBe(false);
    expect(isKickoffCart([{ offer_code: "FASTTRACK", quantity: 1 }])).toBe(false);
  });

  it("is on unless FINANCE_READY_KICKOFF=off", () => {
    expect(kickoffEnabled({})).toBe(true);
    expect(kickoffEnabled({ FINANCE_READY_KICKOFF: "OFF" })).toBe(false);
  });

  it("writes no kickoff Deal fields for other orders", () => {
    expect(kickoffDealFields([{ offer_code: "DIY_STATE_FEE", unit_amount_cents: 12500 }])).toEqual({});
    expect(kickoffDealFields(null)).toEqual({});
  });
});

describe("POST /api/checkout/create with the Finance-Ready kickoff", () => {
  it("opens a $139 card-hold Checkout with the disclosure, and records the $997 package on the order", async () => {
    const fs = await newSession();
    const { status, body } = await create(kickoffBody(fs));
    expect(status).toBe(200);
    expect(body).toMatchObject({
      capture_mode: "hold",
      total_cents: 13900,
      payment_plan: "finance_ready_kickoff",
      kickoff: { selected_package: "PREMIUM", package_price_cents: 99700, initial_hold_cents: 13900, remaining_balance_cents: 85800, disclosure: DISCLOSURE },
    });

    // What goes to Stripe: the three base-filing Prices, a manual-capture hold, the disclosure.
    expect(stripeBodies).toHaveLength(1);
    const sent = stripeBodies[0];
    expect(sent).toContain("line_items[0][price]=price_state");
    expect(sent).toContain("line_items[1][price]=price_service");
    expect(sent).toContain("line_items[2][price]=price_cos");
    expect(sent).not.toContain("line_items[3]");
    expect(sent).not.toContain("price_premium_997");
    expect(sent).toContain("payment_intent_data[capture_method]=manual");
    expect(new URLSearchParams(stripeRaw[0]).get("custom_text[submit][message]")).toBe(DISCLOSURE);
    expect(sent).toContain("payment_intent_data[metadata][selected_package]=Finance-Ready");
    expect(sent).toContain("payment_intent_data[metadata][remaining_balance_cents]=85800");

    const { rows } = await state.db.query("SELECT product, crm_intent, total_cents, line_items, checkout_status FROM orders WHERE order_id = $1", [body.order_id]);
    expect(rows[0]).toMatchObject({ product: "PREMIUM", crm_intent: "LLC_FORMATION_PREMIUM", total_cents: 13900, checkout_status: "checkout_created" });
    expect(rows[0].line_items).toHaveLength(4);
    expect(rows[0].line_items[3]).toMatchObject({ offer_code: "PREMIUM", role: "selected_package", initial_hold_cents: 13900, remaining_balance_cents: 85800 });
  });

  it("tags the Zoho Deal with the package, the hold and the remaining balance when the hold is placed", async () => {
    const fs = await newSession(INTAKE_DEAL_ID);
    expect((await create(kickoffBody(fs))).status).toBe(200);
    await completeHold(INTAKE_DEAL_ID);
    const put = zohoCalls.find((c) => c.method === "PUT" && c.url.includes(`/Deals/${INTAKE_DEAL_ID}`));
    const deal = (put?.body?.data as Array<Record<string, unknown>>)[0];
    expect(deal).toMatchObject({
      Selected_Package: "Finance-Ready ($997)",
      Initial_Hold: "$139",
      Remaining_Balance: "$858 (Pending Scope Review)",
      Amount: 139,
      Package: "Premium",
      Payment_Status: "Hold Placed",
      Stage: "SERVICE REQUESTED",
    });
  });

  it("tags a Deal created at payment the same way", async () => {
    const fs = await newSession(null);
    expect((await create(kickoffBody(fs))).status).toBe(200);
    await completeHold(null);
    const post = zohoCalls.find((c) => c.method === "POST" && /\/crm\/v2\/Deals/.test(c.url));
    const deal = (post?.body?.data as Array<Record<string, unknown>>)[0];
    expect(deal).toMatchObject({ Selected_Package: "Finance-Ready ($997)", Initial_Hold: "$139", Remaining_Balance: "$858 (Pending Scope Review)" });
  });

  it("still refuses full-price PREMIUM without the kickoff plan", async () => {
    const { status, body } = await create({ filing_session_id: await newSession(), line_items: [{ offer_code: "PREMIUM" }] });
    expect(status).toBe(422);
    expect(body.closed_offer_codes).toEqual(["PREMIUM"]);
    expect(stripeBodies).toHaveLength(0);
  });

  it("refuses a kickoff cart with anything besides PREMIUM, an unknown plan, or the switch off", async () => {
    const fs = await newSession();
    const extra = await create({ ...kickoffBody(fs), line_items: [{ offer_code: "PREMIUM" }, { offer_code: "REGISTERED_AGENT_3YR" }] });
    expect(extra.status).toBe(422);
    expect((await create({ ...kickoffBody(fs), line_items: [{ offer_code: "FASTTRACK" }] })).status).toBe(422);
    expect((await create({ ...kickoffBody(fs), payment_plan: "pay_later" })).status).toBe(400);
    process.env.FINANCE_READY_KICKOFF = "off";
    expect((await create(kickoffBody(fs))).status).toBe(422);
    expect(stripeBodies).toHaveLength(0);
  });

  it("refuses the kickoff when holds are switched off, since the customer is promised a hold", async () => {
    process.env.PAYMENT_CAPTURE_MODE = "immediate";
    expect((await create(kickoffBody(await newSession()))).status).toBe(503);
    expect(stripeBodies).toHaveLength(0);
  });

  it("leaves a normal Bank-Ready-style order untouched (no plan, no custom text)", async () => {
    const fs = await newSession(INTAKE_DEAL_ID, "customer");
    const { status, body } = await create({ filing_session_id: fs, line_items: [{ offer_code: "DIY_STATE_FEE" }, { offer_code: "DIY_SERVICE_FEE" }, { offer_code: "DIY_CERT_OF_STATUS" }] });
    expect(status).toBe(200);
    expect(body.payment_plan).toBeUndefined();
    expect(stripeBodies[0]).not.toContain("custom_text");
  });
});

describe("registered agent included in Bank-Ready and Finance-Ready (25 Nov 2026)", () => {
  const DIY = [{ offer_code: "DIY_STATE_FEE" }, { offer_code: "DIY_SERVICE_FEE" }, { offer_code: "DIY_CERT_OF_STATUS" }];

  it("Bank-Ready with Damian as agent goes to Stripe for $499 with no $98 line", async () => {
    const { status, body } = await create({ filing_session_id: await newSession(), line_items: [{ offer_code: "FASTTRACK" }] });
    expect(status).toBe(200);
    expect(body.total_cents).toBe(49900);
    expect(stripeBodies[0]).toContain("line_items[0][price]=price_bank_499");
    expect(stripeBodies[0]).not.toContain("price_ra");
  });

  it("the Finance-Ready $139 kickoff with Damian as agent needs no $98 line either", async () => {
    const { status, body } = await create(kickoffBody(await newSession()));
    expect(status).toBe(200);
    expect(body.total_cents).toBe(13900);
    expect(stripeBodies[0]).not.toContain("price_ra");
  });

  it("File It with Damian as agent still requires the $98 line", async () => {
    const without = await create({ filing_session_id: await newSession(), line_items: DIY });
    expect(without.status).toBe(422);
    expect(without.body.required_offer_code).toBe("REGISTERED_AGENT_3YR");
    const withAgent = await create({ filing_session_id: await newSession(), line_items: [...DIY, { offer_code: "REGISTERED_AGENT_3YR" }] });
    expect(withAgent.status).toBe(200);
    expect(withAgent.body.total_cents).toBe(13900 + 9800);
  });

  it("refuses the $98 line on top of Bank-Ready, so nobody pays twice", async () => {
    const r = await create({ filing_session_id: await newSession(), line_items: [{ offer_code: "FASTTRACK" }, { offer_code: "REGISTERED_AGENT_3YR" }] });
    expect(r.status).toBe(422);
    expect(r.body.reason).toBe("bundled_in_cart");
    expect(stripeBodies).toHaveLength(0);
  });

  it("after a held Bank-Ready order the $98 line is never sold to the same session", async () => {
    const fs = await newSession();
    expect((await create({ filing_session_id: fs, line_items: [{ offer_code: "FASTTRACK" }] })).status).toBe(200);
    await state.db.query(`UPDATE orders SET payment_status = 'authorized' WHERE filing_session_id = $1`, [fs]);
    const later = await create({ filing_session_id: fs, line_items: [{ offer_code: "REGISTERED_AGENT_3YR" }] });
    expect(later.status).toBe(422);
    expect(later.body.reason).toBe("already_included");
  });
});

describe("migration 0032: Finance-Ready name, same price", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "..", "migrations", "0032_offer_master_finance_ready.sql"), "utf8");
  const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
  const rollback = readFileSync(join(here, "..", "migrations-rollback", "0032_offer_master_finance_ready.rollback.sql"), "utf8");

  it("retires exactly the $997 v2 row before inserting v3", () => {
    expect(code.indexOf("SET status = 'retired'")).toBeLessThan(code.indexOf("INSERT INTO offers"));
    expect(code).toMatch(/retired <> 1/);
  });

  it("keeps the $997 amount, Stripe Product and Price, offer_code and CRM intent", () => {
    expect(code).toMatch(/'PREMIUM', 'v3', 'Florida LLC Formation — Finance-Ready', 'LLC_FORMATION_PREMIUM',\s*'prod_V8sRO1rlCP2jfq', 'price_1UefElDo01bXdbWSTnb5H2yX', 99700/);
  });

  it("has a rollback that restores v2", () => {
    expect(rollback).toMatch(/DELETE FROM offers WHERE offer_code = 'PREMIUM' AND offer_version = 'v3'/);
    expect(rollback).toMatch(/SET status = 'active' WHERE offer_code = 'PREMIUM' AND offer_version = 'v2'/);
    expect(rollback).toContain("DELETE FROM schema_migrations WHERE version = '0032_offer_master_finance_ready'");
  });
});
