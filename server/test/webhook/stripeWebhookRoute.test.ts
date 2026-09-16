import "dotenv/config";
import { randomUUID } from "node:crypto";
import http from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool.js";
import { stripeWebhookRouter } from "../../src/routes/stripeWebhook.js";
import { getStripe } from "../../src/checkout/stripeCheckoutClient.js";

/**
 * HTTP-level tests for the raw-body + signature-verification plumbing
 * that only exist at the route layer (webhook/stripeWebhookService.test.ts
 * covers all the event-processing logic once a verified event exists).
 * Uses the REAL `stripe` package's signature verification
 * (`getStripe().webhooks.constructEvent`) and its official test helper
 * (`generateTestHeaderString`) against the locally-configured
 * STRIPE_WEBHOOK_SECRET — genuine HMAC verification, not mocked. No
 * network call to Stripe is made by any test in this file: every event
 * used here resolves to "order not found" (an unrelated/bogus
 * stripe_checkout_session_id) or an unhandled event type, both of which
 * webhook/stripeWebhookService.ts resolves BEFORE it would ever call
 * stripeClient.retrieveCheckoutSession — see that file's branch order.
 * A real payment + real webhook signature is proven separately, live —
 * see GATE2-STRIPE-WEBHOOK-STATUS.md §12.
 */

const createdEventIds: string[] = [];

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(stripeWebhookRouter); // must be mounted before any JSON body-parser — same as index.ts
  app.use(express.json());
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("failed to bind test server");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  if (createdEventIds.length) {
    await pool.query("DELETE FROM stripe_webhook_events WHERE id = ANY($1)", [createdEventIds]);
  }
});

function fakeEventPayload(label: string, type: string, sessionId: string): { id: string; raw: string } {
  const id = `evt_route_test_${label}_${randomUUID()}`;
  createdEventIds.push(id);
  const raw = JSON.stringify({
    id,
    object: "event",
    type,
    data: { object: { id: sessionId, object: "checkout.session" } },
  });
  return { id, raw };
}

function sign(payload: string, secret: string): string {
  return getStripe().webhooks.generateTestHeaderString({ payload, secret });
}

async function postWebhook(rawBody: string, signatureHeader?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (signatureHeader !== undefined) headers["stripe-signature"] = signatureHeader;
  return fetch(`${baseUrl}/api/stripe/webhook`, { method: "POST", headers, body: rawBody });
}

describe("A. Missing signature: rejected, nothing processed", () => {
  it("returns 400 and creates no stripe_webhook_events row", async () => {
    const { raw } = fakeEventPayload("missing_sig", "checkout.session.completed", `cs_test_fake_${randomUUID()}`);
    const res = await postWebhook(raw /* no signature header */);
    expect(res.status).toBe(400);

    const parsed = JSON.parse(raw);
    const { rows } = await pool.query("SELECT count(*) AS n FROM stripe_webhook_events WHERE id = $1", [parsed.id]);
    expect(rows[0].n).toBe("0");
  });
});

describe("B. Invalid signature: rejected, nothing processed", () => {
  it("returns 400 for a signature computed with the wrong secret", async () => {
    const { raw } = fakeEventPayload("bad_sig", "checkout.session.completed", `cs_test_fake_${randomUUID()}`);
    const badSignature = sign(raw, "whsec_definitely_the_wrong_secret");
    const res = await postWebhook(raw, badSignature);
    expect(res.status).toBe(400);

    const parsed = JSON.parse(raw);
    const { rows } = await pool.query("SELECT count(*) AS n FROM stripe_webhook_events WHERE id = $1", [parsed.id]);
    expect(rows[0].n).toBe("0");
  });

  it("returns 400 when the signed payload doesn't match the body actually sent (tampered)", async () => {
    const { raw } = fakeEventPayload("tampered", "checkout.session.completed", `cs_test_fake_${randomUUID()}`);
    const secret = process.env.STRIPE_WEBHOOK_SECRET!;
    const validSignatureForOriginal = sign(raw, secret);
    const tamperedBody = raw.replace("checkout.session.completed", "checkout.session.expired");

    const res = await postWebhook(tamperedBody, validSignatureForOriginal);
    expect(res.status).toBe(400);
  });
});

describe("C. Valid signature: genuinely verified, reaches the service layer", () => {
  it("accepts a validly-signed unhandled-type event and records it as ignored", async () => {
    const { id, raw } = fakeEventPayload("valid_unhandled", "payment_intent.created", `cs_test_fake_${randomUUID()}`);
    const secret = process.env.STRIPE_WEBHOOK_SECRET!;
    const signature = sign(raw, secret);

    const res = await postWebhook(raw, signature);
    expect(res.status).toBe(200);

    const { rows } = await pool.query("SELECT type, processing_result FROM stripe_webhook_events WHERE id = $1", [id]);
    expect(rows[0].type).toBe("payment_intent.created");
    expect(rows[0].processing_result).toBe("ignored_unhandled_event_type");
  });

  it("accepts a validly-signed checkout.session.completed event for an unknown session and records order_not_found", async () => {
    const { id, raw } = fakeEventPayload("valid_unknown_order", "checkout.session.completed", `cs_test_fake_${randomUUID()}`);
    const secret = process.env.STRIPE_WEBHOOK_SECRET!;
    const signature = sign(raw, secret);

    const res = await postWebhook(raw, signature);
    expect(res.status).toBe(200);

    const { rows } = await pool.query("SELECT processing_result FROM stripe_webhook_events WHERE id = $1", [id]);
    expect(rows[0].processing_result).toBe("order_not_found");
  });

  it("is idempotent at the HTTP layer too — redelivering the same signed body twice only processes once", async () => {
    const { id, raw } = fakeEventPayload("valid_dup", "payment_intent.created", `cs_test_fake_${randomUUID()}`);
    const secret = process.env.STRIPE_WEBHOOK_SECRET!;
    const signature = sign(raw, secret);

    const first = await postWebhook(raw, signature);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { claimed: boolean };
    expect(firstBody.claimed).toBe(true);

    const second = await postWebhook(raw, signature);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { claimed: boolean };
    expect(secondBody.claimed).toBe(false);

    const { rows } = await pool.query("SELECT count(*) AS n FROM stripe_webhook_events WHERE id = $1", [id]);
    expect(rows[0].n).toBe("1");
  });
});

describe("D. Missing STRIPE_WEBHOOK_SECRET: fails closed, never processes unverified", () => {
  it("returns 500 and never attempts verification when the server has no configured secret", async () => {
    const { raw } = fakeEventPayload("no_secret_configured", "checkout.session.completed", `cs_test_fake_${randomUUID()}`);
    const secret = process.env.STRIPE_WEBHOOK_SECRET!;
    const signature = sign(raw, secret); // a genuinely valid signature — must still be refused

    const saved = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    try {
      const res = await postWebhook(raw, signature);
      expect(res.status).toBe(500);
    } finally {
      process.env.STRIPE_WEBHOOK_SECRET = saved;
    }

    const parsed = JSON.parse(raw);
    const { rows } = await pool.query("SELECT count(*) AS n FROM stripe_webhook_events WHERE id = $1", [parsed.id]);
    expect(rows[0].n).toBe("0");
  });
});
