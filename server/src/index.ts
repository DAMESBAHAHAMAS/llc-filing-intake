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
import { einOnboardingRouter } from "./routes/einOnboarding.js";
import { postFilingInterestsRouter } from "./routes/postFilingInterests.js";
import { formationDocumentsRouter } from "./routes/formationDocuments.js";
import { defaultOaDeps, isMissingTable, runOperatingAgreementJobOnce } from "./formation/operatingAgreementJob.js";
import { defaultPostFilingDeps, runPostFilingSyncOnce } from "./postFiling/interests.js";
import { defaultEinPortalDeps, runEinPortalInvitesOnce, runEinPortalSweepOnce } from "./ein/portalJobs.js";
import { einPortalConfig, einPortalConfigIssues } from "./ein/onboarding.js";
import { sendOpsAlert } from "./ops/alerts.js";
import { runScorecardTick } from "./scorecard/service.js";
import { realScorecardSender } from "./scorecard/sender.js";
import { runHoldSweepOnce } from "./fulfillment/holdSweep.js";
import { holdReleaseConfig, runHoldReleaseOnce } from "./payments/holdRelease.js";
import { realOrderEmailSender } from "./orderEmails/sender.js";
import { runOnce as runOrderEmailsOnce } from "./orderEmails/worker.js";
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
app.use(einOnboardingRouter);
app.use(postFilingInterestsRouter);
app.use(formationDocumentsRouter);

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
 * held orders nearing expiry without proof of filing, then runs the Day-5
 * release (payments/holdRelease.ts: HOLD_RELEASE_ENABLED, HOLD_RELEASE_START).
 * Every 15 minutes by default; HOLD_SWEEP_INTERVAL_MS=0 disables both.
 */
const holdSweepIntervalMs = Number(process.env.HOLD_SWEEP_INTERVAL_MS ?? 15 * 60_000);
if (holdSweepIntervalMs > 0) {
  setInterval(() => {
    runHoldSweepOnce(pool)
      .catch((err) => {
        console.error("[hold sweep] tick failed", err);
      })
      .then(() => runHoldReleaseOnce(pool))
      .catch((err) => {
        console.error("[hold release] tick failed", err);
      });
  }, holdSweepIntervalMs);
  const release = holdReleaseConfig();
  console.log(
    `Card-hold watch running every ${holdSweepIntervalMs}ms; Day-5 release ${
      release.error ? `NOT running (${release.error})` : release.enabled ? `on for holds placed since ${release.start.toISOString()}, after ${release.afterHours}h` : "off (HOLD_RELEASE_ENABLED)"
    }`
  );
}

/**
 * Customer order emails: sends what the Stripe webhook and proof-of-filing
 * route queued (orderEmails/worker.ts). Every 30 seconds by default;
 * ORDER_EMAIL_POLLER_INTERVAL_MS=0 disables.
 */
const orderEmailPollerIntervalMs = Number(process.env.ORDER_EMAIL_POLLER_INTERVAL_MS ?? 30_000);
if (orderEmailPollerIntervalMs > 0) {
  setInterval(() => {
    runOrderEmailsOnce(pool, realOrderEmailSender, `order-email-poller-${process.pid}`).catch((err) => {
      console.error("[order email poller] tick failed", err);
    });
  }, orderEmailPollerIntervalMs);
  console.log(`Order email poller running every ${orderEmailPollerIntervalMs}ms`);
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

/**
 * ST17 EIN onboarding through the Zoho CRM Portal (ein/portalJobs.ts). Both jobs do
 * nothing unless EIN_ONBOARDING_ENABLED=true and their settings are present.
 * Invites every 10 minutes by default (EIN_PORTAL_INVITE_INTERVAL_MS). The
 * docs-received / passport-retention sweep runs hourly by default
 * (EIN_PORTAL_SWEEP_INTERVAL_MS), not daily: a 24-hour timer restarts on every
 * deploy and could go days without firing. Each pass is idempotent. 0 disables either.
 */
// Unusable EIN portal settings are reported once at startup, only when switched on.
if (einPortalConfig().enabled) {
  const issues = einPortalConfigIssues();
  if (issues.length > 0) {
    console.error("[ein portal] configuration issues:", issues);
    sendOpsAlert("EIN portal settings need attention", issues.join("\n")).catch((err) => {
      console.error("[ein portal] config alert failed", err);
    });
  }
}
const einInviteIntervalMs = Number(process.env.EIN_PORTAL_INVITE_INTERVAL_MS ?? 10 * 60_000);
if (einInviteIntervalMs > 0) {
  setInterval(() => {
    runEinPortalInvitesOnce(defaultEinPortalDeps(pool)).catch((err) => {
      console.error("[ein portal invites] tick failed", err);
    });
  }, einInviteIntervalMs);
}
const einSweepIntervalMs = Number(process.env.EIN_PORTAL_SWEEP_INTERVAL_MS ?? 60 * 60_000);
if (einSweepIntervalMs > 0) {
  setInterval(() => {
    runEinPortalSweepOnce(defaultEinPortalDeps(pool))
      .then((r) => {
        if (r.errors.length > 0) console.error("[ein portal sweep] errors", r.errors);
      })
      .catch((err) => {
        console.error("[ein portal sweep] tick failed", err);
      });
  }, einSweepIntervalMs);
}

/**
 * Dispatch 13 post-filing roadmap: copies the customer's choices from the Thank You
 * page to the Zoho Deal (postFiling/interests.ts). Every 60 seconds by default;
 * POST_FILING_SYNC_INTERVAL_MS=0 disables. Does nothing when
 * POST_FILING_INTERESTS_ENABLED=false.
 */
const postFilingSyncIntervalMs = Number(process.env.POST_FILING_SYNC_INTERVAL_MS ?? 60_000);
if (postFilingSyncIntervalMs > 0) {
  setInterval(() => {
    runPostFilingSyncOnce(defaultPostFilingDeps(pool))
      .then((r) => {
        if (r.blocked.length > 0) console.error("[post-filing sync] needs a person", r.blocked);
      })
      .catch((err) => {
        console.error("[post-filing sync] tick failed", err);
      });
  }, postFilingSyncIntervalMs);
}

/**
 * T144 Dispatch 10: Operating Agreement generation and the Deal's
 * Operating_Agreement_Stat (formation/operatingAgreementJob.ts). Every 10 minutes
 * by default; OPERATING_AGREEMENT_JOB_INTERVAL_MS=0 disables. Before migration
 * 0034 is applied it logs once and does nothing.
 */
const oaJobIntervalMs = Number(process.env.OPERATING_AGREEMENT_JOB_INTERVAL_MS ?? 10 * 60_000);
let oaMissingTableLogged = false;
let oaJobRunning = false;
if (oaJobIntervalMs > 0) {
  setInterval(() => {
    // One run at a time: a slow PDF service must not overlap the next tick.
    if (oaJobRunning) return;
    oaJobRunning = true;
    defaultOaDeps(pool)
      .then((deps) => runOperatingAgreementJobOnce(deps))
      .then((r) => {
        if (r.errors.length > 0) console.error("[operating agreement] Deal updates failed", r.errors);
      })
      .catch((err) => {
        if (isMissingTable(err)) {
          if (!oaMissingTableLogged) console.log("[operating agreement] migration 0034 not applied; job idle");
          oaMissingTableLogged = true;
          return;
        }
        console.error("[operating agreement] tick failed", err);
      })
      .finally(() => {
        oaJobRunning = false;
      });
  }, oaJobIntervalMs);
}
