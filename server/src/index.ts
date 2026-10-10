import "dotenv/config";
import express from "express";
import { corsMiddleware } from "./middleware/cors.js";
import { applyFunnelProtection } from "./middleware/funnelProtection.js";
import { healthRouter } from "./routes/health.js";
import { sessionRouter } from "./routes/session.js";
import { checkoutRouter } from "./routes/checkout.js";
import { stripeWebhookRouter } from "./routes/webhooksStripe.js";
import { registeredAgentRouter } from "./routes/registeredAgent.js";
import { nameCheckRouter } from "./routes/nameCheck.js";
import { einExpressRouter } from "./routes/einExpress.js";
import { offersRouter } from "./routes/offers.js";
import { filingDocumentRouter } from "./routes/filingDocument.js";
import { ordersRouter } from "./routes/orders.js";
import { scorecardRouter } from "./routes/scorecard.js";
import { runScorecardTick } from "./scorecard/service.js";
import { realScorecardSender } from "./scorecard/sender.js";
import { runHoldSweepOnce } from "./fulfillment/holdSweep.js";
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

// Per-IP limits (429) and the Turnstile bot check on the public funnel
// endpoints; see middleware/funnelProtection.ts.
applyFunnelProtection(app);

app.use(healthRouter);
app.use(sessionRouter);
app.use(checkoutRouter);
app.use(registeredAgentRouter);
app.use(nameCheckRouter);
app.use(einExpressRouter);
app.use(offersRouter);
app.use(filingDocumentRouter);
app.use(ordersRouter);
app.use(scorecardRouter);

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

/**
 * Card-hold watch (pay-after-filing): records hold expiry times and flags
 * held orders nearing expiry without proof of filing. Every 15 minutes by
 * default; HOLD_SWEEP_INTERVAL_MS=0 disables it.
 */
const holdSweepIntervalMs = Number(process.env.HOLD_SWEEP_INTERVAL_MS ?? 15 * 60_000);
if (holdSweepIntervalMs > 0) {
  setInterval(() => {
    runHoldSweepOnce(pool).catch((err) => {
      console.error("[hold sweep] tick failed", err);
    });
  }, holdSweepIntervalMs);
  console.log(`Card-hold watch running every ${holdSweepIntervalMs}ms`);
}

/**
 * Scorecard lead funnel (SA4-T38): retries unsynced CRM Leads and sends due
 * emails. Every 30 seconds by default; SCORECARD_POLLER_INTERVAL_MS=0 disables.
 */
const scorecardPollerIntervalMs = Number(process.env.SCORECARD_POLLER_INTERVAL_MS ?? 30_000);
if (scorecardPollerIntervalMs > 0) {
  setInterval(() => {
    runScorecardTick(pool, { sender: realScorecardSender }).catch((err) => {
      console.error("[scorecard poller] tick failed", err);
    });
  }, scorecardPollerIntervalMs);
  console.log(`Scorecard poller running every ${scorecardPollerIntervalMs}ms`);
}
