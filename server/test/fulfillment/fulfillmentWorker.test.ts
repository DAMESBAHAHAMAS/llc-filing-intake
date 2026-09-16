import "dotenv/config";
import { randomUUID, createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool.js";
import {
  claimNextFulfillmentJob,
  processOneFulfillmentJob,
  reconcileOneTransmission,
  runFulfillmentOnce,
  type FulfillmentDeps,
} from "../../src/fulfillment/fulfillmentWorker.js";
import type { FaxProvider, FaxStatusResult, SendFaxInput, SendFaxResult } from "../../src/fulfillment/faxProvider.js";
import { baseFixture } from "../pdf/fixtures.js";

/**
 * Runs against the real Supabase dev instance, same convention as every
 * other integration test in this directory. The fax provider AND the
 * PDF generator are fake (same injectable-client pattern as
 * checkoutService.test.ts/stripeWebhookService.test.ts) — this codebase
 * has no live Telnyx credentials or reachable PDF_SERVICE_URL in this
 * environment, and the real Telnyx integration was proven separately
 * (see the session's own report). What's under test here is the
 * fulfillment engine itself: claiming, PDF-package assembly, document
 * retention, transmission recording, idempotency, and the retry/backoff/
 * dead-letter state machine — all real code, all real database writes.
 */

const createdSessionIds: string[] = [];

function fakeFaxProvider(overrides?: {
  sendFax?: (input: SendFaxInput) => Promise<SendFaxResult>;
  getFaxStatus?: (id: string) => Promise<FaxStatusResult>;
}): { provider: FaxProvider; sendCalls: SendFaxInput[]; statusCalls: string[] } {
  const sendCalls: SendFaxInput[] = [];
  const statusCalls: string[] = [];
  return {
    sendCalls,
    statusCalls,
    provider: {
      async sendFax(input) {
        sendCalls.push(input);
        return overrides?.sendFax ? overrides.sendFax(input) : { ok: true, providerTransmissionId: `fax_${sendCalls.length}_${randomUUID()}` };
      },
      async getFaxStatus(id) {
        statusCalls.push(id);
        return overrides?.getFaxStatus ? overrides.getFaxStatus(id) : { ok: true, state: "delivered", providerStatus: "delivered" };
      },
    },
  };
}

const fakeGeneratePdf: FulfillmentDeps["generatePdf"] = async (context) =>
  Buffer.from(`FAKE-PDF-BYTES-for-${context.llc_name}`);

function testDeps(overrides: Partial<FulfillmentDeps> = {}): FulfillmentDeps {
  return {
    faxProvider: fakeFaxProvider().provider,
    mediaBaseUrl: "http://localhost:9999",
    destinationNumber: "+15551234567",
    destinationLabel: "Test Destination",
    generatePdf: fakeGeneratePdf,
    ...overrides,
  };
}

async function createOrder(opts: {
  registeredAgentStatus?: string | null;
  fulfillmentStatus?: string;
  fulfillmentAttempts?: number;
  fulfillmentStartedAt?: Date;
  filingData?: Record<string, unknown> | null;
}): Promise<{ filingSessionId: string; orderId: string }> {
  const filingSessionId = randomUUID();
  createdSessionIds.push(filingSessionId);
  const filingData = opts.filingData === undefined ? baseFixture : opts.filingData;
  await pool.query(
    `INSERT INTO filing_sessions (filing_session_id, current_stage, email, filing_data, registered_agent_status)
     VALUES ($1, 'complete', 'fulfillment-test@example.com', $2, $3)`,
    [filingSessionId, filingData, opts.registeredAgentStatus === undefined ? "accepted" : opts.registeredAgentStatus]
  );

  const fulfillmentStatus = opts.fulfillmentStatus ?? "ready";
  const inserted = await pool.query<{ order_id: string }>(
    `INSERT INTO orders (filing_session_id, crm_intent, product, line_items, total_cents, currency, checkout_status, payment_status, fulfillment_status, fulfillment_ready_at, fulfillment_attempts, fulfillment_started_at)
     VALUES ($1, 'LLC_FORMATION_DIY', 'LLC_FORMATION_DIY', '[]', 12900, 'usd', 'checkout_created', 'paid', $2, now(), $3, $4)
     RETURNING order_id`,
    [filingSessionId, fulfillmentStatus, opts.fulfillmentAttempts ?? 0, opts.fulfillmentStartedAt ?? null]
  );
  return { filingSessionId, orderId: inserted.rows[0].order_id };
}

async function getOrder(orderId: string) {
  const { rows } = await pool.query(
    "SELECT fulfillment_status, fulfillment_attempts, fulfillment_last_error, fulfillment_run_after, fulfillment_completed_at FROM orders WHERE order_id = $1",
    [orderId]
  );
  return rows[0];
}

async function getTransmissions(orderId: string) {
  const { rows } = await pool.query(
    "SELECT * FROM fulfillment_transmissions WHERE order_id = $1 ORDER BY attempt_number ASC",
    [orderId]
  );
  return rows;
}

/**
 * Cleaned up after EVERY test, not just at the end — this worker's claim
 * queries are deliberately global (whatever's oldest/eligible across ALL
 * orders, exactly as production must behave), so a 'ready'-and-eligible
 * or 'submitted' row left behind by one test would otherwise be picked
 * up by an unrelated later test's single claim/reconcile call, silently
 * testing the wrong row.
 */
afterEach(async () => {
  if (createdSessionIds.length) {
    await pool.query(
      "DELETE FROM fulfillment_transmissions WHERE order_id IN (SELECT order_id FROM orders WHERE filing_session_id = ANY($1))",
      [createdSessionIds]
    );
    await pool.query("DELETE FROM filing_documents WHERE filing_session_id = ANY($1)", [createdSessionIds]);
    await pool.query("DELETE FROM orders WHERE filing_session_id = ANY($1)", [createdSessionIds]);
    await pool.query("DELETE FROM filing_events WHERE filing_session_id = ANY($1)", [createdSessionIds]);
    await pool.query("DELETE FROM filing_sessions WHERE filing_session_id = ANY($1)", [createdSessionIds]);
    createdSessionIds.length = 0;
  }
});

describe("A. Happy path: ready + registered agent accepted -> generated, retained, transmitted", () => {
  it("generates the PDF, retains it, submits the fax, and records everything", async () => {
    const { filingSessionId, orderId } = await createOrder({});
    const fax = fakeFaxProvider();
    const deps = testDeps({ faxProvider: fax.provider });

    const claimedSomething = await processOneFulfillmentJob(pool, deps);
    expect(claimedSomething).toBe(true);

    expect(fax.sendCalls).toHaveLength(1);
    expect(fax.sendCalls[0].toNumber).toBe("+15551234567");
    expect(fax.sendCalls[0].mediaUrl).toMatch(/^http:\/\/localhost:9999\/api\/fax-media\/.+/);

    const order = await getOrder(orderId);
    expect(order.fulfillment_status).toBe("in_progress"); // awaiting reconciliation
    expect(order.fulfillment_attempts).toBe(1);

    const transmissions = await getTransmissions(orderId);
    expect(transmissions).toHaveLength(1);
    expect(transmissions[0].attempt_number).toBe(1);
    expect(transmissions[0].status).toBe("submitted");
    expect(transmissions[0].destination_type).toBe("fax");
    expect(transmissions[0].destination_value).toBe("+15551234567");
    expect(transmissions[0].destination_label).toBe("Test Destination");
    expect(transmissions[0].provider).toBe("telnyx");
    expect(transmissions[0].provider_transmission_id).toBeTruthy();
    expect(transmissions[0].document_id).not.toBeNull();
    expect(transmissions[0].media_access_token_id).toBeTruthy();

    const { rows: docRows } = await pool.query("SELECT * FROM filing_documents WHERE id = $1", [
      transmissions[0].document_id,
    ]);
    expect(docRows).toHaveLength(1);
    expect(docRows[0].filing_session_id).toBe(filingSessionId);
    expect(docRows[0].order_id).toBe(orderId);
    expect(Buffer.from(docRows[0].pdf_bytes).toString()).toBe(`FAKE-PDF-BYTES-for-${baseFixture.llc_name}`);
    expect(docRows[0].sha256).toBe(
      createHash("sha256").update(Buffer.from(`FAKE-PDF-BYTES-for-${baseFixture.llc_name}`)).digest("hex")
    );

    const { rows: eventRows } = await pool.query(
      "SELECT event_type FROM filing_events WHERE filing_session_id = $1 AND event_type = 'fulfillment_transmission_submitted'",
      [filingSessionId]
    );
    expect(eventRows).toHaveLength(1);
  }, 15000);
});

describe("B. Not eligible: registered agent not yet accepted -> not claimed, no attempt made", () => {
  it.each(["pending", "acceptance_requested", "declined", "expired", "email_failed", null])(
    "skips an order whose registered_agent_status is %s",
    async (status) => {
      const { orderId } = await createOrder({ registeredAgentStatus: status });
      const fax = fakeFaxProvider();
      const claimed = await processOneFulfillmentJob(pool, testDeps({ faxProvider: fax.provider }));
      expect(claimed).toBe(false);
      expect(fax.sendCalls).toHaveLength(0);

      const order = await getOrder(orderId);
      expect(order.fulfillment_status).toBe("ready"); // untouched
      const transmissions = await getTransmissions(orderId);
      expect(transmissions).toHaveLength(0);
    }
  );
});

describe("C. Reconciliation: delivered -> orders.fulfillment_status = 'transmitted'", () => {
  it("marks the transmission delivered and the order transmitted", async () => {
    const { filingSessionId, orderId } = await createOrder({});
    const fax = fakeFaxProvider({ getFaxStatus: async () => ({ ok: true, state: "delivered", providerStatus: "delivered" }) });
    const deps = testDeps({ faxProvider: fax.provider });

    await processOneFulfillmentJob(pool, deps);
    const reconciled = await reconcileOneTransmission(pool, deps);
    expect(reconciled).toBe(true);

    const order = await getOrder(orderId);
    expect(order.fulfillment_status).toBe("transmitted");
    expect(order.fulfillment_completed_at).not.toBeNull();

    const transmissions = await getTransmissions(orderId);
    expect(transmissions[0].status).toBe("delivered");
    expect(transmissions[0].completed_at).not.toBeNull();

    const { rows: eventRows } = await pool.query(
      "SELECT event_type FROM filing_events WHERE filing_session_id = $1 AND event_type = 'fulfillment_transmitted'",
      [filingSessionId]
    );
    expect(eventRows).toHaveLength(1);
  }, 15000);
});

describe("D. Reconciliation: failed, under the attempt ceiling -> retried with backoff", () => {
  it("re-queues the order as 'ready' with fulfillment_run_after set, and increments attempts", async () => {
    const { orderId } = await createOrder({});
    const fax = fakeFaxProvider({ getFaxStatus: async () => ({ ok: true, state: "failed", providerStatus: "failed", failureReason: "no answer" }) });
    const deps = testDeps({ faxProvider: fax.provider, maxAttempts: 6 });

    await processOneFulfillmentJob(pool, deps);
    await reconcileOneTransmission(pool, deps);

    const order = await getOrder(orderId);
    expect(order.fulfillment_status).toBe("ready");
    expect(order.fulfillment_attempts).toBe(1);
    expect(order.fulfillment_last_error).toMatch(/no answer/);
    expect(order.fulfillment_run_after).not.toBeNull();
    expect(new Date(order.fulfillment_run_after).getTime()).toBeGreaterThan(Date.now());

    const transmissions = await getTransmissions(orderId);
    expect(transmissions[0].status).toBe("failed");
    expect(transmissions[0].failure_reason).toMatch(/no answer/);

    // The retry is NOT eligible again immediately (run_after is in the
    // future) — a fresh tick must not re-claim it right away.
    const claimedAgain = await processOneFulfillmentJob(pool, deps);
    expect(claimedAgain).toBe(false);
  }, 15000);
});

describe("E. Dead-letter: failure at the attempt ceiling -> requires_review", () => {
  it("moves the order to requires_review instead of scheduling another retry", async () => {
    const { filingSessionId, orderId } = await createOrder({ fulfillmentAttempts: 4 }); // 5th attempt will be the last (maxAttempts=5)
    const fax = fakeFaxProvider({ getFaxStatus: async () => ({ ok: true, state: "failed", providerStatus: "failed", failureReason: "busy" }) });
    const deps = testDeps({ faxProvider: fax.provider, maxAttempts: 5 });

    await processOneFulfillmentJob(pool, deps);
    await reconcileOneTransmission(pool, deps);

    const order = await getOrder(orderId);
    expect(order.fulfillment_status).toBe("requires_review");
    expect(order.fulfillment_attempts).toBe(5);

    const { rows: eventRows } = await pool.query(
      "SELECT event_type FROM filing_events WHERE filing_session_id = $1 AND event_type = 'fulfillment_requires_review'",
      [filingSessionId]
    );
    expect(eventRows).toHaveLength(1);

    // requires_review is terminal — not re-claimed by a fresh tick.
    const claimedAgain = await processOneFulfillmentJob(pool, deps);
    expect(claimedAgain).toBe(false);
  }, 15000);
});

describe("F. PDF generation failure: recorded with no document, still retryable", () => {
  it("creates a failed transmission row with no document_id and retries the order", async () => {
    const { orderId } = await createOrder({});
    const failingGenerate: FulfillmentDeps["generatePdf"] = async () => {
      throw new Error("PDF service unreachable");
    };
    const fax = fakeFaxProvider();
    const deps = testDeps({ faxProvider: fax.provider, generatePdf: failingGenerate });

    await processOneFulfillmentJob(pool, deps);
    expect(fax.sendCalls).toHaveLength(0); // never reached the send step

    const transmissions = await getTransmissions(orderId);
    expect(transmissions).toHaveLength(1);
    expect(transmissions[0].status).toBe("failed");
    expect(transmissions[0].document_id).toBeNull();
    expect(transmissions[0].failure_reason).toMatch(/PDF generation failed/);

    const order = await getOrder(orderId);
    expect(order.fulfillment_status).toBe("ready"); // retryable, not dead-lettered yet
  }, 15000);
});

describe("G. Idempotency: concurrent/duplicate claims cannot double-process the same order", () => {
  it("a second claim attempt immediately after the first finds nothing (already in_progress)", async () => {
    await createOrder({});
    const claimed1 = await claimNextFulfillmentJob(pool);
    expect(claimed1).not.toBeNull();
    const claimed2 = await claimNextFulfillmentJob(pool);
    expect(claimed2).toBeNull(); // not stale yet — correctly not reclaimed
  }, 15000);

  it("UNIQUE(order_id, attempt_number) rejects a duplicate row for the same attempt", async () => {
    const { orderId, filingSessionId } = await createOrder({});
    await pool.query(
      `INSERT INTO fulfillment_transmissions (order_id, filing_session_id, attempt_number, destination_value)
       VALUES ($1, $2, 1, '+15551234567')`,
      [orderId, filingSessionId]
    );
    await expect(
      pool.query(
        `INSERT INTO fulfillment_transmissions (order_id, filing_session_id, attempt_number, destination_value)
         VALUES ($1, $2, 1, '+15551234567')`,
        [orderId, filingSessionId]
      )
    ).rejects.toThrow(/duplicate key value|unique constraint/i);
  }, 15000);
});

describe("H. Stale in_progress reclaim: a stuck order is picked up again as a new attempt", () => {
  it("reclaims an order whose fulfillment_started_at is older than the stale-claim timeout", async () => {
    const staleStart = new Date(Date.now() - 60_000); // 60s ago
    const { orderId } = await createOrder({ fulfillmentStatus: "in_progress", fulfillmentStartedAt: staleStart, fulfillmentAttempts: 1 });

    const notYetStale = await claimNextFulfillmentJob(pool, 10 * 60_000); // 10 min timeout — not stale yet
    expect(notYetStale).toBeNull();

    const nowStale = await claimNextFulfillmentJob(pool, 1_000); // 1s timeout — definitely stale
    expect(nowStale).not.toBeNull();
    expect(nowStale?.order_id).toBe(orderId);
    expect(nowStale?.fulfillment_attempts).toBe(1); // next attempt will be #2
  }, 15000);
});

describe("I. runFulfillmentOnce: drains both submission and reconciliation queues", () => {
  it("processes a ready order through to a terminal transmitted state in one call", async () => {
    const { orderId } = await createOrder({});
    const deps = testDeps(); // default fake fax provider reports delivered on status check

    const result = await runFulfillmentOnce(pool, deps);
    expect(result.submitted).toBe(1);
    expect(result.reconciled).toBe(1);

    const order = await getOrder(orderId);
    expect(order.fulfillment_status).toBe("transmitted");
  }, 15000);
});
