import { readFileSync } from "node:fs";
import { newDb } from "pg-mem";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://unused.invalid/none";
});
import { einPortalConfig } from "../src/ein/onboarding.js";
import { einInviteExpected, registerEinDeals, runEinPortalInvitesOnce, runEinPortalSweepOnce, type EinPortalDeps } from "../src/ein/portalJobs.js";
import type { DealSnapshot, EinPortalClient } from "../src/zoho/einPortal.js";

/**
 * ST17: the EIN-portal jobs' real SQL against pg-mem, with migration 0030 as written
 * (minus what pg-mem cannot run: partial-index WHERE clauses and RLS). The other
 * tables use the columns the migrations leave them with, as in helpers/orderEmailDb.ts.
 * pg-mem is not Postgres; run the SQL once against a scratch Postgres before switching on.
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
    .replace(/ALTER TABLE \w+ ENABLE ROW LEVEL SECURITY;/g, "");
}

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const O1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const O2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const O3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const O4 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
const NOW = new Date("2026-11-25T12:00:00Z");

async function setup() {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await pool.query(BASE);
  await pool.query(migration("0030_ein_portal_deals.sql"));
  await pool.query(migration("0031_ein_portal_deals_failures.sql"));
  await pool.query(`INSERT INTO filing_sessions VALUES ('${S1}', 'ada@example.test'), ('${S2}', 'eve@example.test')`);
  const ein = JSON.stringify([{ offer_code: "FASTTRACK" }]);
  const diy = JSON.stringify([{ offer_code: "DIY_STATE_FEE" }]);
  await pool.query(
    `INSERT INTO orders VALUES
       ($1, $5, $7, 'authorized', NULL, '2026-11-25T10:00:00Z', 'deal-1'),
       ($2, $5, $7, 'paid', '2026-11-25T11:00:00Z', NULL, 'deal-1'),
       ($3, $5, $8, 'paid', '2026-11-25T11:00:00Z', NULL, 'deal-2'),
       ($4, $6, $7, 'paid', '2026-11-25T11:00:00Z', NULL, 'deal-victim')`,
    [O1, O2, O3, O4, S1, S2, ein, diy],
  );
  // O1: ownership-verified stage update. O2: server-created Deal. O3: DIY (no EIN).
  // O4: a browser-supplied Deal id whose ownership check failed (dead_letter).
  await pool.query(
    `INSERT INTO crm_sync_queue (filing_session_id, order_id, sync_type, payload_snapshot, status) VALUES
       ($1, $2, 'deal_stage_update', '{"crm_deal_id":"deal-1"}', 'synced'),
       ($1, $3, 'order_deal', '{}', 'synced'),
       ($1, $4, 'order_deal', '{}', 'synced'),
       ($5, $6, 'deal_stage_update', '{"crm_deal_id":"deal-victim"}', 'dead_letter')`,
    [S1, O1, O2, O3, S2, O4],
  );
  const zohoDeals = new Map<string, DealSnapshot>([
    ["deal-1", { stage: "Cancelled", paymentStatus: null, docsReceived: false, passportFiles: [{ id: "img-1" }], einIssuedDate: null }],
  ]);
  const calls: string[] = [];
  const zoho: EinPortalClient = {
    inviteDealContact: async (dealId, email) => {
      calls.push(`invite ${dealId} ${email}`);
      return { ok: true, value: { contactId: "c-1" } };
    },
    readDeal: async (dealId) => {
      calls.push(`read ${dealId}`);
      const d = zohoDeals.get(dealId);
      return d ? { ok: true, value: structuredClone(d) } : { ok: false, permanent: true, error: "not found" };
    },
    markDocsReceived: async (dealId) => {
      calls.push(`mark ${dealId}`);
      return { ok: true };
    },
    clearImageField: async (dealId) => {
      calls.push(`clear ${dealId}`);
      return { ok: true };
    },
  };
  let now = NOW;
  const deps: EinPortalDeps = {
    db: pool,
    zoho,
    config: einPortalConfig({ EIN_ONBOARDING_ENABLED: "true", EIN_PORTAL_URL: "https://portal.example.test", EIN_PORTAL_USER_TYPE_ID: "123" }),
    now: () => now,
    alert: async () => {},
  };
  return { pool, deps, calls, setNow: (d: Date) => (now = d) };
}

describe("EIN portal jobs against pg-mem", () => {
  it("registers one row per verified EIN Deal, invites it once, and sweeps it", async () => {
    const t = await setup();
    expect(await registerEinDeals(t.deps)).toBe(1);
    const { rows } = await t.pool.query(`SELECT zoho_deal_id, first_order_id, invite_status FROM ein_portal_deals`);
    expect(rows).toEqual([{ zoho_deal_id: "deal-1", first_order_id: O1, invite_status: "pending" }]);

    expect((await runEinPortalInvitesOnce(t.deps)).invited).toEqual(["deal-1"]);
    expect((await runEinPortalInvitesOnce(t.deps)).invited).toEqual([]);
    expect(t.calls).toEqual(["invite deal-1 ada@example.test"]);

    const sweep = await runEinPortalSweepOnce(t.deps);
    expect(sweep).toEqual({ docsReceived: ["deal-1"], purged: [], errors: [] });
    const after = (await t.pool.query(`SELECT docs_received_at, closed_seen_at, next_check_at FROM ein_portal_deals`)).rows[0];
    expect(new Date(after.docs_received_at)).toEqual(NOW);
    expect(new Date(after.closed_seen_at)).toEqual(NOW);

    t.setNow(new Date(NOW.getTime() + 29 * 86_400_000));
    expect((await runEinPortalSweepOnce(t.deps)).purged).toEqual(["deal-1"]);
  });

  it("treats the Deal as refunded only when every verified EIN order on it is refunded", async () => {
    const t = await setup();
    await registerEinDeals(t.deps);
    await t.pool.query(`UPDATE ein_portal_deals SET docs_received_at = $1`, [NOW]);
    const zohoNotCancelled = t.deps.zoho;
    t.deps.zoho = { ...zohoNotCancelled, readDeal: async () => ({ ok: true, value: { stage: "Paid", paymentStatus: null, docsReceived: true, passportFiles: [{ id: "i" }], einIssuedDate: null } }) };
    await t.pool.query(`UPDATE orders SET payment_status = 'refunded' WHERE order_id = $1`, [O1]);
    await runEinPortalSweepOnce(t.deps);
    expect((await t.pool.query(`SELECT closed_seen_at FROM ein_portal_deals`)).rows[0].closed_seen_at).toBeNull();
    await t.pool.query(`UPDATE orders SET payment_status = 'refunded' WHERE order_id = $1`, [O2]);
    await runEinPortalSweepOnce(t.deps);
    expect((await t.pool.query(`SELECT closed_seen_at FROM ein_portal_deals`)).rows[0].closed_seen_at).not.toBeNull();
  });

  it("expects an invite only for an EIN order whose Deal came from intake, not one this server created", async () => {
    const t = await setup();
    // O1 (EIN, Deal id set at payment, no order_deal job): an invite can go out.
    expect(await einInviteExpected(t.pool, { orderId: O1 })).toBe(true);
    expect(await einInviteExpected(t.pool, { filingSessionId: S1 })).toBe(true);
    // O2 (EIN, Deal created by this server through an order_deal job): no Contact, no promise.
    expect(await einInviteExpected(t.pool, { orderId: O2 })).toBe(false);
    // O3 (DIY, no EIN): nothing to promise.
    expect(await einInviteExpected(t.pool, { orderId: O3 })).toBe(false);
    // An EIN order with no Deal id yet: no promise.
    await t.pool.query(`UPDATE orders SET crm_deal_id = NULL WHERE order_id = $1`, [O1]);
    expect(await einInviteExpected(t.pool, { orderId: O1 })).toBe(false);
  });

  it("records a failing Deal read in failing_since (migration 0031) and clears it after a good pass", async () => {
    const t = await setup();
    const readDeal = t.deps.zoho.readDeal;
    t.deps.zoho = { ...t.deps.zoho, readDeal: async () => ({ ok: false, error: "Zoho Deal read failed: 500" }) };
    await runEinPortalSweepOnce(t.deps);
    let row = (await t.pool.query(`SELECT last_error, failing_since FROM ein_portal_deals`)).rows[0];
    expect(row.last_error).toBe("Deal read failed: Zoho Deal read failed: 500");
    expect(new Date(row.failing_since)).toEqual(NOW);
    t.deps.zoho = { ...t.deps.zoho, readDeal };
    t.setNow(new Date(NOW.getTime() + 3600_000));
    await runEinPortalSweepOnce(t.deps);
    row = (await t.pool.query(`SELECT last_error, failing_since FROM ein_portal_deals`)).rows[0];
    expect(row).toEqual({ last_error: null, failing_since: null });
  });
});
