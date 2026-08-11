import { Router } from "express";
import { pool } from "../db/pool.js";
import { getLatestAppliedVersion } from "../db/migrationRunner.js";
import { describeError } from "../db/describeError.js";

export const healthRouter = Router();

healthRouter.get("/health", async (_req, res) => {
  // Always 200 — a paused/unreachable Supabase project (see Supabase
  // free-tier constraints) must not flap Render's health check into
  // restarting a perfectly healthy Express process. The db field, not
  // the HTTP status, carries the DB signal.
  try {
    await pool.query("SELECT 1");
    const migrations = await getLatestAppliedVersion(pool);
    res.status(200).json({ status: "ok", db: "connected", migrations });
  } catch (err) {
    res.status(200).json({
      status: "ok",
      db: "error",
      migrations: null,
      error: describeError(err),
    });
  }
});
