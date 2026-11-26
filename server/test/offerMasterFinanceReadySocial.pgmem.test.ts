import { readFileSync } from "node:fs";
import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";

/**
 * Migration 0041 (Finance-Ready adds "3 Branded Social Media Profiles + 3 Launch Posts", same
 * $997 and the same Stripe Price) against pg-mem. pg-mem cannot run plpgsql, so each DO block is
 * run as what it does: the retire UPDATE must touch exactly one row, and afterwards there must be
 * exactly one active PREMIUM and no offer_code with two active rows. Everything else is the
 * migration's own SQL.
 */
const SQL = readFileSync(new URL("../migrations/0041_offer_master_finance_ready_social_profiles.sql", import.meta.url), "utf8").replace(/^--.*$/gm, "");
const ROLLBACK = readFileSync(
  new URL("../migrations-rollback/0041_offer_master_finance_ready_social_profiles.rollback.sql", import.meta.url),
  "utf8",
).replace(/^--.*$/gm, "");

const SCHEMA = `
  CREATE TABLE schema_migrations (version text PRIMARY KEY);
  CREATE TABLE offers (
    id bigserial PRIMARY KEY,
    offer_code text NOT NULL, offer_version text NOT NULL, display_name text NOT NULL, crm_intent text NOT NULL,
    stripe_product_id text NOT NULL, stripe_price_id text NOT NULL, unit_amount_cents integer NOT NULL,
    currency text NOT NULL DEFAULT 'usd', internal_cost_cents integer,
    inclusions jsonb NOT NULL DEFAULT '[]'::jsonb, exclusions jsonb NOT NULL DEFAULT '[]'::jsonb,
    sla_clock_start text, status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')), notes text,
    UNIQUE (offer_code, offer_version)
  );
`;

/** PREMIUM v3 exactly as 0032 created it, plus the rows 0041 must leave alone. */
/** v3's inclusions read from 0032 itself, so "v4 = v3 + one line" is pinned to the real v3 record. */
const V3_INCLUSIONS = JSON.parse(
  /'(\["Everything in Bank-Ready"[\s\S]*?\])'::jsonb/.exec(readFileSync(new URL("../migrations/0032_offer_master_finance_ready.sql", import.meta.url), "utf8"))![1] as string,
) as string[];
const SOCIAL = "3 Branded Social Media Profiles + 3 Launch Posts";
const SEED = `
  INSERT INTO offers (offer_code, offer_version, display_name, crm_intent, stripe_product_id, stripe_price_id, unit_amount_cents, inclusions, exclusions, status) VALUES
  ('PREMIUM', 'v2', 'Florida LLC Formation — Premium', 'LLC_FORMATION_PREMIUM', 'prod_V8sRO1rlCP2jfq', 'price_1UefElDo01bXdbWSTnb5H2yX', 99700, '[]', '[]', 'retired'),
  ('PREMIUM', 'v3', 'Florida LLC Formation — Finance-Ready', 'LLC_FORMATION_PREMIUM', 'prod_V8sRO1rlCP2jfq', 'price_1UefElDo01bXdbWSTnb5H2yX', 99700,
   '${JSON.stringify(V3_INCLUSIONS)}', '[]', 'active'),
  ('FASTTRACK', 'v3', 'Florida LLC Formation — Bank-Ready', 'LLC_FORMATION_FASTTRACK', 'prod_Vg1H8gZwPtJBWj', 'price_1UefEhDo01bXdbWSei7ja3gV', 49900, '[]', '[]', 'active'),
  ('REGISTERED_AGENT_3YR', 'v2', 'Florida Registered Agent Service — 3 Years', 'REGISTERED_AGENT', 'prod_ra', 'price_ra', 9800, '[]', '[]', 'active');
`;

type Db = { query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> };

/** Runs 0041 with its DO blocks done in JavaScript, raising as the plpgsql would. */
async function run0041(db: Db): Promise<void> {
  const blocks = SQL.split(/DO \$\$[\s\S]*?END \$\$;/);
  const doBlocks = SQL.match(/DO \$\$[\s\S]*?END \$\$;/g) ?? [];
  expect(doBlocks).toHaveLength(2);
  expect(blocks[0].trim()).toBe("");

  const retire = /(UPDATE offers SET status = 'retired'[\s\S]*?);/.exec(doBlocks[0] as string)![1] as string;
  const retired = await db.query(retire);
  if (retired.rowCount !== 1) throw new Error(`0041: expected to retire 1 active PREMIUM v3 row at $997, retired ${retired.rowCount}`);

  await db.query(blocks[1]);

  const active = await db.query(`SELECT count(*)::int AS n FROM offers WHERE offer_code = 'PREMIUM' AND status = 'active'`);
  if (active.rows[0].n !== 1) throw new Error(`0041: expected exactly 1 active PREMIUM row, found ${active.rows[0].n}`);
  // pg-mem has no HAVING: the same grouping, filtered here.
  const grouped = await db.query(`SELECT offer_code, count(*)::int AS n FROM offers WHERE status = 'active' GROUP BY offer_code`);
  const dup = grouped.rows.filter((r) => (r.n as number) > 1);
  if (dup.length) throw new Error(`0041: ${dup.length} offer_code(s) have more than one active row`);
  // The plpgsql guards check exactly these two queries.
  expect(doBlocks[1]).toContain("WHERE offer_code = 'PREMIUM' AND status = 'active'");
  expect(doBlocks[1]).toContain("GROUP BY offer_code HAVING count(*) > 1");
}

async function setup(seed = SEED) {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool() as unknown as Db;
  await pool.query(SCHEMA);
  await pool.query(seed);
  return pool;
}

describe("migration 0041: Finance-Ready adds social profiles at the same price", () => {
  it("retires v3 and adds v4 with the same $997 amount, Product, Price and CRM intent", async () => {
    const db = await setup();
    await run0041(db);
    const { rows } = await db.query(
      `SELECT offer_version, status, unit_amount_cents, stripe_product_id, stripe_price_id, crm_intent, display_name, inclusions, exclusions, sla_clock_start
       FROM offers WHERE offer_code = 'PREMIUM' ORDER BY offer_version`,
    );
    expect(rows.map((r) => [r.offer_version, r.status])).toEqual([
      ["v2", "retired"],
      ["v3", "retired"],
      ["v4", "active"],
    ]);
    expect(rows[2]).toMatchObject({
      unit_amount_cents: 99700,
      stripe_product_id: "prod_V8sRO1rlCP2jfq",
      stripe_price_id: "price_1UefElDo01bXdbWSTnb5H2yX",
      crm_intent: "LLC_FORMATION_PREMIUM",
      display_name: "Florida LLC Formation — Finance-Ready",
      sla_clock_start: "on_payment_confirmed",
    });
    expect(rows[2].exclusions).toEqual([]);
  });

  it("v4's inclusions are v3's, in order, with the social line after the website line (the website card's exact text)", async () => {
    const db = await setup();
    await run0041(db);
    const { rows } = await db.query(`SELECT inclusions FROM offers WHERE offer_code = 'PREMIUM' AND offer_version = 'v4'`);
    expect(rows[0].inclusions).toEqual([...V3_INCLUSIONS.slice(0, 7), SOCIAL, ...V3_INCLUSIONS.slice(7)]);
  });

  it("leaves v3's own record, Bank-Ready and the $98 add-on alone", async () => {
    const db = await setup();
    await run0041(db);
    const v3 = await db.query(`SELECT inclusions FROM offers WHERE offer_code = 'PREMIUM' AND offer_version = 'v3'`);
    expect(v3.rows[0].inclusions).toEqual(V3_INCLUSIONS);
    const { rows } = await db.query(`SELECT offer_code, offer_version, status, unit_amount_cents FROM offers WHERE offer_code <> 'PREMIUM' ORDER BY offer_code`);
    expect(rows).toEqual([
      { offer_code: "FASTTRACK", offer_version: "v3", status: "active", unit_amount_cents: 49900 },
      { offer_code: "REGISTERED_AGENT_3YR", offer_version: "v2", status: "active", unit_amount_cents: 9800 },
    ]);
  });

  it("refuses to run when v3 is not the active $997 row (already migrated, or the price drifted)", async () => {
    const db = await setup();
    await run0041(db);
    await expect(run0041(db)).rejects.toThrow(/expected to retire 1 active PREMIUM v3 row/);

    const drifted = await setup(SEED.replace("99700,\n   '[", "99800,\n   '["));
    await expect(run0041(drifted)).rejects.toThrow(/expected to retire 1/);
  });

  it("v3 really is 0032's nine lines (read from the 0032 migration file)", () => {
    // pg-mem misreads the partial idx_offers_one_active_per_code index (retired rows drop out of
    // later scans), so the schema here omits it; the 0041 guards check one active PREMIUM instead.
    expect(V3_INCLUSIONS).toHaveLength(9);
    expect(V3_INCLUSIONS[0]).toBe("Everything in Bank-Ready");
    expect(V3_INCLUSIONS[8]).toBe("Strategy kickoff call with Damian to set your custom scope");
  });

  it("the rollback restores v3 as the active Finance-Ready", async () => {
    const db = await setup();
    await run0041(db);
    await db.query(`INSERT INTO schema_migrations VALUES ('0041_offer_master_finance_ready_social_profiles')`);
    await db.query(ROLLBACK.replace(/\bBEGIN;|\bCOMMIT;/g, ""));
    const { rows } = await db.query(`SELECT offer_version, status FROM offers WHERE offer_code = 'PREMIUM' AND status = 'active'`);
    expect(rows).toEqual([{ offer_version: "v3", status: "active" }]);
    expect((await db.query(`SELECT * FROM schema_migrations`)).rows).toEqual([]);
  });
});
