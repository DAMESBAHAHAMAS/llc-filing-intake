import "dotenv/config";
import { randomUUID } from "node:crypto";
import http from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { processOne, runOnce } from "../src/sync/worker.js";
import { sessionRouter } from "../src/routes/session.js";
import type { ZohoClient } from "../src/zoho/client.js";

/** claimNextJob claims the OLDEST eligible pending row in the whole
 *  table, not "whatever this test just inserted" — so any unrelated
 *  backlog (e.g. earlier manual/curl testing against this same
 *  Supabase instance) would get claimed ahead of a fresh test row and
 *  make these assertions fail against the wrong job. Drain the table
 *  first so each test's own row is guaranteed to be the one claimed. */
const alwaysSucceedClient: ZohoClient = {
  async syncSession() {
    return { ok: true, leadId: "drain" };
  },
  async syncOrderEvent() {
    return { ok: true, leadId: "drain", dealId: "drain" };
  },
  async updateDealStage() {
    return { ok: true, dealId: "drain" };
  },
};
async function drainQueueBacklog() {
  await runOnce(pool, alwaysSucceedClient, "test-drain");
}

/**
 * Gate 1 exit-criterion tests (3, 4, 5 from the task spec). These run
 * against the REAL Supabase instance via DATABASE_URL — not pg-mem —
 * because the thing under test is real transaction/lock behavior
 * (FOR UPDATE SKIP LOCKED, cross-table commits) that pg-mem doesn't
 * faithfully emulate. Every row this file creates is deleted in
 * afterAll via the collected filing_session_id list.
 */

const createdSessionIds: string[] = [];

function testEmail(tag: string): string {
  return `test-gate1-${tag}-${randomUUID()}@example.invalid`;
}

/** A fake ZohoClient whose first N calls fail (401 or a network-style
 *  error with no httpStatus), then succeeds — lets a test simulate
 *  "credential was bad, then got fixed" without real Zoho credentials. */
function makeFlakyClient(failFirstNCalls: number, failureKind: "401" | "timeout"): ZohoClient {
  let calls = 0;
  return {
    async syncSession(_payload) {
      calls++;
      if (calls <= failFirstNCalls) {
        if (failureKind === "401") {
          return { ok: false, httpStatus: 401, error: `simulated 401 (call ${calls})` };
        }
        return { ok: false, error: `simulated timeout / network error (call ${calls})` };
      }
      return { ok: true, leadId: `fake-lead-call-${calls}` };
    },
    async syncOrderEvent(_payload) {
      calls++;
      if (calls <= failFirstNCalls) {
        if (failureKind === "401") {
          return { ok: false, httpStatus: 401, error: `simulated 401 (call ${calls})` };
        }
        return { ok: false, error: `simulated timeout / network error (call ${calls})` };
      }
      return { ok: true, dealId: `fake-deal-call-${calls}` };
    },
    async updateDealStage(_payload) {
      calls++;
      if (calls <= failFirstNCalls) {
        if (failureKind === "401") {
          return { ok: false, httpStatus: 401, error: `simulated 401 (call ${calls})` };
        }
        return { ok: false, error: `simulated timeout / network error (call ${calls})` };
      }
      return { ok: true, dealId: `fake-deal-stage-call-${calls}` };
    },
  };
}

async function insertQueuedSession(email: string) {
  const filingSessionId = randomUUID();
  createdSessionIds.push(filingSessionId);
  await pool.query(
    `INSERT INTO filing_sessions (filing_session_id, current_stage, email)
     VALUES ($1, 'checkout', $2)`,
    [filingSessionId, email]
  );
  const snapshot = (await pool.query("SELECT * FROM filing_sessions WHERE filing_session_id = $1", [filingSessionId]))
    .rows[0];
  await pool.query(
    `INSERT INTO crm_sync_queue (filing_session_id, sync_type, payload_snapshot)
     VALUES ($1, 'session_sync', $2)`,
    [filingSessionId, JSON.stringify(snapshot)]
  );
  return filingSessionId;
}

async function getQueueRow(filingSessionId: string) {
  const res = await pool.query(
    `SELECT status, attempts, last_error, payload_snapshot FROM crm_sync_queue WHERE filing_session_id = $1`,
    [filingSessionId]
  );
  return res.rows[0];
}

async function getSessionRow(filingSessionId: string) {
  const res = await pool.query(
    `SELECT crm_sync_status, crm_lead_id, crm_last_synced_at, current_stage FROM filing_sessions WHERE filing_session_id = $1`,
    [filingSessionId]
  );
  return res.rows[0];
}

/** Simulates backoff time having elapsed, without waiting for real time. */
async function makeJobEligibleNow(filingSessionId: string) {
  await pool.query(
    `UPDATE crm_sync_queue SET run_after = now(), status = 'pending' WHERE filing_session_id = $1 AND status != 'synced'`,
    [filingSessionId]
  );
}

describe("Gate 1 exit criteria (real Supabase)", () => {
  beforeEach(async () => {
    await drainQueueBacklog();
  });

  afterAll(async () => {
    if (createdSessionIds.length > 0) {
      await pool.query(`DELETE FROM crm_sync_queue WHERE filing_session_id = ANY($1)`, [createdSessionIds]);
      await pool.query(`DELETE FROM filing_events WHERE filing_session_id = ANY($1)`, [createdSessionIds]);
      await pool.query(`DELETE FROM filing_sessions WHERE filing_session_id = ANY($1)`, [createdSessionIds]);
    }
    await pool.end();
  });

  it("Test 3: Zoho 401 -> failed + preserved, then retry succeeds after refresh", async () => {
    const email = testEmail("401");
    const filingSessionId = await insertQueuedSession(email);

    // Both the initial call and the one free 401-retry fail.
    const client = makeFlakyClient(2, "401");
    const didWork = await processOne(pool, client, "test-worker-401");
    expect(didWork).toBe(true);

    const afterFailure = await getQueueRow(filingSessionId);
    expect(afterFailure.status).toBe("pending"); // backed off, not dead-lettered
    expect(afterFailure.attempts).toBe(1); // the free 401-retry did NOT count as a 2nd attempt
    expect(afterFailure.last_error).toMatch(/401/);
    expect(afterFailure.payload_snapshot.email).toBe(email); // payload preserved

    const sessionAfterFailure = await getSessionRow(filingSessionId);
    expect(sessionAfterFailure.crm_sync_status).toBe("failed");

    // Simulate the credential being fixed + backoff elapsing, then the
    // worker's next pass picking the job back up.
    await makeJobEligibleNow(filingSessionId);
    const didWorkAgain = await processOne(pool, client, "test-worker-401");
    expect(didWorkAgain).toBe(true);

    const afterRetry = await getQueueRow(filingSessionId);
    expect(afterRetry.status).toBe("synced");
    expect(afterRetry.last_error).toBeNull();

    const sessionAfterRetry = await getSessionRow(filingSessionId);
    expect(sessionAfterRetry.crm_sync_status).toBe("synced");
    expect(sessionAfterRetry.crm_lead_id).toBe("fake-lead-call-3");
    expect(sessionAfterRetry.crm_last_synced_at).not.toBeNull();
  });

  it("Test 4: Zoho timeout -> failed + preserved, then retry succeeds", async () => {
    const email = testEmail("timeout");
    const filingSessionId = await insertQueuedSession(email);

    // A network-style error (no httpStatus) does NOT get a free retry —
    // syncWithOneFreeAuthRetry only special-cases httpStatus===401.
    const client = makeFlakyClient(1, "timeout");
    const didWork = await processOne(pool, client, "test-worker-timeout");
    expect(didWork).toBe(true);

    const afterFailure = await getQueueRow(filingSessionId);
    expect(afterFailure.status).toBe("pending");
    expect(afterFailure.attempts).toBe(1);
    expect(afterFailure.last_error).toMatch(/timeout/);
    expect(afterFailure.payload_snapshot.email).toBe(email);

    const sessionAfterFailure = await getSessionRow(filingSessionId);
    expect(sessionAfterFailure.crm_sync_status).toBe("failed");

    await makeJobEligibleNow(filingSessionId);
    const didWorkAgain = await processOne(pool, client, "test-worker-timeout");
    expect(didWorkAgain).toBe(true);

    const afterRetry = await getQueueRow(filingSessionId);
    expect(afterRetry.status).toBe("synced");

    const sessionAfterRetry = await getSessionRow(filingSessionId);
    expect(sessionAfterRetry.crm_sync_status).toBe("synced");
  });

  describe("Test 5: abandonment leaves all prior data queryable", () => {
    let server: http.Server;
    let baseUrl: string;

    beforeAll(async () => {
      const app = express();
      app.use(express.json());
      app.use(sessionRouter);
      server = app.listen(0);
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("failed to bind test server");
      baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    });

    it("keeps every stage's data after the user abandons mid-funnel", async () => {
      const email = testEmail("abandon");
      let filingSessionId: string | null = null;
      const stages = ["landing", "name_check", "checkout"]; // no "complete" — simulates abandonment

      for (const stage of stages) {
        const body: Record<string, unknown> = { stage };
        if (filingSessionId) body.filing_session_id = filingSessionId;
        if (stage === "name_check") body.entity_name_primary = "Test Ventures LLC";
        if (stage === "checkout") body.email = email;

        const res = await fetch(`${baseUrl}/api/session/stage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(200);
        const json = (await res.json()) as { filing_session_id: string };
        filingSessionId = json.filing_session_id;
      }

      expect(filingSessionId).not.toBeNull();
      createdSessionIds.push(filingSessionId as string);

      // Abandonment itself: no further calls are made. Everything sent
      // so far must still be queryable — nothing gets rolled back or
      // cleaned up just because the funnel wasn't finished.
      const session = await pool.query(
        `SELECT current_stage, email, entity_name_primary FROM filing_sessions WHERE filing_session_id = $1`,
        [filingSessionId]
      );
      expect(session.rowCount).toBe(1);
      expect(session.rows[0].current_stage).toBe("checkout");
      expect(session.rows[0].email).toBe(email);
      expect(session.rows[0].entity_name_primary).toBe("Test Ventures LLC");

      const events = await pool.query(
        `SELECT event_type FROM filing_events WHERE filing_session_id = $1 ORDER BY created_at ASC`,
        [filingSessionId]
      );
      expect(events.rows.map((r) => r.event_type)).toEqual(stages);

      const queue = await pool.query(
        `SELECT status FROM crm_sync_queue WHERE filing_session_id = $1`,
        [filingSessionId]
      );
      // Email only arrived on the final ("checkout") stage call, so
      // exactly one sync job was enqueued — for that stage.
      expect(queue.rowCount).toBe(1);
      expect(queue.rows[0].status).toBe("pending");
    });
  });
});
