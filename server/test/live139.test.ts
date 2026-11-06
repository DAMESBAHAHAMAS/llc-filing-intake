import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import express from "express";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrderEmailDb, markSubmitted } from "./helpers/orderEmailDb.js";

/**
 * The $139 DIY sale and the live payment test, through the real webhook,
 * proof-of-filing, operator and fulfillment code. The point of the test
 * order is that it can never file, so most of this tries to make it file.
 */
const state = vi.hoisted(() => ({ db: null as unknown as Pool }));
vi.mock("../src/db/pool.js", () => ({
  pool: {
    query: (sql: string, params?: unknown[]) => state.db.query(sql, params as never),
    connect: () => state.db.connect(),
  },
}));
const resend = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("resend", () => ({ Resend: class { emails = { send: resend.send }; } }));
const stripe = vi.hoisted(() => ({ capture: vi.fn(), create: vi.fn(), price: vi.fn() }));
vi.mock("../src/stripe/restClient.js", async (orig) => ({
  ...(await orig<typeof import("../src/stripe/restClient.js")>()),
  capturePaymentIntent: stripe.capture,
  createCheckoutSession: stripe.create,
  retrievePrice: stripe.price,
}));
vi.mock("../src/ops/alerts.js", () => ({
  sendOpsAlert: vi.fn(async () => ({ channel: "log", ok: true })),
  notifyOrderEvent: vi.fn(async () => undefined),
}));
vi.mock("../src/registeredAgent/acceptanceEmail.js", () => ({ dispatchAcceptanceEmail: vi.fn(async () => ({ ok: true })) }));

const { stripeWebhookRouter } = await import("../src/routes/webhooksStripe.js");
const { ordersRouter } = await import("../src/routes/orders.js");
const { liveTestRouter } = await import("../src/routes/liveTest.js");
const { claimNextReadyOrder } = await import("../src/fulfillment/fulfillmentWorker.js");
const { needsSunbizFiling } = await import("../src/offers/sunbizFiling.js");
const payAfter = await import("../src/offers/payAfterFiling.js");
const diy = await import("../src/offers/diyPackage.js");
const { LIVE_TEST_OFFER_CODE, isLiveTestOrder, liveTestEmail } = await import("../src/offers/liveTest.js");
const { isFloridaLlcDocumentNumber } = await import("../src/payments/documentNumber.js");

const WEBHOOK_SECRET = "whsec_live139";
const OPERATOR_KEY = "op-live139";
const LIVE_PRICE = "price_1UYioTDo01bXdbWSznszpIVx";
const TEST_ITEM = { offer_code: LIVE_TEST_OFFER_CODE, stripe_price_id: LIVE_PRICE, unit_amount_cents: 13900, quantity: 1 };

let server: http.Server;
let base = "";
beforeAll(async () => {
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.OPERATOR_API_KEY = OPERATOR_KEY;
  process.env.FRONTEND_BASE_URL = "https://example.com";
  const app = express();
  app.use("/api/webhooks/stripe", express.raw({ type: "application/json" }));
  app.use(stripeWebhookRouter);
  app.use(express.json());
  app.use(ordersRouter);
  app.use(liveTestRouter);
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function deliver(event: Record<string, unknown>) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${body}`, "utf8").digest("hex");
  return fetch(`${base}/api/webhooks/stripe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${t},v1=${v1}` },
    body,
  });
}
const proof = (orderId: string, documentNumber: string) =>
  fetch(`${base}/api/orders/${orderId}/proof-of-filing`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-operator-key": OPERATOR_KEY },
    body: JSON.stringify({ document_number: documentNumber }),
  });
const startTest = (key: string | null = OPERATOR_KEY) =>
  fetch(`${base}/api/operator/live-test/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "x-operator-key": key } : {}) },
  });

async function seedOrder(lineItems: unknown[], product: string, sessionId: string) {
  const filingSessionId = randomUUID();
  const orderId = randomUUID();
  await state.db.query(
    `INSERT INTO filing_sessions (filing_session_id, email, full_name, filing_data, registered_agent_status)
     VALUES ($1, 'owner@example.com', 'Ana Sol', $2, 'accepted')`,
    [filingSessionId, JSON.stringify({ llc_name: "Sol Ventures LLC", registered_agent_path: "house" })]
  );
  await state.db.query(
    `INSERT INTO orders (order_id, filing_session_id, crm_intent, product, line_items, total_cents, stripe_checkout_session_id)
     VALUES ($1, $2, 'x', $3, $4, 13900, $5)`,
    [orderId, filingSessionId, product, JSON.stringify(lineItems), sessionId]
  );
  return orderId;
}
const row = async (orderId: string) =>
  (await state.db.query(`SELECT payment_status, fulfillment_status, proof_of_filing_ref FROM orders WHERE order_id = $1`, [orderId])).rows[0];
const queued = async () => (await state.db.query(`SELECT sync_type FROM crm_sync_queue`)).rows.map((r: { sync_type: string }) => r.sync_type);
const hold = (id: string, session: string) => ({
  id,
  type: "checkout.session.completed",
  livemode: true,
  data: { object: { id: session, payment_status: "unpaid", payment_intent: "pi_hold", metadata: {} } },
});

beforeEach(async () => {
  state.db = await createOrderEmailDb();
  await state.db.query(`CREATE TABLE offers (offer_code text, offer_version text, stripe_price_id text, unit_amount_cents integer, status text, created_at timestamptz DEFAULT now())`);
  await state.db.query(`INSERT INTO offers VALUES ('DIY_PACKAGE', 'v1', $1, 13900, 'draft', now())`, [LIVE_PRICE]);
  process.env.LIVE_TEST_ENABLED = "true";
  process.env.LIVE_TEST_EMAIL = "owner@example.com";
  delete process.env.PAYMENT_CAPTURE_MODE;
  resend.send.mockReset();
  stripe.capture.mockReset().mockResolvedValue({ id: "pi_hold", status: "succeeded" });
  stripe.create.mockReset().mockResolvedValue({ id: "cs_live_x", url: "https://checkout.stripe.com/c/pay/cs_live_x" });
  stripe.price.mockReset().mockResolvedValue({ id: LIVE_PRICE, unit_amount: 13900, active: true });
});

describe("the $139 price", () => {
  it("is $125 + $5 + $9", () => {
    expect(diy.DIY_PACKAGE_BREAKDOWN.map((p) => p.cents)).toEqual([12500, 500, 900]);
    expect(diy.DIY_PACKAGE_TOTAL_CENTS).toBe(13900);
    expect(diy.DIY_PACKAGE_BREAKDOWN_LINE).toMatch(/\$139.*\$125.*\$5.*\$9/);
  });

  it("is a filing, held at checkout, and shows its breakdown", () => {
    const items = [{ offer_code: "DIY_PACKAGE" }];
    expect(needsSunbizFiling(items)).toBe(true);
    expect(payAfter.requiresPayAfterFiling(items)).toBe(true);
    expect(payAfter.holdCheckoutText(items).afterSubmit).toContain(diy.DIY_PACKAGE_BREAKDOWN_LINE);
  });

  it("adds up the same as one Price or three, for the parity check", () => {
    expect(diy.diyTotalCents(new Map([["DIY_PACKAGE", 13900]]))).toBe(13900);
    expect(diy.diyTotalCents(new Map([["DIY_STATE_FEE", 12500], ["DIY_CERT_OF_STATUS", 500], ["DIY_SERVICE_FEE", 900]]))).toBe(13900);
    expect(diy.diyTotalCents(new Map([["DIY_PACKAGE", 12500]]))).not.toBe(13900);
  });

  it("checks only what is on sale once DIY_PACKAGE is alone, and everything before that", () => {
    const decided = { DIY: 13900, FASTTRACK: 49900 };
    expect(diy.parityDecisionsFor(decided, new Map([["DIY_PACKAGE", 13900]])).map(([c]) => c)).toEqual(["DIY"]);
    expect(diy.parityDecisionsFor(decided, new Map()).map(([c]) => c)).toEqual(["DIY", "FASTTRACK"]);
  });
});

describe("the charge rule", () => {
  it("takes only a Florida LLC document number", () => {
    expect(isFloridaLlcDocumentNumber("L26000123456")).toBe(true);
    expect(isFloridaLlcDocumentNumber("l26000123456")).toBe(true);
    for (const bad of ["TEST", "T100", "L2600012345", "L260001234567", "M26000123456", "26000123456", ""]) {
      expect(isFloridaLlcDocumentNumber(bad)).toBe(false);
    }
  });

  it("does not charge on anything else for a real DIY order", async () => {
    const orderId = await seedOrder([{ offer_code: "DIY_PACKAGE", unit_amount_cents: 13900, quantity: 1 }], "DIY_PACKAGE", "cs_diy");
    expect((await deliver(hold("evt_diy", "cs_diy"))).status).toBe(200);
    await markSubmitted(state.db, orderId);

    for (const value of ["TEST", "NOTAREALNUM"]) {
      const res = await proof(orderId, value);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("document_number_invalid");
    }
    expect(stripe.capture).not.toHaveBeenCalled();
    expect((await row(orderId)).proof_of_filing_ref).toBeNull();
  });

  it("does not take the Sunbiz tracking number as proof", async () => {
    const orderId = await seedOrder([{ offer_code: "DIY_PACKAGE", unit_amount_cents: 13900, quantity: 1 }], "DIY_PACKAGE", "cs_trk");
    await deliver(hold("evt_trk", "cs_trk"));
    await markSubmitted(state.db, orderId);
    await state.db.query(`UPDATE orders SET sunbiz_tracking_number = 'L26000999999' WHERE order_id = $1`, [orderId]);
    const res = await proof(orderId, "L26000999999");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("document_number_is_tracking_number");
    expect(stripe.capture).not.toHaveBeenCalled();
  });

  it("charges a real DIY order on the real number, and not before Florida has it", async () => {
    const orderId = await seedOrder([{ offer_code: "DIY_PACKAGE", unit_amount_cents: 13900, quantity: 1 }], "DIY_PACKAGE", "cs_ok");
    await deliver(hold("evt_ok", "cs_ok"));
    expect((await proof(orderId, "L26000123456")).status).toBe(409); // not submitted yet
    expect(stripe.capture).not.toHaveBeenCalled();
    await markSubmitted(state.db, orderId);
    resend.send.mockResolvedValue({ data: { id: "re_1" }, error: null });
    process.env.RESEND_API_KEY = "re_x";
    process.env.RESEND_FROM_EMAIL = "o@example.com";
    await state.db.query(`UPDATE orders SET stripe_livemode = false WHERE order_id = $1`, [orderId]);
    const res = await proof(orderId, "L26000123456");
    if (res.status === 200) expect(stripe.capture).toHaveBeenCalledTimes(1);
  });

  it("refuses to charge a filing up front with a live key", () => {
    process.env.PAYMENT_CAPTURE_MODE = "immediate";
    const live = { ...process.env, STRIPE_SECRET_KEY: "rk_live_x" };
    const test = { ...process.env, STRIPE_SECRET_KEY: "sk_test_x" };
    expect(payAfter.immediateChargeForbidden([{ offer_code: "DIY_PACKAGE" }], live)).toBe(true);
    expect(payAfter.immediateChargeForbidden([{ offer_code: "DIY_PACKAGE" }], test)).toBe(false);
    expect(payAfter.immediateChargeForbidden([{ offer_code: "CREDENTIALS_KIT" }], live)).toBe(false);
    delete process.env.PAYMENT_CAPTURE_MODE;
    expect(payAfter.immediateChargeForbidden([{ offer_code: "DIY_PACKAGE" }], live)).toBe(false);
  });
});

describe("the live test cannot file", () => {
  it("is never a filing, whatever else is on the order", () => {
    expect(needsSunbizFiling([{ offer_code: LIVE_TEST_OFFER_CODE }])).toBe(false);
    expect(needsSunbizFiling([{ offer_code: LIVE_TEST_OFFER_CODE }, { offer_code: "DIY_PACKAGE" }])).toBe(false);
    expect(needsSunbizFiling([{ offer_code: LIVE_TEST_OFFER_CODE }, { offer_code: "FASTTRACK" }])).toBe(false);
    expect(isLiveTestOrder([{ offer_code: "DIY_PACKAGE" }])).toBe(false);
  });

  it("uses the hold and says no LLC is filed", () => {
    const items = [{ offer_code: LIVE_TEST_OFFER_CODE }];
    expect(payAfter.requiresPayAfterFiling(items)).toBe(true);
    expect(payAfter.holdCheckoutText(items).submit).toContain("No LLC is filed");
  });

  it("stays out of fulfillment, the CRM and customer email through hold and capture", async () => {
    const res = await startTest();
    expect(res.status).toBe(201);
    const { order_id: orderId } = (await res.json()) as { order_id: string };
    await state.db.query(`UPDATE orders SET stripe_checkout_session_id = 'cs_live_x' WHERE order_id = $1`, [orderId]);

    expect((await deliver(hold("evt_t1", "cs_live_x"))).status).toBe(200);
    expect(await row(orderId)).toMatchObject({ payment_status: "authorized", fulfillment_status: "not_ready" });

    const proved = await proof(orderId, "TEST-139");
    expect(proved.status).toBe(200);
    expect(stripe.capture).toHaveBeenCalledTimes(1);
    await deliver({ id: "evt_t2", type: "payment_intent.succeeded", livemode: true, data: { object: { id: "pi_hold", metadata: { order_id: orderId } } } });

    expect(await row(orderId)).toMatchObject({ payment_status: "paid", fulfillment_status: "not_ready", proof_of_filing_ref: "TEST-139" });
    expect(await queued()).toEqual([]);
    expect(resend.send).not.toHaveBeenCalled();
    expect(await claimNextReadyOrder(state.db, "t")).toBeNull();
  });

  it("reaches no abandoned-cart job when its session expires", async () => {
    await seedOrder([TEST_ITEM], LIVE_TEST_OFFER_CODE, "cs_t5");
    const res = await deliver({ id: "evt_t5", type: "checkout.session.expired", livemode: true, data: { object: { id: "cs_t5", metadata: {} } } });
    expect(res.status).toBe(200);
    expect(await queued()).toEqual([]);
  });

  it("is refused by the Sunbiz routes", async () => {
    const orderId = await seedOrder([TEST_ITEM], LIVE_TEST_OFFER_CODE, "cs_t3");
    await deliver(hold("evt_t3", "cs_t3"));
    const res = await fetch(`${base}/api/orders/${orderId}/submitted-to-sunbiz`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-operator-key": OPERATOR_KEY },
      body: JSON.stringify({ tracking_number: "T555" }),
    });
    expect(res.status).toBe(409);
    expect((await row(orderId)).fulfillment_status).toBe("not_ready");
  });

  it("is not claimed by the worker even if it is forced to ready", async () => {
    const orderId = await seedOrder([TEST_ITEM], LIVE_TEST_OFFER_CODE, "cs_t4");
    await state.db.query(`UPDATE orders SET payment_status = 'authorized', fulfillment_status = 'ready', fulfillment_ready_at = now() WHERE order_id = $1`, [orderId]);
    expect(await claimNextReadyOrder(state.db, "t")).toBeNull();
  });
});

describe("the live test switch", () => {
  it("needs the operator key", async () => {
    expect((await startTest(null)).status).toBe(401);
    expect((await startTest("wrong-key-value-x")).status).toBe(401);
    expect(stripe.create).not.toHaveBeenCalled();
  });

  it("is off unless both settings are present", async () => {
    delete process.env.LIVE_TEST_ENABLED;
    expect((await startTest()).status).toBe(404);
    process.env.LIVE_TEST_ENABLED = "yes";
    expect((await startTest()).status).toBe(404);
    process.env.LIVE_TEST_ENABLED = "true";
    delete process.env.LIVE_TEST_EMAIL;
    expect((await startTest()).status).toBe(404);
    expect(liveTestEmail({ LIVE_TEST_ENABLED: "true", LIVE_TEST_EMAIL: " " })).toBeNull();
    expect(stripe.create).not.toHaveBeenCalled();
  });

  it("creates a hold on the real price, one at a time", async () => {
    expect((await startTest()).status).toBe(201);
    const args = stripe.create.mock.calls[0][0];
    expect(args.lineItems).toEqual([{ price: LIVE_PRICE, quantity: 1 }]);
    expect(args.captureMode).toBe("hold");
    expect(args.metadata.live_test).toBe("true");
    expect(args.customerEmail).toBe("owner@example.com");
    expect((await startTest()).status).toBe(409);
    expect(stripe.create).toHaveBeenCalledTimes(1);
  });

  it("lets the next test run after Stripe refuses one", async () => {
    stripe.create.mockRejectedValueOnce(new Error("no such price"));
    expect((await startTest()).status).toBe(502);
    expect((await startTest()).status).toBe(201);
  });

  it("refuses a Price that is not an active $139", async () => {
    for (const bad of [{ unit_amount: 12500, active: true }, { unit_amount: 13900, active: false }]) {
      stripe.price.mockResolvedValueOnce({ id: LIVE_PRICE, ...bad });
      expect((await startTest()).status).toBe(409);
    }
    expect(stripe.create).not.toHaveBeenCalled();
  });
});
