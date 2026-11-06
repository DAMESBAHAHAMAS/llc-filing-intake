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
const stripe = vi.hoisted(() => ({ capture: vi.fn(), create: vi.fn(), price: vi.fn(), retrieve: vi.fn(), replace: vi.fn(), cancel: vi.fn() }));
vi.mock("../src/stripe/restClient.js", async (orig) => ({
  ...(await orig<typeof import("../src/stripe/restClient.js")>()),
  capturePaymentIntent: stripe.capture,
  createCheckoutSession: stripe.create,
  retrievePrice: stripe.price,
  retrievePaymentIntent: stripe.retrieve,
  placeReplacementHold: stripe.replace,
  cancelPaymentIntent: stripe.cancel,
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
const { runHoldSweepOnce } = await import("../src/fulfillment/holdSweep.js");
const { runSavedCardCleanupOnce } = await import("../src/payments/savedCardCleanup.js");
const { clearanceFor, entityNameKey, sameEntityName, approvalCurrent } = await import("../src/payments/filingClearance.js");
const { replaceHold } = await import("../src/payments/replaceHold.js");
const { sendOpsAlert } = await import("../src/ops/alerts.js");
const { buildOrderEmail } = await import("../src/orderEmails/templates.js");
const { sessionRouter } = await import("../src/routes/session.js");
const { registeredAgentRouter } = await import("../src/routes/registeredAgent.js");
const { filingDocumentRouter } = await import("../src/routes/filingDocument.js");
const { checkoutRouter } = await import("../src/routes/checkout.js");
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
  app.use(sessionRouter);
  app.use(registeredAgentRouter);
  app.use(filingDocumentRouter);
  app.use(checkoutRouter);
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
const operator = (path: string, body: unknown = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-operator-key": OPERATOR_KEY },
    body: JSON.stringify(body),
  });
const proof = (orderId: string, documentNumber: string, verifiedEntityName: string | undefined = "Sol Ventures LLC") =>
  operator(`/api/orders/${orderId}/proof-of-filing`, { document_number: documentNumber, verified_entity_name: verifiedEntityName });
const DIY_ITEM = { offer_code: "DIY_PACKAGE", unit_amount_cents: 13900, quantity: 1 };
const capturable = (overrides: Record<string, unknown> = {}) => ({
  id: "pi_hold", status: "requires_capture", amount: 13900, amount_capturable: 13900, amount_received: 0, currency: "usd",
  customer: "cus_1", payment_method: "pm_1",
  latest_charge: { id: "ch_1", payment_method_details: { card: { capture_before: Math.floor(Date.now() / 1000) + 5 * 86400 } } },
  ...overrides,
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
  stripe.price.mockReset().mockResolvedValue({ id: LIVE_PRICE, unit_amount: 13900, active: true, currency: "usd", livemode: true });
  stripe.retrieve.mockReset().mockResolvedValue(capturable());
  stripe.replace.mockReset().mockResolvedValue(capturable({ id: "pi_new" }));
  stripe.cancel.mockReset().mockResolvedValue({ id: "pi_hold", status: "canceled" });
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

  async function heldDiy(session: string) {
    const orderId = await seedOrder([DIY_ITEM], "DIY_PACKAGE", session);
    await state.db.query(`UPDATE filing_sessions SET entity_name_primary = 'Sol Ventures LLC' WHERE filing_session_id = (SELECT filing_session_id FROM orders WHERE order_id = $1)`, [orderId]);
    await deliver(hold(`evt_${session}`, session));
    return orderId;
  }

  it("does not charge on anything else for a real DIY order", async () => {
    const orderId = await heldDiy("cs_diy");
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
    const orderId = await heldDiy("cs_trk");
    await markSubmitted(state.db, orderId);
    await state.db.query(`UPDATE orders SET sunbiz_tracking_number = 'L26000999999' WHERE order_id = $1`, [orderId]);
    const res = await proof(orderId, "L26000999999");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("document_number_is_tracking_number");
    expect(stripe.capture).not.toHaveBeenCalled();
  });

  it("needs the LLC name read from Florida's record, and it must be this order's", async () => {
    const orderId = await heldDiy("cs_name");
    await markSubmitted(state.db, orderId);
    for (const name of ["", "Another Business LLC"]) {
      const res = await proof(orderId, "L26000123456", name);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("entity_name_not_verified");
    }
    expect(stripe.capture).not.toHaveBeenCalled();
    expect(sameEntityName("SOL VENTURES, L.L.C.", "Sol Ventures LLC")).toBe(true);
    expect(sameEntityName("", "")).toBe(false);
  });

  it("will not silently keep a different number on a retry", async () => {
    const orderId = await heldDiy("cs_typo");
    await markSubmitted(state.db, orderId);
    await state.db.query(`UPDATE orders SET proof_of_filing_ref = 'L26000123465' WHERE order_id = $1`, [orderId]);
    const res = await proof(orderId, "L26000123456");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("document_number_differs");
    expect(stripe.capture).not.toHaveBeenCalled();
  });

  it("will not collect twice on one document number", async () => {
    const first = await heldDiy("cs_dup1");
    await state.db.query(`UPDATE orders SET proof_of_filing_ref = 'L26000123456' WHERE order_id = $1`, [first]);
    const second = await heldDiy("cs_dup2");
    await markSubmitted(state.db, second);
    const res = await proof(second, "L26000123456");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("document_number_used");
    expect(stripe.capture).not.toHaveBeenCalled();
  });

  it("charges a real DIY order on the real number, and not before Florida has it", async () => {
    const orderId = await heldDiy("cs_ok");
    expect((await proof(orderId, "L26000123456")).status).toBe(409); // not submitted yet
    expect(stripe.capture).not.toHaveBeenCalled();
    await markSubmitted(state.db, orderId);
    resend.send.mockResolvedValue({ data: { id: "re_1" }, error: null });
    process.env.RESEND_API_KEY = "re_x";
    process.env.RESEND_FROM_EMAIL = "o@example.com";
    await state.db.query(`UPDATE filing_sessions SET email = 'owner+test@example.com' WHERE filing_session_id = (SELECT filing_session_id FROM orders WHERE order_id = $1)`, [orderId]);
    await state.db.query(`UPDATE orders SET stripe_livemode = true WHERE order_id = $1`, [orderId]);
    const res = await proof(orderId, "L26000123456");
    expect(res.status).toBe(200);
    expect(stripe.capture).toHaveBeenCalledTimes(1);
    expect(stripe.capture.mock.calls[0][1]).toBe(`capture-${orderId}-pi_hold`);
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
    for (const bad of [{ unit_amount: 12500, active: true, currency: "usd", livemode: true }, { unit_amount: 13900, active: false, currency: "usd", livemode: true }, { unit_amount: 13900, active: true, currency: "usd", livemode: false }, { unit_amount: 13900, active: true, currency: "eur", livemode: true }]) {
      stripe.price.mockResolvedValueOnce({ id: LIVE_PRICE, ...bad });
      expect((await startTest()).status).toBe(409);
    }
    expect(stripe.create).not.toHaveBeenCalled();
  });
});

describe("control 1: a capturable hold before filing", () => {
  const now = new Date();
  const seed = async (session: string) => {
    const orderId = await seedOrder([DIY_ITEM], "DIY_PACKAGE", session);
    await state.db.query(`UPDATE filing_sessions SET entity_name_primary = 'Sol Ventures LLC' WHERE filing_session_id = (SELECT filing_session_id FROM orders WHERE order_id = $1)`, [orderId]);
    await deliver(hold(`evt_${session}`, session));
    await state.db.query(`UPDATE orders SET fulfillment_status = 'requires_review' WHERE order_id = $1`, [orderId]);
    return orderId;
  };
  const approve = (orderId: string) => operator(`/api/orders/${orderId}/approve-filing`);
  const code = async (res: Response) => ((await res.json()) as { code?: string }).code;

  it("reads Stripe, not the order row", () => {
    expect(clearanceFor(capturable() as never, 13900, now)).toMatchObject({ cleared: true });
    expect(clearanceFor(capturable({ status: "canceled" }) as never, 13900, now)).toMatchObject({ code: "hold_not_capturable" });
    expect(clearanceFor(capturable({ status: "succeeded" }) as never, 13900, now)).toMatchObject({ code: "hold_not_capturable" });
    expect(clearanceFor(capturable({ amount_capturable: 12500 }) as never, 13900, now)).toMatchObject({ code: "hold_amount_short" });
    expect(clearanceFor(capturable({ latest_charge: "ch_1" }) as never, 13900, now)).toMatchObject({ code: "hold_expiry_unknown" });
    const soon = capturable({ latest_charge: { id: "c", payment_method_details: { card: { capture_before: Math.floor(Date.now() / 1000) + 3600 } } } });
    expect(clearanceFor(soon as never, 13900, now)).toMatchObject({ code: "hold_expiring" });
  });

  it("will not submit a $139 order that was not approved", async () => {
    const orderId = await seed("cs_a1");
    const res = await operator(`/api/orders/${orderId}/submitted-to-sunbiz`, { tracking_number: "T555" });
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("filing_not_approved");
    expect((await row(orderId)).fulfillment_status).toBe("requires_review");
  });

  it("does not approve a hold Stripe says cannot be captured, and stores nothing", async () => {
    const orderId = await seed("cs_a2");
    stripe.retrieve.mockResolvedValueOnce(capturable({ status: "canceled" }));
    const res = await approve(orderId);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("hold_not_capturable");
    const { rows } = await state.db.query(`SELECT filing_approved_at FROM orders WHERE order_id = $1`, [orderId]);
    expect(rows[0].filing_approved_at).toBeNull();
  });

  it("does not approve if Stripe cannot be reached", async () => {
    const orderId = await seed("cs_a3");
    stripe.retrieve.mockRejectedValueOnce(new Error("stripe down"));
    expect((await approve(orderId)).status).toBe(502);
  });

  it("approves a capturable hold, records its real deadline, and an old approval expires", async () => {
    const orderId = await seed("cs_a4");
    expect((await approve(orderId)).status).toBe(200);
    const { rows } = await state.db.query(`SELECT filing_approved_at, capture_before FROM orders WHERE order_id = $1`, [orderId]);
    expect(rows[0].capture_before).not.toBeNull();
    expect(approvalCurrent(rows[0].filing_approved_at, new Date())).toBe(true);
    expect(approvalCurrent(new Date(Date.now() - 25 * 3600 * 1000), new Date())).toBe(false);
  });

  it("control 5: will not approve a second filing of the same LLC", async () => {
    const first = await seed("cs_a5");
    expect((await approve(first)).status).toBe(200);
    const second = await seed("cs_a6");
    const res = await approve(second);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("duplicate_filing");
  });

  it("does not file on a released hold", async () => {
    const orderId = await seed("cs_a7");
    await state.db.query(`UPDATE orders SET payment_status = 'released', filing_approved_at = now() WHERE order_id = $1`, [orderId]);
    const res = await operator(`/api/orders/${orderId}/submitted-to-sunbiz`, { tracking_number: "T556" });
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("hold_not_capturable");
  });
});

describe("controls 3 and 4: expiry and replacement", () => {
  const heldOrder = async (session: string, consent = true) => {
    const orderId = await seedOrder([DIY_ITEM], "DIY_PACKAGE", session);
    await deliver(hold(`evt_${session}`, session));
    if (consent) {
      await state.db.query(`UPDATE orders SET saved_card_authorized_at = now(), saved_card_authorization_text = $2 WHERE order_id = $1`, [orderId, payAfter.DIY_SAVED_CARD_AUTHORIZATION]);
    }
    return orderId;
  };
  const replace = (orderId: string) => operator(`/api/orders/${orderId}/replace-authorization`);
  const current = async (orderId: string) =>
    (await state.db.query(`SELECT stripe_payment_intent_id, capture_before, hold_expiry_flagged_at, filing_approved_at, superseded_payment_intent_ids, payment_status FROM orders WHERE order_id = $1`, [orderId])).rows[0];

  it("escalates twice, from Stripe's own deadline, and retries a failed alert", async () => {
    const orderId = await heldOrder("cs_e1");
    const inHours = (h: number) => new Date(Date.now() + h * 3600 * 1000);
    await state.db.query(`UPDATE orders SET capture_before = $2 WHERE order_id = $1`, [orderId, inHours(40)]);
    const alert = vi.fn(async () => undefined);
    const deps = { retrievePaymentIntent: stripe.retrieve, now: () => new Date(), alert, replace: vi.fn() };

    const failing = vi.fn(async () => { throw new Error("cliq down"); });
    await runHoldSweepOnce(state.db, { ...deps, alert: failing });
    expect(failing).toHaveBeenCalledTimes(1);
    await runHoldSweepOnce(state.db, deps);
    expect(alert).toHaveBeenCalledTimes(1); // the failed alert was tried again
    await runHoldSweepOnce(state.db, deps);
    expect(alert).toHaveBeenCalledTimes(1); // and only once

    await state.db.query(`UPDATE orders SET capture_before = $2 WHERE order_id = $1`, [orderId, inHours(10)]);
    await runHoldSweepOnce(state.db, deps);
    expect(alert).toHaveBeenCalledTimes(2);
    expect(String((alert.mock.calls as unknown as string[][])[1][0])).toContain("within 24 hours");
  });

  it("places the new hold first, then moves the order, then cancels the old one", async () => {
    const orderId = await heldOrder("cs_r1");
    const res = await replace(orderId);
    expect(res.status).toBe(200);
    expect(stripe.replace.mock.calls[0][0]).toMatchObject({ amountCents: 13900, customerId: "cus_1", paymentMethodId: "pm_1", idempotencyKey: `replace-${orderId}-pi_hold-1` });
    expect(stripe.cancel).toHaveBeenCalledWith("pi_hold", "cancel-superseded-pi_hold");
    expect(stripe.replace.mock.invocationCallOrder[0]).toBeLessThan(stripe.cancel.mock.invocationCallOrder[0]);
    expect(await current(orderId)).toMatchObject({ stripe_payment_intent_id: "pi_new", capture_before: null, hold_expiry_flagged_at: null, filing_approved_at: null, payment_status: "authorized" });
  });

  it("keeps the old hold if the bank refuses the new one", async () => {
    const orderId = await heldOrder("cs_r2");
    stripe.replace.mockRejectedValueOnce(new Error("card_declined"));
    const res = await replace(orderId);
    expect(res.status).toBe(402);
    expect(stripe.cancel).not.toHaveBeenCalled();
    expect((await current(orderId)).stripe_payment_intent_id).toBe("pi_hold");
  });

  it("keeps the old hold if the new one is not capturable", async () => {
    const orderId = await heldOrder("cs_r3");
    stripe.replace.mockResolvedValueOnce(capturable({ id: "pi_new", status: "requires_action" }));
    expect((await replace(orderId)).status).toBe(402);
    expect(stripe.cancel).not.toHaveBeenCalledWith("pi_hold", expect.anything());
    expect((await current(orderId)).stripe_payment_intent_id).toBe("pi_hold");
  });

  it("needs consent on record: none, or the older wording, is refused and touches nothing", async () => {
    const none = await heldOrder("cs_c1", false);
    const refused = await replace(none);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("no_replacement_consent");

    const older = await heldOrder("cs_c2", false);
    await state.db.query(`UPDATE orders SET saved_card_authorized_at = now(), saved_card_authorization_text = $2 WHERE order_id = $1`, [older, payAfter.SAVED_CARD_AUTHORIZATION]);
    expect((await replace(older)).status).toBe(409);
    expect(stripe.replace).not.toHaveBeenCalled();
    expect(stripe.cancel).not.toHaveBeenCalled();
  });

  it("shows the customer the consent it later relies on", () => {
    const shown = payAfter.holdCheckoutText([{ offer_code: "DIY_PACKAGE" }]).submit;
    expect(shown).toContain(payAfter.REPLACEMENT_CONSENT_PHRASE);
    expect(shown).toMatch(/we will email you when we do/);
    expect(shown.length).toBeLessThanOrEqual(1200);
  });

  it("tells the customer when a hold is renewed", async () => {
    const orderId = await heldOrder("cs_n1");
    await replace(orderId);
    expect(await queued()).toContain("customer_email_hold_replaced");
  });

  it("on a refusal: counts it, tells the customer once, and retries as a new attempt", async () => {
    const orderId = await heldOrder("cs_f1");
    stripe.replace.mockRejectedValue(new Error("card_declined"));
    for (const attempt of [1, 2, 3]) {
      const res = await replace(orderId);
      expect(res.status).toBe(402);
      expect(stripe.replace.mock.calls[attempt - 1][0].idempotencyKey).toBe(`replace-${orderId}-pi_hold-${attempt}`);
    }
    const stopped = await replace(orderId);
    expect(stopped.status).toBe(409);
    expect(((await stopped.json()) as { code: string }).code).toBe("replacement_attempts_used");
    expect(stripe.replace).toHaveBeenCalledTimes(3);
    expect((await queued()).filter((t: string) => t === "customer_email_hold_replacement_failed")).toHaveLength(1);
    expect((await current(orderId)).stripe_payment_intent_id).toBe("pi_hold");
    stripe.replace.mockReset();
  });

  it("cancels a new hold that needs the customer, so it can't sit on their card", async () => {
    const orderId = await heldOrder("cs_f2");
    stripe.replace.mockResolvedValueOnce(capturable({ id: "pi_stuck", status: "requires_action" }));
    expect((await replace(orderId)).status).toBe(402);
    expect(stripe.cancel).toHaveBeenCalledWith("pi_stuck", "cancel-replacement-pi_stuck");
    expect((await current(orderId)).stripe_payment_intent_id).toBe("pi_hold");
  });

  it("renews automatically near expiry, waits between tries, and leaves everything else alone", async () => {
    const inHours = (h: number) => new Date(Date.now() + h * 3600 * 1000);
    const near = await heldOrder("cs_a_near");
    const far = await heldOrder("cs_a_far");
    const recent = await heldOrder("cs_a_recent");
    const test = await seedOrder([TEST_ITEM], LIVE_TEST_OFFER_CODE, "cs_a_test");
    await deliver(hold("evt_a_test", "cs_a_test"));
    await state.db.query(`UPDATE orders SET capture_before = $2 WHERE order_id IN ($1, $3, $4)`, [near, inHours(40), recent, test]);
    await state.db.query(`UPDATE orders SET capture_before = $2 WHERE order_id = $1`, [far, inHours(120)]);
    await state.db.query(`UPDATE orders SET replacement_last_attempt_at = now() WHERE order_id = $1`, [recent]);
    const replaceFn = vi.fn(async () => ({ kind: "replaced" as const, paymentIntentId: "pi_x", oldHoldStillOpen: false }));
    await runHoldSweepOnce(state.db, { retrievePaymentIntent: stripe.retrieve, now: () => new Date(), alert: vi.fn(async () => undefined), replace: replaceFn });
    expect(replaceFn.mock.calls.map((c) => (c as unknown as string[])[1])).toEqual([near]);
  });

  it("does not release the order when the old hold's cancel event arrives", async () => {
    const orderId = await heldOrder("cs_r4");
    await replace(orderId);
    await deliver({ id: "evt_old", type: "payment_intent.canceled", livemode: true, data: { object: { id: "pi_hold", metadata: { order_id: orderId } } } });
    expect((await current(orderId)).payment_status).toBe("authorized");
    await deliver({ id: "evt_new", type: "payment_intent.canceled", livemode: true, data: { object: { id: "pi_new", metadata: { order_id: orderId } } } });
    expect((await current(orderId)).payment_status).toBe("released");
  });

  it("will not replace a hold once proof is in, or on a test order", async () => {
    const orderId = await heldOrder("cs_r5");
    await state.db.query(`UPDATE orders SET proof_of_filing_at = now() WHERE order_id = $1`, [orderId]);
    expect((await replace(orderId)).status).toBe(409);
    const testOrder = await seedOrder([TEST_ITEM], LIVE_TEST_OFFER_CODE, "cs_r6");
    await deliver(hold("evt_r6", "cs_r6"));
    expect((await replace(testOrder)).status).toBe(409);
    expect(stripe.replace).not.toHaveBeenCalled();
  });

  it("captures the replacement under its own key, so a repeat cannot capture twice", async () => {
    const orderId = await heldOrder("cs_r7");
    await replace(orderId);
    await state.db.query(`UPDATE filing_sessions SET entity_name_primary = 'Sol Ventures LLC', email = 'owner+test@example.com' WHERE filing_session_id = (SELECT filing_session_id FROM orders WHERE order_id = $1)`, [orderId]);
    await markSubmitted(state.db, orderId);
    resend.send.mockResolvedValue({ data: { id: "re_2" }, error: null });
    process.env.RESEND_API_KEY = "re_x";
    process.env.RESEND_FROM_EMAIL = "o@example.com";
    await state.db.query(`UPDATE orders SET stripe_livemode = true WHERE order_id = $1`, [orderId]);
    expect((await proof(orderId, "L26000123456")).status).toBe(200);
    expect(stripe.capture.mock.calls[0].slice(0, 2)).toEqual(["pi_new", `capture-${orderId}-pi_new`]);
  });
});

describe("control 6: a test order is sealed", () => {
  const started = async () => {
    const res = await startTest();
    const { order_id } = (await res.json()) as { order_id: string };
    await state.db.query(`UPDATE orders SET stripe_checkout_session_id = 'cs_live_x' WHERE order_id = $1`, [order_id]);
    const { rows } = await state.db.query(`SELECT filing_session_id FROM orders WHERE order_id = $1`, [order_id]);
    return { orderId: order_id, sessionId: rows[0].filing_session_id as string };
  };
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("refuses every public route on its session", async () => {
    const { sessionId } = await started();
    const replies = [
      await post("/api/session/stage", { filing_session_id: sessionId, stage: "review", filing_data: { llc_name: "Hijack LLC" } }),
      await post("/registered-agent/select", { filing_session_id: sessionId, agent_choice: "own" }),
      await post("/api/registered-agent/request-acceptance", { filing_session_id: sessionId, registered_agent_name: "A", registered_agent_email: "a@real.example" }),
      await post(`/api/filing-session/${sessionId}/pdf`, {}),
      await post("/api/checkout/create", { filing_session_id: sessionId, line_items: [{ offer_code: "DIY_PACKAGE", quantity: 1 }] }),
    ];
    expect(replies.map((r) => r.status)).toEqual([409, 409, 409, 409, 409]);
    expect(await queued()).toEqual([]);
  });

  it("sends nothing when cancelled, or when capture fails, and never touches the saved card", async () => {
    const { orderId } = await started();
    await deliver(hold("evt_c1", "cs_live_x"));
    stripe.capture.mockRejectedValueOnce(Object.assign(new (await import("../src/stripe/restClient.js")).StripeApiError("gone", 400, { code: "charge_expired_for_capture" }), {}));
    const res = await proof(orderId, "TEST-139");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("live_test_not_captured");
    expect((await operator(`/api/orders/${orderId}/cancel`)).status).toBeLessThan(500);
    expect((await queued()).filter((t: string) => t.includes("email"))).toEqual([]);
    expect(resend.send).not.toHaveBeenCalled();
  });

  it("a released test cannot be charged, stays open, and its card is detached", async () => {
    const { orderId } = await started();
    await deliver(hold("evt_c2", "cs_live_x"));
    await deliver({ id: "evt_c3", type: "payment_intent.canceled", livemode: true, data: { object: { id: "pi_hold", metadata: { order_id: orderId } } } });
    expect((await row(orderId)).payment_status).toBe("released");
    const res = await proof(orderId, "TEST-139");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("live_test_released");
    expect((await startTest()).status).toBe(409);
    const detach = vi.fn(async () => undefined);
    await runSavedCardCleanupOnce(state.db, { retrievePaymentIntent: async () => ({ payment_method: "pm_1" }), detachPaymentMethod: detach } as never);
    expect(detach).toHaveBeenCalledWith("pm_1");
  });

  it("sends no receipt to anyone from Stripe", async () => {
    await started();
    expect(stripe.create.mock.calls[0][0].receiptEmail).toBeUndefined();
  });

  it("control 8: one filing is one LLC", async () => {
    const orderId = await seedOrder([DIY_ITEM], "DIY_PACKAGE", "cs_q");
    const { rows } = await state.db.query(`SELECT filing_session_id FROM orders WHERE order_id = $1`, [orderId]);
    await state.db.query(`UPDATE orders SET cancelled_at = now() WHERE order_id = $1`, [orderId]);
    const res = await post("/api/checkout/create", { filing_session_id: rows[0].filing_session_id, line_items: [{ offer_code: "DIY_PACKAGE", quantity: 2 }] });
    expect(res.status).toBe(422);
  });
});

describe("control 7: hold disclosure", () => {
  it("is on the Stripe page, with the breakdown", () => {
    const text = payAfter.holdCheckoutText([{ offer_code: "DIY_PACKAGE" }]).afterSubmit ?? "";
    expect(text).toContain(diy.holdFundsDisclosure(13900));
    expect(diy.holdFundsDisclosure(13900)).toMatch(/temporary hold of \$139, not a charge/);
    expect(diy.holdFundsDisclosure(13900)).toMatch(/balance or credit available/);
    expect(text.length).toBeLessThanOrEqual(1200); // Stripe's custom_text limit
  });
});

describe("the price check before the live test", () => {
  const good = { active: true, unit_amount: 13900, currency: "usd", livemode: true };
  it("passes only the live, active, $139 USD Price", () => {
    expect(diy.livePriceProblems(good)).toEqual([]);
    expect(diy.livePriceProblems({ ...good, livemode: false })).toHaveLength(1);
    expect(diy.livePriceProblems({ ...good, currency: "eur" })).toHaveLength(1);
    expect(diy.livePriceProblems({ ...good, unit_amount: 12500 })).toHaveLength(1);
    expect(diy.livePriceProblems({ ...good, active: false })).toHaveLength(1);
  });
});


describe("what the independent review found", () => {
  const seed = async (session: string) => {
    const orderId = await seedOrder([DIY_ITEM], "DIY_PACKAGE", session);
    await state.db.query(
      `UPDATE filing_sessions SET entity_name_primary = 'Sol Ventures LLC' WHERE filing_session_id = (SELECT filing_session_id FROM orders WHERE order_id = $1)`,
      [orderId]
    );
    await deliver(hold(`evt_${session}`, session));
    await state.db.query(
      `UPDATE orders SET fulfillment_status = 'requires_review', saved_card_authorized_at = now(), saved_card_authorization_text = $2 WHERE order_id = $1`,
      [orderId, payAfter.DIY_SAVED_CARD_AUTHORIZATION]
    );
    return orderId;
  };
  const approve = (orderId: string) => operator(`/api/orders/${orderId}/approve-filing`);
  const code = async (res: Response) => ((await res.json()) as { code?: string }).code;
  const fields = async (orderId: string) => (await state.db.query(`SELECT * FROM orders WHERE order_id = $1`, [orderId])).rows[0];
  const inHours = (h: number) => new Date(Date.now() + h * 3600 * 1000);
  const sweepDeps = () => ({ retrievePaymentIntent: stripe.retrieve, now: () => new Date(), alert: vi.fn(async () => undefined), replace: vi.fn() });

  describe("control 5: one money step at a time", () => {
    it("refuses a capture while another step holds the order, and takes no money", async () => {
      const orderId = await seed("cs_l1");
      await markSubmitted(state.db, orderId);
      await state.db.query(`UPDATE orders SET hold_op_until = $2 WHERE order_id = $1`, [orderId, inHours(1)]);
      const res = await proof(orderId, "L26000123456");
      expect(res.status).toBe(409);
      expect(await code(res)).toBe("order_busy");
      expect(stripe.capture).not.toHaveBeenCalled();
    });

    it("lets a claim lapse if the process died mid-step", async () => {
      const orderId = await seed("cs_l2");
      await state.db.query(`UPDATE orders SET hold_op_until = $2 WHERE order_id = $1`, [orderId, inHours(-1)]);
      expect((await approve(orderId)).status).toBe(200);
    });

    it("frees the order as soon as a step ends, including a refused one", async () => {
      const orderId = await seed("cs_l3");
      stripe.retrieve.mockResolvedValueOnce(capturable({ status: "canceled" }));
      expect((await approve(orderId)).status).toBe(409);
      expect((await approve(orderId)).status).toBe(200);
      expect((await approve(orderId)).status).toBe(200);
    });

    it("keeps the sweep's renewal out while an operator step runs", async () => {
      const orderId = await seed("cs_l4");
      await state.db.query(`UPDATE orders SET hold_op_until = $2 WHERE order_id = $1`, [orderId, inHours(1)]);
      expect(await replaceHold(state.db, orderId)).toMatchObject({ kind: "refused", code: "order_busy" });
      expect(stripe.replace).not.toHaveBeenCalled();
    });
  });

  describe("control 4: replacing a hold safely", () => {
    it("never cancels the hold the order points at, when a repeated key returns it", async () => {
      const orderId = await seed("cs_h1");
      stripe.replace.mockImplementationOnce(async () => {
        await state.db.query(`UPDATE orders SET stripe_payment_intent_id = 'pi_new' WHERE order_id = $1`, [orderId]);
        return capturable({ id: "pi_new" });
      });
      expect(await replaceHold(state.db, orderId)).toMatchObject({ kind: "refused", code: "order_changed" });
      expect(stripe.cancel).not.toHaveBeenCalledWith("pi_new", expect.anything());
      expect(stripe.capture).not.toHaveBeenCalled();
    });

    it("renews a hold that lapsed before filing, so the order can file", async () => {
      const orderId = await seed("cs_h2");
      await state.db.query(`UPDATE orders SET payment_status = 'released', fulfillment_status = 'not_ready' WHERE order_id = $1`, [orderId]);
      stripe.retrieve.mockResolvedValue(capturable({ status: "canceled", amount_capturable: 0 }));
      expect(await replaceHold(state.db, orderId)).toMatchObject({ kind: "replaced", paymentIntentId: "pi_new" });
      const order = await fields(orderId);
      expect(order.payment_status).toBe("authorized");
      expect(order.stripe_payment_intent_id).toBe("pi_new");
      expect(order.superseded_open).toBe(false);
      expect(order.fulfillment_status).toBe("ready");
      expect(stripe.cancel).not.toHaveBeenCalled();
    });

    it("leaves a lapsed hold alone once the filing is with Florida", async () => {
      const orderId = await seed("cs_h3");
      await markSubmitted(state.db, orderId);
      await state.db.query(`UPDATE orders SET payment_status = 'released' WHERE order_id = $1`, [orderId]);
      expect((await replaceHold(state.db, orderId)).kind).toBe("refused");
      expect(stripe.replace).not.toHaveBeenCalled();
    });

    it("has the sweep finish a cancel that failed, until Stripe confirms it", async () => {
      const orderId = await seed("cs_h4");
      stripe.cancel.mockRejectedValueOnce(new Error("stripe down"));
      await replaceHold(state.db, orderId, { alert: vi.fn(async () => undefined) });
      expect((await fields(orderId)).superseded_open).toBe(true);

      const deps = sweepDeps();
      stripe.cancel.mockRejectedValueOnce(new Error("still down"));
      await runHoldSweepOnce(state.db, deps);
      expect((await fields(orderId)).superseded_open).toBe(true);
      expect(deps.alert).toHaveBeenCalled();

      await runHoldSweepOnce(state.db, sweepDeps());
      expect(stripe.cancel).toHaveBeenLastCalledWith("pi_hold", "cancel-superseded-pi_hold");
      expect((await fields(orderId)).superseded_open).toBe(false);
    });

    it("tells the customer what a failed renewal means for them, before and after filing", () => {
      const ctx = { order_id: "ord-1", line_items: [DIY_ITEM], total_cents: 13900, proof_of_filing_ref: null, email: "a@example.com", full_name: "Ana Sol", phone: null, country: null, entity_name_primary: null, entity_name_backup: null, filing_data: {}, registered_agent_status: "accepted" };
      const before = buildOrderEmail("hold_replacement_failed", ctx, "hold", { filingSubmitted: false });
      expect(before?.text).toContain("We can't send your filing to Florida until a valid hold is in place");
      expect(before?.text).not.toContain("we charge the card");
      const after = buildOrderEmail("hold_replacement_failed", ctx, "hold", { filingSubmitted: true });
      expect(after?.text).toContain("we charge the card you authorized at checkout once");
    });

    it("does not let a captured replaced hold mark the order paid, and raises it", async () => {
      const orderId = await seed("cs_h5");
      await replaceHold(state.db, orderId);
      vi.mocked(sendOpsAlert).mockClear();
      await deliver({ id: "evt_old_cap", type: "payment_intent.succeeded", livemode: true, data: { object: { id: "pi_hold", status: "succeeded", amount: 13900, amount_received: 13900, metadata: {} } } });
      expect((await fields(orderId)).payment_status).toBe("authorized");
      expect(vi.mocked(sendOpsAlert).mock.calls[0][0]).toBe("A replaced card hold was captured");
    });
  });

  describe("control 1: the same clearance on every path to Florida", () => {
    it("asks Stripe again at submission, and refuses if the hold has ended", async () => {
      const orderId = await seed("cs_f1");
      expect((await approve(orderId)).status).toBe(200);
      stripe.retrieve.mockResolvedValueOnce(capturable({ status: "canceled" }));
      const res = await operator(`/api/orders/${orderId}/submitted-to-sunbiz`, { tracking_number: "T700" });
      expect(res.status).toBe(409);
      expect(await code(res)).toBe("hold_not_capturable");
      expect((await fields(orderId)).fulfillment_status).toBe("requires_review");
    });

    it("refuses to submit if Stripe can't be reached", async () => {
      const orderId = await seed("cs_f2");
      expect((await approve(orderId)).status).toBe(200);
      stripe.retrieve.mockRejectedValueOnce(new Error("stripe down"));
      expect((await operator(`/api/orders/${orderId}/submitted-to-sunbiz`, { tracking_number: "T701" })).status).toBe(502);
    });

    it("needs a new approval and a capturable hold to resubmit after a rejection", async () => {
      const orderId = await seed("cs_f3");
      expect((await approve(orderId)).status).toBe(200);
      await markSubmitted(state.db, orderId);
      expect((await operator(`/api/orders/${orderId}/filing-rejected`, { reason: "name not distinguishable" })).status).toBe(200);
      expect((await fields(orderId)).filing_approved_at).toBeNull();

      const refused = await operator(`/api/orders/${orderId}/resubmitted-to-sunbiz`, {});
      expect(refused.status).toBe(409);
      expect(await code(refused)).toBe("filing_not_approved");

      expect((await approve(orderId)).status).toBe(200);
      stripe.retrieve.mockResolvedValueOnce(capturable({ status: "canceled" }));
      expect((await operator(`/api/orders/${orderId}/resubmitted-to-sunbiz`, {})).status).toBe(409);
      expect((await fields(orderId)).fulfillment_status).toBe("rejected");

      expect((await operator(`/api/orders/${orderId}/resubmitted-to-sunbiz`, {})).status).toBe(200);
      expect((await fields(orderId)).fulfillment_status).toBe("transmitted");
    });

    it("clears the approval when a person releases the hold, and stops it renewing", async () => {
      const orderId = await seed("cs_f4");
      expect((await approve(orderId)).status).toBe(200);
      expect((await operator(`/api/orders/${orderId}/release-hold`)).status).toBe(200);
      const order = await fields(orderId);
      expect(order.filing_approved_at).toBeNull();
      await state.db.query(`UPDATE orders SET payment_status = 'released' WHERE order_id = $1`, [orderId]);
      const deps = sweepDeps();
      await runHoldSweepOnce(state.db, deps);
      expect(deps.replace).not.toHaveBeenCalled();
    });
  });

  describe("control 5: one filing per LLC", () => {
    it("treats the ways people write one LLC name as one name", () => {
      for (const same of ["Sol Ventures L.L.C.", "SOL VENTURES, LLC", "Sol Ventures LC", "sol ventures limited liability company", "Sol Ventures Limited Liability Co.", "Sol Ventures L.C.", "Sol Ventures Limited Company"]) {
        expect(sameEntityName(same, "Sol Ventures LLC")).toBe(true);
      }
      expect(sameEntityName("Sol & Sea LLC", "Sol and Sea LLC")).toBe(true);
      expect(sameEntityName("Maria's Cafe LLC", "MARIAS CAFE LLC")).toBe(true);
      expect(sameEntityName("Café Sol LLC", "Cafe Sol LLC")).toBe(true);
      expect(sameEntityName("Sol Ventures LLC", "Sol Holdings LLC")).toBe(false);
      expect(entityNameKey("LLC")).toBeNull();
      expect(entityNameKey("  ")).toBeNull();
    });

    it("lets only one of two simultaneous approvals through", async () => {
      const [a, b] = [await seed("cs_d1"), await seed("cs_d2")];
      const [first, second] = await Promise.all([approve(a), approve(b)]);
      expect([first.status, second.status].sort()).toEqual([200, 409]);
      expect((await state.db.query(`SELECT count(*)::int AS n FROM orders WHERE filing_name_key IS NOT NULL`)).rows[0].n).toBe(1);
    });

    it("frees the name when the other order is cancelled", async () => {
      const [a, b] = [await seed("cs_d3"), await seed("cs_d4")];
      expect((await approve(a)).status).toBe(200);
      expect((await approve(b)).status).toBe(409);
      expect((await operator(`/api/orders/${a}/cancel`, { reason: "customer changed their mind" })).status).toBe(200);
      expect((await approve(b)).status).toBe(200);
    });

    it("refuses a filing with no name", async () => {
      const orderId = await seed("cs_d5");
      await state.db.query(`UPDATE filing_sessions SET entity_name_primary = NULL, filing_data = '{}' WHERE filing_session_id = (SELECT filing_session_id FROM orders WHERE order_id = $1)`, [orderId]);
      const res = await approve(orderId);
      expect(res.status).toBe(409);
      expect(await code(res)).toBe("filing_name_missing");
    });

    it("re-checks a corrected name at resubmission", async () => {
      const [a, b] = [await seed("cs_d6"), await seed("cs_d7")];
      await state.db.query(`UPDATE filing_sessions SET filing_data = filing_data WHERE filing_session_id IS NULL`);
      await state.db.query(`UPDATE orders SET filing_name_key = 'OTHER NAME' WHERE order_id = $1`, [b]);
      expect((await approve(a)).status).toBe(200);
      await markSubmitted(state.db, a);
      expect((await operator(`/api/orders/${a}/filing-rejected`, { reason: "name" })).status).toBe(200);
      expect((await approve(a)).status).toBe(200);
      const res = await operator(`/api/orders/${a}/resubmitted-to-sunbiz`, {
        corrections: {
          llc_name: "Other Name LLC", principal_address_line1: "1 Main St", principal_city: "Miami", principal_state: "FL", principal_zip: "33101",
          organizer_name: "Ana Sol", registered_agent_name: "Ana Sol", registered_agent_address_line1: "1 Main St", registered_agent_city: "Miami", registered_agent_state: "FL", registered_agent_zip: "33101",
        },
      });
      expect([409, 422]).toContain(res.status);
      if (res.status === 409) expect(await code(res)).toBe("duplicate_filing");
    });
  });

  describe("control 2: verifying Florida's approval", () => {
    it("checks the filed name, and accepts the backup the customer gave", async () => {
      const orderId = await seed("cs_v1");
      await state.db.query(`UPDATE filing_sessions SET entity_name_primary = NULL, entity_name_backup = 'Sol Marine LLC' WHERE filing_session_id = (SELECT filing_session_id FROM orders WHERE order_id = $1)`, [orderId]);
      await markSubmitted(state.db, orderId);
      await state.db.query(`UPDATE orders SET stripe_livemode = true WHERE order_id = $1`, [orderId]);
      expect((await proof(orderId, "L26000123456", "Some Other LLC")).status).toBe(400);
      expect(stripe.capture).not.toHaveBeenCalled();
      resend.send.mockResolvedValue({ data: { id: "re_3" }, error: null });
      process.env.RESEND_API_KEY = "re_x";
      process.env.RESEND_FROM_EMAIL = "o@example.com";
      expect((await proof(orderId, "L26000123456", "SOL MARINE, L.L.C.")).status).toBe(200);
    });

    it("corrects a wrong document number only before anything was collected, and records it", async () => {
      const orderId = await seed("cs_v2");
      await state.db.query(`UPDATE orders SET proof_of_filing_ref = 'L26000111111', proof_of_filing_at = now() WHERE order_id = $1`, [orderId]);
      const fix = (body: unknown) => operator(`/api/orders/${orderId}/correct-document-number`, body);
      expect((await fix({ document_number: "12345", reason: "typo" })).status).toBe(400);
      expect((await fix({ document_number: "L26000222222" })).status).toBe(400);
      expect((await fix({ document_number: "L26000222222", reason: "typo in the digits" })).status).toBe(200);
      expect((await fields(orderId)).proof_of_filing_ref).toBe("L26000222222");
      const events = await state.db.query(`SELECT payload FROM filing_events WHERE event_type = 'document_number_corrected'`);
      expect(JSON.stringify(events.rows[0].payload)).toContain("L26000111111");

      await state.db.query(`UPDATE orders SET payment_status = 'paid' WHERE order_id = $1`, [orderId]);
      expect((await fix({ document_number: "L26000333333", reason: "again" })).status).toBe(409);
    });
  });

  describe("control 3: nothing goes unwatched", () => {
    it("keeps trying when an alert was not delivered, on the real alert path", async () => {
      const orderId = await seed("cs_w1");
      await state.db.query(`UPDATE orders SET capture_before = $2, replacement_attempts = 3 WHERE order_id = $1`, [orderId, inHours(40)]);
      vi.mocked(sendOpsAlert).mockResolvedValueOnce({ channel: "cliq", ok: false, error: "webhook 500" });
      await runHoldSweepOnce(state.db);
      expect((await fields(orderId)).hold_expiry_flagged_at).toBeNull();
      vi.mocked(sendOpsAlert).mockResolvedValueOnce({ channel: "log", ok: true });
      await runHoldSweepOnce(state.db);
      expect((await fields(orderId)).hold_expiry_flagged_at).toBeNull(); // logs reach nobody
      vi.mocked(sendOpsAlert).mockResolvedValueOnce({ channel: "cliq", ok: true });
      await runHoldSweepOnce(state.db);
      expect((await fields(orderId)).hold_expiry_flagged_at).not.toBeNull();
    });

    it("raises a hold whose deadline Stripe won't give, once", async () => {
      const orderId = await seed("cs_w2");
      await state.db.query(`UPDATE orders SET capture_before = NULL, authorized_at = $2 WHERE order_id = $1`, [orderId, inHours(-2)]);
      stripe.retrieve.mockResolvedValue(capturable({ latest_charge: "ch_1" }));
      const deps = sweepDeps();
      await runHoldSweepOnce(state.db, deps);
      await runHoldSweepOnce(state.db, deps);
      expect(deps.alert).toHaveBeenCalledTimes(1);
      expect(String((deps.alert.mock.calls as unknown as string[][])[0][0])).toContain("gives no deadline");
    });

    it("keeps watching a hold after proof, because that money isn't collected yet", async () => {
      const orderId = await seed("cs_w3");
      await state.db.query(`UPDATE orders SET capture_before = $2, proof_of_filing_at = now() WHERE order_id = $1`, [orderId, inHours(10)]);
      const deps = sweepDeps();
      await runHoldSweepOnce(state.db, deps);
      expect(deps.alert).toHaveBeenCalled();
      expect(deps.replace).not.toHaveBeenCalled();
    });

    it("leaves test-mode rows out once a live key is in place", async () => {
      const orderId = await seed("cs_w4");
      await state.db.query(`UPDATE orders SET capture_before = NULL, stripe_livemode = false, authorized_at = $2 WHERE order_id = $1`, [orderId, inHours(-2)]);
      const before = process.env.STRIPE_SECRET_KEY;
      process.env.STRIPE_SECRET_KEY = "rk_live_for_this_test";
      try {
        const deps = sweepDeps();
        await runHoldSweepOnce(state.db, deps);
        expect(stripe.retrieve).not.toHaveBeenCalled();
        expect(deps.alert).not.toHaveBeenCalled();
      } finally {
        if (before === undefined) delete process.env.STRIPE_SECRET_KEY;
        else process.env.STRIPE_SECRET_KEY = before;
      }
    });
  });

  describe("control 6: test orders stay out of everything", () => {
    const testEvent = (id: string, session: string) => ({ ...hold(id, session), livemode: false });

    it("keeps a Stripe test-mode order out of the CRM and away from Florida", async () => {
      const orderId = await seedOrder([DIY_ITEM], "DIY_PACKAGE", "cs_t1");
      await deliver(testEvent("evt_t1", "cs_t1"));
      expect((await row(orderId)).payment_status).toBe("authorized");
      expect((await row(orderId)).fulfillment_status).not.toBe("ready");
      expect(await queued()).not.toContain("order_deal");
      expect(await claimNextReadyOrder(state.db, "t")).toBeNull();
    });

    it("lets QA opt in, on purpose, to the whole path", async () => {
      process.env.TEST_MODE_ORDERS_FILE = "true";
      try {
        const orderId = await seedOrder([DIY_ITEM], "DIY_PACKAGE", "cs_t2");
        await deliver(testEvent("evt_t2", "cs_t2"));
        expect((await row(orderId)).fulfillment_status).toBe("ready");
      } finally {
        delete process.env.TEST_MODE_ORDERS_FILE;
      }
    });

    it("closes a live test whatever state it reached", async () => {
      const pending = await seedOrder([TEST_ITEM], LIVE_TEST_OFFER_CODE, "cs_t3");
      expect((await operator(`/api/orders/${pending}/cancel`, { reason: "test finished" })).status).toBe(200);

      const proved = await seedOrder([TEST_ITEM], LIVE_TEST_OFFER_CODE, "cs_t4");
      await deliver(hold("evt_t4", "cs_t4"));
      await state.db.query(`UPDATE orders SET proof_of_filing_ref = 'L26000999999', proof_of_filing_at = now() WHERE order_id = $1`, [proved]);
      expect((await operator(`/api/orders/${proved}/cancel`, { reason: "test finished" })).status).toBe(200);
      expect(stripe.cancel).toHaveBeenCalled();
      expect(stripe.capture).not.toHaveBeenCalled();
    });
  });

  describe("control 7: the disclosure matches the order", () => {
    it("states the amount actually held", () => {
      expect(diy.holdFundsDisclosure(13900)).toContain("temporary hold of $139,");
      expect(diy.holdFundsDisclosure(23700)).toContain("temporary hold of $237,");
      const shown = payAfter.holdCheckoutText([{ offer_code: "DIY_PACKAGE", unit_amount_cents: 13900, quantity: 1 }, { offer_code: "EXTRA", unit_amount_cents: 9800, quantity: 1 }]).afterSubmit;
      expect(shown).toContain("temporary hold of $237,");
    });
  });

  it("control 2: a cancel can't overtake a submission", async () => {
    const orderId = await seed("cs_x1");
    await markSubmitted(state.db, orderId);
    const res = await operator(`/api/orders/${orderId}/cancel`, { reason: "too late" });
    expect(res.status).toBe(409);
    expect((await fields(orderId)).cancelled_at).toBeNull();
    expect(stripe.cancel).not.toHaveBeenCalled();
  });
});
