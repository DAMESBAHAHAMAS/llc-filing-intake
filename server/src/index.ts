import "dotenv/config";
import express from "express";
import { corsMiddleware } from "./middleware/cors.js";
import { healthRouter } from "./routes/health.js";
import { sessionRouter } from "./routes/session.js";
import { pool } from "./db/pool.js";
import { realZohoClient } from "./zoho/client.js";
import { runOnce } from "./sync/worker.js";

const app = express();

app.use(corsMiddleware);
app.use(express.json());
app.use(healthRouter);
app.use(sessionRouter);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`llc-data-spine listening on :${port}`);
});

/**
 * In-process poller. Configurable via env so it can be tuned without a
 * code change (DECISIONS.md). Set SYNC_POLLER_INTERVAL_MS=0 to disable
 * (e.g. in tests, which call the worker functions directly instead).
 * Known limitation, already logged: this poller stops while the process
 * is asleep/restarting — the Render Cron Job sweeper backstop
 * (DEPLOY.md, "Sync-worker hardening") is the independent safety net
 * for that, not yet built.
 */
const pollerIntervalMs = Number(process.env.SYNC_POLLER_INTERVAL_MS ?? 30_000);
if (pollerIntervalMs > 0) {
  setInterval(() => {
    runOnce(pool, realZohoClient, `poller-${process.pid}`).catch((err) => {
      console.error("[sync poller] tick failed", err);
    });
  }, pollerIntervalMs);
  console.log(`CRM sync poller running every ${pollerIntervalMs}ms`);
}
