import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

/**
 * Bootstrap only — creates the tracking table itself. This is
 * intentionally NOT a numbered migration file: it has to exist before
 * any migration file can be recorded against it.
 */
export async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function getAppliedVersions(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ version: string }>(
    "SELECT version FROM schema_migrations ORDER BY version ASC"
  );
  return rows.map((r) => r.version);
}

export async function getLatestAppliedVersion(pool: Pool): Promise<string | null> {
  const applied = await getAppliedVersions(pool);
  return applied.length ? applied[applied.length - 1] : null;
}

function listMigrationFiles(): string[] {
  try {
    return readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Applies every migrations/*.sql file not yet recorded in
 * schema_migrations, in filename order, each inside its own transaction.
 * Safe to run with zero migration files present (no-op).
 */
export async function runMigrations(pool: Pool): Promise<{ applied: string[]; skipped: string[] }> {
  await ensureMigrationsTable(pool);
  const already = new Set(await getAppliedVersions(pool));
  const files = listMigrationFiles();

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (already.has(version)) {
      skipped.push(version);
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      await client.query("COMMIT");
      applied.push(version);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file} failed and was rolled back: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
}
