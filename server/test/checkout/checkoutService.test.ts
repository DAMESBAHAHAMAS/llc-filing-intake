import "dotenv/config";
import { randomUUID } from "node:crypto";
import http from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool.js";
import { sessionRouter } from "../../src/routes/session.js";
import { checkoutRouter } from "../../src/routes/checkout.js";
import { createCheckoutSession, OFFER_LINE_ITEMS } from "../../src/checkout/checkoutService.js";
import type {
  CreateCheckoutSessionInput,
  CreateCheckoutSessionResult,
  StripeCheckoutClient,
} from "../../src/checkout/stripeCheckoutClient.js";

/**
 * Runs against the real Supabase dev instance, same convention as every
 * other integration test in this directory (see
 * test/registeredAgent/acceptanceService.test.ts's file comment). No
 * real Stripe API call is made — a fake StripeCheckoutClient is injected
 * per test (same fake-injection pattern already used for ZohoClient and
 * EmailSender), since this environment has no STRIPE_SECRET_KEY
 * configured. The real Stripe-side behavior (these exact Price IDs,
 * amounts, test-mode-ness) was verified separately via the Stripe MCP —
 * see GATE2-CHECKOUT-INTEGRATION-STATUS.md §6.
 */

const createdSessionIds: string[] = [];

function fakeStripeClient(
  impl: (input: CreateCheckoutSessionInput) => Promise<CreateCheckoutSessionResult>
): { client: StripeCheckoutClient; calls: CreateCheckoutSessionInput[] } {
  const calls: CreateCheckoutSessionInput[] = [];
  return {
    calls,
    client: {
      async createCheckoutSession(input) {
        calls.push(input);
        return impl(input);
      },
      // Not exercised by this file's tests — checkout creation only.
      // See test/webhook/stripeWebhookService.test.ts for
      // retrieveCheckoutSession coverage.
      async retrieveCheckoutSession() {
        throw new Error("retrieveCheckoutSession not faked in this test file");
      },
    },
  };
}

const alwaysSucceedStripe = () =>
  fakeStripeClient(async () => ({ id: `cs_test_fake_${randomUUID()}`, url: "https://checkout.stripe.com/fake" }));

async function createFilingSession(stage: string): Promise<string> {
  const filingSessionId = randomUUID();
  createdSessionIds.push(filingSessionId);
  await pool.query(
    `INSERT INTO filing_sessions (filing_session_id, current_stage, email, filing_data)
     VALUES ($1, $2, 'test@example.com', $3)`,
    [filingSessionId, stage, { llc_name: "Checkout Integration Test LLC" }]
  );
  return filingSessionId;
}

afterAll(async () => {
  if (createdSessionIds.length) {
    await pool.query("DELETE FROM orders WHERE filing_session_id = ANY($1)", [createdSessionIds]);
    await pool.query("DELETE FROM crm_sync_queue WHERE filing_session_id = ANY($1)", [createdSessionIds]);
    await pool.query("DELETE FROM filing_events WHERE filing_session_id = ANY($1)", [createdSessionIds]);
    await pool.query("DELETE FROM filing_sessions WHERE filing_session_id = ANY($1)", [createdSessionIds]);
  }
});

describe("A. Gate: current_stage must be 'complete'", () => {
  it("blocks checkout and creates no order when the session is not yet complete", async () => {
    const filingSessionId = await createFilingSession("authorized_persons");
    const { client } = alwaysSucceedStripe();

    const result = await createCheckoutSession(pool, client, {
      filingSessionId,
      crmIntent: "LLC_FORMATION_DIY",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("stage_not_complete");

    const { rows } = await pool.query("SELECT count(*) AS n FROM orders WHERE filing_session_id = $1", [
      filingSessionId,
    ]);
    expect(rows[0].n).toBe("0");
  });

  it("returns session_not_ready for an unknown filing_session_id, creates no order", async () => {
    const { client } = alwaysSucceedStripe();
    const result = await createCheckoutSession(pool, client, {
      filingSessionId: randomUUID(),
      crmIntent: "LLC_FORMATION_DIY",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("session_not_ready");
  });
});

describe("B. crm_intent validation — server-authoritative pricing", () => {
  it("rejects an unrecognized crm_intent before touching the database", async () => {
    const filingSessionId = await createFilingSession("complete");
    const { client, calls } = alwaysSucceedStripe();

    const result = await createCheckoutSession(pool, client, {
      filingSessionId,
      crmIntent: "NOT_A_REAL_OFFER",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown_crm_intent");
    expect(calls.length).toBe(0);

    const { rows } = await pool.query("SELECT count(*) AS n FROM orders WHERE filing_session_id = $1", [
      filingSessionId,
    ]);
    expect(rows[0].n).toBe("0");
  });
});

describe("C. Happy path: persistence -> complete stage -> order -> Stripe Checkout", () => {
  it("creates a $125 + $4 = $129 order for LLC_FORMATION_DIY and a Checkout Session, never trusting a client-supplied amount", async () => {
    const filingSessionId = await createFilingSession("complete");
    const { client, calls } = alwaysSucceedStripe();

    // A client-supplied amount field, if it existed, would be ignored —
    // createCheckoutSession's input type doesn't even accept one.
    const result = await createCheckoutSession(pool, client, {
      filingSessionId,
      crmIntent: "LLC_FORMATION_DIY",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.checkoutUrl).toBe("https://checkout.stripe.com/fake");

    // Stripe was called with exactly this service's own price table —
    // the two current (non-archived) DIY Price IDs, $125 + $4.
    expect(calls[0].lineItems).toEqual([
      { price: OFFER_LINE_ITEMS.LLC_FORMATION_DIY[0].price, quantity: 1 },
      { price: OFFER_LINE_ITEMS.LLC_FORMATION_DIY[1].price, quantity: 1 },
    ]);
    expect(calls[0].lineItems[0].price).not.toBe("price_1U8afzDo01bXdbWSpjBCA0jn"); // archived $129 Price

    const { rows } = await pool.query("SELECT * FROM orders WHERE order_id = $1", [result.orderId]);
    const order = rows[0];
    expect(order.filing_session_id).toBe(filingSessionId);
    expect(order.crm_intent).toBe("LLC_FORMATION_DIY");
    expect(order.currency).toBe("usd");
    expect(order.checkout_status).toBe("checkout_created");
    expect(order.stripe_checkout_session_id).toMatch(/^cs_test_fake_/);
    expect(order.total_cents).toBe(12900);
    expect(order.line_items).toEqual([
      { price: OFFER_LINE_ITEMS.LLC_FORMATION_DIY[0].price, label: "Florida LLC Filing", quantity: 1, amount_cents: 12500 },
      { price: OFFER_LINE_ITEMS.LLC_FORMATION_DIY[1].price, label: "Service Fee", quantity: 1, amount_cents: 400 },
    ]);
  });
});

describe("D. Stripe failure: order and filing session are preserved, not deleted", () => {
  it("marks the order checkout_failed and returns its id, without deleting anything", async () => {
    const filingSessionId = await createFilingSession("complete");
    const { client } = fakeStripeClient(async () => {
      throw new Error("simulated Stripe outage");
    });

    const result = await createCheckoutSession(pool, client, {
      filingSessionId,
      crmIntent: "LLC_FORMATION_DIY",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("stripe_failed");
    expect(result.orderId).toBeTruthy();

    const { rows: orderRows } = await pool.query("SELECT checkout_status, failure_reason FROM orders WHERE order_id = $1", [
      result.orderId,
    ]);
    expect(orderRows[0].checkout_status).toBe("checkout_failed");
    expect(orderRows[0].failure_reason).toContain("simulated Stripe outage");

    const { rows: sessionRows } = await pool.query(
      "SELECT current_stage FROM filing_sessions WHERE filing_session_id = $1",
      [filingSessionId]
    );
    expect(sessionRows[0].current_stage).toBe("complete"); // untouched
  });
});

describe("E. Real HTTP sequence: POST /api/session/stage then POST /checkout/session", () => {
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
  });

  it("rejects checkout with 409 before intake completes, then succeeds once it does", async () => {
    // ── Real customer intake: mint a session, but not yet 'complete' ──
    const stageRes = await fetch(`${baseUrl}/api/session/stage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "signature", email: "gate2-http-test@example.com" }),
    });
    const stageJson = (await stageRes.json()) as { filing_session_id: string };
    createdSessionIds.push(stageJson.filing_session_id);

    // Checkout attempted too early — gate must reject it. This request
    // has no working STRIPE_SECRET_KEY in this environment, so a 200
    // here would only be possible if the gate were bypassed.
    const earlyCheckout = await fetch(`${baseUrl}/checkout/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filing_session_id: stageJson.filing_session_id, crm_intent: "LLC_FORMATION_DIY" }),
    });
    expect(earlyCheckout.status).toBe(409);

    // ── Intake actually completes ──
    const completeRes = await fetch(`${baseUrl}/api/session/stage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filing_session_id: stageJson.filing_session_id,
        stage: "complete",
        email: "gate2-http-test@example.com",
      }),
    });
    expect(completeRes.status).toBe(200);

    const { rows } = await pool.query(
      "SELECT current_stage FROM filing_sessions WHERE filing_session_id = $1",
      [stageJson.filing_session_id]
    );
    expect(rows[0].current_stage).toBe("complete");

    // Checkout gate now passes — order persistence succeeds — and the
    // only remaining failure is the real Stripe call itself, which is
    // expected to fail clearly with 502 in this environment (no
    // STRIPE_SECRET_KEY configured, per this test run's .env), NOT with
    // a silent success and NOT by ever letting the gate check pass
    // incorrectly. If STRIPE_SECRET_KEY is set (e.g. CI with a real
    // test-mode key), 200 is the expected outcome instead.
    const checkoutRes = await fetch(`${baseUrl}/checkout/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filing_session_id: stageJson.filing_session_id, crm_intent: "LLC_FORMATION_DIY" }),
    });
    expect([200, 502]).toContain(checkoutRes.status);
    expect(checkoutRes.status).not.toBe(409);

    // Either way, an order row now exists for this session — created
    // before Stripe was ever called.
    const { rows: orderRows } = await pool.query(
      "SELECT checkout_status, total_cents FROM orders WHERE filing_session_id = $1",
      [stageJson.filing_session_id]
    );
    expect(orderRows.length).toBe(1);
    expect(orderRows[0].total_cents).toBe(12900);
  });
});
