import { Resend } from "resend";
import type { Pool } from "pg";
import { describeError } from "../db/describeError.js";
import { needsSunbizFiling } from "../offers/sunbizFiling.js";

/**
 * Delivers proof of filing to the customer. routes/orders.ts calls this
 * before it collects a held payment, because of Damian's rule (29 Sep 2026):
 * funds are collected only after proof of filing is delivered.
 *
 * Proof is the Sunbiz document number of the filed Articles (DECISIONS.md,
 * 2026-09-30). An EIN-only order records the EIN as its proof; that number
 * stays out of email, so the customer gets a completion notice instead.
 *
 * "Delivered" means the email provider accepted the message. It is not an
 * inbox receipt. The Articles PDF is not attached or linked: its storage and
 * serving target is still undecided (DECISIONS.md, 2026-09-09, boundary 1).
 *
 * Never throws: any failure comes back as { ok: false }, so the caller
 * collects nothing.
 */
export const DISCLAIMER = "Damian Knowles is a Business Developer, not a law firm or attorney, and does not provide legal advice.";

export interface ProofEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Passed to the provider, so a retry after a lost response does not send twice. */
  idempotencyKey: string;
}

export interface ProofEmailSender {
  send(message: ProofEmail): Promise<{ ok: boolean; providerMessageId?: string; error?: string }>;
}

export type ProofDeliveryResult = { ok: true; alreadyDelivered: boolean } | { ok: false; error: string };

export interface ProofOrderRow {
  order_id: string;
  line_items: Array<{ offer_code?: string }> | null;
  proof_of_filing_ref: string | null;
  proof_delivered_at: Date | string | null;
  email: string | null;
  full_name: string | null;
  entity_name_primary: string | null;
  filing_data: { llc_name?: string } | null;
}

let client: Resend | null = null;

export const realProofEmailSender: ProofEmailSender = {
  async send({ to, subject, text, html, idempotencyKey }) {
    const key = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM_EMAIL;
    if (!key || !from) {
      return { ok: false, error: "Resend not configured (RESEND_API_KEY / RESEND_FROM_EMAIL unset)" };
    }
    const replyTo = process.env.ORDER_EMAIL_REPLY_TO;
    try {
      client ??= new Resend(key);
      const { data, error } = await client.emails.send(
        { from, to: [to], subject, text, html, ...(replyTo ? { replyTo } : {}) },
        { idempotencyKey }
      );
      if (error) return { ok: false, error: `Resend send failed: ${error.message}` };
      return { ok: true, providerMessageId: data?.id };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  },
};

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Text and html carry the same content, as the other transactional emails do. */
export function renderProofEmail(row: ProofOrderRow): { subject: string; text: string; html: string } {
  const firstName = row.full_name?.trim().split(/\s+/)[0];
  const company = row.filing_data?.llc_name?.trim() || row.entity_name_primary?.trim() || "your company";
  const sunbizFiling = needsSunbizFiling(row.line_items ?? []);

  const subject = sunbizFiling ? `Your LLC is filed: ${company}` : "Your filing is complete";
  const paragraphs = [
    firstName ? `Hello ${firstName},` : "Hello,",
    ...(sunbizFiling
      ? [
          `The Florida Division of Corporations has filed the Articles of Organization for ${company}.`,
          `Sunbiz document number: ${row.proof_of_filing_ref}`,
          `Order number: ${row.order_id}`,
          "You can look up your company on sunbiz.org with this number.",
        ]
      : ["Your filing for this order is complete.", `Order number: ${row.order_id}`]),
    "We are now collecting payment for this order from the card you used at checkout, as your order confirmation explained.",
    "Questions? Reply to this email.",
    DISCLAIMER,
  ];
  return {
    subject,
    text: paragraphs.join("\n\n"),
    html: paragraphs.map((line) => `<p>${escapeHtml(line)}</p>`).join("\n"),
  };
}

async function recordFailure(pool: Pool, orderId: string, error: string): Promise<void> {
  try {
    await pool.query(`UPDATE orders SET proof_delivery_error = $2 WHERE order_id = $1`, [orderId, error]);
  } catch (err) {
    console.error(`[proof delivery] could not record the failure for ${orderId}:`, describeError(err));
  }
}

/** Sends the proof once per order. A repeat call after success sends nothing. */
export async function deliverProofToCustomer(
  pool: Pool,
  orderId: string,
  sender: ProofEmailSender = realProofEmailSender
): Promise<ProofDeliveryResult> {
  try {
    const { rows } = await pool.query<ProofOrderRow>(
      `SELECT o.order_id, o.line_items, o.proof_of_filing_ref, o.proof_delivered_at,
              s.email, s.full_name, s.entity_name_primary, s.filing_data
       FROM orders o JOIN filing_sessions s ON s.filing_session_id = o.filing_session_id
       WHERE o.order_id = $1`,
      [orderId]
    );
    const row = rows[0];
    if (!row) return { ok: false, error: "order not found" };
    if (row.proof_delivered_at) return { ok: true, alreadyDelivered: true };
    if (!row.proof_of_filing_ref) return { ok: false, error: "no proof of filing recorded on this order" };

    const email = row.email?.trim();
    if (!email) {
      const error = "this order has no customer email address, so proof of filing cannot be delivered";
      await recordFailure(pool, orderId, error);
      return { ok: false, error };
    }

    const sent = await sender.send({
      to: email,
      ...renderProofEmail(row),
      idempotencyKey: `proof-of-filing/${orderId}`,
    });
    if (!sent.ok) {
      const error = sent.error ?? "the email provider did not accept the message";
      await recordFailure(pool, orderId, error);
      return { ok: false, error };
    }

    await pool.query(
      `UPDATE orders SET proof_delivered_at = now(), proof_delivery_message_id = $2, proof_delivery_error = NULL WHERE order_id = $1`,
      [orderId, sent.providerMessageId ?? null]
    );
    return { ok: true, alreadyDelivered: false };
  } catch (err) {
    const error = describeError(err);
    await recordFailure(pool, orderId, error);
    return { ok: false, error };
  }
}
