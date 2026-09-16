import "dotenv/config";
import http from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { sessionRouter } from "../src/routes/session.js";

/**
 * Focused tests for the exact request shape LLCFilingIntake.tsx's
 * handleComplete() now sends to POST /api/session/stage (Gate 2, "connect
 * the live funnel to real persistence"). Scenario D (CRM failure after
 * successful persistence must not block the user) is frontend
 * orchestration — a real browser test proved it directly (see
 * GATE2-LIVE-PERSISTENCE-STATUS.md §6): the Worker call was made to fail
 * and the app still reached the success page with the filing session
 * durably persisted. Scenario E (real session -> composer -> PDF) is
 * covered by test/pdf/realSession.integration.test.ts already; this file
 * does not duplicate it.
 */

const createdSessionIds: string[] = [];
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
  if (createdSessionIds.length) {
    await pool.query("DELETE FROM crm_sync_queue WHERE filing_session_id = ANY($1)", [createdSessionIds]);
    await pool.query("DELETE FROM filing_events WHERE filing_session_id = ANY($1)", [createdSessionIds]);
    await pool.query("DELETE FROM filing_sessions WHERE filing_session_id = ANY($1)", [createdSessionIds]);
  }
});

function handleCompletePayload(overrides: Record<string, unknown> = {}) {
  return {
    stage: "complete",
    full_name: "Test Tester",
    entity_name_primary: "Handle Complete Test LLC",
    filing_data: {
      llc_name: "Handle Complete Test LLC",
      principal_street: "1 Test St", principal_city: "Miami", principal_state: "FL", principal_zip: "33101",
      mailing_same: "Yes",
      agent_choice: "damian", agent_name: "Damian Knowles", agent_street: "3850 South University Drive",
      agent_unit: "Unit #291921", agent_city: "Davie", agent_state: "Florida", agent_zip: "33329",
      management_structure: "Manager-Managed", members: [], managers: [
        { name: "A Manager", street: "1 A St", city: "Miami", state: "FL", zip: "33101", article_iv_title: "MGR" },
      ],
      additional_authorized_persons: [],
      effective_date_option: "Immediately",
      other_provisions: "",
    },
    ...overrides,
  };
}

describe("A. Successful frontend/session persistence", () => {
  it("persists the exact handleComplete()-shaped payload and returns a filing_session_id", async () => {
    const res = await fetch(`${baseUrl}/api/session/stage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(handleCompletePayload()),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { filing_session_id: string; current_stage: string };
    createdSessionIds.push(json.filing_session_id);
    expect(json.current_stage).toBe("complete");

    const { rows } = await pool.query(
      "SELECT current_stage, entity_name_primary, filing_data FROM filing_sessions WHERE filing_session_id = $1",
      [json.filing_session_id]
    );
    expect(rows[0].current_stage).toBe("complete");
    expect(rows[0].entity_name_primary).toBe("Handle Complete Test LLC");
    expect(rows[0].filing_data.llc_name).toBe("Handle Complete Test LLC");
    expect(rows[0].filing_data.agent_name).toBe("Damian Knowles");
  });
});

describe("B. Persistence failure", () => {
  it("rejects a request missing the required 'stage' field without creating a row", async () => {
    const before = await pool.query("SELECT count(*) AS n FROM filing_sessions");
    const res = await fetch(`${baseUrl}/api/session/stage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filing_data: { llc_name: "Should Not Persist LLC" } }),
    });
    expect(res.status).toBe(400);
    const after = await pool.query("SELECT count(*) AS n FROM filing_sessions");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe("C. Duplicate completion/submission", () => {
  it("submitting the same handleComplete() payload twice with the reused filing_session_id upserts one row, not two", async () => {
    const first = await fetch(`${baseUrl}/api/session/stage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(handleCompletePayload({ entity_name_primary: "Duplicate Submit Test LLC" })),
    });
    const firstJson = (await first.json()) as { filing_session_id: string };
    createdSessionIds.push(firstJson.filing_session_id);

    // Second "click" — same filing_session_id, same stage, same data,
    // exactly what handleComplete() sends once dataSpineFilingSessionId
    // has been written back to IntakeData from the first response.
    const second = await fetch(`${baseUrl}/api/session/stage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        handleCompletePayload({
          filing_session_id: firstJson.filing_session_id,
          entity_name_primary: "Duplicate Submit Test LLC",
        })
      ),
    });
    const secondJson = (await second.json()) as { filing_session_id: string; stage_changed: boolean };
    expect(secondJson.filing_session_id).toBe(firstJson.filing_session_id);
    expect(secondJson.stage_changed).toBe(false); // already "complete" — recognized as a no-op

    const { rows: sessionRows } = await pool.query(
      "SELECT count(*) AS n FROM filing_sessions WHERE filing_session_id = $1",
      [firstJson.filing_session_id]
    );
    expect(sessionRows[0].n).toBe("1");

    const { rows: eventRows } = await pool.query(
      "SELECT count(*) AS n FROM filing_events WHERE filing_session_id = $1",
      [firstJson.filing_session_id]
    );
    expect(eventRows[0].n).toBe("1"); // one event, not two, despite two "complete" submissions
  });
});
