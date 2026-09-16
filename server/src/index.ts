import "dotenv/config";
import express from "express";
import { healthRouter } from "./routes/health.js";
import { sessionRouter } from "./routes/session.js";
import { registeredAgentRouter } from "./routes/registeredAgentAcceptance.js";
import { checkoutRouter } from "./routes/checkout.js";
import { stripeWebhookRouter } from "./routes/stripeWebhook.js";
import { faxMediaRouter } from "./routes/faxMedia.js";
import { pool } from "./db/pool.js";
import { realZohoClient } from "./zoho/client.js";
import { runOnce } from "./sync/worker.js";
import { runFulfillmentOnce, type FulfillmentDeps } from "./fulfillment/fulfillmentWorker.js";
import { telnyxFaxProvider } from "./fulfillment/faxProvider.js";

const app = express();

/**
 * The browser-facing frontend (florida-business-launchpad) is always a
 * different origin from this service — different port in local dev,
 * different domain in production (Render vs wherever the SPA is hosted).
 * Without this, no browser call from that frontend to any route here can
 * succeed at all; this is not optional hardening, it's required for
 * Gate 2's frontend-to-persistence connection to function. Every route
 * here is already unauthenticated by design (session.ts, checkout.ts —
 * no request carries credentials), so an open CORS policy doesn't change
 * this service's access-control posture; CORS_ALLOWED_ORIGIN narrows it
 * before going live if that's wanted. Hand-written, not the `cors`
 * package — no new dependency for three response headers.
 */
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", process.env.CORS_ALLOWED_ORIGIN ?? "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// Must be mounted BEFORE express.json() — see stripeWebhook.ts's file
// comment. It uses its own route-local express.raw() and always sends a
// response itself, so express.json() below never runs for this path.
app.use(stripeWebhookRouter);

app.use(express.json());
app.use(healthRouter);
app.use(sessionRouter);
app.use(registeredAgentRouter);
app.use(checkoutRouter);
// Public by necessity (a fax provider fetches this, carrying no
// credentials of ours) — see faxMedia.ts's own comment on why an
// unguessable per-document token is the access control here instead.
app.use(faxMediaRouter);

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
 * Fulfillment (fax transmission) poller. Same shape as the CRM poller
 * above — SYNC_POLLER_INTERVAL_MS's sibling is
 * FULFILLMENT_POLLER_INTERVAL_MS, same "0 disables it" convention (tests
 * call processOneFulfillmentJob/reconcileOneTransmission directly).
 *
 * Unlike the CRM poller, this one also refuses to start at all if its
 * required configuration is missing — FULFILLMENT_FAX_DESTINATION_NUMBER
 * and FULFILLMENT_MEDIA_BASE_URL have no safe default (an unset
 * destination must never silently resolve to "don't fax anyone," it
 * must be loud that fulfillment isn't running yet). Telnyx's own
 * credentials (TELNYX_API_KEY etc.) are NOT checked here — exactly like
 * realZohoClient/realEmailSender, telnyxFaxProvider fails clearly per-call
 * if those are missing, recorded as a normal retryable transmission
 * failure rather than blocking startup.
 */
const fulfillmentDestinationNumber = process.env.FULFILLMENT_FAX_DESTINATION_NUMBER;
const fulfillmentMediaBaseUrl = process.env.FULFILLMENT_MEDIA_BASE_URL;
const fulfillmentPollerIntervalMs = Number(process.env.FULFILLMENT_POLLER_INTERVAL_MS ?? 60_000);

if (fulfillmentPollerIntervalMs > 0 && fulfillmentDestinationNumber && fulfillmentMediaBaseUrl) {
  const fulfillmentDeps: FulfillmentDeps = {
    faxProvider: telnyxFaxProvider,
    mediaBaseUrl: fulfillmentMediaBaseUrl,
    destinationNumber: fulfillmentDestinationNumber,
    destinationLabel: process.env.FULFILLMENT_FAX_DESTINATION_LABEL,
    mediaTokenTtlMs: process.env.FULFILLMENT_MEDIA_TOKEN_TTL_MS
      ? Number(process.env.FULFILLMENT_MEDIA_TOKEN_TTL_MS)
      : undefined,
  };
  setInterval(() => {
    runFulfillmentOnce(pool, fulfillmentDeps).catch((err) => {
      console.error("[fulfillment poller] tick failed", err);
    });
  }, fulfillmentPollerIntervalMs);
  console.log(
    `Fulfillment (fax) poller running every ${fulfillmentPollerIntervalMs}ms, destination: ${
      fulfillmentDeps.destinationLabel ?? "(unlabeled) "
    }${fulfillmentDestinationNumber}`
  );
} else if (fulfillmentPollerIntervalMs > 0) {
  console.log(
    "Fulfillment (fax) poller NOT started — FULFILLMENT_FAX_DESTINATION_NUMBER and/or FULFILLMENT_MEDIA_BASE_URL is unset."
  );
}
