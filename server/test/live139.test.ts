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
const { clearanceFor, sameEntityName, approvalCurrent } = await import("../src/payments/filingClearance.js");
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
    await state.db.query(`UPDATE orders SET sunbiz_submitted_at = now(), fulfillment_status = 'transmitted' WHERE order_id = $1`, [first]);
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
  const heldOrder = async (session: string) => {
    const orderId = await seedOrder([DIY_ITEM], "DIY_PACKAGE", session);
    await deliver(hold(`evt_${session}`, session));
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
    const deps = { retrievePaymentIntent: stripe.retrieve, now: () => new Date(), alert };

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
    expect(stripe.replace.mock.calls[0][0]).toMatchObject({ amountCents: 13900, customerId: "cus_1", paymentMethodId: "pm_1", idempotencyKey: `replace-${orderId}-pi_hold` });
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
    expect(stripe.cancel).not.toHaveBeenCalled();
    expect((await current(orderId)).stripe_payment_intent_id).toBe("pi_hold");
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
    expect(text).toContain(diy.HOLD_FUNDS_DISCLOSURE);
    expect(diy.HOLD_FUNDS_DISCLOSURE).toMatch(/temporary hold of \$139, not a charge/);
    expect(diy.HOLD_FUNDS_DISCLOSURE).toMatch(/balance or credit available/);
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

