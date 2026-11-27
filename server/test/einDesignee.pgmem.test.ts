import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type http from "node:http";
import express from "express";
import { newDb } from "pg-mem";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://unused.invalid/none";
});
import {
  SS4_DESIGNEE_STATEMENT_CLAUSES,
  SS4_DESIGNEE_STATEMENT_SHA256,
  SS4_DESIGNEE_STATEMENT_TEXT,
  SS4_DESIGNEE_STATEMENT_VERSION,
  authorityExpiresAt,
  checkSignatureInput,
  cleanSignerText,
  designeeConfig,
} from "../src/ein/designee.js";
import { createEinDesigneeRouter } from "../src/routes/einDesignee.js";
import { funnelRateLimiters } from "../src/middleware/rateLimit.js";

/**
 * ST17: the SS-4 Third-Party Designee e-signature, with the real SQL of migration
 * 0040 against pg-mem (minus RLS, which pg-mem cannot run). No real database.
 */

/** Damian's approved wording (26 Nov 2026), copied by hand from his message. */
const APPROVED = `IRS Form SS-4 — Third-Party Designee Authorization
By typing my full legal name and clicking below, I authorize Damian Knowles (Designee) to answer questions that may arise during the completion of IRS Form SS-4 (Application for Employer Identification Number), receive the newly assigned Employer Identification Number (EIN) on behalf of the entity listed above, and answer questions regarding the completion of Form SS-4.

1. Limited Authority: Applies only to the completion of Form SS-4 and receipt of the assigned EIN, terminating upon EIN assignment or one (1) year from signing, whichever occurs first.
2. No Legal or Tax Representation: Damian Knowles is acting solely as a Third-Party Designee for EIN application submission and is not acting as an attorney, CPA, or Enrolled Agent, nor providing legal or tax advice.
3. Accuracy of Information: Under penalties of perjury, I declare that I am an authorized member, manager, or officer of the entity and that the information provided for this EIN application (including my SSN/ITIN or passport documentation, if applicable) is true, correct, and complete.`;

const BASE = `
  CREATE TABLE filing_sessions (filing_session_id uuid PRIMARY KEY, filing_data jsonb);
  CREATE TABLE orders (
    order_id uuid PRIMARY KEY, filing_session_id uuid NOT NULL, line_items jsonb NOT NULL, payment_status text NOT NULL
  );
`;

function migration(file: string): string {
  return readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8")
    .replace(/^--.*$/gm, "")
    .replace(/ALTER TABLE \w+ ENABLE ROW LEVEL SECURITY;/g, "");
}

const S_EIN = "11111111-1111-4111-8111-111111111111"; // FASTTRACK, card held
const S_DIY = "22222222-2222-4222-8222-222222222222"; // paid, no EIN
const S_PENDING = "33333333-3333-4333-8333-333333333333"; // EIN, checkout never completed
const S_NONAME = "44444444-4444-4444-8444-444444444444"; // EIN add-on paid, no LLC name yet
const O_EIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const O_DIY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const O_PENDING = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const O_NONAME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
const NOW = new Date("2026-11-26T15:00:00Z");

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function setup(opts: { withoutMigration?: boolean; enabled?: boolean } = {}) {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await pool.query(BASE);
  if (!opts.withoutMigration) await pool.query(migration("0040_ein_designee_authorizations.sql"));
  await pool.query(
    `INSERT INTO filing_sessions VALUES
       ($1, '{"llc_name":" Sunshine Widgets LLC "}'), ($2, '{"llc_name":"Plain LLC"}'),
       ($3, '{"llc_name":"Never Paid LLC"}'), ($4, '{}')`,
    [S_EIN, S_DIY, S_PENDING, S_NONAME],
  );
  await pool.query(
    `INSERT INTO orders VALUES
       ($1, $5, '[{"offer_code":"FASTTRACK"}]', 'authorized'),
       ($2, $6, '[{"offer_code":"DIY_STATE_FEE"}]', 'paid'),
       ($3, $7, '[{"offer_code":"PREMIUM"}]', 'pending'),
       ($4, $8, '[{"offer_code":"DIY_STATE_FEE"},{"offer_code":"EIN_FILING"}]', 'paid')`,
    [O_EIN, O_DIY, O_PENDING, O_NONAME, S_EIN, S_DIY, S_PENDING, S_NONAME],
  );

  let enabled = opts.enabled ?? true;
  const app = express();
  app.use(express.json());
  app.use(createEinDesigneeRouter({ db: pool, config: () => ({ enabled }), now: () => NOW }));
  const server: http.Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}/api/ein/designee-authorization`;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(base, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const get = (sid: string, oid: string) => fetch(`${base}?filing_session_id=${sid}&order_id=${oid}`);
  return { pool, post, get, setEnabled: (v: boolean) => (enabled = v) };
}

const sign = (over: Record<string, unknown> = {}) => ({
  filing_session_id: S_EIN,
  order_id: O_EIN,
  statement_version: SS4_DESIGNEE_STATEMENT_VERSION,
  signer_name: "Ada Lovelace",
  signer_title: "Managing Member",
  entity_name: "Sunshine Widgets LLC",
  consent: true,
  ...over,
});

describe("approved wording", () => {
  it("is Damian's 26 Nov text, character for character", () => {
    expect(SS4_DESIGNEE_STATEMENT_TEXT).toBe(APPROVED);
    expect(SS4_DESIGNEE_STATEMENT_VERSION).toBe("ss4-designee-2026-11-26");
    expect(SS4_DESIGNEE_STATEMENT_CLAUSES).toHaveLength(3);
    expect(SS4_DESIGNEE_STATEMENT_SHA256).toBe(createHash("sha256").update(APPROVED, "utf8").digest("hex"));
  });
});

describe("configuration", () => {
  it("is off unless EIN_DESIGNEE_ESIGN_ENABLED is exactly true", () => {
    expect(designeeConfig({}).enabled).toBe(false);
    expect(designeeConfig({ EIN_DESIGNEE_ESIGN_ENABLED: "false" }).enabled).toBe(false);
    expect(designeeConfig({ EIN_DESIGNEE_ESIGN_ENABLED: "yes" }).enabled).toBe(false);
    expect(designeeConfig({ EIN_DESIGNEE_ESIGN_ENABLED: "1" }).enabled).toBe(false);
    expect(designeeConfig({ EIN_DESIGNEE_ESIGN_ENABLED: " TRUE " }).enabled).toBe(true);
  });

  it("has its own per-IP rate limit", () => {
    expect(funnelRateLimiters().einDesignee).toBeTypeOf("function");
  });
});

describe("input checks", () => {
  it("cleans the typed name", () => {
    expect(cleanSignerText("  Ada \n  Lovelace\u0000 ", 200)).toBe("Ada Lovelace");
    expect(cleanSignerText("José Núñez", 200)).toBe("José Núñez");
    expect(cleanSignerText("   ", 200)).toBeNull();
    expect(cleanSignerText("12345", 200)).toBeNull();
    expect(cleanSignerText("x".repeat(201), 200)).toBeNull();
    expect(cleanSignerText(42, 200)).toBeNull();
    expect(cleanSignerText("Ada\u200b Love\u202elace", 200)).toBe("Ada Lovelace");
    expect(cleanSignerText("Jose\u0301", 200)).toBe("Jos\u00e9");
  });

  it("needs consent, a name and the current version", () => {
    expect(checkSignatureInput(sign({ consent: "true" }))).toMatchObject({ ok: false, status: 400, error: "consent_required" });
    expect(checkSignatureInput(sign({ signer_name: "" }))).toMatchObject({ ok: false, status: 400, error: "signer_name_required" });
    expect(checkSignatureInput(sign({ signer_title: "!!" }))).toMatchObject({ ok: false, status: 400, error: "invalid_signer_title" });
    expect(checkSignatureInput(sign({ statement_version: undefined }))).toMatchObject({ ok: false, status: 400 });
    expect(checkSignatureInput(sign({ statement_version: "ss4-designee-2026-01-01" }))).toMatchObject({ ok: false, status: 409, error: "statement_changed" });
    expect(checkSignatureInput(sign({ entity_name: " " }))).toMatchObject({ ok: false, status: 400, error: "entity_name_required" });
    expect(checkSignatureInput(sign({ signer_title: undefined }))).toEqual({
      ok: true,
      signerName: "Ada Lovelace",
      signerTitle: null,
      shownEntityName: "SUNSHINE WIDGETS LLC",
    });
  });

  it("ends the authority one year after signing", () => {
    expect(authorityExpiresAt(NOW).toISOString()).toBe("2027-11-26T15:00:00.000Z");
    expect(authorityExpiresAt(new Date("2028-02-29T12:00:00Z")).toISOString()).toBe("2029-02-28T12:00:00.000Z");
  });
});

describe("GET /api/ein/designee-authorization", () => {
  it("is 503 not_open while switched off", async () => {
    const t = await setup({ enabled: false });
    const res = await t.get(S_EIN, O_EIN);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not_open" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("is 503 not_open before migration 0040 is applied", async () => {
    const t = await setup({ withoutMigration: true });
    expect((await t.get(S_EIN, O_EIN)).status).toBe(503);
  });

  it("shows the statement and the LLC name for an EIN order", async () => {
    const t = await setup();
    const res = await t.get(S_EIN, O_EIN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ status: "open", entity_name: "SUNSHINE WIDGETS LLC", signature: null });
    expect(body.statement.text).toBe(APPROVED);
    expect(body.statement.version).toBe(SS4_DESIGNEE_STATEMENT_VERSION);
  });

  it("is 404 for a session without a held or paid EIN order, or a mismatched pair", async () => {
    const t = await setup();
    expect((await t.get(S_DIY, O_DIY)).status).toBe(404);
    expect((await t.get(S_PENDING, O_PENDING)).status).toBe(404);
    expect((await t.get(S_EIN, O_DIY)).status).toBe(404);
    expect((await t.get("55555555-5555-4555-8555-555555555555", O_EIN)).status).toBe(404);
  });

  it("is 400 for malformed ids", async () => {
    const t = await setup();
    expect((await t.get("not-a-uuid", O_EIN)).status).toBe(400);
  });
});

describe("POST /api/ein/designee-authorization", () => {
  it("is 503 not_open while switched off, and stores nothing", async () => {
    const t = await setup({ enabled: false });
    expect((await t.post(sign())).status).toBe(503);
    expect((await t.pool.query("SELECT count(*)::int AS n FROM ein_designee_authorizations")).rows[0].n).toBe(0);
  });

  it("stores the signature with the server's time, IP, version and the exact text", async () => {
    const t = await setup();
    const res = await t.post(sign(), {
      "True-Client-IP": "203.0.113.7",
      "X-Forwarded-For": "203.0.113.7, 10.0.0.1",
      "User-Agent": "TestBrowser/1.0",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      status: "signed",
      already_signed: false,
      signature: {
        statement_version: SS4_DESIGNEE_STATEMENT_VERSION,
        signer_name: "Ada Lovelace",
        signer_title: "Managing Member",
        entity_name: "SUNSHINE WIDGETS LLC",
        signed_at: NOW.toISOString(),
        authority_expires_at: "2027-11-26T15:00:00.000Z",
      },
    });
    const { rows } = await t.pool.query("SELECT * FROM ein_designee_authorizations");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      filing_session_id: S_EIN,
      order_id: O_EIN,
      statement_version: SS4_DESIGNEE_STATEMENT_VERSION,
      statement_text: APPROVED,
      statement_sha256: SS4_DESIGNEE_STATEMENT_SHA256,
      consent: true,
      ip: "203.0.113.7",
      forwarded_for: "203.0.113.7, 10.0.0.1",
      user_agent: "TestBrowser/1.0",
    });
    expect(new Date(rows[0].signed_at).toISOString()).toBe(NOW.toISOString());

    const after = (await (await t.get(S_EIN, O_EIN)).json()) as any;
    expect(after.signature.signer_name).toBe("Ada Lovelace");
  });

  it("keeps the first signature when the customer signs again", async () => {
    const t = await setup();
    expect((await t.post(sign())).status).toBe(201);
    const again = await t.post(sign({ signer_name: "Someone Else" }));
    expect(again.status).toBe(200);
    const body = (await again.json()) as any;
    expect(body.already_signed).toBe(true);
    expect(body.signature.signer_name).toBe("Ada Lovelace");
    expect((await t.pool.query("SELECT count(*)::int AS n FROM ein_designee_authorizations")).rows[0].n).toBe(1);
  });

  it("stores no IP when the header is missing or is not an IP address", async () => {
    const t = await setup();
    expect((await t.post(sign(), { "True-Client-IP": "<script>not-an-ip" })).status).toBe(201);
    expect((await t.pool.query("SELECT ip FROM ein_designee_authorizations")).rows[0].ip).toBeNull();
  });

  it("refuses with 409 when the LLC name changed since the page showed it", async () => {
    const t = await setup();
    const res = await t.post(sign({ entity_name: "Old Name LLC" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "entity_name_changed", entity_name: "SUNSHINE WIDGETS LLC" });
    expect((await t.post(sign({ entity_name: "  sunshine   widgets llc " }))).status).toBe(201);
  });

  it("refuses an older wording with 409 and sends the current statement", async () => {
    const t = await setup();
    const res = await t.post(sign({ statement_version: "ss4-designee-2026-11-01" }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.error).toBe("statement_changed");
    expect(body.statement.version).toBe(SS4_DESIGNEE_STATEMENT_VERSION);
  });

  it("needs consent and a typed name", async () => {
    const t = await setup();
    expect((await t.post(sign({ consent: false }))).status).toBe(400);
    expect((await t.post(sign({ signer_name: "  " }))).status).toBe(400);
    expect((await t.pool.query("SELECT count(*)::int AS n FROM ein_designee_authorizations")).rows[0].n).toBe(0);
  });

  it("is 404 without a held or paid EIN order, 400 for malformed ids", async () => {
    const t = await setup();
    expect((await t.post(sign({ filing_session_id: S_DIY, order_id: O_DIY }))).status).toBe(404);
    expect((await t.post(sign({ filing_session_id: S_PENDING, order_id: O_PENDING }))).status).toBe(404);
    expect((await t.post(sign({ order_id: "x" }))).status).toBe(400);
  });

  it("is 409 when the interview has no LLC name to show above the statement", async () => {
    const t = await setup();
    const res = await t.post(sign({ filing_session_id: S_NONAME, order_id: O_NONAME, entity_name: "Anything LLC" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "entity_name_missing" });
  });
});
