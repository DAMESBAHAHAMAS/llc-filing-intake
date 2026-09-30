import { Resend } from "resend";
import type { Pool } from "pg";
import { describeError } from "../db/describeError.js";

/**
 * Operations alerts: new orders, money events and failures that need a
 * person. Delivery, first configured wins:
 *   1. Zoho Cliq incoming webhook (CLIQ_WEBHOOK_URL)
 *   2. Email through Resend (RESEND_API_KEY + RESEND_FROM_EMAIL + OPS_ALERT_EMAIL)
 *   3. Render logs only (console.error), so nothing is silently lost
 * An alert never throws and never blocks the request that raised it.
 */
export interface OpsAlertResult {
  channel: "cliq" | "email" | "log";
  ok: boolean;
  error?: string;
}

export async function sendOpsAlert(subject: string, body: string): Promise<OpsAlertResult> {
  const line = `[OPS ALERT] ${subject} — ${body}`;
  const cliq = process.env.CLIQ_WEBHOOK_URL;
  if (cliq) {
    try {
      const res = await fetch(cliq, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `*${subject}*\n${body}` }),
      });
      if (res.ok) return { channel: "cliq", ok: true };
      console.error(`${line} (Cliq returned ${res.status})`);
      return { channel: "cliq", ok: false, error: `HTTP ${res.status}` };
    } catch (err) {
      console.error(`${line} (Cliq failed: ${describeError(err)})`);
      return { channel: "cliq", ok: false, error: describeError(err) };
    }
  }
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  const to = process.env.OPS_ALERT_EMAIL;
  if (key && from && to) {
    try {
      const resend = new Resend(key);
      const { error } = await resend.emails.send({ from, to, subject: `[Orders] ${subject}`, text: body });
      if (!error) return { channel: "email", ok: true };
      console.error(`${line} (email failed: ${error.message})`);
      return { channel: "email", ok: false, error: error.message };
    } catch (err) {
      console.error(`${line} (email failed: ${describeError(err)})`);
      return { channel: "email", ok: false, error: describeError(err) };
    }
  }
  console.error(line);
  return { channel: "log", ok: true };
}

/** Which webhook outcomes a person should hear about, and the alert title. */
export function orderAlertTitle(processingResult: string): string | null {
  switch (processingResult) {
    case "held_deal_enqueued":
      return "New order — card held until filing";
    case "paid_deal_enqueued":
      return "New order — paid at checkout";
    case "collected":
    case "collected_deal_update_enqueued":
      return "Payment collected after filing";
    case "hold_released":
      return "Card hold released — check the order";
    case "refunded":
      return "Order refunded";
    default:
      return null;
  }
}

/** Looks up the order and sends the alert for a webhook outcome, if it merits one. */
export async function notifyOrderEvent(pool: Pool, processingResult: string, orderId: string | null): Promise<void> {
  const title = orderAlertTitle(processingResult);
  if (!title || !orderId) return;
  try {
    const { rows } = await pool.query(
      `SELECT o.order_id, o.product, o.total_cents, o.payment_status, o.fulfillment_status, fs.email, fs.entity_name_primary
       FROM orders o LEFT JOIN filing_sessions fs ON fs.filing_session_id = o.filing_session_id
       WHERE o.order_id = $1`,
      [orderId]
    );
    const o = rows[0];
    const email: string = o?.email ?? "";
    const test = /\+test|test@|launch-test|\.invalid$/i.test(email);
    const body = o
      ? [
          `Order ${o.order_id}`,
          `Package: ${o.product} — $${(o.total_cents / 100).toFixed(2)}`,
          `Company name: ${o.entity_name_primary ?? "(not given)"}`,
          `Payment: ${o.payment_status} · Filing: ${o.fulfillment_status}`,
        ].join("\n")
      : `Order ${orderId}`;
    await sendOpsAlert(`${test ? "[TEST] " : ""}${title}`, body);
  } catch (err) {
    console.error(`[ops alert] could not build order alert for ${orderId}:`, describeError(err));
  }
}
