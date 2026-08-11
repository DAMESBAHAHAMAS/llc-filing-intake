import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import {
  ensureMigrationsTable,
  getAppliedVersions,
  getLatestAppliedVersion,
} from "../src/db/migrationRunner.js";

// pg-mem, not a real Postgres — fine for exercising the tracking-table
// logic in isolation. runMigrations() itself (which reads migrations/*.sql
// off disk) is proven against the real Supabase instance per DEPLOY.md,
// not re-tested against pg-mem here.
function makeMemPool() {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  return new adapter.Pool();
}

describe("migrationRunner bootstrap", () => {
  // Re-running CREATE TABLE IF NOT EXISTS against an already-existing table
  // is standard, well-established Postgres semantics — not re-verified here
  // because pg-mem itself can't parse a second CREATE TABLE IF NOT EXISTS
  // against the same table yet (upstream limitation: re-running the exact
  // same DDL trips its AST-coverage checker on the no-op path). This is
  // exercised for real by `npm run migrate` being safe to run repeatedly
  // against the actual Supabase instance — see DEPLOY.md step 2.
  it("creates schema_migrations and starts empty", async () => {
    const pool = makeMemPool();
    await ensureMigrationsTable(pool);
    expect(await getAppliedVersions(pool)).toEqual([]);
    expect(await getLatestAppliedVersion(pool)).toBeNull();
  });

  it("reports the latest version once rows exist", async () => {
    const pool = makeMemPool();
    await ensureMigrationsTable(pool);
    await pool.query("INSERT INTO schema_migrations (version) VALUES ($1)", ["0001_init"]);
    await pool.query("INSERT INTO schema_migrations (version) VALUES ($1)", ["0002_next"]);
    expect(await getAppliedVersions(pool)).toEqual(["0001_init", "0002_next"]);
    expect(await getLatestAppliedVersion(pool)).toBe("0002_next");
  });
});
