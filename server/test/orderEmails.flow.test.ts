import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import express from "express";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrderEmailDb } from "./helpers/orderEmailDb.js";

/**
 * Hold to filing, through the real webhook route, proof-of-filing route
 * and email worker. Stripe and Resend are mocked, so no email is sent and
 * no card is touched.
 */
const state = vi.hoisted(() => ({ db: null as unknown as Pool }));
vi.mock("../src/db/pool.js", () => ({
  pool: {
    query: (sql: string, params?: unknown[]) => state.db.query(sql, params as never),
    connect: () => state.db.connect(),
  },
}));

const resend = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: resend.send };
  },
}));

const stripe = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("../src/stripe/restClient.js", async (orig) => ({
  ...(await orig<typeof import("../src/stripe/restClient.js")>()),
  capturePaymentIntent: stripe.capture,
}));

const alerts = vi.hoisted(() => ({ send: vi.fn(async () => ({ channel: "log", ok: true })) }));
vi.mock("../src/ops/alerts.js", () => ({ sendOpsAlert: alerts.send, notifyOrderEvent: vi.fn(async () => undefined) }));
vi.mock("../src/registeredAgent/acceptanceEmail.js", () => ({ dispatchAcceptanceEmail: vi.fn(async () => ({ ok: true })) }));

const { stripeWebhookRouter } = await import("../src/routes/webhooksStripe.js");
const { ordersRouter } = await import("../src/routes/orders.js");
const { realOrderEmailSender } = await import("../src/orderEmails/sender.js");
const { runOnce, enqueueCustomerEmails } = await import("../src/orderEmails/worker.js");
const syncWorker = await import("../src/sync/worker.js");

const WEBHOOK_SECRET = "whsec_flow_test";
const OPERATOR_KEY = "op-test-key";
const CUSTOMER = "ana@example.com";
const resetEnv = () => {
  process.env.RESEND_API_KEY = "re_test_mocked";
  process.env.RESEND_FROM_EMAIL = "Orders <orders@example.com>";
  delete process.env.ORDER_EMAIL_REPLY_TO;
};

let server: http.Server;
let base = "";
beforeAll(async () => {
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.OPERATOR_API_KEY = OPERATOR_KEY;
  const app = express();
  app.use("/api/webhooks/stripe", express.raw({ type: "application/json" }));
  app.use(stripeWebhookRouter);
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

let orderId: string;
const checkoutSessionId = "cs_test_flow";
beforeEach(async () => {
  resetEnv();
  state.db = await createOrderEmailDb();
  resend.send.mockReset();
  resend.send.mockImplementation(async () => ({ data: { id: `re_${randomUUID()}` }, error: null }));
  stripe.capture.mockReset();
  stripe.capture.mockResolvedValue({ id: "pi_hold", status: "requires_capture" });
  alerts.send.mockClear();

  const filingSessionId = randomUUID();
  orderId = randomUUID();
  await state.db.query(
    `INSERT INTO filing_sessions (filing_session_id, email, full_name, phone, entity_name_primary, filing_data, registered_agent_status)
     VALUES ($1, $2, 'Ana Sol', '+1 954 555 0100', 'Sol Ventures LLC', $3, 'accepted')`,
    [filingSessionId, CUSTOMER, JSON.stringify({ llc_name: "Sol Ventures LLC", registered_agent_path: "house" })]
  );
  await state.db.query(
    `INSERT INTO orders (order_id, filing_session_id, crm_intent, product, line_items, total_cents, stripe_checkout_session_id)
     VALUES ($1, $2, 'llc_fasttrack', 'FASTTRACK', $3, 24900, $4)`,
    [orderId, filingSessionId, JSON.stringify([{ offer_code: "FASTTRACK", display_name: "FastTrack LLC Filing", unit_amount_cents: 24900, quantity: 1 }]), checkoutSessionId]
  );
});

async function deliver(event: { id: string; type: string; data: { object: Record<string, unknown> } }) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${body}`, "utf8").digest("hex");
  const res = await fetch(`${base}/api/webhooks/stripe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${t},v1=${v1}` },
    body,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const holdEvent = (id = "evt_hold") => ({
  id,
  type: "checkout.session.completed",
  data: { object: { id: checkoutSessionId, payment_status: "unpaid", payment_intent: "pi_hold", metadata: {} } },
});
const paidEvent = (id = "evt_paid", type = "checkout.session.completed") => ({
  id,
  type,
  data: { object: { id: checkoutSessionId, payment_status: "paid", payment_intent: "pi_paid", metadata: {} } },
});

async function proof(documentNumber = "L26000123456") {
  const res = await fetch(`${base}/api/orders/${orderId}/proof-of-filing`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-operator-key": OPERATOR_KEY },
    body: JSON.stringify({ document_number: documentNumber }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const emailJobs = async () =>
  (await state.db.query(`SELECT sync_type, status, attempts, last_error, order_id FROM crm_sync_queue WHERE sync_type LIKE 'customer_email_%' ORDER BY id`)).rows;
const sentSubjects = () => resend.send.mock.calls.map(([message]) => message.subject as string);
const orderRow = async () => (await state.db.query(`SELECT payment_status, fulfillment_status FROM orders WHERE order_id = $1`, [orderId])).rows[0];
const makeDue = () => state.db.query(`UPDATE crm_sync_queue SET run_after = now() WHERE status = 'pending'`);

async function operatorEmails(key: string | null = OPERATOR_KEY) {
  const res = await fetch(`${base}/api/orders/${orderId}/emails`, { headers: key ? { "x-operator-key": key } : {} });
  return { status: res.status, json: (await res.json()) as { emails: Array<Record<string, unknown>> } };
}

describe("when the card hold is placed", () => {
  it("sends the welcome, order confirmation and intake summary to the customer", async () => {
    expect((await deliver(holdEvent())).status).toBe(200);
    expect(resend.send).not.toHaveBeenCalled(); // never inline in the webhook

    expect(await runOnce(state.db, realOrderEmailSender)).toBe(3);

    expect(sentSubjects()).toEqual([
      "Welcome. We have your order for Sol Ventures LLC",
      "Order confirmation for Sol Ventures LLC",
      "Please check what you submitted for Sol Ventures LLC",
    ]);
    for (const [message] of resend.send.mock.calls) {
      expect(message.to).toEqual([CUSTOMER]);
      expect(message.from).toBe("Orders <orders@example.com>");
    }
    expect(resend.send.mock.calls[1][0].text).toContain("A hold is not a charge");
    expect(resend.send.mock.calls.map(([, options]) => options.idempotencyKey)).toEqual([
      `order-email/${orderId}/welcome`,
      `order-email/${orderId}/order_confirmation`,
      `order-email/${orderId}/intake_summary`,
    ]);
    expect((await emailJobs()).map((j) => j.status)).toEqual(["synced", "synced", "synced"]);
  });

  it("uses ORDER_EMAIL_REPLY_TO when set, because the Terms say to reply to cancel", async () => {
    process.env.ORDER_EMAIL_REPLY_TO = "help@example.com";
    await deliver(holdEvent());
    await runOnce(state.db, realOrderEmailSender);
    expect(resend.send.mock.calls[0][0].replyTo).toBe("help@example.com");
  });

  it("describes a charge when the card was charged at checkout", async () => {
    await deliver(paidEvent());
    await runOnce(state.db, realOrderEmailSender);
    expect(resend.send.mock.calls[1][0].text).toContain("We charged $249.00 to your card at checkout.");
  });

  it("does not resend on a duplicate webhook", async () => {
    await deliver(holdEvent());
    await runOnce(state.db, realOrderEmailSender);

    expect((await deliver(holdEvent())).json.duplicate).toBe(true);
    expect(await runOnce(state.db, realOrderEmailSender)).toBe(0);
    expect(resend.send).toHaveBeenCalledTimes(3);
  });

  it("does not resend when a different event reports the same order", async () => {
    await deliver(paidEvent("evt_a"));
    await deliver(paidEvent("evt_b", "checkout.session.async_payment_succeeded"));
    await state.db.query(`UPDATE orders SET payment_status = 'pending', fulfillment_status = 'not_ready' WHERE order_id = $1`, [orderId]);
    await deliver(paidEvent("evt_c"));
    expect(await emailJobs()).toHaveLength(3);
    await runOnce(state.db, realOrderEmailSender);
    expect(resend.send).toHaveBeenCalledTimes(3);
  });

  it("does not queue anything for a checkout that took no payment", async () => {
    const event = holdEvent();
    event.data.object.payment_intent = null as never;
    await deliver(event);
    expect(await emailJobs()).toHaveLength(0);
  });
});

describe("when a send fails", () => {
  it("leaves payment and fulfilment alone, records the failure and retries", async () => {
    resend.send.mockImplementation(async () => ({ data: null, error: { message: "domain not verified" } }));

    expect((await deliver(holdEvent())).status).toBe(200);
    await runOnce(state.db, realOrderEmailSender);

    expect(await orderRow()).toEqual({ payment_status: "authorized", fulfillment_status: "ready" });
    const jobs = await emailJobs();
    expect(jobs.map((j) => [j.status, j.attempts])).toEqual([
      ["pending", 1],
      ["pending", 1],
      ["pending", 1],
    ]);
    expect(jobs[0].last_error).toBe("Resend send failed: domain not verified");
    expect(alerts.send).toHaveBeenCalledWith("Customer email failed", expect.stringContaining(`welcome for order ${orderId}`));

    const visible = await operatorEmails();
    expect(visible.json.emails[0]).toMatchObject({ email_type: "welcome", status: "pending", attempts: 1, last_error: "Resend send failed: domain not verified" });

    // Backing off: nothing due yet, then the retry goes through with the same key.
    expect(await runOnce(state.db, realOrderEmailSender)).toBe(0);
    resend.send.mockReset();
    resend.send.mockImplementation(async () => ({ data: { id: "re_ok" }, error: null }));
    await makeDue();
    await runOnce(state.db, realOrderEmailSender);
    expect(resend.send.mock.calls[0][1].idempotencyKey).toBe(`order-email/${orderId}/welcome`);
    expect((await operatorEmails()).json.emails[0]).toMatchObject({ status: "sent", provider_message_id: "re_ok", last_error: null });
  });

  it("gives up after the sixth attempt and alerts", async () => {
    resend.send.mockImplementation(async () => ({ data: null, error: { message: "still failing" } }));
    await deliver(holdEvent());
    for (let i = 0; i < 6; i++) {
      await runOnce(state.db, realOrderEmailSender);
      await makeDue();
    }
    expect((await emailJobs()).map((j) => [j.status, j.attempts])).toEqual([
      ["dead_letter", 6],
      ["dead_letter", 6],
      ["dead_letter", 6],
    ]);
    expect(alerts.send).toHaveBeenCalledWith("Customer email gave up", expect.stringContaining("will not be retried"));
    expect(await runOnce(state.db, realOrderEmailSender)).toBe(0);
  });

  it("records the failure, without sending, when Resend is not configured", async () => {
    delete process.env.RESEND_FROM_EMAIL;
    await deliver(holdEvent());
    await runOnce(state.db, realOrderEmailSender);
    expect(resend.send).not.toHaveBeenCalled();
    expect((await emailJobs())[0].last_error).toMatch(/Resend not configured/);
  });

  it("records the failure when a thrown error reaches the provider call", async () => {
    resend.send.mockImplementation(async () => {
      throw new Error("socket hang up");
    });
    await deliver(holdEvent());
    await runOnce(state.db, realOrderEmailSender);
    expect((await emailJobs())[0]).toMatchObject({ status: "pending", last_error: "socket hang up" });
  });

  it("stops at once when the session has no customer email", async () => {
    await state.db.query(`UPDATE filing_sessions SET email = NULL`);
    await deliver(holdEvent());
    await runOnce(state.db, realOrderEmailSender);
    expect((await emailJobs())[0]).toMatchObject({ status: "dead_letter", last_error: "no customer email on the filing session" });
    expect(await orderRow()).toMatchObject({ payment_status: "authorized" });
    expect(alerts.send).toHaveBeenCalledWith("Customer email gave up", expect.any(String));
  });

  it("reclaims a job a dead worker left mid-send, using the same key", async () => {
    await deliver(holdEvent());
    await state.db.query(`UPDATE crm_sync_queue SET status = 'processing', locked_at = now() - interval '11 minutes' WHERE sync_type = 'customer_email_welcome'`);
    await state.db.query(`UPDATE crm_sync_queue SET status = 'processing', locked_at = now() WHERE sync_type = 'customer_email_intake_summary'`);
    expect(await runOnce(state.db, realOrderEmailSender)).toBe(2);
    expect((await emailJobs()).map((j) => j.status)).toEqual(["synced", "synced", "processing"]);
  });
});

describe("queueing", () => {
  it("reports failure instead of throwing, so the payment transaction can commit", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (/INSERT INTO crm_sync_queue/.test(sql)) throw new Error("queue unavailable");
      }),
    };
    const queued = await enqueueCustomerEmails(client, { orderId, filingSessionId: "fs", emailTypes: ["welcome"], paymentMode: "hold" });
    expect(queued).toBe(false);
    expect(queries).toEqual(["SAVEPOINT customer_emails", expect.stringContaining("INSERT"), "ROLLBACK TO SAVEPOINT customer_emails"]);
  });
});

describe("the CRM sync worker", () => {
  it("leaves customer emails for their own worker", async () => {
    await deliver(holdEvent());
    const zoho = {
      syncSession: vi.fn(async () => ({ ok: true })),
      syncOrderEvent: vi.fn(async () => ({ ok: true })),
      updateDealStage: vi.fn(async () => ({ ok: true })),
    };
    await syncWorker.runOnce(state.db, zoho);
    expect(zoho.syncSession).not.toHaveBeenCalled();
    expect(zoho.syncOrderEvent).toHaveBeenCalledTimes(1); // the order's own Deal job
    expect((await emailJobs()).map((j) => j.status)).toEqual(["pending", "pending", "pending"]);
  });
});

describe("when proof of filing is recorded", () => {
  beforeEach(async () => {
    await deliver(holdEvent());
    await runOnce(state.db, realOrderEmailSender);
    resend.send.mockClear();
  });

  it("requests collection and sends the filing confirmation with the Sunbiz document number", async () => {
    const r = await proof();
    expect(r.json.status).toBe("collection_requested");
    expect(stripe.capture).toHaveBeenCalledTimes(1);

    await runOnce(state.db, realOrderEmailSender);
    const [message, options] = resend.send.mock.calls[0];
    expect(message.subject).toBe("Your LLC is filed: Sol Ventures LLC");
    expect(message.text).toContain("Sunbiz document number: L26000123456");
    expect(message.text).toContain("We are now collecting payment");
    expect(options.idempotencyKey).toBe(`order-email/${orderId}/filing_confirmation`);
  });

  it("does not send a second confirmation on a repeat call", async () => {
    await proof();
    await runOnce(state.db, realOrderEmailSender);
    await proof("L26000999999");
    expect(await runOnce(state.db, realOrderEmailSender)).toBe(0);
    expect(resend.send).toHaveBeenCalledTimes(1);
  });

  it("still tells the customer the LLC is filed when collection fails", async () => {
    stripe.capture.mockRejectedValue(new Error("stripe unavailable"));
    expect((await proof()).status).toBe(502);
    await runOnce(state.db, realOrderEmailSender);
    expect(sentSubjects()).toEqual(["Your LLC is filed: Sol Ventures LLC"]);
  });

  it("never lets a failed send block collection", async () => {
    resend.send.mockImplementation(async () => ({ data: null, error: { message: "down" } }));
    const r = await proof();
    expect(r.json.status).toBe("collection_requested");
    await runOnce(state.db, realOrderEmailSender);
    expect(stripe.capture).toHaveBeenCalledTimes(1);
    expect((await operatorEmails()).json.emails.at(-1)).toMatchObject({ email_type: "filing_confirmation", status: "pending", attempts: 1 });
  });

  it("confirms an order paid at checkout, without talking about collection", async () => {
    await state.db.query(`UPDATE orders SET payment_status = 'paid'`);
    expect((await proof()).json.status).toBe("already_paid");
    await runOnce(state.db, realOrderEmailSender);
    expect(resend.send.mock.calls[0][0].text).toContain("You paid for this order at checkout.");
  });

  it("sends nothing for an order with nothing paid or held", async () => {
    await state.db.query(`UPDATE orders SET payment_status = 'failed', fulfillment_status = 'not_ready'`);
    expect((await proof()).status).toBe(409);
    expect(await runOnce(state.db, realOrderEmailSender)).toBe(0);
  });
});

describe("GET /api/orders/:orderId/emails", () => {
  it("needs the operator key", async () => {
    expect((await operatorEmails(null)).status).toBe(401);
  });

  it("lists each email with its provider id", async () => {
    await deliver(holdEvent());
    await runOnce(state.db, realOrderEmailSender);
    const { json } = await operatorEmails();
    expect(json.emails.map((e) => [e.email_type, e.status])).toEqual([
      ["welcome", "sent"],
      ["order_confirmation", "sent"],
      ["intake_summary", "sent"],
    ]);
    expect(json.emails[0].provider_message_id).toMatch(/^re_/);
    expect(json.emails[0].sent_at).toBeTruthy();
  });
});
