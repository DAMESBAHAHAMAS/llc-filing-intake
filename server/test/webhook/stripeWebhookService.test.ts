import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool.js";
import { processStripeWebhookEvent } from "../../src/webhook/stripeWebhookService.js";
import type {
  RetrievedCheckoutSession,
  StripeCheckoutClient,
} from "../../src/checkout/stripeCheckoutClient.js";
import type { ZohoClient, ZohoSyncResult } from "../../src/zoho/client.js";
import type Stripe from "stripe";

/**
 * Runs against the real Supabase dev instance, same convention as every
 * other integration test in this directory. Fake StripeCheckoutClient
 * and ZohoClient are injected (same pattern as checkoutService.test.ts
 * and syncWorker.integration.test.ts) — the real Stripe-side behavior
 * (a genuine test-mode payment, a genuine signed webhook delivery) is
 * proven separately, live, via the route-level test and the manual
 * end-to-end run — see GATE2-STRIPE-WEBHOOK-STATUS.md §12.
 */

const createdSessionIds: string[] = [];

function fakeStripeClient(
  impl: (id: string) => Promise<RetrievedCheckoutSession>
): { client: StripeCheckoutClient; retrieveCalls: string[] } {
  const retrieveCalls: string[] = [];
  return {
    retrieveCalls,
    client: {
      async createCheckoutSession() {
        throw new Error("createCheckoutSession not used by webhook tests");
      },
      async retrieveCheckoutSession(id) {
        retrieveCalls.push(id);
        return impl(id);
      },
    },
  };
}

function fakeZohoClient(result: ZohoSyncResult = { ok: true }): { client: ZohoClient; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    client: {
      async syncSession(snapshot) {
        calls.push(snapshot);
        return result;
      },
    },
  };
}

async function createFilingSessionAndOrder(opts: {
  checkoutStatus?: string;
  paymentStatus?: string;
  crmDealId?: string | null;
  totalCents?: number;
  currency?: string;
  /** Defaults to a valid, minimal filing_data. Pass `null` to simulate a
   *  paid order whose filing_data is missing at confirmation time. */
  filingData?: Record<string, unknown> | null;
}): Promise<{ filingSessionId: string; orderId: string; stripeSessionId: string }> {
  const filingSessionId = randomUUID();
  createdSessionIds.push(filingSessionId);
  const filingData = opts.filingData === undefined ? { llc_name: "Webhook Test LLC" } : opts.filingData;
  await pool.query(
    `INSERT INTO filing_sessions (filing_session_id, current_stage, email, filing_data)
     VALUES ($1, 'complete', 'webhook-test@example.com', $2)`,
    [filingSessionId, filingData]
  );

  const stripeSessionId = `cs_test_fake_${randomUUID()}`;
  const totalCents = opts.totalCents ?? 12900;
  const currency = opts.currency ?? "usd";
  const inserted = await pool.query<{ order_id: string }>(
    `INSERT INTO orders (filing_session_id, crm_intent, product, line_items, total_cents, currency, checkout_status, stripe_checkout_session_id, crm_deal_id)
     VALUES ($1, 'LLC_FORMATION_DIY', 'LLC_FORMATION_DIY', $2, $3, $4, $5, $6, $7)
     RETURNING order_id`,
    [
      filingSessionId,
      JSON.stringify([
        { price: "price_1U9HsDDo01bXdbWStkpesATi", label: "Florida LLC Filing", quantity: 1, amount_cents: 12500 },
        { price: "price_1U9HsRDo01bXdbWSHUSLnbcO", label: "Service Fee", quantity: 1, amount_cents: 400 },
      ]),
      totalCents,
      currency,
      opts.checkoutStatus ?? "checkout_created",
      stripeSessionId,
      opts.crmDealId ?? null,
    ]
  );
  const orderId = inserted.rows[0].order_id;

  if (opts.paymentStatus) {
    await pool.query("UPDATE orders SET payment_status = $2 WHERE order_id = $1", [orderId, opts.paymentStatus]);
  }

  return { filingSessionId, orderId, stripeSessionId };
}

const createdEventIds: string[] = [];

/**
 * Every event.id used in this file must be unique per run and tracked
 * for cleanup — stripe_webhook_events rows for events that never resolve
 * to an order (order_not_found, unhandled-type) have no order_id, so
 * they can't be cleaned up via createdSessionIds' cascade alone.
 * A hardcoded literal id here would collide with a leftover row from a
 * prior run and be (correctly, per the idempotency design) treated as
 * "already processed" — which is exactly the bug this caused before this
 * fix: a second run of this suite silently skipped re-processing.
 */
function fakeEvent(label: string, type: string, sessionId: string): Stripe.Event {
  const id = `evt_test_${label}_${randomUUID()}`;
  createdEventIds.push(id);
  return {
    id,
    type,
    data: { object: { id: sessionId, object: "checkout.session" } },
  } as unknown as Stripe.Event;
}

afterAll(async () => {
  if (createdEventIds.length) {
    await pool.query("DELETE FROM stripe_webhook_events WHERE id = ANY($1)", [createdEventIds]);
  }
  if (createdSessionIds.length) {
    await pool.query("DELETE FROM orders WHERE filing_session_id = ANY($1)", [createdSessionIds]);
    await pool.query("DELETE FROM crm_sync_queue WHERE filing_session_id = ANY($1)", [createdSessionIds]);
    await pool.query("DELETE FROM filing_events WHERE filing_session_id = ANY($1)", [createdSessionIds]);
    await pool.query("DELETE FROM filing_sessions WHERE filing_session_id = ANY($1)", [createdSessionIds]);
  }
});

describe("A. Happy path: verified payment marks the order paid", () => {
  it("marks payment_status = paid only after re-fetching and confirming with Stripe, preserving every other order field", async () => {
    const { orderId, stripeSessionId, filingSessionId } = await createFilingSessionAndOrder({});
    const { client: stripe } = fakeStripeClient(async () => ({
      id: stripeSessionId,
      paymentStatus: "paid",
      amountTotal: 12900,
      currency: "usd",
      metadata: null,
    }));
    const { client: zoho, calls: zohoCalls } = fakeZohoClient();

    const event = fakeEvent("evt_happy", "checkout.session.completed", stripeSessionId);
    const outcome = await processStripeWebhookEvent(pool, stripe, zoho, event);

    expect(outcome).toEqual({ claimed: true, result: "paid", orderId, fulfillmentStatus: "ready" });
    // Zoho is never called — crm_deal_id is null (Deal-at-checkout not
    // built) — see stripeWebhookService.ts's CRM comment.
    expect(zohoCalls.length).toBe(0);

    const { rows } = await pool.query("SELECT * FROM orders WHERE order_id = $1", [orderId]);
    const order = rows[0];
    expect(order.payment_status).toBe("paid");
    expect(order.order_id).toBe(orderId);
    expect(order.filing_session_id).toBe(filingSessionId);
    expect(order.product).toBe("LLC_FORMATION_DIY");
    expect(order.total_cents).toBe(12900);
    expect(order.currency).toBe("usd");
    expect(order.stripe_checkout_session_id).toBe(stripeSessionId);
    expect(order.checkout_status).toBe("checkout_created"); // untouched
    expect(order.fulfillment_status).toBe("ready");
    expect(order.fulfillment_ready_at).not.toBeNull();

    const { rows: eventRows } = await pool.query(
      "SELECT processing_result, order_id FROM stripe_webhook_events WHERE id = $1",
      [event.id]
    );
    expect(eventRows[0].processing_result).toBe("paid");
    expect(eventRows[0].order_id).toBe(orderId);

    const { rows: fulfillmentEventRows } = await pool.query(
      "SELECT payload FROM filing_events WHERE filing_session_id = $1 AND event_type = 'fulfillment_ready'",
      [filingSessionId]
    );
    expect(fulfillmentEventRows).toHaveLength(1);
    expect(fulfillmentEventRows[0].payload.order_id).toBe(orderId);
  });
});

describe("B. Idempotency: the same event.id is never processed twice", () => {
  it("a second delivery of the same event.id is a no-op — no duplicate order update", async () => {
    const { orderId, stripeSessionId } = await createFilingSessionAndOrder({});
    const { client: stripe, retrieveCalls } = fakeStripeClient(async () => ({
      id: stripeSessionId,
      paymentStatus: "paid",
      amountTotal: 12900,
      currency: "usd",
      metadata: null,
    }));
    const { client: zoho } = fakeZohoClient();

    const event = fakeEvent("evt_dup", "checkout.session.completed", stripeSessionId);

    const first = await processStripeWebhookEvent(pool, stripe, zoho, event);
    expect(first).toEqual({ claimed: true, result: "paid", orderId, fulfillmentStatus: "ready" });
    expect(retrieveCalls.length).toBe(1);

    // Stripe redelivers the identical event object/id (its normal retry
    // behavior) — this must be recognized and skipped, not reprocessed.
    const second = await processStripeWebhookEvent(pool, stripe, zoho, event);
    expect(second).toEqual({ claimed: false });
    expect(retrieveCalls.length).toBe(1); // Stripe was not called again

    const { rows: eventRows } = await pool.query("SELECT count(*) AS n FROM stripe_webhook_events WHERE id = $1", [event.id]);
    expect(eventRows[0].n).toBe("1"); // exactly one row, not two
  });
});

describe("C. Unhandled event type: acknowledged, no state change", () => {
  it("ignores a non-checkout.session.completed event without touching any order", async () => {
    const { orderId, stripeSessionId } = await createFilingSessionAndOrder({});
    const { client: stripe, retrieveCalls } = fakeStripeClient(async () => {
      throw new Error("must not be called for an unhandled event type");
    });
    const { client: zoho } = fakeZohoClient();

    const outcome = await processStripeWebhookEvent(pool, stripe, zoho, fakeEvent("evt_other", "payment_intent.created", stripeSessionId));
    expect(outcome).toEqual({ claimed: true, result: "ignored_unhandled_event_type" });
    expect(retrieveCalls.length).toBe(0);

    const { rows } = await pool.query("SELECT payment_status FROM orders WHERE order_id = $1", [orderId]);
    expect(rows[0].payment_status).toBe("pending");
  });
});

describe("D. Unknown order_id: never marks an unrelated order paid", () => {
  it("acknowledges the event but marks it order_not_found, touching no order", async () => {
    const { client: stripe, retrieveCalls } = fakeStripeClient(async () => {
      throw new Error("must not be called when no order matches");
    });
    const { client: zoho } = fakeZohoClient();

    const bogusSessionId = `cs_test_fake_${randomUUID()}`;
    const outcome = await processStripeWebhookEvent(pool, stripe, zoho, fakeEvent("evt_unknown", "checkout.session.completed", bogusSessionId));
    expect(outcome).toEqual({ claimed: true, result: "order_not_found" });
    expect(retrieveCalls.length).toBe(0);
  });
});

describe("E. Unpaid Checkout: order remains pending", () => {
  it("does not mark paid when Stripe's own re-fetch says the session is not paid", async () => {
    const { orderId, stripeSessionId } = await createFilingSessionAndOrder({});
    const { client: stripe } = fakeStripeClient(async () => ({
      id: stripeSessionId,
      paymentStatus: "unpaid",
      amountTotal: 12900,
      currency: "usd",
      metadata: null,
    }));
    const { client: zoho } = fakeZohoClient();

    const outcome = await processStripeWebhookEvent(pool, stripe, zoho, fakeEvent("evt_unpaid", "checkout.session.completed", stripeSessionId));
    expect(outcome).toEqual({ claimed: true, result: "payment_not_confirmed", orderId });

    const { rows } = await pool.query("SELECT payment_status, fulfillment_status FROM orders WHERE order_id = $1", [orderId]);
    expect(rows[0].payment_status).toBe("pending");
    // Filing data exists (createFilingSessionAndOrder always sets it) but
    // payment is not confirmed — the fulfillment bridge must never act on
    // filing-data completeness alone. Stays at its default.
    expect(rows[0].fulfillment_status).toBe("not_ready");
  });
});

describe("F. Amount/currency mismatch: order remains pending, flagged", () => {
  it("does not mark paid when the confirmed amount doesn't match this order's own total", async () => {
    const { orderId, stripeSessionId } = await createFilingSessionAndOrder({});
    const { client: stripe } = fakeStripeClient(async () => ({
      id: stripeSessionId,
      paymentStatus: "paid",
      amountTotal: 500, // wrong — order total is 12900
      currency: "usd",
      metadata: null,
    }));
    const { client: zoho } = fakeZohoClient();

    const outcome = await processStripeWebhookEvent(pool, stripe, zoho, fakeEvent("evt_mismatch", "checkout.session.completed", stripeSessionId));
    expect(outcome).toEqual({ claimed: true, result: "amount_or_currency_mismatch", orderId });

    const { rows } = await pool.query("SELECT payment_status FROM orders WHERE order_id = $1", [orderId]);
    expect(rows[0].payment_status).toBe("pending");
  });
});

describe("G. Already-paid guard: a second, distinct event for an already-paid order is a no-op", () => {
  it("does not re-process or re-mark an order that a different event already confirmed", async () => {
    const { orderId, stripeSessionId } = await createFilingSessionAndOrder({ paymentStatus: "paid" });
    const { client: stripe, retrieveCalls } = fakeStripeClient(async () => ({
      id: stripeSessionId,
      paymentStatus: "paid",
      amountTotal: 12900,
      currency: "usd",
      metadata: null,
    }));
    const { client: zoho } = fakeZohoClient();

    const outcome = await processStripeWebhookEvent(pool, stripe, zoho, fakeEvent("evt_already_paid", "checkout.session.completed", stripeSessionId));
    expect(outcome).toEqual({ claimed: true, result: "already_paid_noop", orderId });
    expect(retrieveCalls.length).toBe(0); // doesn't even need to re-verify with Stripe
  });
});

describe("H. Stripe verification failure: safely retryable, never falsely marks paid", () => {
  it("propagates the error without finishing the event row, and a retry with the same event.id can still succeed", async () => {
    const { orderId, stripeSessionId } = await createFilingSessionAndOrder({});
    const { client: failingStripe } = fakeStripeClient(async () => {
      throw new Error("simulated transient Stripe API error");
    });
    const { client: zoho } = fakeZohoClient();
    const event = fakeEvent("evt_retry", "checkout.session.completed", stripeSessionId);

    await expect(processStripeWebhookEvent(pool, failingStripe, zoho, event)).rejects.toThrow(
      /simulated transient Stripe API error/
    );

    const { rows: midRows } = await pool.query(
      "SELECT processing_result FROM stripe_webhook_events WHERE id = $1",
      [event.id]
    );
    expect(midRows[0].processing_result).toBeNull(); // claimed, but not finished

    const { rows: orderMidRows } = await pool.query("SELECT payment_status FROM orders WHERE order_id = $1", [orderId]);
    expect(orderMidRows[0].payment_status).toBe("pending"); // never falsely marked paid

    // Stripe redelivers the SAME event.id on retry — this must be able
    // to actually reprocess, not be silently treated as a duplicate.
    const { client: recoveredStripe } = fakeStripeClient(async () => ({
      id: stripeSessionId,
      paymentStatus: "paid",
      amountTotal: 12900,
      currency: "usd",
      metadata: null,
    }));
    const retryOutcome = await processStripeWebhookEvent(pool, recoveredStripe, zoho, event);
    expect(retryOutcome).toEqual({ claimed: true, result: "paid", orderId, fulfillmentStatus: "ready" });

    const { rows: finalRows } = await pool.query("SELECT payment_status FROM orders WHERE order_id = $1", [orderId]);
    expect(finalRows[0].payment_status).toBe("paid");
  });
});

describe("I. CRM: never faked, never duplicated, payment stays authoritative regardless", () => {
  it("records 'no_crm_deal_yet' and never calls Zoho when crm_deal_id is null", async () => {
    const { orderId, stripeSessionId, filingSessionId } = await createFilingSessionAndOrder({ crmDealId: null });
    const { client: stripe } = fakeStripeClient(async () => ({
      id: stripeSessionId,
      paymentStatus: "paid",
      amountTotal: 12900,
      currency: "usd",
      metadata: null,
    }));
    const { client: zoho, calls } = fakeZohoClient();

    await processStripeWebhookEvent(pool, stripe, zoho, fakeEvent("evt_crm_none", "checkout.session.completed", stripeSessionId));
    expect(calls.length).toBe(0);

    const { rows } = await pool.query(
      "SELECT payload FROM filing_events WHERE filing_session_id = $1 AND event_type = 'payment_confirmed'",
      [filingSessionId]
    );
    expect(rows[0].payload.crm_result).toBe("no_crm_deal_yet");
    expect(rows[0].payload.order_id).toBe(orderId);
  });

  it("records 'crm_deal_update_not_implemented' and still never calls Zoho when crm_deal_id is already set (no duplicate-Deal risk)", async () => {
    const { stripeSessionId, filingSessionId } = await createFilingSessionAndOrder({ crmDealId: "zcrm_fake_deal_123" });
    const { client: stripe } = fakeStripeClient(async () => ({
      id: stripeSessionId,
      paymentStatus: "paid",
      amountTotal: 12900,
      currency: "usd",
      metadata: null,
    }));
    const { client: zoho, calls } = fakeZohoClient();

    await processStripeWebhookEvent(pool, stripe, zoho, fakeEvent("evt_crm_existing", "checkout.session.completed", stripeSessionId));
    expect(calls.length).toBe(0); // never calls syncSession — would risk creating a duplicate Deal

    const { rows } = await pool.query(
      "SELECT payload FROM filing_events WHERE filing_session_id = $1 AND event_type = 'payment_confirmed'",
      [filingSessionId]
    );
    expect(rows[0].payload.crm_result).toBe("crm_deal_update_not_implemented");
  });

  it("payment stays authoritative even if Zoho would have failed — CRM is never on the payment critical path", async () => {
    // This test's very existence proves the point: processStripeWebhookEvent
    // never calls zohoClient.syncSession on the success path today (both
    // tests above assert calls.length === 0), so a Zoho outage
    // (ZOHOONE_TRIAL_EXPIRED) cannot block or roll back a confirmed
    // payment — there is no code path where it's even attempted.
    const { orderId, stripeSessionId } = await createFilingSessionAndOrder({ crmDealId: "zcrm_fake_deal_456" });
    const { client: stripe } = fakeStripeClient(async () => ({
      id: stripeSessionId,
      paymentStatus: "paid",
      amountTotal: 12900,
      currency: "usd",
      metadata: null,
    }));
    const throwingZoho: ZohoClient = {
      async syncSession() {
        throw new Error("ZOHOONE_TRIAL_EXPIRED");
      },
    };

    const outcome = await processStripeWebhookEvent(pool, stripe, throwingZoho, fakeEvent("evt_crm_zoho_down", "checkout.session.completed", stripeSessionId));
    expect(outcome).toEqual({ claimed: true, result: "paid", orderId, fulfillmentStatus: "ready" });

    const { rows } = await pool.query("SELECT payment_status FROM orders WHERE order_id = $1", [orderId]);
    expect(rows[0].payment_status).toBe("paid");
  });
});

describe("J. Fulfillment bridge: paid + filing_data -> fulfillment_status", () => {
  it("requires_review when filing_data is missing at the moment payment is confirmed (Gate 2 backstop)", async () => {
    // Should not happen in normal operation — checkoutService.ts gates
    // Checkout Session creation on current_stage = 'complete' — but a
    // customer can take arbitrarily long to pay, and this proves the
    // payment-side backstop actually fires instead of silently treating
    // a missing filing record as fulfillment-ready.
    const { orderId, stripeSessionId, filingSessionId } = await createFilingSessionAndOrder({ filingData: null });
    const { client: stripe } = fakeStripeClient(async () => ({
      id: stripeSessionId,
      paymentStatus: "paid",
      amountTotal: 12900,
      currency: "usd",
      metadata: null,
    }));
    const { client: zoho } = fakeZohoClient();

    const outcome = await processStripeWebhookEvent(
      pool,
      stripe,
      zoho,
      fakeEvent("evt_missing_filing_data", "checkout.session.completed", stripeSessionId)
    );
    expect(outcome).toEqual({ claimed: true, result: "paid", orderId, fulfillmentStatus: "requires_review" });

    const { rows } = await pool.query(
      "SELECT payment_status, fulfillment_status, fulfillment_ready_at FROM orders WHERE order_id = $1",
      [orderId]
    );
    // Payment authority is untouched by the fulfillment-readiness outcome
    // — a missing filing record never rolls back or blocks the payment.
    expect(rows[0].payment_status).toBe("paid");
    expect(rows[0].fulfillment_status).toBe("requires_review");
    expect(rows[0].fulfillment_ready_at).toBeNull();

    const { rows: eventRows } = await pool.query(
      "SELECT payload FROM filing_events WHERE filing_session_id = $1 AND event_type = 'fulfillment_blocked_missing_filing_data'",
      [filingSessionId]
    );
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].payload.order_id).toBe(orderId);
  });

  it("requires_review when filing_data is present but has no llc_name (structurally incomplete)", async () => {
    const { orderId, stripeSessionId } = await createFilingSessionAndOrder({ filingData: { principal_city: "Tampa" } });
    const { client: stripe } = fakeStripeClient(async () => ({
      id: stripeSessionId,
      paymentStatus: "paid",
      amountTotal: 12900,
      currency: "usd",
      metadata: null,
    }));
    const { client: zoho } = fakeZohoClient();

    await processStripeWebhookEvent(pool, stripe, zoho, fakeEvent("evt_incomplete_filing_data", "checkout.session.completed", stripeSessionId));

    const { rows } = await pool.query("SELECT fulfillment_status FROM orders WHERE order_id = $1", [orderId]);
    expect(rows[0].fulfillment_status).toBe("requires_review");
  });

  it("a duplicate webhook delivery does not create a second fulfillment_ready event or re-decide fulfillment", async () => {
    const { orderId, stripeSessionId, filingSessionId } = await createFilingSessionAndOrder({});
    const { client: stripe, retrieveCalls } = fakeStripeClient(async () => ({
      id: stripeSessionId,
      paymentStatus: "paid",
      amountTotal: 12900,
      currency: "usd",
      metadata: null,
    }));
    const { client: zoho } = fakeZohoClient();
    const event = fakeEvent("evt_fulfillment_dup", "checkout.session.completed", stripeSessionId);

    await processStripeWebhookEvent(pool, stripe, zoho, event);
    await processStripeWebhookEvent(pool, stripe, zoho, event); // Stripe's own redelivery of the same event.id
    expect(retrieveCalls.length).toBe(1); // second delivery never reaches fulfillment logic at all

    const { rows } = await pool.query(
      "SELECT payload FROM filing_events WHERE filing_session_id = $1 AND event_type = 'fulfillment_ready'",
      [filingSessionId]
    );
    expect(rows).toHaveLength(1); // not two
  });

  it("schema-level invariant: fulfillment_status can never be advanced on an order that isn't paid", async () => {
    // Belt-and-suspenders proof of migration 0010's CHECK constraint —
    // independent of any application code, a direct UPDATE attempting to
    // set fulfillment progress on a non-paid order is rejected by
    // Postgres itself.
    const { orderId } = await createFilingSessionAndOrder({}); // payment_status defaults to 'pending'
    await expect(
      pool.query("UPDATE orders SET fulfillment_status = 'ready' WHERE order_id = $1", [orderId])
    ).rejects.toThrow(/orders_fulfillment_requires_paid/);
  });
});
