import { Router } from "express";
import { pool } from "../db/pool.js";
import { getLatestAppliedVersion } from "../db/migrationRunner.js";
import { describeError } from "../db/describeError.js";

export const healthRouter = Router();

async function checkDb(): Promise<{ db: "connected" | "error"; migrations: string | null; error?: string }> {
  try {
    await pool.query("SELECT 1");
    const migrations = await getLatestAppliedVersion(pool);
    return { db: "connected", migrations };
  } catch (err) {
    return { db: "error", migrations: null, error: describeError(err) };
  }
}

// Always 200 — a paused/unreachable Supabase project (see Supabase
// free-tier constraints) must not flap Render's health check into
// restarting a perfectly healthy Express process. The db field, not
// the HTTP status, carries the DB signal. This is what Render's own
// health check path points at.
healthRouter.get("/health", async (_req, res) => {
  const result = await checkDb();
  res.status(200).json({ status: "ok", ...result });
});

// Unlike /health, this DOES fail the HTTP status (503) when the DB is
// unreachable — for our own manual verification and for the sync
// worker to gate on later (e.g. don't start claiming queue rows until
// this is 200). Not wired to Render's health check.
healthRouter.get("/ready", async (_req, res) => {
  const result = await checkDb();
  res.status(result.db === "connected" ? 200 : 503).json(result);
});
