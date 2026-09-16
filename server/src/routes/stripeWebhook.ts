import express, { Router } from "express";
import type Stripe from "stripe";
import { pool } from "../db/pool.js";
import { getStripe, realStripeCheckoutClient } from "../checkout/stripeCheckoutClient.js";
import { realZohoClient } from "../zoho/client.js";
import { processStripeWebhookEvent } from "../webhook/stripeWebhookService.js";
import { describeError } from "../db/describeError.js";

export const stripeWebhookRouter = Router();

/**
 * POST /api/stripe/webhook
 *
 * MUST be mounted in index.ts BEFORE `app.use(express.json())` — Stripe
 * signature verification (`stripe.webhooks.constructEvent`) needs the
 * exact raw request body bytes, and once any JSON body-parser has run,
 * that exact byte sequence is gone (re-serializing the parsed object is
 * not the same bytes and will fail signature verification). This route
 * uses `express.raw({ type: "application/json" })` as its own,
 * route-local body parser — since this handler always sends a response
 * itself (never calls `next()`), the request never reaches the global
 * `express.json()` middleware registered after it.
 *
 * All actual event handling (idempotency, order lookup, payment
 * verification, CRM) lives in webhook/stripeWebhookService.ts — this
 * file only does signature verification and status-code translation.
 */
stripeWebhookRouter.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      // Server misconfiguration, not a client error — but still must not
      // process an unverified event. 500 so this is loud in logs/Stripe's
      // dashboard rather than silently accepting unverified payloads.
      res.status(500).json({ error: "STRIPE_WEBHOOK_SECRET is not set" });
      return;
    }

    if (!signature || typeof signature !== "string") {
      res.status(400).json({ error: "Missing Stripe-Signature header" });
      return;
    }

    if (!Buffer.isBuffer(req.body)) {
      // Only reachable if this route is ever mounted after express.json()
      // by mistake — the raw body would already be gone. Fail loudly
      // rather than attempting (and failing) signature verification
      // against a JSON-parsed object.
      res.status(500).json({ error: "Webhook body was not raw — check route mount order in index.ts" });
      return;
    }

    let event: Stripe.Event;
    try {
      event = getStripe().webhooks.constructEvent(req.body, signature, webhookSecret);
    } catch (err) {
      // Invalid signature or malformed payload — reject, never process.
      res.status(400).json({ error: "Webhook signature verification failed", detail: describeError(err) });
      return;
    }

    try {
      const outcome = await processStripeWebhookEvent(pool, realStripeCheckoutClient, realZohoClient, event);
      res.status(200).json({ received: true, ...outcome });
    } catch (err) {
      // A verification/DB failure mid-processing — 500 so Stripe retries
      // delivery (see stripeWebhookService.ts's comment on why the
      // Stripe-lookup-failure path re-throws instead of finishing the
      // stripe_webhook_events row).
      console.error("Stripe webhook processing failed:", describeError(err));
      res.status(500).json({ error: "Webhook processing failed" });
    }
  }
);
