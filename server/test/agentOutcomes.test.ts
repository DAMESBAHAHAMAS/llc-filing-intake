import { randomUUID } from "node:crypto";
import http from "node:http";
import express from "express";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrderEmailDb } from "./helpers/orderEmailDb.js";

/**
 * The customer's own registered agent: accepted, declined, or silent for
 * 7 days, on an order that is held rather than paid. Real routes, sweep and
 * email worker; Resend and alerts are mocked.
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
const alerts = vi.hoisted(() => ({ send: vi.fn(async () => ({ channel: "log", ok: true })) }));
vi.mock("../src/ops/alerts.js", () => ({ sendOpsAlert: alerts.send, notifyOrderEvent: vi.fn(async () => undefined) }));

const { registeredAgentRouter } = await import("../src/routes/registeredAgent.js");
const { runAgentAcceptanceSweepOnce } = await import("../src/registeredAgent/customerNotice.js");
const { claimNextReadyOrder } = await import("../src/fulfillment/fulfillmentWorker.js");
const { realOrderEmailSender } = await import("../src/orderEmails/sender.js");
const { runOnce: runEmails } = await import("../src/orderEmails/worker.js");

let server: http.Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(registeredAgentRouter);
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const DAY = 24 * 60 * 60 * 1000;
let filingSessionId: string;
let orderId: string;
const TOKEN = "agent-token";

async function order(paymentStatus: string, lineItems: unknown[] = [{ offer_code: "FASTTRACK", display_name: "FastTrack", unit_amount_cents: 19900, quantity: 1 }]) {
  orderId = randomUUID();
  await state.db.query(
    `INSERT INTO orders (order_id, filing_session_id, crm_intent, product, line_items, total_cents, payment_status, authorized_at, stripe_livemode)
     VALUES ($1, $2, 'x', 'FASTTRACK', $3, 19900, $4, now(), true)`,
    [orderId, filingSessionId, JSON.stringify(lineItems), paymentStatus]
  );
}

const ask = (requestedAt = new Date(), token = TOKEN) =>
  state.db.query(
    `INSERT INTO registered_agent_acceptances (filing_session_id, status, requested_at, registered_agent_name, registered_agent_email, acceptance_token_id, acceptance_version)
     VALUES ($1, 'acceptance_requested', $2, 'Rae Agent', 'rae@example.com', $3, 'v1')`,
    [filingSessionId, requestedAt, token]
  );

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};
const orderRow = async () => (await state.db.query(`SELECT payment_status, fulfillment_status FROM orders WHERE order_id = $1`, [orderId])).rows[0];
const sessionStatus = async () => (await state.db.query(`SELECT registered_agent_status FROM filing_sessions WHERE filing_session_id = $1`, [filingSessionId])).rows[0].registered_agent_status;
const subjects = () => resend.send.mock.calls.map(([m]) => m.subject as string);

beforeEach(async () => {
  state.db = await createOrderEmailDb();
  process.env.RESEND_API_KEY = "re_test_mocked";
  process.env.RESEND_FROM_EMAIL = "Orders <orders@example.com>";
  process.env.FRONTEND_BASE_URL = "https://example.com";
  resend.send.mockReset();
  resend.send.mockImplementation(async () => ({ data: { id: "re_1" }, error: null }));
  alerts.send.mockClear();
  filingSessionId = randomUUID();
  await state.db.query(
    `INSERT INTO filing_sessions (filing_session_id, email, full_name, entity_name_primary, filing_data, registered_agent_status)
     VALUES ($1, 'ana@example.com', 'Ana Sol', 'Sol Ventures LLC', $2, 'acceptance_requested')`,
    [
      filingSessionId,
      JSON.stringify({
        llc_name: "Sol Ventures LLC",
        registered_agent_path: "customer",
        registered_agent_name: "Rae Agent",
        registered_agent_florida_address: "5 Bay Rd, Tampa, FL 33601",
        registered_agent_email: "rae@example.com",
      }),
    ]
  );
});

describe("the agent accepts", () => {
  it("advances a held order, which is what nearly every order is at this point", async () => {
    await order("authorized");
    await ask();
    expect((await post("/api/registered-agent/accept", { token: TOKEN })).status).toBe(200);
    expect(await orderRow()).toEqual({ payment_status: "authorized", fulfillment_status: "ready" });
    expect(alerts.send).not.toHaveBeenCalled();
  });

  it("still advances a paid order", async () => {
    await order("paid");
    await ask();
    await post("/api/registered-agent/accept", { token: TOKEN });
    expect(await orderRow()).toEqual({ payment_status: "paid", fulfillment_status: "ready" });
  });

  it("files a released hold on the saved card, tells ops, and the filing worker picks it up", async () => {
    await order("released");
    await ask();
    await post("/api/registered-agent/accept", { token: TOKEN });
    expect(await orderRow()).toEqual({ payment_status: "released", fulfillment_status: "ready" });
    expect(alerts.send).toHaveBeenCalledWith("Filing started with no hold in place", expect.stringContaining(orderId));
    expect((await claimNextReadyOrder(state.db, "test"))?.order_id).toBe(orderId);
  });

  it("does not start a cancelled, refunded or failed order", async () => {
    for (const status of ["released", "refunded", "failed"]) {
      await order(status);
      if (status === "released") await state.db.query(`UPDATE orders SET cancelled_at = now() WHERE order_id = $1`, [orderId]);
      await state.db.query(`UPDATE registered_agent_acceptances SET status = 'expired'`);
      await ask(new Date(), `token-${status}`);
      await post("/api/registered-agent/accept", { token: `token-${status}` });
      expect((await orderRow()).fulfillment_status).toBe("not_ready");
    }
  });

  it("leaves an order with no Sunbiz filing alone", async () => {
    await order("paid", [{ offer_code: "EIN_FILING" }]);
    await ask();
    await post("/api/registered-agent/accept", { token: TOKEN });
    expect((await orderRow()).fulfillment_status).toBe("not_ready");
  });
});

describe("the agent declines", () => {
  beforeEach(async () => {
    await order("authorized");
    await ask();
    await post("/api/registered-agent/decline", { token: TOKEN });
  });

  it("emails the customer and alerts ops, and the order stays open", async () => {
    expect(await orderRow()).toEqual({ payment_status: "authorized", fulfillment_status: "not_ready" });
    expect(alerts.send).toHaveBeenCalledWith("Registered agent needs replacing", expect.stringContaining(orderId));
    await runEmails(state.db, realOrderEmailSender);
    expect(subjects()).toEqual(["Your registered agent declined: Sol Ventures LLC"]);
    expect(resend.send.mock.calls[0][0].to).toEqual(["ana@example.com"]);
  });

  it("does not repeat itself when the sweep passes over the same decline", async () => {
    await runAgentAcceptanceSweepOnce(state.db);
    expect(alerts.send).toHaveBeenCalledTimes(1);
    await runEmails(state.db, realOrderEmailSender);
    expect(resend.send).toHaveBeenCalledTimes(1);
  });

  it("asks the newly named agent, at their address and not the old one", async () => {
    const r = await post("/registered-agent/select", {
      filing_session_id: filingSessionId,
      agent_choice: "own",
      name: "Sam Second",
      email: "sam@example.com",
      street: "9 Bay Rd",
      city: "Tampa",
      state: "Florida",
      zip: "33601",
    });
    expect(r.json).toMatchObject({ status: "acceptance_requested", acceptance_email_sent: true });
    expect(resend.send.mock.calls.map(([m]) => String(m.to))).toEqual(["sam@example.com"]);
    expect(await sessionStatus()).toBe("acceptance_requested");
  });

  it("emails the customer again if the second agent also declines", async () => {
    await runEmails(state.db, realOrderEmailSender);
    await post("/registered-agent/select", { filing_session_id: filingSessionId, agent_choice: "own", name: "Sam Second", email: "sam@example.com", street: "9 Bay Rd", city: "Tampa", state: "Florida", zip: "33601" });
    const { rows } = await state.db.query(`SELECT acceptance_token_id FROM registered_agent_acceptances WHERE registered_agent_email = 'sam@example.com'`);
    resend.send.mockClear();
    await post("/api/registered-agent/decline", { token: rows[0].acceptance_token_id });
    await runEmails(state.db, realOrderEmailSender);
    expect(subjects()).toEqual(["Your registered agent declined: Sol Ventures LLC"]);
  });

  it("will not switch to Damian without the 3-year agent service on an order", async () => {
    const r = await post("/registered-agent/select", { filing_session_id: filingSessionId, agent_choice: "damian" });
    expect(r.status).toBe(409);
    expect(r.json.required_offer_code).toBe("REGISTERED_AGENT_3YR");
    expect((await orderRow()).fulfillment_status).toBe("not_ready");
  });

  it("switches to Damian when the service is on the order", async () => {
    await state.db.query(`UPDATE orders SET line_items = $1 WHERE order_id = $2`, [
      JSON.stringify([{ offer_code: "FASTTRACK" }, { offer_code: "REGISTERED_AGENT_3YR" }]),
      orderId,
    ]);
    expect((await post("/registered-agent/select", { filing_session_id: filingSessionId, agent_choice: "damian" })).status).toBe(200);
    expect((await orderRow()).fulfillment_status).toBe("ready");
  });
});

describe("the agent does not answer", () => {
  const now = new Date();

  it("does nothing inside the 7 days", async () => {
    await order("authorized");
    await ask(new Date(now.getTime() - 6 * DAY));
    expect((await runAgentAcceptanceSweepOnce(state.db, now)).notified).toBe(0);
    expect(alerts.send).not.toHaveBeenCalled();
  });

  it("after 7 days emails the customer, alerts ops, and ends the old link", async () => {
    await order("authorized");
    await ask(new Date(now.getTime() - 8 * DAY));
    await runAgentAcceptanceSweepOnce(state.db, now);
    expect(await orderRow()).toEqual({ payment_status: "authorized", fulfillment_status: "not_ready" });
    expect(await sessionStatus()).toBe("expired");
    expect(alerts.send).toHaveBeenCalledWith("Registered agent needs replacing", expect.stringContaining("did not accept within 7 days"));
    await runEmails(state.db, realOrderEmailSender);
    expect(subjects()).toEqual(["Your registered agent has not accepted: Sol Ventures LLC"]);
    expect((await post("/api/registered-agent/accept", { token: TOKEN })).status).toBe(409);
  });

  it("covers a hold that ended in the same 7 days", async () => {
    await order("released");
    await ask(new Date(now.getTime() - 8 * DAY));
    await runAgentAcceptanceSweepOnce(state.db, now);
    await runEmails(state.db, realOrderEmailSender);
    expect(resend.send).toHaveBeenCalledTimes(1);
  });

  it("does not notify twice", async () => {
    await order("authorized");
    await ask(new Date(now.getTime() - 8 * DAY));
    await runAgentAcceptanceSweepOnce(state.db, now);
    await runAgentAcceptanceSweepOnce(state.db, now);
    expect(alerts.send).toHaveBeenCalledTimes(1);
    expect(await runEmails(state.db, realOrderEmailSender)).toBe(1);
  });

  it("skips an order that is cancelled or filed, and an agent who accepted", async () => {
    await order("authorized");
    await state.db.query(`UPDATE orders SET cancelled_at = now() WHERE order_id = $1`, [orderId]);
    await order("authorized");
    await state.db.query(`UPDATE orders SET proof_of_filing_at = now() WHERE order_id = $1`, [orderId]);
    await ask(new Date(now.getTime() - 8 * DAY));
    expect((await runAgentAcceptanceSweepOnce(state.db, now)).notified).toBe(0);
    await state.db.query(`UPDATE orders SET proof_of_filing_at = NULL`);
    await state.db.query(`UPDATE filing_sessions SET registered_agent_status = 'accepted'`);
    expect((await runAgentAcceptanceSweepOnce(state.db, now)).notified).toBe(0);
  });

  it("does not send the notice if the agent accepts before it goes out", async () => {
    await order("authorized");
    await ask(new Date(now.getTime() - 8 * DAY));
    await runAgentAcceptanceSweepOnce(state.db, now);
    await state.db.query(`UPDATE filing_sessions SET registered_agent_status = 'accepted'`);
    await runEmails(state.db, realOrderEmailSender);
    expect(resend.send).not.toHaveBeenCalled();
  });
});

describe("a test-mode order", () => {
  it("does not email a real agent", async () => {
    await order("authorized");
    await state.db.query(`UPDATE orders SET stripe_livemode = false`);
    const { dispatchAcceptanceEmail } = await import("../src/registeredAgent/acceptanceEmail.js");
    await state.db.query(`UPDATE filing_sessions SET filing_data = $1`, [
      JSON.stringify({ llc_name: "Sol", registered_agent_name: "Rae", registered_agent_florida_address: "5 Bay Rd", registered_agent_email: "rae@gmail.com" }),
    ]);
    const r = await dispatchAcceptanceEmail(state.db, filingSessionId);
    expect(r.ok).toBe(false);
    expect(resend.send).not.toHaveBeenCalled();
    expect(await sessionStatus()).toBe("email_failed");
  });
});
