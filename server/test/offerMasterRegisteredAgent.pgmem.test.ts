import { readFileSync } from "node:fs";
import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";

/**
 * Migration 0037 (Bank-Ready includes 3 years of registered agent service, same
 * $499 and the same Stripe Price) against pg-mem. pg-mem cannot run plpgsql, so
 * each DO block is run as what it does: the retire UPDATE must touch exactly one
 * row, and afterwards there must be exactly one active FASTTRACK and no offer_code
 * with two active rows. Everything else is the migration's own SQL.
 */
const SQL = readFileSync(new URL("../migrations/0037_offer_master_bank_ready_includes_registered_agent.sql", import.meta.url), "utf8").replace(/^--.*$/gm, "");
const ROLLBACK = readFileSync(
  new URL("../migrations-rollback/0037_offer_master_bank_ready_includes_registered_agent.rollback.sql", import.meta.url),
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

/** The rows as production has them after 0029 and 0032 (the ones 0037 cares about). */
const SEED = `
  INSERT INTO offers (offer_code, offer_version, display_name, crm_intent, stripe_product_id, stripe_price_id, unit_amount_cents, inclusions, exclusions, status) VALUES
  ('FASTTRACK', 'v1', 'FastTrack', 'LLC_FORMATION_FASTTRACK', 'prod_old', 'price_old', 19900, '[]', '[]', 'retired'),
  ('FASTTRACK', 'v2', 'Florida LLC Formation — Bank-Ready', 'LLC_FORMATION_FASTTRACK', 'prod_Vg1H8gZwPtJBWj', 'price_1UefEhDo01bXdbWSei7ja3gV', 49900,
   '["Articles of Organization prepared and filed"]', '["Registered agent service beyond statutory designation (available as a separate add-on)"]', 'active'),
  ('PREMIUM', 'v3', 'Florida LLC Formation — Finance-Ready', 'LLC_FORMATION_PREMIUM', 'prod_V8sRO1rlCP2jfq', 'price_1UefElDo01bXdbWSTnb5H2yX', 99700,
   '["3 years Florida registered agent service"]', '[]', 'active'),
  ('REGISTERED_AGENT_3YR', 'v2', 'Florida Registered Agent Service — 3 Years', 'REGISTERED_AGENT', 'prod_ra', 'price_ra', 9800, '[]', '[]', 'active');
`;

type Db = { query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> };

/** Runs 0037 with its DO blocks done in JavaScript, raising as the plpgsql would. */
async function run0037(db: Db): Promise<void> {
  const blocks = SQL.split(/DO \$\$[\s\S]*?END \$\$;/);
  const doBlocks = SQL.match(/DO \$\$[\s\S]*?END \$\$;/g) ?? [];
  expect(doBlocks).toHaveLength(2);
  expect(blocks[0].trim()).toBe("");

  const retire = /(UPDATE offers SET status = 'retired'[\s\S]*?);/.exec(doBlocks[0] as string)![1] as string;
  const retired = await db.query(retire);
  if (retired.rowCount !== 1) throw new Error(`0037: expected to retire 1 active FASTTRACK v2 row at $499, retired ${retired.rowCount}`);

  await db.query(blocks[1]);

  const active = await db.query(`SELECT count(*)::int AS n FROM offers WHERE offer_code = 'FASTTRACK' AND status = 'active'`);
  if (active.rows[0].n !== 1) throw new Error(`0037: expected exactly 1 active FASTTRACK row, found ${active.rows[0].n}`);
  // pg-mem has no HAVING: the same grouping, filtered here.
  const grouped = await db.query(`SELECT offer_code, count(*)::int AS n FROM offers WHERE status = 'active' GROUP BY offer_code`);
  const dup = { rows: grouped.rows.filter((r) => (r.n as number) > 1) };
  if (dup.rows.length) throw new Error(`0037: ${dup.rows.length} offer_code(s) have more than one active row`);
  // The plpgsql guards check exactly these two queries.
  expect(doBlocks[1]).toContain("WHERE offer_code = 'FASTTRACK' AND status = 'active'");
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

describe("migration 0037: Bank-Ready includes the registered agent at the same price", () => {
  it("retires v2 and adds v3 with the same $499 amount, Product and Price", async () => {
    const db = await setup();
    await run0037(db);
    const { rows } = await db.query(
      `SELECT offer_version, status, unit_amount_cents, stripe_product_id, stripe_price_id, crm_intent, display_name, inclusions, exclusions
       FROM offers WHERE offer_code = 'FASTTRACK' ORDER BY offer_version`,
    );
    expect(rows.map((r) => [r.offer_version, r.status])).toEqual([
      ["v1", "retired"],
      ["v2", "retired"],
      ["v3", "active"],
    ]);
    const v3 = rows[2];
    expect(v3).toMatchObject({
      unit_amount_cents: 49900,
      stripe_product_id: "prod_Vg1H8gZwPtJBWj",
      stripe_price_id: "price_1UefEhDo01bXdbWSei7ja3gV",
      crm_intent: "LLC_FORMATION_FASTTRACK",
      display_name: "Florida LLC Formation — Bank-Ready",
    });
    expect(v3.inclusions).toContain("3 years Florida registered agent service");
    expect(v3.inclusions).toEqual(expect.arrayContaining(["Federal EIN (Tax ID) registration — IRS Form SS-4 prepared and filed", "Florida $125 state filing fee included"]));
    expect(v3.exclusions).toEqual([]);
  });

  it("leaves Finance-Ready and the $98 add-on alone", async () => {
    const db = await setup();
    await run0037(db);
    const { rows } = await db.query(`SELECT offer_code, offer_version, status, unit_amount_cents FROM offers WHERE offer_code <> 'FASTTRACK' ORDER BY offer_code`);
    expect(rows).toEqual([
      { offer_code: "PREMIUM", offer_version: "v3", status: "active", unit_amount_cents: 99700 },
      { offer_code: "REGISTERED_AGENT_3YR", offer_version: "v2", status: "active", unit_amount_cents: 9800 },
    ]);
  });

  it("refuses to run when v2 is not the active $499 row (already migrated, or the price drifted)", async () => {
    const db = await setup();
    await run0037(db);
    await expect(run0037(db)).rejects.toThrow(/expected to retire 1 active FASTTRACK v2 row/);

    const drifted = await setup(SEED.replace("49900,", "50000,"));
    await expect(run0037(drifted)).rejects.toThrow(/expected to retire 1/);
  });

  it("the rollback restores v2 as the active Bank-Ready", async () => {
    const db = await setup();
    await run0037(db);
    await db.query(`INSERT INTO schema_migrations VALUES ('0037_offer_master_bank_ready_includes_registered_agent')`);
    await db.query(ROLLBACK.replace(/\bBEGIN;|\bCOMMIT;/g, ""));
    const { rows } = await db.query(`SELECT offer_version, status FROM offers WHERE offer_code = 'FASTTRACK' AND status = 'active'`);
    expect(rows).toEqual([{ offer_version: "v2", status: "active" }]);
    expect((await db.query(`SELECT * FROM schema_migrations`)).rows).toEqual([]);
  });
});
