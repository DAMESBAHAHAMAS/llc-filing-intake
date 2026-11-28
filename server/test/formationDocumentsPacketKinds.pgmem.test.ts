import { readFileSync } from "node:fs";
import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";

// Migration 0042: formation_documents can also hold the two received packet
// documents (filed Articles, IRS EIN letter). Generated kinds still need a
// template; received kinds have none and are never drafts.

const O1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const S1 = "11111111-1111-4111-8111-111111111111";

function migration(file: string): string {
  return readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8")
    .replace(/^--.*$/gm, "")
    .replace(/ALTER TABLE \w+ ENABLE ROW LEVEL SECURITY;/g, "");
}

async function setup() {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  // pg-mem names an inline CHECK "<table>_constraint_N"; Postgres names it
  // "<table>_<column>_check", which 0042 drops by name (name checked in
  // production). Give it the Postgres name so the drop is exercised here too.
  await pool.query(migration("0034_formation_documents.sql").replace(
    "kind                text NOT NULL CHECK",
    "kind                text NOT NULL CONSTRAINT formation_documents_kind_check CHECK"
  ));
  // An Operating Agreement stored before 0042 must survive it.
  await insert(pool, "operating_agreement", "operating_agreement_single_member", false);
  await pool.query(migration("0042_formation_documents_packet_kinds.sql"));
  return pool;
}

function insert(pool: { query: (sql: string, params: unknown[]) => Promise<unknown> }, kind: string, template: string | null, draft: boolean) {
  return pool.query(
    `INSERT INTO formation_documents (order_id, filing_session_id, kind, template, draft, byte_size, sha256, pdf_bytes)
     VALUES ($1, $2, $3, $4, $5, 4, 'sha', $6)`,
    [O1, S1, kind, template, draft, Buffer.from("%PDF")]
  );
}

describe("migration 0042: packet documents", () => {
  it("keeps existing rows and stores the filed Articles and the EIN letter without a template", async () => {
    const pool = await setup();
    await insert(pool, "articles_of_organization", null, false);
    await insert(pool, "ein_confirmation_letter", null, false);
    await insert(pool, "banking_resolution", "banking_resolution", false);
    const { rows } = await pool.query(`SELECT kind FROM formation_documents WHERE order_id = $1 ORDER BY kind`, [O1]);
    expect(rows.map((r: { kind: string }) => r.kind)).toEqual([
      "articles_of_organization", "banking_resolution", "ein_confirmation_letter", "operating_agreement",
    ]);
  });

  it("refuses an unknown kind", async () => {
    const pool = await setup();
    await expect(insert(pool, "cp_575_scan", null, false)).rejects.toThrow();
  });

  it("refuses a generated document without a template", async () => {
    const pool = await setup();
    await expect(insert(pool, "banking_resolution", null, false)).rejects.toThrow();
  });

  it("refuses a received document with a template or marked as a draft", async () => {
    const pool = await setup();
    await expect(insert(pool, "articles_of_organization", "articles_of_organization", false)).rejects.toThrow();
    await expect(insert(pool, "ein_confirmation_letter", null, true)).rejects.toThrow();
  });

  it("still allows only one of each document per order", async () => {
    const pool = await setup();
    await insert(pool, "ein_confirmation_letter", null, false);
    await expect(insert(pool, "ein_confirmation_letter", null, false)).rejects.toThrow();
  });
});
