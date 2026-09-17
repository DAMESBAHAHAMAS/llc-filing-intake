import { Router } from "express";
import { pool } from "../db/pool.js";
import { describeError } from "../db/describeError.js";
import { verifyStripeSignature, WebhookSignatureError } from "../stripe/webhookSignature.js";
import { needsSunbizFiling } from "../offers/sunbizFiling.js";
import { dispatchAcceptanceEmail } from "../registeredAgent/acceptanceEmail.js";

export const stripeWebhookRouter = Router();

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
  let shouldSendRegisteredAgentEmail = false;
  let paidFilingSessionId: string | null = null;
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
      const session = event.data.object as { id: string; payment_status?: string; metadata?: Record<string, string> | null };
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

          // Registered-agent gate: a "customer" (third-party) RA must
          // accept before Sunbiz filing may proceed — typing a name at
          // intake is not acceptance (frozen rule, pdf/context.ts).
          // "house" never blocks (server-stamped identity, no acceptance
          // needed). filing_data/registered_agent_status are read fresh
          // here, inside this transaction, FOR UPDATE alongside the
          // order row above, rather than trusted from any earlier read.
          const sessionForGate = await client.query<{
            filing_data: { registered_agent_path?: string } | null;
            registered_agent_status: string | null;
          }>(
            `SELECT filing_data, registered_agent_status FROM filing_sessions WHERE filing_session_id = $1 FOR UPDATE`,
            [order.filing_session_id]
          );
          const registeredAgentPath = sessionForGate.rows[0]?.filing_data?.registered_agent_path;
          const registeredAgentStatus = sessionForGate.rows[0]?.registered_agent_status ?? null;
          const blockedOnRegisteredAgent = registeredAgentPath === "customer" && registeredAgentStatus !== "accepted";
          const fulfillmentReady = requiresFiling && !blockedOnRegisteredAgent;

          await client.query(
            `UPDATE orders
             SET payment_status = 'paid', paid_at = now()${fulfillmentReady ? ", fulfillment_status = 'ready', fulfillment_ready_at = now()" : ""}
             WHERE order_id = $1`,
            [orderId]
          );

          const sessionRow = await client.query(
            `SELECT email, full_name, phone, entity_name_primary, crm_lead_id FROM filing_sessions WHERE filing_session_id = $1`,
            [order.filing_session_id]
          );

          // Zoho Deal lifecycle: when the Cloudflare Worker already
          // created a Deal at intake (filing_sessions.crm_deal_id, known
          // here via Stripe metadata — routes/checkout.ts sets it,
          // read back from this already-signature-verified event body,
          // no extra Stripe round-trip needed), update that EXISTING
          // Deal's stage instead of creating a second one. Only when
          // it's unknown does this fall back to the original "create a
          // Deal at payment time" path (order_deal/paid_deal) —
          // unchanged, so an order never ends up with zero Deal linkage
          // just because the Worker->session capture didn't happen yet.
          const crmDealId = session.metadata?.crm_deal_id;
          const targetStage = process.env.ZOHO_DEAL_STAGE_ON_PAYMENT;
          const expectedEmail = sessionRow.rows[0]?.email;
          if (crmDealId) {
            await client.query(`UPDATE orders SET crm_deal_id = $2 WHERE order_id = $1`, [orderId, crmDealId]);
            if (targetStage && expectedEmail) {
              // expected_email is what zoho/client.ts's updateDealStage
              // verifies the Deal's linked Contact against before ever
              // writing to it — crm_deal_id itself is client-suppliable
              // (routes/session.ts) and unverified at capture time; this
              // is the actual ownership check, not this enqueue step.
              await client.query(
                `INSERT INTO crm_sync_queue (filing_session_id, order_id, sync_type, payload_snapshot)
                 VALUES ($1, $2, 'deal_stage_update', $3)`,
                [
                  order.filing_session_id,
                  orderId,
                  JSON.stringify({ crm_deal_id: crmDealId, target_stage: targetStage, expected_email: expectedEmail }),
                ]
              );
              processingResult = "deal_stage_update_enqueued";
            } else if (!expectedEmail) {
              // No email on this filing_session to verify Deal ownership
              // against — enqueueing would only produce a job that can
              // never pass the ownership check, so it isn't enqueued at
              // all rather than guaranteed-dead-lettered.
              processingResult = "crm_deal_id_set_but_no_email_to_verify_ownership";
            } else {
              // No confirmed "this means paid" Zoho Stage value set
              // (ZOHO_DEAL_STAGE_ON_PAYMENT, .env.example) — deliberately
              // not enqueued rather than guessed; a wrong guess would
              // just dead-letter against Zoho's own INVALID_DATA error.
              processingResult = "crm_deal_id_set_but_target_stage_unconfigured";
            }
          } else {
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
          }

          shouldSendRegisteredAgentEmail = blockedOnRegisteredAgent;
          paidFilingSessionId = order.filing_session_id;
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

    // Third-party ("customer") registered agent: the acceptance email
    // fires HERE, only once payment is durably confirmed and committed —
    // never at selection time (POST /registered-agent/select only
    // persists the choice). Deliberately outside the transaction above:
    // this makes a real network call, and a slow/failing email provider
    // must never hold open or roll back the payment-confirmation
    // transaction. A send failure is recorded by dispatchAcceptanceEmail
    // itself (registered_agent_status -> 'email_failed', a durable row)
    // rather than thrown, so it never turns this into a 500 — payment is
    // already safely recorded either way, and an operator can trigger a
    // resend via POST /api/registered-agent/request-acceptance.
    if (shouldSendRegisteredAgentEmail && paidFilingSessionId) {
      try {
        await dispatchAcceptanceEmail(pool, paidFilingSessionId);
      } catch (err) {
        console.error(`Registered-agent acceptance email failed for filing_session_id=${paidFilingSessionId}:`, describeError(err));
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "webhook processing failed", detail: describeError(err) });
  } finally {
    client.release();
  }
});
