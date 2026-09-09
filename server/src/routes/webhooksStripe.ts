import { Router } from "express";
import { pool } from "../db/pool.js";
import { describeError } from "../db/describeError.js";
import { verifyStripeSignature, WebhookSignatureError } from "../stripe/webhookSignature.js";

export const stripeWebhookRouter = Router();

/**
 * offer_codes whose presence in an order's line_items means "this order
 * includes an actual Articles of Organization filing with the state" —
 * i.e. needs the Sunbiz fax-fulfillment pipeline (orders.fulfillment_status
 * -> 'ready'). EIN-only, Registered-Agent-only, or Credentials-Kit-only
 * orders never touch that pipeline at all.
 */
const SUNBIZ_FILING_OFFER_CODES = new Set(["FASTTRACK", "PREMIUM", "DIY_STATE_FEE"]);

function needsSunbizFiling(lineItems: Array<{ offer_code?: string }>): boolean {
  return lineItems.some((li) => li.offer_code && SUNBIZ_FILING_OFFER_CODES.has(li.offer_code));
}

interface MinimalStripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

/**
 * POST /api/webhooks/stripe
 *
 * Mounted in index.ts with express.raw() applied ONLY to this route,
 * before the global express.json() — signature verification requires the
 * exact raw bytes Stripe sent (frozen rule).
 *
 * Idempotency: stripe_webhook_events.id (the Stripe event ID) is the
 * primary key. `INSERT ... ON CONFLICT (id) DO NOTHING RETURNING id`
 * inside the same transaction as every downstream write is the whole
 * mechanism — a duplicate delivery of an already-processed event.id
 * finds no row returned and does nothing further, every time, including
 * under concurrent delivery (the unique constraint is what actually
 * prevents a race, not the application-level check alone).
 *
 * PDF generation and CRM Deal creation are never done inline here — only
 * state transitions + queue enqueues, inside one transaction with the
 * event-id insert (frozen rule: never do PDF/CRM/email inline in the
 * webhook handler).
 */
stripeWebhookRouter.post("/api/webhooks/stripe", async (req, res) => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    res.status(500).json({ error: "server misconfigured: STRIPE_WEBHOOK_SECRET not set" });
    return;
  }

  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    // Should be unreachable if index.ts wiring is correct — fail loudly
    // rather than silently trying to verify a signature against parsed JSON.
    res.status(500).json({ error: "server misconfigured: webhook route is not receiving a raw body" });
    return;
  }

  try {
    verifyStripeSignature(rawBody, req.header("Stripe-Signature"), webhookSecret);
  } catch (err) {
    const message = err instanceof WebhookSignatureError ? err.message : describeError(err);
    res.status(400).json({ error: "signature verification failed", detail: message });
    return;
  }

  let event: MinimalStripeEvent;
  try {
    event = JSON.parse(rawBody.toString("utf8")) as MinimalStripeEvent;
  } catch {
    res.status(400).json({ error: "invalid JSON payload" });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO stripe_webhook_events (id, type, payload) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [event.id, event.type, JSON.stringify(event)]
    );

    if (inserted.rowCount === 0) {
      await client.query("COMMIT");
      res.status(200).json({ received: true, duplicate: true });
      return;
    }

    let processingResult = "ignored_event_type";
    let orderId: string | null = null;

    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const session = event.data.object as { id: string; payment_status?: string };
      const orderRes = await client.query<{
        order_id: string;
        filing_session_id: string;
        product: string;
        total_cents: number;
        line_items: Array<{ offer_code?: string }>;
        payment_status: string;
      }>(
        `SELECT order_id, filing_session_id, product, total_cents, line_items, payment_status
         FROM orders WHERE stripe_checkout_session_id = $1 FOR UPDATE`,
        [session.id]
      );

      if (orderRes.rowCount === 0) {
        processingResult = "order_not_found";
        console.error(`[stripe webhook] ${event.type}: no order for stripe_checkout_session_id=${session.id}`);
      } else {
        const order = orderRes.rows[0];
        orderId = order.order_id;

        if (session.payment_status === "paid" && order.payment_status !== "paid") {
          const requiresFiling = needsSunbizFiling(order.line_items ?? []);
          await client.query(
            `UPDATE orders
             SET payment_status = 'paid', paid_at = now()${requiresFiling ? ", fulfillment_status = 'ready', fulfillment_ready_at = now()" : ""}
             WHERE order_id = $1`,
            [orderId]
          );

          const sessionRow = await client.query(
            `SELECT email, full_name, phone, entity_name_primary, crm_lead_id FROM filing_sessions WHERE filing_session_id = $1`,
            [order.filing_session_id]
          );

          await client.query(
            `INSERT INTO crm_sync_queue (filing_session_id, order_id, sync_type, payload_snapshot)
             VALUES ($1, $2, 'order_deal', $3)`,
            [
              order.filing_session_id,
              orderId,
              JSON.stringify({
                kind: "paid_deal",
                order: {
                  order_id: orderId,
                  filing_session_id: order.filing_session_id,
                  product: order.product,
                  crm_intent: order.product,
                  total_cents: order.total_cents,
                },
                filing_session: sessionRow.rows[0] ?? {},
              }),
            ]
          );

          processingResult = "paid_deal_enqueued";
        } else {
          processingResult = "payment_status_not_paid_or_already_paid";
        }
      }
    } else if (event.type === "checkout.session.async_payment_failed" || event.type === "checkout.session.expired") {
      const session = event.data.object as { id: string };
      const orderRes = await client.query<{
        order_id: string;
        filing_session_id: string;
        product: string;
        total_cents: number;
        payment_status: string;
      }>(
        `SELECT order_id, filing_session_id, product, total_cents, payment_status
         FROM orders WHERE stripe_checkout_session_id = $1 FOR UPDATE`,
        [session.id]
      );

      if (orderRes.rowCount === 0) {
        processingResult = "order_not_found";
      } else {
        const order = orderRes.rows[0];
        orderId = order.order_id;
        const failureReason = event.type === "checkout.session.expired" ? "checkout_session_expired" : "async_payment_failed";

        if (order.payment_status !== "paid") {
          // Never delete the session/order — record the failure in place.
          await client.query(`UPDATE orders SET payment_status = 'failed', failure_reason = $2 WHERE order_id = $1`, [
            orderId,
            failureReason,
          ]);

          const sessionRow = await client.query(
            `SELECT email, full_name, phone, entity_name_primary, crm_lead_id FROM filing_sessions WHERE filing_session_id = $1`,
            [order.filing_session_id]
          );

          await client.query(
            `INSERT INTO crm_sync_queue (filing_session_id, order_id, sync_type, payload_snapshot)
             VALUES ($1, $2, 'abandoned_cart', $3)`,
            [
              order.filing_session_id,
              orderId,
              JSON.stringify({
                kind: "abandoned_cart",
                order: {
                  order_id: orderId,
                  filing_session_id: order.filing_session_id,
                  product: order.product,
                  crm_intent: order.product,
                  total_cents: order.total_cents,
                  failure_reason: failureReason,
                },
                filing_session: sessionRow.rows[0] ?? {},
              }),
            ]
          );

          processingResult = "abandoned_cart_enqueued";
        } else {
          // Already paid (e.g. a late/duplicate expired event racing a
          // completed one) — never overwrite a paid order as failed.
          processingResult = "ignored_already_paid";
        }
      }
    }

    await client.query(`UPDATE stripe_webhook_events SET order_id = $2, processing_result = $3, processed_at = now() WHERE id = $1`, [
      event.id,
      orderId,
      processingResult,
    ]);

    await client.query("COMMIT");
    res.status(200).json({ received: true });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "webhook processing failed", detail: describeError(err) });
  } finally {
    client.release();
  }
});
