import { randomUUID } from "node:crypto";
import http from "node:http";
import express from "express";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrderEmailDb } from "./helpers/orderEmailDb.js";

/**
 * After checkout: submission, rejection, resubmission, abandoning, the proof
 * gates, failed charges and payment made another way. Real routes, order
 * email worker and card sweep on an in-memory database; Stripe, Resend and
 * the PDF service are mocked.
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
const stripe = vi.hoisted(() => ({ capture: vi.fn(), cancel: vi.fn(), charge: vi.fn(), retrieve: vi.fn(), detach: vi.fn() }));
vi.mock("../src/stripe/restClient.js", async (orig) => ({
  ...(await orig<typeof import("../src/stripe/restClient.js")>()),
  capturePaymentIntent: stripe.capture,
  cancelPaymentIntent: stripe.cancel,
  chargeSavedCard: stripe.charge,
  retrievePaymentIntent: stripe.retrieve,
  detachPaymentMethod: stripe.detach,
}));
const pdf = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("../src/pdf/serviceClient.js", () => ({ generateArticlesOfOrganizationPdf: pdf.generate }));

const { ordersRouter } = await import("../src/routes/orders.js");
const { sessionRouter } = await import("../src/routes/session.js");
const { registeredAgentRouter } = await import("../src/routes/registeredAgent.js");
const { checkoutRouter } = await import("../src/routes/checkout.js");
const { StripeApiError } = await import("../src/stripe/restClient.js");
const { realOrderEmailSender } = await import("../src/orderEmails/sender.js");
const { runOnce: runEmails } = await import("../src/orderEmails/worker.js");
const { runSavedCardCleanupOnce } = await import("../src/payments/savedCardCleanup.js");
const { runOnce: runFulfillment } = await import("../src/fulfillment/fulfillmentWorker.js");

const OPERATOR_KEY = "op-test-key";
let server: http.Server;
let base = "";
beforeAll(async () => {
  process.env.OPERATOR_API_KEY = OPERATOR_KEY;
  process.env.RESEND_API_KEY = "re_test";
  process.env.RESEND_FROM_EMAIL = "orders@example.com";
  const app = express();
  app.use(express.json());
  app.use(ordersRouter);
  app.use(sessionRouter);
  app.use(registeredAgentRouter);
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
  registered_agent_path: "house",
  authorized_persons: [{ name: "Ana Sol", article_iv_title: "AMBR", address: "100 Main St, Miami, FL 33101" }],
  filing_authorization: { accepted: true },
};

let filingSessionId: string;
let orderId: string;

async function makeSession(filingData: Record<string, unknown> = FILING, agentStatus = "accepted") {
  filingSessionId = randomUUID();
  await state.db.query(
    `INSERT INTO filing_sessions (filing_session_id, email, full_name, entity_name_primary, filing_data, registered_agent_status)
     VALUES ($1, 'ana@example.com', 'Ana Sol', 'Sol Ventures LLC', $2, $3)`,
    [filingSessionId, JSON.stringify(filingData), agentStatus]
  );
}
async function makeOrder(over: { payment_status?: string; fulfillment_status?: string; line_items?: unknown[]; total_cents?: number; deferred_cents?: number } = {}) {
  orderId = randomUUID();
  await state.db.query(
    `INSERT INTO orders (order_id, filing_session_id, crm_intent, product, line_items, total_cents, deferred_cents, payment_status, fulfillment_status, authorized_at, stripe_payment_intent_id, stripe_livemode)
     VALUES ($1, $2, 'x', 'FASTTRACK', $3, $4, $5, $6, $7, now(), $8, true)`,
    [
      orderId,
      filingSessionId,
      JSON.stringify(over.line_items ?? [{ offer_code: "FASTTRACK", display_name: "FastTrack", unit_amount_cents: 49900, quantity: 1 }]),
      over.total_cents ?? 49900,
      over.deferred_cents ?? 0,
      over.payment_status ?? "authorized",
      over.fulfillment_status ?? "requires_review",
      `pi_${orderId}`,
    ]
  );
}
const addPdf = () =>
  state.db.query(`INSERT INTO filing_documents (filing_session_id, order_id, byte_size, sha256, pdf_bytes) VALUES ($1, $2, 4, 'abc', $3)`, [filingSessionId, orderId, Buffer.from("%PDF")]);

async function op(path: string, body: unknown = {}, key: string | null = OPERATOR_KEY) {
  const res = await fetch(`${base}/api/orders/${orderId}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "x-operator-key": key } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}
const orderRow = async () => (await state.db.query(`SELECT * FROM orders WHERE order_id = $1`, [orderId])).rows[0];
const subjects = () => resend.send.mock.calls.map(([m]) => m.subject as string);
const submit = (tracking = "T100123456") => op("submitted-to-sunbiz", { tracking_number: tracking });
const reject = (reason = "The name is not distinguishable.") => op("filing-rejected", { reason });
const events = async () => (await state.db.query(`SELECT event_type, payload FROM filing_events ORDER BY id`)).rows;

beforeEach(async () => {
  state.db = await createOrderEmailDb();
  resend.send.mockReset();
  resend.send.mockImplementation(async () => ({ data: { id: `re_${randomUUID()}` }, error: null }));
  alerts.send.mockClear();
  Object.values(stripe).forEach((f) => f.mockReset());
  stripe.capture.mockResolvedValue({ id: "pi", status: "succeeded" });
  stripe.cancel.mockResolvedValue({ id: "pi", status: "canceled" });
  stripe.retrieve.mockResolvedValue({ id: "pi", status: "requires_capture", customer: "cus_1", payment_method: "pm_1" });
  stripe.detach.mockResolvedValue({ id: "pm_1" });
  pdf.generate.mockReset();
  pdf.generate.mockResolvedValue({ ok: true, pdfBytes: Buffer.from("%PDF-corrected"), sha256: "def" });
  await makeSession();
  await makeOrder();
  await addPdf();
});

describe("POST /api/orders/:id/submitted-to-sunbiz", () => {
  it("needs the operator key and a tracking number", async () => {
    expect((await op("submitted-to-sunbiz", { tracking_number: "T100123456" }, null)).status).toBe(401);
    expect((await op("submitted-to-sunbiz", {})).status).toBe(400);
    expect((await op("submitted-to-sunbiz", { tracking_number: "no spaces allowed" })).status).toBe(400);
  });

  it("stores the number and time, and sets the transmitted state", async () => {
    const r = await submit();
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("submitted");
    const row = await orderRow();
    expect(row.fulfillment_status).toBe("transmitted");
    expect(row.sunbiz_tracking_number).toBe("T100123456");
    expect(row.sunbiz_submitted_at).toBeTruthy();
    expect((await events()).map((e) => e.event_type)).toEqual(["sunbiz_submitted"]);
  });

  it("changes nothing on a repeat, and refuses a different number", async () => {
    await submit();
    const first = (await orderRow()).sunbiz_submitted_at;
    expect((await submit()).json.status).toBe("already_submitted");
    expect((await orderRow()).sunbiz_submitted_at).toEqual(first);
    expect((await submit("T999999")).status).toBe(409);
    expect((await orderRow()).sunbiz_tracking_number).toBe("T100123456");
  });

  it("refuses an order whose Articles do not exist", async () => {
    await makeOrder();
    const r = await submit();
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("articles_pdf_missing");
    expect((await orderRow()).fulfillment_status).toBe("requires_review");
  });

  it("refuses before the customer's agent accepts", async () => {
    await makeSession({ ...FILING, registered_agent_path: "customer" }, "acceptance_requested");
    await makeOrder({ fulfillment_status: "not_ready" });
    await addPdf();
    expect((await submit()).json.code).toBe("registered_agent_not_accepted");
  });

  it("refuses a cancelled order, and an order with no Sunbiz filing", async () => {
    await op("cancel");
    expect((await submit()).json.code).toBe("order_cancelled");
    await makeOrder({ line_items: [{ offer_code: "EIN_FILING" }] });
    await addPdf();
    expect((await submit()).status).toBe(409);
  });

  it("files a lapsed hold, which the saved card still covers", async () => {
    await makeOrder({ payment_status: "released" });
    await addPdf();
    expect((await submit()).status).toBe(200);
  });
});

describe("/cancel around a submission", () => {
  it("is refused after submission, and leaves the hold alone", async () => {
    await submit();
    const r = await op("cancel");
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("filing_submitted");
    expect(stripe.cancel).not.toHaveBeenCalled();
    expect((await orderRow()).cancelled_at).toBeNull();
  });

  it("is refused again after a resubmission", async () => {
    await submit();
    await reject();
    await op("resubmitted-to-sunbiz");
    expect((await op("cancel")).status).toBe(409);
  });
});

describe("a rejected filing", () => {
  beforeEach(async () => {
    await submit();
  });

  it("records the reason and emails the customer why, leaving the hold in place", async () => {
    const r = await reject("The name is not distinguishable from Sol Ventures Inc.");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "rejected", rejection: 1, customer_emailed: true });
    const row = await orderRow();
    expect(row.fulfillment_status).toBe("rejected");
    expect(row.payment_status).toBe("authorized");
    expect(row.sunbiz_rejection_reason).toContain("Sol Ventures Inc");
    expect(stripe.cancel).not.toHaveBeenCalled();
    expect(stripe.capture).not.toHaveBeenCalled();
    await runEmails(state.db, realOrderEmailSender);
    expect(subjects()).toEqual(["Florida rejected your filing: Sol Ventures LLC"]);
    expect(resend.send.mock.calls[0][0].text).toContain("not distinguishable from Sol Ventures Inc.");
    expect(alerts.send).toHaveBeenCalledWith("Florida rejected a filing", expect.any(String));
  });

  it("needs a reason, and a submitted filing", async () => {
    expect((await op("filing-rejected", {})).status).toBe(400);
    await makeOrder();
    await addPdf();
    expect((await reject()).json.code).toBe("filing_not_submitted");
  });

  it("emails once however often it is called, and keeps a lapsed hold's order open", async () => {
    await reject();
    await reject();
    await runEmails(state.db, realOrderEmailSender);
    expect(subjects()).toHaveLength(1);
    await state.db.query(`UPDATE orders SET payment_status = 'released' WHERE order_id = $1`, [orderId]);
    await op("resubmitted-to-sunbiz");
    await reject("Second reason");
    await runEmails(state.db, realOrderEmailSender);
    expect(subjects()).toHaveLength(2);
    expect(resend.send.mock.calls[1][0].text).toContain("Your card still isn't charged until Florida accepts it.");
  });

  it("does not email a rejection that was corrected before its turn came", async () => {
    await reject();
    await op("resubmitted-to-sunbiz");
    await runEmails(state.db, realOrderEmailSender);
    expect(subjects()).toEqual([]);
  });

  it("refuses proof until it is resubmitted", async () => {
    await reject();
    const r = await op("proof-of-filing", { document_number: "L26000123456" });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("filing_rejected");
    expect(stripe.capture).not.toHaveBeenCalled();
  });

  describe("resubmission", () => {
    beforeEach(async () => {
      await reject();
    });

    it("goes back to transmitted, keeps the first filing date and the tracking number", async () => {
      const before = (await orderRow()).sunbiz_submitted_at;
      const r = await op("resubmitted-to-sunbiz");
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ status: "resubmitted", tracking_number: "T100123456", within_60_days: true });
      const row = await orderRow();
      expect(row.fulfillment_status).toBe("transmitted");
      expect(row.sunbiz_submitted_at).toEqual(before);
      expect(row.sunbiz_resubmitted_at).toBeTruthy();
      expect(row.sunbiz_rejection_count).toBe(1);
    });

    it("records a new tracking number, and says when the 60 days have passed", async () => {
      await state.db.query(`UPDATE orders SET sunbiz_rejected_at = now() - interval '61 days' WHERE order_id = $1`, [orderId]);
      const r = await op("resubmitted-to-sunbiz", { tracking_number: "T200" });
      expect(r.json).toMatchObject({ tracking_number: "T200", within_60_days: false });
    });

    it("is refused on a filing that is not rejected", async () => {
      await op("resubmitted-to-sunbiz", { tracking_number: "T200" });
      expect((await op("resubmitted-to-sunbiz", {})).json.status).toBe("already_resubmitted");
      await makeOrder();
      await addPdf();
      expect((await op("resubmitted-to-sunbiz")).json.code).toBe("filing_not_rejected");
    });

    it("then proof collects as normal", async () => {
      await op("resubmitted-to-sunbiz");
      const r = await op("proof-of-filing", { document_number: "L26000123456" });
      expect(r.status).toBe(200);
      expect(stripe.capture).toHaveBeenCalledTimes(1);
    });

    it("writes corrections back, with corrected Articles, so the confirmation names what Florida filed", async () => {
      const r = await op("resubmitted-to-sunbiz", { corrections: { llc_name: "Sol Ventures Group LLC", payment_status: "paid", ssn: "x" } });
      expect(r.json.corrected_fields).toEqual(["llc_name"]);
      const session = (await state.db.query(`SELECT filing_data, entity_name_primary FROM filing_sessions WHERE filing_session_id = $1`, [filingSessionId])).rows[0];
      expect(session.filing_data.llc_name).toBe("Sol Ventures Group LLC");
      expect(session.filing_data.ssn).toBeUndefined();
      expect(session.filing_data.registered_agent_path).toBe("house");
      expect(session.entity_name_primary).toBe("Sol Ventures Group LLC");
      expect((await state.db.query(`SELECT sha256 FROM filing_documents WHERE order_id = $1 ORDER BY id`, [orderId])).rows.map((d: { sha256: string }) => d.sha256)).toEqual(["abc", "def"]);
      expect((await orderRow()).payment_status).toBe("authorized");
    });

    it("changes nothing if the corrections cannot be built or the PDF fails", async () => {
      expect((await op("resubmitted-to-sunbiz", { corrections: { principal_address: "" } })).json.code).toBe("filing_data_incomplete");
      pdf.generate.mockResolvedValue({ ok: false, error: "down" });
      expect((await op("resubmitted-to-sunbiz", { corrections: { llc_name: "New LLC" } })).status).toBe(502);
      expect((await orderRow()).fulfillment_status).toBe("rejected");
      const session = (await state.db.query(`SELECT filing_data FROM filing_sessions WHERE filing_session_id = $1`, [filingSessionId])).rows[0];
      expect(session.filing_data.llc_name).toBe("Sol Ventures LLC");
    });
  });

  describe("abandoning through /cancel", () => {
    beforeEach(async () => {
      await reject();
    });

    it("closes the order, releases the hold, detaches the card and emails 'you pay nothing'", async () => {
      const r = await op("cancel", { reason: "customer will not correct" });
      expect(r.status).toBe(200);
      expect(stripe.cancel).toHaveBeenCalledWith(`pi_${orderId}`, `release-${orderId}`);
      const row = await orderRow();
      expect(row.cancelled_at).toBeTruthy();
      expect(row.fulfillment_status).toBe("not_ready");
      expect(row.sunbiz_rejection_reason).toBeTruthy();
      await runEmails(state.db, realOrderEmailSender);
      const cancelled = resend.send.mock.calls.map(([m]) => m).find((m) => /cancelled/.test(m.subject));
      expect(cancelled.text).toContain("you pay nothing");
      expect(subjects().filter((s) => /rejected/.test(s))).toHaveLength(0);

      // The webhook then moves the order to released, and the sweep takes the card off.
      await state.db.query(`UPDATE orders SET payment_status = 'released' WHERE order_id = $1`, [orderId]);
      expect((await runSavedCardCleanupOnce(state.db, { retrievePaymentIntent: stripe.retrieve, detachPaymentMethod: stripe.detach, alert: async () => undefined })).detached).toBe(1);
      expect(stripe.detach).toHaveBeenCalledWith("pm_1");
      expect(alerts.send).toHaveBeenCalledWith("Order cancelled", expect.stringContaining("request the state refund"));
    });

    it("works on a lapsed hold, with nothing to release", async () => {
      await state.db.query(`UPDATE orders SET payment_status = 'released' WHERE order_id = $1`, [orderId]);
      expect((await op("cancel")).status).toBe(200);
      expect(stripe.cancel).not.toHaveBeenCalled();
    });

    it("then nothing can file or charge it", async () => {
      await op("cancel");
      expect((await op("resubmitted-to-sunbiz")).json.code).toBe("order_cancelled");
      expect((await op("proof-of-filing", { document_number: "L26000123456" })).status).toBe(409);
      expect(stripe.capture).not.toHaveBeenCalled();
    });
  });
});

describe("the proof of filing gates", () => {
  const proof = () => op("proof-of-filing", { document_number: "L26000123456" });

  it("refuses an order that was not submitted, and records nothing", async () => {
    const r = await proof();
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("filing_not_submitted");
    expect((await orderRow()).proof_of_filing_at).toBeNull();
    expect(resend.send).not.toHaveBeenCalled();
    expect(stripe.capture).not.toHaveBeenCalled();
  });

  it("refuses when the customer's agent has not accepted", async () => {
    await submit();
    await state.db.query(`UPDATE filing_sessions SET filing_data = $1, registered_agent_status = 'pending'`, [JSON.stringify({ ...FILING, registered_agent_path: "customer" })]);
    const r = await proof();
    expect(r.json.code).toBe("registered_agent_not_accepted");
    expect(stripe.capture).not.toHaveBeenCalled();
  });

  it("refuses when the PDF is missing, even if the state says submitted", async () => {
    await submit();
    await state.db.query(`DELETE FROM filing_documents`);
    expect((await proof()).json.code).toBe("articles_pdf_missing");
    expect(stripe.capture).not.toHaveBeenCalled();
  });

  it("does not count a pre-payment PDF", async () => {
    await submit();
    await state.db.query(`DELETE FROM filing_documents`);
    await state.db.query(`INSERT INTO filing_documents (filing_session_id, order_id, byte_size, sha256, pdf_bytes) VALUES ($1, NULL, 4, 'abc', $2)`, [filingSessionId, Buffer.from("%PDF")]);
    expect((await proof()).json.code).toBe("articles_pdf_missing");
  });

  it("delivers before it collects, when every gate passes", async () => {
    await submit();
    const order: string[] = [];
    resend.send.mockImplementation(async () => {
      order.push("delivered");
      return { data: { id: "re_1" }, error: null };
    });
    stripe.capture.mockImplementation(async () => {
      order.push("captured");
      return { id: "pi", status: "succeeded" };
    });
    expect((await proof()).status).toBe(200);
    expect(order).toEqual(["delivered", "captured"]);
    expect((await orderRow()).fulfillment_completed_at).toBeTruthy();
  });

  it("collects nothing when delivery fails", async () => {
    await submit();
    resend.send.mockImplementation(async () => ({ data: null, error: { message: "down" } }));
    expect((await proof()).status).toBe(502);
    expect(stripe.capture).not.toHaveBeenCalled();
  });

  it("an EIN-only order has no Sunbiz filing to gate on", async () => {
    await makeOrder({ line_items: [{ offer_code: "EIN_FILING", display_name: "EIN", unit_amount_cents: 29900, quantity: 1 }], fulfillment_status: "not_ready" });
    expect((await op("proof-of-filing", { document_number: "12-3456789" })).status).toBe(200);
  });
});

describe("a failed charge after filing", () => {
  const proof = () => op("proof-of-filing", { document_number: "L26000123456" });
  beforeEach(async () => {
    await submit();
  });

  it("emails the customer on a capture that fails outright", async () => {
    stripe.capture.mockRejectedValue(new StripeApiError("Your card was declined", 402, { code: "card_declined" }));
    const r = await proof();
    expect(r.status).toBe(502);
    expect(r.json.customer_emailed).toBe(true);
    await runEmails(state.db, realOrderEmailSender);
    expect(subjects()).toContain("We could not charge your card");
  });

  it("emails the customer on a Stripe error that is not a decline", async () => {
    stripe.capture.mockRejectedValue(new StripeApiError("api_error", 500, {}));
    expect((await proof()).json.customer_emailed).toBe(true);
    await runEmails(state.db, realOrderEmailSender);
    expect(subjects()).toContain("We could not charge your card");
  });

  it("emails on a saved-card failure that is not a 402, and when no saved card exists", async () => {
    await state.db.query(`UPDATE orders SET payment_status = 'released' WHERE order_id = $1`, [orderId]);
    stripe.retrieve.mockResolvedValue({ id: "pi", status: "canceled", customer: null, payment_method: null });
    expect((await proof()).json.customer_emailed).toBe(true);
    await runEmails(state.db, realOrderEmailSender);
    expect(subjects()).toContain("We could not charge your card");
  });

  it("emails only once across retries", async () => {
    stripe.capture.mockRejectedValue(new StripeApiError("api_error", 500, {}));
    await proof();
    await proof();
    await runEmails(state.db, realOrderEmailSender);
    expect(subjects().filter((s) => s === "We could not charge your card")).toHaveLength(1);
  });

  it("does not email if the charge turns out to have gone through", async () => {
    stripe.capture.mockRejectedValue(new Error("socket hang up"));
    await proof();
    await state.db.query(`UPDATE orders SET payment_status = 'paid' WHERE order_id = $1`, [orderId]);
    await runEmails(state.db, realOrderEmailSender);
    expect(subjects()).not.toContain("We could not charge your card");
  });

  it("emails on a failed service charge that is not a decline", async () => {
    await makeOrder({ payment_status: "paid", deferred_cents: 29900, total_cents: 79800 });
    stripe.retrieve.mockRejectedValue(new Error("stripe unreachable"));
    const r = await op("service-complete", { service_ref: "EIN123456" });
    expect(r.json.customer_emailed).toBe(true);
  });
});

describe("POST /api/orders/:id/payment-received", () => {
  const paid = (amount = 49900) => op("payment-received", { method: "wire", reference: "W-1", amount_cents: amount });
  const settle = async (status = "released") => {
    await submit();
    await state.db.query(`UPDATE orders SET payment_status = $2, proof_of_filing_at = now(), proof_of_filing_ref = 'L26000123456' WHERE order_id = $1`, [orderId, status]);
  };

  it("needs the operator key, a method and an amount", async () => {
    expect((await op("payment-received", { method: "wire", amount_cents: 1 }, null)).status).toBe(401);
    expect((await op("payment-received", { amount_cents: 1 })).status).toBe(400);
    expect((await op("payment-received", { method: "wire", amount_cents: 10.5 })).status).toBe(400);
  });

  it("records the payment, closes the order and the sweep detaches the card", async () => {
    await settle();
    const r = await paid();
    expect(r.status).toBe(200);
    const row = await orderRow();
    expect(row).toMatchObject({ payment_status: "paid", other_payment_method: "wire", other_payment_reference: "W-1", other_payment_cents: 49900 });
    expect(row.other_payment_at).toBeTruthy();
    expect((await runSavedCardCleanupOnce(state.db, { retrievePaymentIntent: stripe.retrieve, detachPaymentMethod: stripe.detach, alert: async () => undefined })).detached).toBe(1);
    expect(stripe.detach).toHaveBeenCalledWith("pm_1");
  });

  it("releases a hold still in place, so the order cannot be collected twice", async () => {
    await settle("authorized");
    const r = await paid();
    expect(r.json.hold_released).toBe(true);
    expect(stripe.cancel).toHaveBeenCalledTimes(1);
  });

  it("refuses when Stripe shows the hold was collected after all", async () => {
    await settle("authorized");
    stripe.retrieve.mockResolvedValue({ id: "pi", status: "succeeded" });
    expect((await paid()).json.code).toBe("already_collected");
    expect((await orderRow()).payment_status).toBe("authorized");
  });

  it("refuses before Florida confirms, whatever was paid", async () => {
    expect((await paid()).json.code).toBe("filing_not_confirmed");
  });

  it("refuses a cancelled order, a charge in progress, a wrong amount and nothing due", async () => {
    await settle();
    expect((await paid(100)).json).toMatchObject({ code: "amount_mismatch", amount_due_cents: 49900 });
    await state.db.query(`UPDATE orders SET saved_card_payment_intent_id = 'pi_x' WHERE order_id = $1`, [orderId]);
    expect((await paid()).json.code).toBe("charge_in_progress");
    await state.db.query(`UPDATE orders SET saved_card_payment_intent_id = NULL, payment_status = 'paid' WHERE order_id = $1`, [orderId]);
    expect((await paid()).json.code).toBe("nothing_due");
    await state.db.query(`UPDATE orders SET cancelled_at = now() WHERE order_id = $1`, [orderId]);
    expect((await paid()).json.code).toBe("order_cancelled");
  });

  it("covers a service charge that failed, and no charge follows", async () => {
    await makeOrder({ payment_status: "paid", deferred_cents: 29900, total_cents: 79800 });
    await state.db.query(`UPDATE orders SET proof_of_filing_at = now() WHERE order_id = $1`, [orderId]);
    expect((await paid(29900)).status).toBe(200);
    expect((await orderRow()).deferred_charged_at).toBeTruthy();
    expect((await op("service-complete", { service_ref: "EIN123456" })).json.status).toBe("already_paid");
    expect(stripe.charge).not.toHaveBeenCalled();
  });

  it("makes a later proof call say paid, without charging", async () => {
    await settle();
    await paid();
    expect((await op("proof-of-filing", { document_number: "L26000123456" })).json.status).toBe("already_paid");
    expect(stripe.charge).not.toHaveBeenCalled();
  });
});

describe("order status for the site", () => {
  const status = async () => (await (await fetch(`${base}/api/checkout/order/${orderId}`)).json()) as Record<string, any>;

  it("tells a lapsed hold from a cancelled order", async () => {
    await state.db.query(`UPDATE orders SET payment_status = 'released' WHERE order_id = $1`, [orderId]);
    expect(await status()).toMatchObject({ payment_status: "released", cancelled: false, cancelled_at: null });
    await op("cancel", { reason: "private reason" });
    const after = await status();
    expect(after).toMatchObject({ payment_status: "released", cancelled: true });
    expect(after.cancelled_at).toBeTruthy();
    expect(JSON.stringify(after)).not.toContain("private reason");
  });

  it("reports submission and rejection, not the reason", async () => {
    await submit();
    expect((await status()).sunbiz_submitted_at).toBeTruthy();
    await reject("private reason");
    const after = await status();
    expect(after.sunbiz_rejected_at).toBeTruthy();
    expect(JSON.stringify(after)).not.toContain("private reason");
  });
});

describe("filing_data on a session with an order (MIR-321)", () => {
  const stage = async (filingData: unknown) => {
    const res = await fetch(`${base}/api/session/stage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filing_session_id: filingSessionId, stage: "complete", filing_data: filingData }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  const stored = async () => (await state.db.query(`SELECT filing_data FROM filing_sessions WHERE filing_session_id = $1`, [filingSessionId])).rows[0].filing_data;

  it.each(["authorized", "paid", "released"])("refuses a replacement on a %s order", async (paymentStatus) => {
    await state.db.query(`UPDATE orders SET payment_status = $1`, [paymentStatus]);
    const r = await stage({ ...FILING, llc_name: "Someone Else LLC" });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("filing_data_locked");
    expect((await stored()).llc_name).toBe("Sol Ventures LLC");
  });

  it("lets a repeat through without writing, so stored agent details survive", async () => {
    const { registered_agent_path: _path, ...sentByBrowser } = FILING;
    const r = await stage(sentByBrowser);
    expect(r.status).toBe(200);
    expect((await stored()).registered_agent_path).toBe("house");
  });

  it("still allows a change on a cancelled order, and before any order", async () => {
    await state.db.query(`UPDATE orders SET payment_status = 'released', cancelled_at = now()`);
    expect((await stage({ ...FILING, llc_name: "Again LLC" })).status).toBe(200);
    await makeSession();
    expect((await stage({ ...FILING, llc_name: "New LLC" })).status).toBe(200);
  });

  it("a stage change with no filing_data is unaffected", async () => {
    const res = await fetch(`${base}/api/session/stage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filing_session_id: filingSessionId, stage: "complete" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("the registered agent once a filing is at Florida", () => {
  const select = (body: Record<string, unknown>) =>
    fetch(`${base}/registered-agent/select`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filing_session_id: filingSessionId, ...body }) }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> }));
  const own = { agent_choice: "own", name: "Sam", email: "sam@example.com", street: "9 Bay Rd", city: "Tampa", state: "Florida", zip: "33601" };

  it("cannot be changed while the filing is with Florida", async () => {
    await submit();
    expect((await select(own)).json.code).toBe("filing_submitted");
    expect((await select({ agent_choice: "damian" })).json.code).toBe("filing_submitted");
  });

  it("can be changed on a rejected filing", async () => {
    await submit();
    await reject();
    expect((await select(own)).status).toBe(200);
  });

  it("reports every spelling of a P.O. Box, in the street or the unit", async () => {
    expect((await select({ ...own, street: "P. O. Box 9" })).json.validationErrors).toContain("P.O. Boxes are not allowed for the registered agent address");
    await state.db.query(`UPDATE orders SET payment_status = 'failed'`);
    expect((await select({ ...own, unit: "P O Box 9" })).json.validationErrors).toContain("P.O. Boxes are not allowed for the registered agent address");
  });
});

describe("the fulfillment worker", () => {
  it("alerts ops when an order lands in requires_review with details missing", async () => {
    await makeSession({ ...FILING, authorized_persons: [{ name: "Ana", article_iv_title: "AMBR", address: "" }] });
    await makeOrder({ fulfillment_status: "ready" });
    await runFulfillment(state.db, "t");
    expect((await orderRow()).fulfillment_status).toBe("requires_review");
    expect(alerts.send).toHaveBeenCalledWith("Filing needs review: details missing", expect.stringContaining("authorized_persons[0].address"));
  });

  it("alerts ops when an order lands in requires_review ready to file", async () => {
    await makeOrder({ fulfillment_status: "ready" });
    await runFulfillment(state.db, "t");
    expect((await orderRow()).fulfillment_status).toBe("requires_review");
    expect(alerts.send).toHaveBeenCalledWith("Filing ready for review", expect.stringContaining(orderId));
  });

  it("alerts ops when the PDF gives up", async () => {
    pdf.generate.mockResolvedValue({ ok: false, error: "down" });
    await makeOrder({ fulfillment_status: "ready" });
    await state.db.query(`UPDATE orders SET fulfillment_attempts = 5 WHERE order_id = $1`, [orderId]);
    await runFulfillment(state.db, "t");
    expect((await orderRow()).fulfillment_status).toBe("failed");
    expect(alerts.send).toHaveBeenCalledWith("Articles could not be generated", expect.stringContaining(orderId));
  });
});
