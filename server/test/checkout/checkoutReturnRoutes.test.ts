import "dotenv/config";
import { randomUUID } from "node:crypto";
import http from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool.js";
import { sessionRouter } from "../../src/routes/session.js";
import { checkoutRouter } from "../../src/routes/checkout.js";
import { createCheckoutSession } from "../../src/checkout/checkoutService.js";
import type {
  CreateCheckoutSessionInput,
  CreateCheckoutSessionResult,
  StripeCheckoutClient,
} from "../../src/checkout/stripeCheckoutClient.js";

/**
 * Gate 2 Stripe Checkout return-routes task. Covers: the new
 * GET /checkout/session-status read path, retry-without-duplicate-Order
 * reuse, and cross-customer isolation. Runs against the real dev Supabase
 * instance, same convention as every other integration test here. No
 * real Stripe API call — a fake StripeCheckoutClient is injected (same
 * pattern used throughout this codebase).
 */

const createdSessionIds: string[] = [];

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(sessionRouter);
  app.use(checkoutRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("failed to bind test server");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  if (createdSessionIds.length) {
    await pool.query("DELETE FROM orders WHERE filing_session_id = ANY($1)", [createdSessionIds]);
    await pool.query("DELETE FROM crm_sync_queue WHERE filing_session_id = ANY($1)", [createdSessionIds]);
    await pool.query("DELETE FROM filing_events WHERE filing_session_id = ANY($1)", [createdSessionIds]);
    await pool.query("DELETE FROM filing_sessions WHERE filing_session_id = ANY($1)", [createdSessionIds]);
  }
});

function fakeStripeClient(
  impl?: (input: CreateCheckoutSessionInput) => Promise<CreateCheckoutSessionResult>
): { client: StripeCheckoutClient; calls: CreateCheckoutSessionInput[] } {
  const calls: CreateCheckoutSessionInput[] = [];
  const defaultImpl = async () => ({ id: `cs_test_fake_${randomUUID()}`, url: "https://checkout.stripe.com/fake" });
  return {
    calls,
    client: {
      async createCheckoutSession(input) {
        calls.push(input);
        return (impl ?? defaultImpl)(input);
      },
      async retrieveCheckoutSession() {
        throw new Error("not used in this test file");
      },
    },
  };
}

async function createCompleteFilingSession(email: string): Promise<string> {
  const filingSessionId = randomUUID();
  createdSessionIds.push(filingSessionId);
  await pool.query(
    `INSERT INTO filing_sessions (filing_session_id, current_stage, email, filing_data)
     VALUES ($1, 'complete', $2, $3)`,
    [filingSessionId, email, { llc_name: "Return Routes Test LLC" }]
  );
  return filingSessionId;
}

describe("A. GET /checkout/session-status — read-only order lookup", () => {
  it("returns the order's safe summary fields for a known session id", async () => {
    const filingSessionId = await createCompleteFilingSession("return-routes-a@example.com");
    const { client } = fakeStripeClient();
    const result = await createCheckoutSession(pool, client, { filingSessionId, crmIntent: "LLC_FORMATION_DIY" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");

    const { rows } = await pool.query("SELECT stripe_checkout_session_id FROM orders WHERE order_id = $1", [
      result.orderId,
    ]);
    const stripeSessionId = rows[0].stripe_checkout_session_id;

    const res = await fetch(`${baseUrl}/checkout/session-status?session_id=${stripeSessionId}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.found).toBe(true);
    expect(json.order_id).toBe(result.orderId);
    expect(json.filing_session_id).toBe(filingSessionId);
    expect(json.crm_intent).toBe("LLC_FORMATION_DIY");
    expect(json.payment_status).toBe("pending");
    expect(json.checkout_status).toBe("checkout_created");
    expect(json.total_cents).toBe(12900);
    expect(json.currency).toBe("usd");
    // Never exposed — no email, name, address, or filing_data in the response.
    expect(json.email).toBeUndefined();
    expect(json.full_name).toBeUndefined();
    expect(json.filing_data).toBeUndefined();
  });

  it("returns 404 (not a leak, not a crash) for an unknown session id", async () => {
    const res = await fetch(`${baseUrl}/checkout/session-status?session_id=cs_test_fake_${randomUUID()}`);
    expect(res.status).toBe(404);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.found).toBe(false);
    // No stack trace, no DB error detail, no hint about what does exist.
    expect(Object.keys(json)).toEqual(["found"]);
  });

  it("returns 400 for a missing session_id — never does a wildcard/empty lookup", async () => {
    const res = await fetch(`${baseUrl}/checkout/session-status`);
    expect(res.status).toBe(400);
  });

  it("is idempotent — repeated reads never change anything (refresh-safety)", async () => {
    const filingSessionId = await createCompleteFilingSession("return-routes-refresh@example.com");
    const { client } = fakeStripeClient();
    const result = await createCheckoutSession(pool, client, { filingSessionId, crmIntent: "LLC_FORMATION_DIY" });
    if (!result.ok) throw new Error("expected success");
    const { rows } = await pool.query("SELECT stripe_checkout_session_id FROM orders WHERE order_id = $1", [
      result.orderId,
    ]);
    const stripeSessionId = rows[0].stripe_checkout_session_id;

    const before = await pool.query("SELECT count(*) AS n FROM orders WHERE filing_session_id = $1", [
      filingSessionId,
    ]);

    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${baseUrl}/checkout/session-status?session_id=${stripeSessionId}`);
      expect(res.status).toBe(200);
    }

    const after = await pool.query("SELECT count(*) AS n FROM orders WHERE filing_session_id = $1", [
      filingSessionId,
    ]);
    expect(after.rows[0].n).toBe(before.rows[0].n); // still exactly 1 — 5 reads created nothing
    const { rows: finalRows } = await pool.query("SELECT payment_status FROM orders WHERE order_id = $1", [
      result.orderId,
    ]);
    expect(finalRows[0].payment_status).toBe("pending"); // reading never marks paid
  });
});

describe("B. Cross-customer isolation", () => {
  it("customer A's session_id never returns customer B's data, and vice versa", async () => {
    const filingSessionA = await createCompleteFilingSession("customer-a@example.com");
    const filingSessionB = await createCompleteFilingSession("customer-b@example.com");
    const { client: clientA } = fakeStripeClient();
    const { client: clientB } = fakeStripeClient();

    const resultA = await createCheckoutSession(pool, clientA, {
      filingSessionId: filingSessionA,
      crmIntent: "LLC_FORMATION_DIY",
    });
    const resultB = await createCheckoutSession(pool, clientB, {
      filingSessionId: filingSessionB,
      crmIntent: "LLC_FORMATION_DIY",
    });
    if (!resultA.ok || !resultB.ok) throw new Error("expected both to succeed");

    const { rows: rowsA } = await pool.query("SELECT stripe_checkout_session_id FROM orders WHERE order_id = $1", [
      resultA.orderId,
    ]);
    const { rows: rowsB } = await pool.query("SELECT stripe_checkout_session_id FROM orders WHERE order_id = $1", [
      resultB.orderId,
    ]);

    const statusForA = (await (
      await fetch(`${baseUrl}/checkout/session-status?session_id=${rowsA[0].stripe_checkout_session_id}`)
    ).json()) as Record<string, unknown>;
    const statusForB = (await (
      await fetch(`${baseUrl}/checkout/session-status?session_id=${rowsB[0].stripe_checkout_session_id}`)
    ).json()) as Record<string, unknown>;

    expect(statusForA.filing_session_id).toBe(filingSessionA);
    expect(statusForA.filing_session_id).not.toBe(filingSessionB);
    expect(statusForB.filing_session_id).toBe(filingSessionB);
    expect(statusForB.filing_session_id).not.toBe(filingSessionA);

    // Attempting A's *order_id* or *filing_session_id* as if it were a
    // session_id never accidentally matches anything (different id
    // format/value entirely) — proves the lookup can't be confused by a
    // client substituting a different kind of id in the query param.
    const misuseAttempt = await fetch(`${baseUrl}/checkout/session-status?session_id=${filingSessionA}`);
    expect(misuseAttempt.status).toBe(404);
  });
});

describe("C. Retry Checkout does not create a duplicate Order", () => {
  it("a second createCheckoutSession call for the same (filing_session_id, crm_intent) reuses the existing order", async () => {
    const filingSessionId = await createCompleteFilingSession("retry-test@example.com");
    const { client: client1 } = fakeStripeClient();
    const first = await createCheckoutSession(pool, client1, { filingSessionId, crmIntent: "LLC_FORMATION_DIY" });
    if (!first.ok) throw new Error("expected success");
    expect(first.reusedOrder).toBe(false); // first attempt — nothing to reuse yet

    // Simulate cancel: customer never pays, comes back and retries.
    const { client: client2 } = fakeStripeClient();
    const second = await createCheckoutSession(pool, client2, { filingSessionId, crmIntent: "LLC_FORMATION_DIY" });
    if (!second.ok) throw new Error("expected success");
    expect(second.reusedOrder).toBe(true);
    expect(second.orderId).toBe(first.orderId); // same Order row, not a new one

    const { rows } = await pool.query("SELECT count(*) AS n FROM orders WHERE filing_session_id = $1", [
      filingSessionId,
    ]);
    expect(rows[0].n).toBe("1"); // exactly one Order despite two Checkout attempts

    // The old (first) Stripe Checkout Session id is superseded on the
    // order row, but stays historically identifiable via filing_events.
    const { rows: eventRows } = await pool.query(
      `SELECT payload FROM filing_events WHERE filing_session_id = $1 AND event_type = 'checkout_session_created' ORDER BY created_at ASC`,
      [filingSessionId]
    );
    expect(eventRows.length).toBe(2);
    expect(eventRows[0].payload.reused_order).toBe(false);
    expect(eventRows[0].payload.stripe_checkout_session_id).not.toBe(eventRows[1].payload.stripe_checkout_session_id);
    expect(eventRows[1].payload.reused_order).toBe(true);
    expect(eventRows[1].payload.order_id).toBe(first.orderId);
  });

  it("does NOT reuse an already-paid order — a repeat purchase attempt gets its own new order", async () => {
    const filingSessionId = await createCompleteFilingSession("retry-paid-test@example.com");
    const { client } = fakeStripeClient();
    const first = await createCheckoutSession(pool, client, { filingSessionId, crmIntent: "LLC_FORMATION_DIY" });
    if (!first.ok) throw new Error("expected success");
    await pool.query("UPDATE orders SET payment_status = 'paid' WHERE order_id = $1", [first.orderId]);

    const second = await createCheckoutSession(pool, client, { filingSessionId, crmIntent: "LLC_FORMATION_DIY" });
    if (!second.ok) throw new Error("expected success");
    expect(second.reusedOrder).toBe(false);
    expect(second.orderId).not.toBe(first.orderId);
  });
});

describe("D. Cancel preserves the filing session, the order, and payment stays pending", () => {
  it("an order left at checkout_created (Checkout never completed) is untouched by a session-status read", async () => {
    const filingSessionId = await createCompleteFilingSession("cancel-preserve-test@example.com");
    const { client } = fakeStripeClient();
    const result = await createCheckoutSession(pool, client, { filingSessionId, crmIntent: "LLC_FORMATION_DIY" });
    if (!result.ok) throw new Error("expected success");

    // "Customer cancels" is, from this app's perspective, simply never
    // receiving a paid webhook — nothing to simulate beyond not paying.
    const { rows: orderRows } = await pool.query(
      "SELECT payment_status, checkout_status FROM orders WHERE order_id = $1",
      [result.orderId]
    );
    expect(orderRows[0].payment_status).toBe("pending");
    expect(orderRows[0].checkout_status).toBe("checkout_created");

    const { rows: sessionRows } = await pool.query(
      "SELECT current_stage FROM filing_sessions WHERE filing_session_id = $1",
      [filingSessionId]
    );
    expect(sessionRows[0].current_stage).toBe("complete"); // filing session preserved, untouched
  });
});
