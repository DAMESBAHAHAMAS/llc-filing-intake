import { newDb } from "pg-mem";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkSignature,
  cleanSignatureName,
  isEntityName,
  loadStoredAcceptance,
  queueRaDealStatus,
  RA_ACCEPTANCE_STATEMENT,
  RA_DEAL_SYNC_TYPE,
  RA_STATUS_ACCEPTED,
  RA_STATUS_AWAITING,
  raDealPayloadNow,
  raDealStatusField,
  signatureMatchesAgent,
  tokenRef,
  type StoredAcceptance,
} from "../src/registeredAgent/acceptanceRecord.js";
import { recordAcceptance } from "../src/registeredAgent/acceptTransaction.js";
import { buildAcceptanceStatementContext, floridaDateTime, registeredAgentSignatureForArticles } from "../src/registeredAgent/acceptanceStatement.js";
import { buildPdfContext } from "../src/pdf/context.js";
import { realZohoClient, resetZohoTokenCache } from "../src/zoho/client.js";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const O1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const at = new Date("2026-11-25T15:31:00Z");

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

/** pg-mem with the columns the migrations leave (0005 + 0033), as in the other pg-mem tests. */
async function db(withSignatureColumns = true) {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  await pool.query(`
    CREATE TABLE filing_sessions (filing_session_id uuid PRIMARY KEY, email text, crm_deal_id text, filing_data jsonb, registered_agent_status text);
    CREATE TABLE registered_agent_acceptances (
      id bigserial PRIMARY KEY, filing_session_id uuid NOT NULL, status text NOT NULL, requested_at timestamptz,
      accepted_at timestamptz, registered_agent_name text NOT NULL, registered_agent_email text NOT NULL,
      accepted_ip text, acceptance_token_id text NOT NULL, acceptance_version text NOT NULL
      ${withSignatureColumns ? `, signature_name text, signature_consent boolean, accepted_user_agent text, statement_version text,
        accepted_agent_name text, accepted_agent_address text, accepted_llc_name text` : ""}
    );
    CREATE TABLE orders (order_id uuid PRIMARY KEY, filing_session_id uuid NOT NULL, payment_status text NOT NULL,
      paid_at timestamptz, authorized_at timestamptz, crm_deal_id text);
    CREATE TABLE crm_sync_queue (id bigserial PRIMARY KEY, filing_session_id uuid NOT NULL, order_id uuid, sync_type text NOT NULL,
      payload_snapshot jsonb NOT NULL, status text NOT NULL DEFAULT 'pending', run_after timestamptz DEFAULT now());
  `);
  await pool.query(`INSERT INTO filing_sessions VALUES ($1, 'attacker@example.test', 'client-deal', $2, 'acceptance_requested'),
                                                       ($3, 'x@example.test', NULL, $2, 'acceptance_requested')`, [S1, JSON.stringify(fd), S2]);
  await pool.query(`INSERT INTO registered_agent_acceptances (filing_session_id, status, requested_at, registered_agent_name, registered_agent_email, acceptance_token_id, acceptance_version)
                    VALUES ($1, 'acceptance_requested', now(), 'Riley Test Agent', 'agent@example.test', 'tok-1', 'v1')`, [S1]);
  return pool as never as import("pg").Pool;
}

describe("signature checks (T144 D12)", () => {
  it("accepts a button-only answer while the signature is not required", () => {
    expect(checkSignature({ token: "t" }, {})).toEqual({ ok: true, signatureName: null });
    expect(checkSignature({ token: "t" }, { RA_ACCEPT_REQUIRE_SIGNATURE: "true" })).toMatchObject({ ok: false, code: "signature_required" });
  });
  it("needs consent with a typed name", () => {
    expect(checkSignature({ signature_name: "Riley Test Agent" }, {})).toMatchObject({ ok: false, code: "consent_required" });
    expect(checkSignature({ signature_name: "  Riley   Test Agent ", consent: true }, {})).toEqual({ ok: true, signatureName: "Riley Test Agent" });
    expect(cleanSignatureName("12345")).toBeNull();
  });
  it("matches the named agent, ignoring case, accents, punctuation and a middle name", () => {
    expect(signatureMatchesAgent("riley  test agent", "Riley Test Agent")).toBe(true);
    expect(signatureMatchesAgent("Riley T. Agent", "Riley Test Agent")).toBe(true);
    expect(signatureMatchesAgent("José Núñez", "Jose Nunez")).toBe(true);
    expect(signatureMatchesAgent("Bob", "Riley Test Agent")).toBe(false);
    expect(signatureMatchesAgent("Riley Smith", "Riley Test Agent")).toBe(false);
  });
  it("lets a person sign for a business agent", () => {
    expect(isEntityName("Sunshine Registered Agents, Inc.")).toBe(true);
    expect(isEntityName("Riley Test Agent")).toBe(false);
    expect(signatureMatchesAgent("Pat Officer", "Sunshine Registered Agents, Inc.")).toBe(true);
  });
});

describe("recordAcceptance: one transaction, server-side record", () => {
  const base = { acceptanceId: 1, filingSessionId: S1, ip: "203.0.113.9", userAgent: "UA", acceptedAt: at, requireSignature: false };

  it("stores the signature on the acceptance row and opens the gate together", async () => {
    const pool = await db();
    expect(await recordAcceptance(pool, { ...base, signatureName: "Riley Test Agent" })).toEqual({ kind: "accepted", signed: true });
    const acc = await loadStoredAcceptance(pool, S1);
    expect(acc).toMatchObject({ signature_name: "Riley Test Agent", accepted_ip: "203.0.113.9", accepted_user_agent: "UA",
      accepted_agent_name: "Riley Test Agent", accepted_agent_address: fd.registered_agent_florida_address, accepted_llc_name: fd.llc_name });
    expect((await pool.query(`SELECT registered_agent_status FROM filing_sessions WHERE filing_session_id = $1`, [S1])).rows[0].registered_agent_status).toBe("accepted");
    // The token is used: a second answer is refused.
    expect(await recordAcceptance(pool, { ...base, signatureName: "Riley Test Agent" })).toEqual({ kind: "not_actionable", status: "accepted" });
  });

  it("refuses a name that is not the named agent's, and changes nothing", async () => {
    const pool = await db();
    expect(await recordAcceptance(pool, { ...base, signatureName: "Bob" })).toEqual({ kind: "signature_mismatch", agentName: "Riley Test Agent" });
    expect((await pool.query(`SELECT status FROM registered_agent_acceptances WHERE id = 1`)).rows[0].status).toBe("acceptance_requested");
    expect((await pool.query(`SELECT registered_agent_status FROM filing_sessions WHERE filing_session_id = $1`, [S1])).rows[0].registered_agent_status).toBe("acceptance_requested");
  });

  it("still accepts (button-only) before migration 0033, unless a signature is required", async () => {
    const pool = await db(false);
    expect(await recordAcceptance(pool, { ...base, signatureName: null, requireSignature: true })).toEqual({ kind: "signature_storage_unavailable" });
    expect(await recordAcceptance(pool, { ...base, signatureName: "Riley Test Agent" })).toEqual({ kind: "accepted", signed: false });
    expect(await loadStoredAcceptance(pool, S1)).toBeNull();
  });
});

describe("Articles and statement read only the server-side row", () => {
  const acc: StoredAcceptance = {
    signature_name: "Riley Test Agent", accepted_at: at, accepted_ip: "203.0.113.9", accepted_user_agent: "UA",
    statement_version: "ra-statement-2026-11-25", accepted_agent_name: "Riley Test Agent",
    accepted_agent_address: "1 SE 3rd Ave, Suite 1500, Miami, FL, 33131", accepted_llc_name: "Test Dispatch Twelve LLC", acceptance_token_id: "tok-1",
  };

  it("prints Article III from the row, never from filing_data", () => {
    const forged = { ...fd, registered_agent_acceptance: { method: "typed_signature", signature_name: "Forged Name", accepted_at: at.toISOString() } };
    const none = buildPdfContext(forged as never, "accepted");
    expect(none.ok && none.context.registered_agent_signature).toBeNull();
    const signed = buildPdfContext(forged as never, "accepted", { registeredAgentAcceptance: acc });
    expect(signed.ok && signed.context.registered_agent_signature).toEqual({ name: "Riley Test Agent", date: "November 25, 2026" });
    expect(JSON.stringify(signed)).not.toContain("Forged Name");
  });

  it("drops the signature when the filing now names another agent or address", () => {
    expect(registeredAgentSignatureForArticles(acc, { ...fd, registered_agent_name: "Other Agent" })).toBeNull();
    expect(registeredAgentSignatureForArticles(acc, { ...fd, registered_agent_florida_address: "2 Other St, Miami, FL 33130" })).toBeNull();
    expect(registeredAgentSignatureForArticles({ ...acc, signature_name: null }, fd)).toBeNull();
  });

  it("builds the statement from the row", () => {
    const r = buildAcceptanceStatementContext(acc);
    expect(r.ok && r.context).toMatchObject({ llc_name: "TEST DISPATCH TWELVE LLC", signature_name: "Riley Test Agent",
      statement_text: RA_ACCEPTANCE_STATEMENT, ip: "203.0.113.9", token_ref: tokenRef("tok-1"),
      accepted_at_display: "November 25, 2026 at 10:31 AM EST" });
    expect(buildAcceptanceStatementContext(null).ok).toBe(false);
    expect(buildAcceptanceStatementContext({ ...acc, signature_name: null }).ok).toBe(false);
  });

  it("formats Florida time", () => {
    expect(floridaDateTime("2026-07-01T16:05:00Z")).toBe("July 1, 2026 at 12:05 PM EDT");
  });
});

describe("Zoho Deal status: verified Deal, current status", () => {
  const env = { RA_DEAL_ACCEPTED_AT_FIELD: "Registered_Agent_Accepted_At" };

  it("never uses the client-supplied crm_deal_id, and queues nothing without a verified Deal", async () => {
    const pool = await db();
    expect(await queueRaDealStatus(pool, S1, env)).toMatchObject({ queued: false });
    expect(await raDealPayloadNow(pool, S1, env)).toMatchObject({ ok: false });
  });

  it("writes RA_Acceptance_Status by default, and can be switched off", async () => {
    expect(raDealStatusField({})).toBe("RA_Acceptance_Status");
    expect(raDealStatusField({ RA_DEAL_STATUS_FIELD: "Other_Field" })).toBe("Other_Field");
    expect(raDealStatusField({ RA_DEAL_STATUS_FIELD: "off" })).toBe("");
    expect(raDealStatusField({ RA_DEAL_STATUS_FIELD: "bad name!" })).toBe("");
    const pool = await db();
    expect(await queueRaDealStatus(pool, S1, { RA_DEAL_STATUS_FIELD: "off" })).toMatchObject({ queued: false });
  });

  it("sends the verified Deal and the status as it is when the job runs", async () => {
    const pool = await db();
    await pool.query(`INSERT INTO orders VALUES ($1, $2, 'authorized', NULL, '2026-11-25T10:00:00Z', 'verified-deal')`, [O1, S1]);
    await pool.query(`INSERT INTO crm_sync_queue (filing_session_id, order_id, sync_type, payload_snapshot, status) VALUES ($1, $2, 'order_deal', '{}', 'synced')`, [S1, O1]);

    expect(await queueRaDealStatus(pool, S1, env)).toEqual({ queued: true });
    // A second request does not add a job; the pending one sends the current status.
    expect(await queueRaDealStatus(pool, S1, env)).toMatchObject({ queued: true });
    expect((await pool.query(`SELECT count(*)::int AS n FROM crm_sync_queue WHERE sync_type = $1`, [RA_DEAL_SYNC_TYPE])).rows[0].n).toBe(1);

    let built = await raDealPayloadNow(pool, S1, env);
    expect(built).toEqual({ ok: true, payload: { crm_deal_id: "verified-deal", expected_email: "", server_created: true,
      extra_fields: { RA_Acceptance_Status: RA_STATUS_AWAITING } } });

    // The agent accepts before the old "Awaiting" job is sent: it now sends "Accepted".
    await recordAcceptance(pool, { acceptanceId: 1, filingSessionId: S1, signatureName: "Riley Test Agent", ip: null, userAgent: null, acceptedAt: at, requireSignature: false });
    built = await raDealPayloadNow(pool, S1, env);
    expect(built.ok && built.payload.extra_fields).toEqual({ RA_Acceptance_Status: RA_STATUS_ACCEPTED, Registered_Agent_Accepted_At: "2026-11-25T15:31:00+00:00" });
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
    const r = await realZohoClient.updateDealStage({ crm_deal_id: "deal-9", expected_email: "", server_created: true, extra_fields: { Registered_Agent_Status: RA_STATUS_ACCEPTED } });
    expect(r.ok).toBe(true);
    expect(JSON.parse(bodies[0])).toEqual({ data: [{ Registered_Agent_Status: RA_STATUS_ACCEPTED }] });
  });
});
