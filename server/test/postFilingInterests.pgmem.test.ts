import { readFileSync } from "node:fs";
import type http from "node:http";
import express from "express";
import { newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://unused.invalid/none";
});
import {
  ALERT_REPEAT_MS,
  CLAIM_LEASE_MS,
  RETRY_DELAYS_MS,
  cleanNote,
  postFilingConfig,
  realPostFilingZohoClient,
  resetPostFilingJobState,
  runPostFilingSyncOnce,
  type PostFilingDeps,
  type PostFilingZohoClient,
  type ZohoResult,
} from "../src/postFiling/interests.js";
import { createPostFilingInterestsRouter } from "../src/routes/postFilingInterests.js";
import { funnelRateLimiters } from "../src/middleware/rateLimit.js";
import { resetZohoTokenCache } from "../src/zoho/client.js";

/**
 * Dispatch 13: the post-filing roadmap endpoint and its Zoho copy, with the real SQL
 * of migration 0032 against pg-mem (minus the partial index, RLS and the note-length
 * CHECK, which pg-mem cannot run; the app caps the note at 500 itself) and a fake Zoho
 * client. No real database, Zoho or network.
 */

const BASE = `
  CREATE TABLE filing_sessions (filing_session_id uuid PRIMARY KEY, email text);
  CREATE TABLE orders (
    order_id uuid PRIMARY KEY, filing_session_id uuid NOT NULL, line_items jsonb NOT NULL,
    payment_status text NOT NULL, paid_at timestamptz, authorized_at timestamptz, crm_deal_id text
  );
  CREATE TABLE crm_sync_queue (
    id bigserial PRIMARY KEY, filing_session_id uuid NOT NULL, order_id uuid, sync_type text NOT NULL,
    payload_snapshot jsonb NOT NULL, status text NOT NULL DEFAULT 'pending'
  );
`;

function migration(file: string): string {
  return readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8")
    .replace(/^--.*$/gm, "")
    .replace(/CREATE INDEX[^;]*;/g, "")
    .replace(/ALTER TABLE \w+ ENABLE ROW LEVEL SECURITY;/g, "")
    .replace(/ CHECK \(license_note IS NULL OR char_length\(license_note\) <= 500\)/, "");
}

const S1 = "11111111-1111-4111-8111-111111111111"; // held order, verified intake Deal
const S2 = "22222222-2222-4222-8222-222222222222"; // paid order, Deal id failed its ownership check
const S3 = "33333333-3333-4333-8333-333333333333"; // checkout never completed
const O1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const O2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const O3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const NOW = new Date("2026-11-25T12:00:00Z");

async function setup(opts: { without0039?: boolean } = {}) {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await pool.query(BASE);
  await pool.query(migration("0032_post_filing_interests.sql"));
  if (!opts.without0039) await pool.query(migration("0039_post_filing_interests_filing_support.sql"));
  await pool.query(`INSERT INTO filing_sessions VALUES ('${S1}', 'ada@example.test'), ('${S2}', 'eve@example.test'), ('${S3}', 'bob@example.test')`);
  const items = JSON.stringify([{ offer_code: "FASTTRACK" }]);
  await pool.query(
    `INSERT INTO orders VALUES
       ($1, $4, $7, 'authorized', NULL, '2026-11-25T10:00:00Z', 'deal-1'),
       ($2, $5, $7, 'paid', '2026-11-25T11:00:00Z', NULL, 'deal-victim'),
       ($3, $6, $7, 'pending', NULL, NULL, NULL)`,
    [O1, O2, O3, S1, S2, S3, items],
  );
  await pool.query(
    `INSERT INTO crm_sync_queue (filing_session_id, order_id, sync_type, payload_snapshot, status) VALUES
       ($1, $2, 'deal_stage_update', '{"crm_deal_id":"deal-1"}', 'pending'),
       ($3, $4, 'deal_stage_update', '{"crm_deal_id":"deal-victim"}', 'dead_letter')`,
    [S1, O1, S2, O2],
  );

  const calls: string[] = [];
  let setResult: ZohoResult = { ok: true };
  const zoho: PostFilingZohoClient = {
    updateDeal: async (dealId, fields) => {
      calls.push(`set ${dealId} ${JSON.stringify(fields)}`);
      return setResult;
    },
  };
  const alerts: string[] = [];
  let now = NOW;
  const deps: PostFilingDeps = {
    db: pool,
    zoho,
    config: postFilingConfig({}),
    now: () => now,
    alert: async (subject) => {
      alerts.push(subject);
    },
  };

  const app = express();
  app.use(express.json());
  let enabled = true;
  const routeAlerts: string[] = [];
  app.use(
    createPostFilingInterestsRouter({
      db: pool,
      config: () => ({ ...postFilingConfig({}), enabled }),
      now: () => now,
      alert: async (subject, body) => {
        routeAlerts.push(`${subject}: ${body}`);
      },
    }),
  );
  const server: http.Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}/api/post-filing-interests`;

  const post = (body: unknown) =>
    fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const get = (sid: string, oid: string) => fetch(`${base}?filing_session_id=${sid}&order_id=${oid}`);

  return {
    pool,
    deps,
    calls,
    alerts,
    routeAlerts,
    post,
    get,
    setNow: (d: Date) => (now = d),
    setEnabled: (v: boolean) => (enabled = v),
    failSet: (r: ZohoResult) => (setResult = r),
    verifyDeal: () => pool.query(`UPDATE crm_sync_queue SET status = 'synced' WHERE order_id = $1`, [O1]),
  };
}

const servers: http.Server[] = [];
beforeEach(() => resetPostFilingJobState());
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

describe("POST/GET /api/post-filing-interests", () => {
  it("saves each toggle against the filing session and reads it back", async () => {
    const t = await setup();
    const initial = await t.get(S1, O1);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({
      status: "open",
      interests: { bank_account: false, licenses_permits: false, tax_compliance: false, filing_support: false },
      license_note: null,
    });

    const res = await t.post({ filing_session_id: S1, order_id: O1, interest: "licenses_permits", selected: true, note: "  Food truck, Miami-Dade\u0007 " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "saved",
      interests: { bank_account: false, licenses_permits: true, tax_compliance: false, filing_support: false },
      license_note: "Food truck, Miami-Dade",
    });
    await t.post({ filing_session_id: S1, order_id: O1, interest: "tax_compliance", selected: true });
    await t.post({ filing_session_id: S1, order_id: O1, interest: "tax_compliance", selected: true }); // no change

    const { rows } = await t.pool.query(`SELECT licenses_permits, tax_compliance, version, synced_version FROM post_filing_interests`);
    expect(rows).toEqual([{ licenses_permits: true, tax_compliance: true, version: 2, synced_version: 0 }]);
  });

  it("refuses anything but a held or paid order of the same session, without saying which", async () => {
    const t = await setup();
    const cases: Array<[string, string]> = [
      [S1, O2], // another session's order
      [S3, O3], // unpaid order
      ["44444444-4444-4444-8444-444444444444", O1], // unknown session
    ];
    for (const [sid, oid] of cases) {
      const r = await t.post({ filing_session_id: sid, order_id: oid, interest: "bank_account", selected: true });
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: "not_found" });
      expect((await t.get(sid, oid)).status).toBe(404);
    }
    expect((await t.pool.query(`SELECT * FROM post_filing_interests`)).rows).toEqual([]);
  });

  it("rejects malformed bodies and a client-supplied Deal id changes nothing", async () => {
    const t = await setup();
    for (const body of [
      { filing_session_id: S1, order_id: O1, interest: "crypto", selected: true },
      { filing_session_id: S1, order_id: O1, interest: "bank_account", selected: "yes" },
      { filing_session_id: "not-a-uuid", order_id: O1, interest: "bank_account", selected: true },
      { filing_session_id: S1, order_id: O1, interest: "licenses_permits", selected: true, note: 42 },
    ]) {
      expect((await t.post(body)).status).toBe(400);
    }
    const ok = await t.post({ filing_session_id: S1, order_id: O1, interest: "bank_account", selected: true, crm_deal_id: "deal-attacker" });
    expect(ok.status).toBe(200);
    await t.verifyDeal();
    await runPostFilingSyncOnce(t.deps);
    expect(t.calls).toEqual([`set deal-1 {"Post_Filing_Interests":["Bank Account Setup"],"Post_Filing_License_Note":null}`]);
  });

  it("answers 503 not_open when switched off", async () => {
    const t = await setup();
    t.setEnabled(false);
    expect((await t.get(S1, O1)).status).toBe(503);
    expect((await t.post({ filing_session_id: S1, order_id: O1, interest: "bank_account", selected: true })).status).toBe(503);
  });

  it("keeps a note only for the licence check", async () => {
    const t = await setup();
    const r = await t.post({ filing_session_id: S1, order_id: O1, interest: "tax_compliance", selected: true, note: "ignored" });
    expect(((await r.json()) as { license_note: unknown }).license_note).toBeNull();
    expect(cleanNote("x".repeat(900))).toHaveLength(500);
    expect(cleanNote("   ")).toBeNull();
  });
});

describe("Zoho Deal copy", () => {
  it("waits for a verified Deal, then writes the full set and the note in one update", async () => {
    const t = await setup();
    await t.post({ filing_session_id: S1, order_id: O1, interest: "bank_account", selected: true });
    await t.post({ filing_session_id: S1, order_id: O1, interest: "licenses_permits", selected: true, note: "Salon, Orlando" });

    // The Deal's ownership check has not run yet: nothing is written, it retries in a minute.
    expect(await runPostFilingSyncOnce(t.deps)).toEqual({ synced: [], retried: [S1], blocked: [] });
    expect(t.calls).toEqual([]);
    expect(await runPostFilingSyncOnce(t.deps)).toEqual({ synced: [], retried: [], blocked: [] }); // not due yet

    await t.verifyDeal();
    t.setNow(new Date(NOW.getTime() + RETRY_DELAYS_MS[0]));
    expect((await runPostFilingSyncOnce(t.deps)).synced).toEqual([S1]);
    expect(t.calls).toEqual([
      `set deal-1 {"Post_Filing_Interests":["Bank Account Setup","Licenses and Permits"],"Post_Filing_License_Note":"Salon, Orlando"}`,
    ]);

    // Turning one off rewrites the set without it; turning the licence check off empties the note field.
    t.calls.length = 0;
    await t.post({ filing_session_id: S1, order_id: O1, interest: "bank_account", selected: false });
    expect((await runPostFilingSyncOnce(t.deps)).synced).toEqual([S1]);
    await t.post({ filing_session_id: S1, order_id: O1, interest: "licenses_permits", selected: false });
    expect((await runPostFilingSyncOnce(t.deps)).synced).toEqual([S1]);
    expect(t.calls).toEqual([
      `set deal-1 {"Post_Filing_Interests":["Licenses and Permits"],"Post_Filing_License_Note":"Salon, Orlando"}`,
      `set deal-1 {"Post_Filing_Interests":[],"Post_Filing_License_Note":null}`,
    ]);
    expect(await runPostFilingSyncOnce(t.deps)).toEqual({ synced: [], retried: [], blocked: [] });
  });

  it("never uses a Deal id whose ownership check failed", async () => {
    const t = await setup();
    await t.post({ filing_session_id: S2, order_id: O2, interest: "tax_compliance", selected: true });
    expect((await runPostFilingSyncOnce(t.deps)).retried).toEqual([S2]);
    expect(t.calls).toEqual([]);
  });

  it("copies a change made while a copy was in flight on the next pass", async () => {
    const t = await setup();
    await t.verifyDeal();
    await t.post({ filing_session_id: S1, order_id: O1, interest: "bank_account", selected: true });
    const slow: PostFilingZohoClient = {
      updateDeal: async (_dealId, fields) => {
        const labels = fields.Post_Filing_Interests as string[];
        t.calls.push(`set [${labels.join("|")}]`);
        if (labels.length === 1) await t.post({ filing_session_id: S1, order_id: O1, interest: "tax_compliance", selected: true });
        return { ok: true };
      },
    };
    const deps = { ...t.deps, zoho: slow };
    expect((await runPostFilingSyncOnce(deps)).synced).toEqual([S1]);
    expect((await runPostFilingSyncOnce(deps)).synced).toEqual([S1]);
    expect(t.calls).toEqual(["set [Bank Account Setup]", "set [Bank Account Setup|Tax and Compliance]"]);
  });

  it("backs off on a transient failure and blocks with one alert on a permanent one", async () => {
    const t = await setup();
    await t.verifyDeal();
    await t.post({ filing_session_id: S1, order_id: O1, interest: "bank_account", selected: true });
    t.failSet({ ok: false, error: "Zoho Deal update failed: 500" });
    expect((await runPostFilingSyncOnce(t.deps)).retried).toEqual([S1]);
    t.setNow(new Date(NOW.getTime() + RETRY_DELAYS_MS[0] + 1));
    t.failSet({ ok: false, permanent: true, error: "Zoho Deal update failed: INVALID_DATA" });
    expect((await runPostFilingSyncOnce(t.deps)).blocked).toEqual([S1]);
    expect(t.alerts).toEqual(["Post-filing interests not copied to Zoho"]);
    t.setNow(new Date(NOW.getTime() + 7 * 24 * 3600_000));
    expect(await runPostFilingSyncOnce(t.deps)).toEqual({ synced: [], retried: [], blocked: [] });

    // A new choice from the customer clears the block and tries again.
    t.failSet({ ok: true });
    await t.post({ filing_session_id: S1, order_id: O1, interest: "tax_compliance", selected: true });
    expect((await runPostFilingSyncOnce(t.deps)).synced).toEqual([S1]);
  });

  it("blocks after the last retry when no verified Deal ever appears", async () => {
    const t = await setup();
    await t.post({ filing_session_id: S1, order_id: O1, interest: "bank_account", selected: true });
    let at = NOW.getTime();
    for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
      t.setNow(new Date(at));
      expect((await runPostFilingSyncOnce(t.deps)).retried).toEqual([S1]);
      at += RETRY_DELAYS_MS[i];
    }
    t.setNow(new Date(at));
    expect((await runPostFilingSyncOnce(t.deps)).blocked).toEqual([S1]);
    expect(t.alerts).toHaveLength(1);
  });

  it("retries a customer's newer change at once even when the attempt in flight failed", async () => {
    const t = await setup();
    await t.verifyDeal();
    await t.post({ filing_session_id: S1, order_id: O1, interest: "bank_account", selected: true });
    const flaky: PostFilingZohoClient = {
      updateDeal: async () => {
        await t.post({ filing_session_id: S1, order_id: O1, interest: "tax_compliance", selected: true });
        return { ok: false, permanent: true, error: "INVALID_DATA" };
      },
    };
    expect((await runPostFilingSyncOnce({ ...t.deps, zoho: flaky })).blocked).toEqual([]);
    const { rows } = await t.pool.query(`SELECT crm_blocked_at, crm_attempts, crm_claimed_at FROM post_filing_interests`);
    expect(rows).toEqual([{ crm_blocked_at: null, crm_attempts: 0, crm_claimed_at: null }]);
    expect((await runPostFilingSyncOnce(t.deps)).synced).toEqual([S1]);
  });

  it("alerts once per cause, not once per customer", async () => {
    const t = await setup();
    await t.verifyDeal();
    await t.pool.query(`INSERT INTO orders VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', $1, '[]', 'paid', $2, NULL, 'deal-9')`, [S3, NOW]);
    await t.pool.query(
      `INSERT INTO crm_sync_queue (filing_session_id, order_id, sync_type, payload_snapshot, status) VALUES ($1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', 'order_deal', '{}', 'synced')`,
      [S3],
    );
    await t.post({ filing_session_id: S1, order_id: O1, interest: "bank_account", selected: true });
    await t.post({ filing_session_id: S3, order_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", interest: "bank_account", selected: true });
    t.failSet({ ok: false, permanent: true, error: "Zoho Deal update failed: INVALID_DATA invalid data" });
    expect((await runPostFilingSyncOnce(t.deps)).blocked.sort()).toEqual([S1, S3].sort());
    expect(t.alerts).toHaveLength(1);
    t.setNow(new Date(NOW.getTime() + ALERT_REPEAT_MS + 1));
    await t.post({ filing_session_id: S1, order_id: O1, interest: "tax_compliance", selected: true });
    await runPostFilingSyncOnce(t.deps);
    expect(t.alerts).toHaveLength(2);
  });

  it("behaves as switched off until migration 0032 is applied", async () => {
    const t = await setup();
    await t.pool.query(`DROP TABLE post_filing_interests`);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await t.get(S1, O1)).status).toBe(503);
    expect((await t.post({ filing_session_id: S1, order_id: O1, interest: "bank_account", selected: true })).status).toBe(503);
    expect(await runPostFilingSyncOnce(t.deps)).toEqual({ synced: [], retried: [], blocked: [] });
    expect(await runPostFilingSyncOnce(t.deps)).toEqual({ synced: [], retried: [], blocked: [] });
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  it("leaves a claimed row alone until its lease ends", async () => {
    const t = await setup();
    await t.verifyDeal();
    await t.post({ filing_session_id: S1, order_id: O1, interest: "bank_account", selected: true });
    await t.pool.query(`UPDATE post_filing_interests SET crm_claimed_at = $1`, [NOW]);
    expect((await runPostFilingSyncOnce(t.deps)).synced).toEqual([]);
    t.setNow(new Date(NOW.getTime() + CLAIM_LEASE_MS + 1));
    expect((await runPostFilingSyncOnce(t.deps)).synced).toEqual([S1]);
  });

  it("does nothing when switched off", async () => {
    const t = await setup();
    await t.verifyDeal();
    await t.post({ filing_session_id: S1, order_id: O1, interest: "bank_account", selected: true });
    expect(await runPostFilingSyncOnce({ ...t.deps, config: postFilingConfig({ POST_FILING_INTERESTS_ENABLED: "false" }) })).toEqual({
      synced: [],
      retried: [],
      blocked: [],
    });
  });
});

describe("config and limits", () => {
  it("is on by default with the created Deal field, and has its own per-IP limit", () => {
    expect(postFilingConfig({})).toEqual({ enabled: true, dealField: "Post_Filing_Interests", noteField: "Post_Filing_License_Note", filingSupportValue: "" });
    expect(postFilingConfig({ POST_FILING_INTERESTS_ENABLED: "FALSE", POST_FILING_INTERESTS_FIELD: "X", POST_FILING_NOTE_FIELD: "Y" })).toEqual({
      enabled: false,
      dealField: "X",
      noteField: "Y",
      filingSupportValue: "",
    });
    expect(typeof funnelRateLimiters().postFilingInterests).toBe("function");
  });
});

describe("ST17 fourth card: Dedicated Filing Support & Strategy (migration 0039)", () => {
  it("saves filing_support and reads it back with the other three", async () => {
    const t = await setup();
    const res = await t.post({ filing_session_id: S1, order_id: O1, interest: "filing_support", selected: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "saved",
      interests: { bank_account: false, licenses_permits: false, tax_compliance: false, filing_support: true },
      license_note: null,
    });
    const { rows } = await t.pool.query(`SELECT filing_support, version FROM post_filing_interests WHERE filing_session_id = $1`, [S1]);
    expect(rows).toEqual([{ filing_support: true, version: 1 }]);
    // Not on the Deal until the picklist value exists, so each request reaches a person.
    expect(t.routeAlerts).toHaveLength(1);
    expect(t.routeAlerts[0]).toContain(S1);
    await t.post({ filing_session_id: S1, order_id: O1, interest: "bank_account", selected: true });
    expect(t.routeAlerts).toHaveLength(1);
  });

  it("keeps it out of the Zoho multi-select until the picklist value is configured", async () => {
    const t = await setup();
    await t.verifyDeal();
    await t.post({ filing_session_id: S1, order_id: O1, interest: "bank_account", selected: true });
    await t.post({ filing_session_id: S1, order_id: O1, interest: "filing_support", selected: true });
    expect((await runPostFilingSyncOnce(t.deps)).synced).toEqual([S1]);
    expect(t.calls).toEqual([`set deal-1 {"Post_Filing_Interests":["Bank Account Setup"],"Post_Filing_License_Note":null}`]);

    t.calls.length = 0;
    t.deps.config = postFilingConfig({ POST_FILING_SUPPORT_ZOHO_VALUE: "Filing Support and Strategy" });
    await t.post({ filing_session_id: S1, order_id: O1, interest: "tax_compliance", selected: true });
    expect((await runPostFilingSyncOnce(t.deps)).synced).toEqual([S1]);
    expect(t.calls).toEqual([
      `set deal-1 {"Post_Filing_Interests":["Bank Account Setup","Tax and Compliance","Filing Support and Strategy"],"Post_Filing_License_Note":null}`,
    ]);
  });

  it("behaves as switched off when 0032 is applied but 0039 is not", async () => {
    const t = await setup({ without0039: true });
    expect((await t.get(S1, O1)).status).toBe(503);
    expect((await t.post({ filing_session_id: S1, order_id: O1, interest: "bank_account", selected: true })).status).toBe(503);
  });
});

describe("realPostFilingZohoClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetZohoTokenCache();
  });

  it("sends both fields in one v8 update and reads the record status", async () => {
    const seen: Array<{ url: string; method?: string; body?: string }> = [];
    let reply: { status: number; body: unknown } = { status: 200, body: { data: [{ status: "success" }] } };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.includes("oauth")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
        seen.push({ url, method: init.method, body: init.body as string });
        return new Response(JSON.stringify(reply.body), { status: reply.status });
      }),
    );
    vi.stubEnv("ZOHO_CLIENT_ID", "id");
    vi.stubEnv("ZOHO_CLIENT_SECRET", "secret");
    vi.stubEnv("ZOHO_REFRESH_TOKEN", "refresh");
    const fields = { Post_Filing_Interests: ["Tax and Compliance"], Post_Filing_License_Note: null };
    expect(await realPostFilingZohoClient.updateDeal("d-1", fields)).toEqual({ ok: true });
    expect(seen[0]).toEqual({ url: "https://www.zohoapis.com/crm/v8/Deals/d-1", method: "PUT", body: JSON.stringify({ data: [fields] }) });

    reply = { status: 200, body: { data: [{ status: "error", code: "INVALID_DATA", message: "invalid data" }] } };
    expect(await realPostFilingZohoClient.updateDeal("d-1", fields)).toMatchObject({ ok: false, permanent: true });
    reply = { status: 401, body: { code: "OAUTH_SCOPE_MISMATCH", message: "scope" } };
    expect(await realPostFilingZohoClient.updateDeal("d-1", fields)).toMatchObject({ ok: false, permanent: true });
    reply = { status: 500, body: { code: "INTERNAL_ERROR" } };
    expect(await realPostFilingZohoClient.updateDeal("d-1", fields)).toMatchObject({ ok: false, permanent: false });
    reply = { status: 404, body: {} };
    expect(await realPostFilingZohoClient.updateDeal("d-1", fields)).toMatchObject({ ok: false, permanent: true });
  });
});
