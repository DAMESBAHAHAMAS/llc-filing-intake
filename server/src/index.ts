import "dotenv/config";
import express from "express";
import { corsMiddleware } from "./middleware/cors.js";
import { healthRouter } from "./routes/health.js";
import { sessionRouter } from "./routes/session.js";
import { checkoutRouter } from "./routes/checkout.js";
import { stripeWebhookRouter } from "./routes/webhooksStripe.js";
import { registeredAgentRouter } from "./routes/registeredAgent.js";
import { nameCheckRouter } from "./routes/nameCheck.js";
import { einExpressRouter } from "./routes/einExpress.js";
import { pool } from "./db/pool.js";
import { realZohoClient } from "./zoho/client.js";
import { runOnce } from "./sync/worker.js";
import { runOnce as runFulfillmentOnce } from "./fulfillment/fulfillmentWorker.js";

const app = express();

// CORS stays FIRST, ahead of the raw-body webhook mount below. Two
// reasons it has to be in this position and not after: an OPTIONS
// preflight must short-circuit (204) before any body-parsing layer
// sees it, and every response — including the webhook's and any error
// response from a route below — should carry the headers. This layer
// is a no-op for Stripe's own server-to-server webhook POST, which
// carries no Origin header: no header is set and it calls next().
// Do not reorder: without this, every browser call from the live
// frontend fails at preflight (the P0 fixed in fee74e2).
app.use(corsMiddleware);

// Stripe webhook signature verification needs the RAW request bytes.
// express.raw() is scoped by PATH to only this route (not app-wide) —
// otherwise it would consume the body stream for every other JSON route
// too, leaving express.json() below nothing to parse. This MUST still
// come before the global express.json() (frozen rule: raw-body
// middleware only on the webhook route, JSON everywhere else). For any
// path other than /api/webhooks/stripe this layer is a no-op passthrough.
app.use("/api/webhooks/stripe", express.raw({ type: "application/json" }));
app.use(stripeWebhookRouter);

app.use(express.json());
app.use(healthRouter);
app.use(sessionRouter);
app.use(checkoutRouter);
app.use(registeredAgentRouter);
app.use(nameCheckRouter);
app.use(einExpressRouter);

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

/**
 * Fulfillment poller (Gate 2) — claims orders.fulfillment_status='ready'
 * rows and drives them through PDF generation (see
 * fulfillment/fulfillmentWorker.ts for exactly how far this goes today:
 * PDF generation + filing_documents persistence, stopping at
 * 'requires_review' rather than a fabricated fax-transmission success).
 * Same in-process-poller limitation as the CRM sync poller above.
 */
const fulfillmentPollerIntervalMs = Number(process.env.FULFILLMENT_POLLER_INTERVAL_MS ?? 30_000);
if (fulfillmentPollerIntervalMs > 0) {
  setInterval(() => {
    runFulfillmentOnce(pool, `fulfillment-poller-${process.pid}`).catch((err) => {
      console.error("[fulfillment poller] tick failed", err);
    });
  }, fulfillmentPollerIntervalMs);
  console.log(`Fulfillment poller running every ${fulfillmentPollerIntervalMs}ms`);
}
