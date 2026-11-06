import type { Pool } from "pg";
import { describeError } from "../db/describeError.js";
import { realOrderEmailSender, type OrderEmailSender } from "../orderEmails/sender.js";
import type { EmailSendResult } from "../registeredAgent/emailSender.js";
import { buildOrderEmail, type RenderedEmail } from "../orderEmails/templates.js";
import { blockedByTestMode, TEST_MODE_NOT_SENT } from "../orderEmails/testAddress.js";
import { currentPaymentMode, ORDER_EMAIL_COLUMNS, type OrderEmailState } from "../orderEmails/worker.js";

/**
 * Delivers the filing confirmation, the one email that carries proof of
 * filing. routes/orders.ts calls this before it collects a held payment,
 * because of Damian's rule (29 Sep 2026): funds are collected only after
 * proof of filing is delivered. There is no other filing confirmation: the
 * order email queue does not send one.
 *
 * Proof is the Sunbiz document number of the filed Articles (DECISIONS.md,
 * 2026-09-30). An EIN-only order records the EIN as its proof; that number
 * stays out of email, so the customer gets a completion notice instead.
 *
 * "Delivered" means the email provider accepted the message. It is not an
 * inbox receipt. The Articles PDF is not attached or linked: its storage and
 * serving target is still undecided (DECISIONS.md, 2026-09-09, boundary 1).
 *
 * A test-mode order at a real address is refused, so it collects nothing.
 *
 * Never throws: any failure comes back as { ok: false }, so the caller
 * collects nothing.
 */
export type ProofDeliveryResult = { ok: true; alreadyDelivered: boolean } | { ok: false; error: string };

/** Well inside the 3 minute claim on an order. Resend's client has no timeout of its own. */
export const PROOF_SEND_TIMEOUT_MS = 60_000;

export interface ProofOrderRow extends OrderEmailState {
  proof_delivered_at: Date | string | null;
}

/** The same template the other order emails use, so there is one wording. */
export function renderProofEmail(row: ProofOrderRow): RenderedEmail {
  return buildOrderEmail("filing_confirmation", row, currentPaymentMode(row) ?? "hold");
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
  sender: OrderEmailSender = realOrderEmailSender,
  timeoutMs: number = PROOF_SEND_TIMEOUT_MS
): Promise<ProofDeliveryResult> {
  try {
    const { rows } = await pool.query<ProofOrderRow>(
      `SELECT ${ORDER_EMAIL_COLUMNS}, o.proof_delivered_at
       FROM orders o JOIN filing_sessions fs ON fs.filing_session_id = o.filing_session_id
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
    if (blockedByTestMode(row.stripe_livemode, email)) {
      await recordFailure(pool, orderId, TEST_MODE_NOT_SENT);
      return { ok: false, error: TEST_MODE_NOT_SENT };
    }

    // Too slow counts as not delivered. The idempotency key stops a retry
    // sending a second email if this one gets through after all.
    let timer: NodeJS.Timeout | undefined;
    const tooSlow = new Promise<EmailSendResult>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: `the email provider did not answer within ${timeoutMs / 1000} seconds` }), timeoutMs);
    });
    const sent = await Promise.race([sender.send({ to: email, ...renderProofEmail(row), idempotencyKey: `proof-of-filing/${orderId}` }), tooSlow]).finally(() => clearTimeout(timer));
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
