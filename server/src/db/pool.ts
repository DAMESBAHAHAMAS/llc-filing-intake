import { Pool } from "pg";

/**
 * Supabase free tier: shared-CPU Micro instance, limited connection
 * headroom. max: 5 is deliberate — do not raise it without confirming
 * the project's plan has changed. An exhausted pool here presents as
 * hung requests, not an obvious pool-size error, so this comment is
 * the trail back to why it's capped.
 */
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set. See .env.example.");
}

export const pool = new Pool({
  connectionString,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: process.env.PGSSL_DISABLE === "true" ? false : { rejectUnauthorized: false },
});

pool.on("error", (err) => {
  // A background/idle client emitted an error (e.g. Supabase paused the
  // project mid-connection). Log it; do not crash the process over an
  // idle-connection error — an in-flight request's own error handling
  // covers the request-facing failure.
  console.error("[pg pool] unexpected error on idle client", err);
});
