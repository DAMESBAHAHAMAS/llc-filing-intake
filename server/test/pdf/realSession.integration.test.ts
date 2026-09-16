import "dotenv/config";
import http from "node:http";
import { writeFileSync } from "node:fs";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool.js";
import { sessionRouter } from "../../src/routes/session.js";
import { filingSessionRecordFromRow } from "../../src/pdf/fromFilingSessionRow.js";
import { composeArticlesOfOrganizationContext } from "../../src/pdf/composeArticlesOfOrganizationContext.js";
import type { FilingSessionRecord } from "../../src/pdf/types.js";

/**
 * The "critical proof" from the Gate-2 real-data task: not a fixture
 * fed straight to the composer, but real data going through the actual
 * write path (POST /api/session/stage -> filing_sessions.filing_data,
 * migration 0004), a real read back out (a plain SELECT — session.ts has
 * no GET route to retrieve a session by id, so this test reads the row
 * directly via `pool`, the same way syncWorker.integration.test.ts's own
 * assertions already do), and only THEN into the composer. Runs against
 * the real Supabase instance, same as the other integration test in this
 * directory — every row this file creates is deleted in afterAll.
 *
 * Deliberately no `email` on any of these POSTs: session.ts only enqueues
 * a crm_sync_queue row when a stage change coincides with an email being
 * present, and that queue is real, shared state that syncWorker's own
 * integration test file also claims from by "oldest pending row" — with
 * Vitest running test files concurrently, an email here would race that
 * file's own claim-logic assertions. This test has nothing to prove about
 * CRM sync, so it simply doesn't trigger it.
 */

/** The same shape LLCFilingIntake.tsx's handleComplete() submits, reduced
 *  to what filing_data needs to carry (see types.ts). Deliberately
 *  includes 5 authorized persons — 2 primary managers + 3 overflow,
 *  mixed MGR/AMBR — the exact case that proves article_iv_title survives
 *  a real database round-trip, not just an in-memory object. */
function buildRealisticFilingData(): FilingSessionRecord {
  return {
    llc_name: "Real Session Ventures LLC",

    principal_street: "400 S Andrews Ave",
    principal_city: "Fort Lauderdale",
    principal_state: "FL",
    principal_zip: "33301",
    principal_country: "United States",

    mailing_same: "No",
    mailing_street: "PO Box 9876",
    mailing_city: "Orlando",
    mailing_state: "FL",
    mailing_zip: "32801",
    mailing_country: "United States",

    agent_choice: "damian",
    agent_name: "Damian Knowles",
    agent_street: "3850 South University Drive",
    agent_unit: "Unit #291921",
    agent_city: "Davie",
    agent_state: "Florida",
    agent_zip: "33329",

    management_structure: "Manager-Managed",
    members: [],
    managers: [
      { name: "Real Manager A", street: "1 A St", city: "Miami", state: "FL", zip: "33101", article_iv_title: "MGR" },
      { name: "Real Manager B", street: "2 B St", city: "Miami", state: "FL", zip: "33101", article_iv_title: "MGR" },
    ],
    additional_authorized_persons: [
      { name: "Real Overflow C", street: "3 C St", city: "Miami", state: "FL", zip: "33101", article_iv_title: "MGR" },
      { name: "Real Overflow D", street: "4 D St", city: "Miami", state: "FL", zip: "33101", article_iv_title: "AMBR" },
      { name: "Real Overflow E", street: "5 E St", city: "Miami", state: "FL", zip: "33101", article_iv_title: "MGR" },
    ],

    effective_date_option: "Future Date",
    effective_date: "2026-11-01",

    other_provisions: "The Company's fiscal year shall end on December 31.",

    signer_name: "Damian Knowles",
    representative_role: "Organizer",
  };
}

describe("Real filing session -> PDF context (not a fixture)", () => {
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
      // Order matters: both tables FK-reference filing_sessions.
      // "complete" with an email present enqueues a crm_sync_queue row
      // (session.ts) — skipping this delete leaves a stray "pending" row
      // that a real sync-worker run would later claim, on top of failing
      // the filing_sessions delete outright via the FK constraint.
      await pool.query(`DELETE FROM crm_sync_queue WHERE filing_session_id = ANY($1)`, [createdSessionIds]);
      await pool.query(`DELETE FROM filing_events WHERE filing_session_id = ANY($1)`, [createdSessionIds]);
      await pool.query(`DELETE FROM filing_sessions WHERE filing_session_id = ANY($1)`, [createdSessionIds]);
    }
  });

  it("persists via the real POST /api/session/stage path, reads back, composes, and matches", async () => {
    const filingData = buildRealisticFilingData();

    // 1 & 2: construct + persist through the ACTUAL session mechanism —
    // the same endpoint the frontend calls, not a direct INSERT.
    const res = await fetch(`${baseUrl}/api/session/stage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stage: "complete",
        full_name: "Damian Knowles",
        filing_data: filingData,
      }),
    });
    expect(res.status).toBe(200);
    const { filing_session_id: filingSessionId } = (await res.json()) as { filing_session_id: string };
    createdSessionIds.push(filingSessionId);

    // 3: retrieve the session — a real SELECT against the real row this
    // POST just created (session.ts has no GET-by-id route; reading the
    // row directly is the retrieval step here).
    const { rows } = await pool.query<{ filing_session_id: string; filing_data: unknown; current_stage: string }>(
      "SELECT filing_session_id, filing_data, current_stage FROM filing_sessions WHERE filing_session_id = $1",
      [filingSessionId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].current_stage).toBe("complete");
    // Round-tripped through jsonb — proves pg's automatic serialization
    // handles this column the same way it already does name_check_results.
    expect(rows[0].filing_data).toMatchObject({ llc_name: "Real Session Ventures LLC" });

    // 4: through the adapter, then the UNMODIFIED existing composer.
    const record = filingSessionRecordFromRow(rows[0]);
    const context = composeArticlesOfOrganizationContext(record);

    // Assertions on real, round-tripped data.
    expect(context.llc_name).toBe("Real Session Ventures LLC");
    expect(context.principal_address).toBe("400 S Andrews Ave, Fort Lauderdale, FL 33301");
    expect(context.mailing_address).toBe("PO Box 9876, Orlando, FL 32801");
    expect(context.registered_agent_name).toBe("Damian Knowles");
    expect(context.registered_agent_florida_address).toBe(
      "3850 South University Drive, Unit #291921, Davie, Florida 33329"
    );
    expect(context.authorized_persons).toHaveLength(5);
    // The core proof: person 5 (index 4, the continuation-page entry)
    // survived a real database round-trip with the correct role.
    expect(context.authorized_persons[4]).toMatchObject({ name: "Real Overflow E", article_iv_title: "MGR" });
    expect(context.authorized_persons[3]).toMatchObject({ name: "Real Overflow D", article_iv_title: "AMBR" });
    expect(context.effective_date_option).toBe("Future");
    expect(context.effective_date).toBe("2026-11-01");
    expect(context.annual_report_due_date).toBe("May 1, 2027");
    expect(context.other_provisions).toBe("The Company's fiscal year shall end on December 31.");

    // Hand this real-session-derived context to the same Jinja2/WeasyPrint
    // smoke check used for the fixture-only proof in the prior session —
    // this file can prove persistence + retrieval + composition against
    // the real database; it cannot invoke Python's Jinja2/WeasyPrint
    // itself. Writing the composed context here is what makes that
    // external check exercise REAL session output instead of a fixture.
    const outPath =
      "/private/tmp/claude-501/-Users-damianknowles-florida-business-launchpad/3e4fb099-ea8f-466d-88b2-00e6a54609f6/scratchpad/realSessionContext.json";
    writeFileSync(outPath, JSON.stringify({ real_session: context }, null, 2));
  }, 20_000);

  it("throws via the adapter, not a fabricated PDF, when filing_data is absent", async () => {
    const res = await fetch(`${baseUrl}/api/session/stage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "landing" }),
    });
    const { filing_session_id: filingSessionId } = (await res.json()) as { filing_session_id: string };
    createdSessionIds.push(filingSessionId);

    const { rows } = await pool.query("SELECT filing_session_id, filing_data FROM filing_sessions WHERE filing_session_id = $1", [
      filingSessionId,
    ]);
    expect(() => filingSessionRecordFromRow(rows[0])).toThrow(/has no filing_data/);
  });
});
