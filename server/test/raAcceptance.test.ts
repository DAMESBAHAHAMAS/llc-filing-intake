import { newDb } from "pg-mem";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAcceptanceRecord,
  checkSignature,
  cleanSignatureName,
  queueRaDealStatus,
  RA_ACCEPTANCE_STATEMENT,
  RA_DEAL_SYNC_TYPE,
  RA_STATUS_ACCEPTED,
  raDealFields,
  tokenRef,
} from "../src/registeredAgent/acceptanceRecord.js";
import { buildAcceptanceStatementContext, floridaDateTime, registeredAgentSignatureForArticles } from "../src/registeredAgent/acceptanceStatement.js";
import { buildPdfContext } from "../src/pdf/context.js";
import { realZohoClient, resetZohoTokenCache } from "../src/zoho/client.js";

const fd = {
  llc_name: "Test Dispatch Twelve LLC",
  principal_address: "100 S Biscayne Blvd, Suite 300, Miami, FL, 33131",
  mailing_address: "100 S Biscayne Blvd, Suite 300, Miami, FL, 33131",
  registered_agent_path: "customer",
  registered_agent_name: "Riley Test Agent",
  registered_agent_florida_address: "1 SE 3rd Ave, Suite 1500, Miami, FL 33131",
  authorized_persons: [{ article_iv_title: "AR", name: "Jordan Test Rivera", address: "x" }],
  effective_date_option: "Immediate",
};
const at = new Date("2026-11-25T15:31:00Z");

describe("checkSignature (T144 D12)", () => {
  it("accepts a button-only answer while the signature is not required", () => {
    expect(checkSignature({ token: "t" }, {})).toEqual({ ok: true, signatureName: null });
  });
  it("requires the typed name once RA_ACCEPT_REQUIRE_SIGNATURE=true", () => {
    expect(checkSignature({ token: "t" }, { RA_ACCEPT_REQUIRE_SIGNATURE: "true" })).toMatchObject({ ok: false, status: 400 });
  });
  it("needs consent with a typed name", () => {
    expect(checkSignature({ signature_name: "Riley Test Agent" }, {})).toMatchObject({ ok: false });
    expect(checkSignature({ signature_name: "  Riley   Test Agent ", consent: true }, {})).toEqual({ ok: true, signatureName: "Riley Test Agent" });
  });
  it("refuses names that are not a name", () => {
    expect(cleanSignatureName("x")).toBeNull();
    expect(cleanSignatureName("12345")).toBeNull();
    expect(cleanSignatureName("a".repeat(121))).toBeNull();
    expect(cleanSignatureName("José\u0007 Núñez")).toBe("José Núñez");
  });
});

describe("acceptance record and statement", () => {
  const rec = buildAcceptanceRecord({ signatureName: "Riley Test Agent", filingData: fd, acceptedAt: at, ip: "203.0.113.9", userAgent: "UA", token: "secret-token" });

  it("records what was signed, when, from where, without the token itself", () => {
    expect(rec).toMatchObject({
      method: "typed_signature", signature_name: "Riley Test Agent", registered_agent_name: "Riley Test Agent",
      llc_name: "Test Dispatch Twelve LLC", accepted_at: "2026-11-25T15:31:00.000Z", ip: "203.0.113.9",
      statement_text: RA_ACCEPTANCE_STATEMENT, token_ref: tokenRef("secret-token"),
    });
    expect(JSON.stringify(rec)).not.toContain("secret-token");
  });

  it("builds the statement context", () => {
    const r = buildAcceptanceStatementContext({ ...fd, registered_agent_acceptance: rec });
    expect(r.ok && r.context).toMatchObject({
      llc_name: "TEST DISPATCH TWELVE LLC", signature_name: "Riley Test Agent", ip: "203.0.113.9",
      accepted_at_display: "November 25, 2026 at 10:31 AM EST",
    });
  });

  it("has no statement for a button-only acceptance", () => {
    const button = buildAcceptanceRecord({ signatureName: null, filingData: fd, acceptedAt: at, ip: null, userAgent: undefined, token: "t" });
    const r = buildAcceptanceStatementContext({ ...fd, registered_agent_acceptance: button });
    expect(r.ok).toBe(false);
    expect(registeredAgentSignatureForArticles({ registered_agent_acceptance: button })).toBeNull();
  });

  it("prints the agent's signature in Article III of the Articles for an own agent only", () => {
    const signed = buildPdfContext({ ...fd, registered_agent_acceptance: rec } as never, "accepted");
    expect(signed.ok && signed.context.registered_agent_signature).toEqual({ name: "Riley Test Agent", date: "November 25, 2026" });
    const house = buildPdfContext({ ...fd, registered_agent_path: "house", registered_agent_acceptance: rec } as never, null);
    expect(house.ok && house.context.registered_agent_signature).toBeNull();
  });

  it("formats Florida time", () => {
    expect(floridaDateTime("2026-07-01T16:05:00Z")).toBe("July 1, 2026 at 12:05 PM EDT");
  });
});

describe("Zoho Deal status (switched off by default)", () => {
  it("is off until RA_DEAL_STATUS_FIELD names a field", () => {
    expect(raDealFields(RA_STATUS_ACCEPTED, at, {})).toBeNull();
    expect(raDealFields(RA_STATUS_ACCEPTED, at, { RA_DEAL_STATUS_FIELD: "bad name!" })).toBeNull();
    expect(raDealFields(RA_STATUS_ACCEPTED, at, { RA_DEAL_STATUS_FIELD: "Registered_Agent_Status", RA_DEAL_ACCEPTED_AT_FIELD: "Registered_Agent_Accepted_At" }))
      .toEqual({ Registered_Agent_Status: "Agent Accepted — Ready for Sunbiz", Registered_Agent_Accepted_At: "2026-11-25T15:31:00+00:00" });
  });

  async function db() {
    const { Pool } = newDb().adapters.createPg();
    const pool = new Pool();
    await pool.query(`
      CREATE TABLE filing_sessions (filing_session_id uuid PRIMARY KEY, email text, crm_deal_id text);
      CREATE TABLE crm_sync_queue (id bigserial PRIMARY KEY, filing_session_id uuid NOT NULL, sync_type text NOT NULL, payload_snapshot jsonb NOT NULL);
      INSERT INTO filing_sessions VALUES ('11111111-1111-4111-8111-111111111111', 'owner@example.test', 'deal-9'),
                                         ('22222222-2222-4222-8222-222222222222', 'owner@example.test', NULL);
    `);
    return pool;
  }
  const env = { RA_DEAL_STATUS_FIELD: "Registered_Agent_Status" };

  it("queues a field-only update for the session's Deal", async () => {
    const pool = await db();
    expect(await queueRaDealStatus(pool as never, "11111111-1111-4111-8111-111111111111", RA_STATUS_ACCEPTED, at, env)).toEqual({ queued: true });
    const { rows } = await pool.query("SELECT sync_type, payload_snapshot FROM crm_sync_queue");
    expect(rows).toEqual([{ sync_type: RA_DEAL_SYNC_TYPE, payload_snapshot: { crm_deal_id: "deal-9", expected_email: "owner@example.test", extra_fields: { Registered_Agent_Status: RA_STATUS_ACCEPTED } } }]);
  });

  it("skips when off or when the session has no Deal yet", async () => {
    const pool = await db();
    expect((await queueRaDealStatus(pool as never, "11111111-1111-4111-8111-111111111111", RA_STATUS_ACCEPTED, at, {})).queued).toBe(false);
    expect((await queueRaDealStatus(pool as never, "22222222-2222-4222-8222-222222222222", RA_STATUS_ACCEPTED, at, env)).queued).toBe(false);
    expect((await pool.query("SELECT count(*)::int AS n FROM crm_sync_queue")).rows[0].n).toBe(0);
  });
});

describe("field-only Deal update leaves Stage alone", () => {
  afterEach(() => { vi.unstubAllGlobals(); resetZohoTokenCache(); });
  it("PUTs only the extra fields", async () => {
    process.env.ZOHO_CLIENT_ID = "id"; process.env.ZOHO_CLIENT_SECRET = "s"; process.env.ZOHO_REFRESH_TOKEN = "r";
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("oauth")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      if (init?.method === "PUT") { bodies.push(String(init.body)); return new Response("{}", { status: 200 }); }
      throw new Error("unexpected " + url);
    }));
    const r = await realZohoClient.updateDealStage({ crm_deal_id: "deal-9", expected_email: "x", server_created: true, extra_fields: { Registered_Agent_Status: RA_STATUS_ACCEPTED } });
    expect(r.ok).toBe(true);
    expect(JSON.parse(bodies[0])).toEqual({ data: [{ Registered_Agent_Status: RA_STATUS_ACCEPTED }] });
  });
});
