import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards migration 0029 (Bank-Ready $499 all-inclusive, Premium $997). It reads
 * the SQL text because the migration runs against the real database; these
 * checks catch the mistakes that would be expensive there: a placeholder id, a
 * v2 row inserted before v1 is retired (the one-active-per-code index would
 * reject it), a wrong amount, or an EIN/Kit exclusion that contradicts the tier.
 */
const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "0029_offer_master_bank_ready_premium_997.sql"), "utf8");
const rollback = readFileSync(
  join(here, "..", "migrations-rollback", "0029_offer_master_bank_ready_premium_997.rollback.sql"),
  "utf8",
);
const code = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");

describe("migration 0029: Bank-Ready and Premium offers", () => {
  it("retires the v1 rows before inserting v2 (one active version per offer_code)", () => {
    expect(code.indexOf("SET status = 'retired'")).toBeGreaterThan(-1);
    expect(code.indexOf("SET status = 'retired'")).toBeLessThan(code.indexOf("INSERT INTO offers"));
  });

  it("fails loudly unless exactly the two expected v1 rows were retired", () => {
    expect(code).toMatch(/retired <> 2/);
  });

  it("charges $499 for Bank-Ready and $997 for Premium, with real Stripe ids", () => {
    expect(code).toMatch(/'FASTTRACK', 'v2'[\s\S]*?'prod_Vg1H8gZwPtJBWj', 'price_1UefEhDo01bXdbWSei7ja3gV', 49900/);
    expect(code).toMatch(/'PREMIUM', 'v2'[\s\S]*?'prod_V8sRO1rlCP2jfq', 'price_1UefElDo01bXdbWSTnb5H2yX', 99700/);
    const inserted = code.slice(code.indexOf("INSERT INTO offers"));
    expect(inserted).not.toMatch(/__|PLACEHOLDER|price_XXXX/i);
  });

  it("Bank-Ready includes everything the pricing page promises, and the state fee", () => {
    const bankReady = code.slice(code.indexOf("'FASTTRACK', 'v2'"), code.indexOf("'PREMIUM', 'v2'"));
    for (const promise of [
      "Florida $125 state filing fee included",
      "Federal EIN",
      "Custom Operating Agreement and Banking Resolution",
      "Florida commercial mailing address",
      "Hardbound Company Credentials Kit",
    ]) {
      expect(bankReady, promise).toContain(promise);
    }
  });

  it("no longer excludes EIN or the Credentials Kit from Bank-Ready", () => {
    const bankReady = code.slice(code.indexOf("'FASTTRACK', 'v2'"), code.indexOf("'PREMIUM', 'v2'"));
    const exclusions = bankReady.match(/'\[[^']*\]'::jsonb,\s*'(\[[^']*\])'::jsonb/)?.[1] ?? "";
    expect(exclusions).not.toMatch(/EIN|Credentials Kit/i);
  });

  it("keeps the internal FASTTRACK code and the CRM intent that other code keys off", () => {
    expect(code).toContain("'LLC_FORMATION_FASTTRACK'");
    expect(code).toContain("'LLC_FORMATION_PREMIUM'");
  });

  it("has a rollback that restores v1 and clears the migration record", () => {
    expect(rollback).toMatch(/DELETE FROM offers[\s\S]*offer_version = 'v2'/);
    expect(rollback).toMatch(/SET status = 'active'[\s\S]*offer_version = 'v1'/);
    expect(rollback).toContain("DELETE FROM schema_migrations WHERE version = '0029_offer_master_bank_ready_premium_997'");
  });
});
