import type { Pool } from "pg";
import { describeError } from "../db/describeError.js";
import { hasDiyPackage } from "../offers/diyPackage.js";
import { REPLACEMENT_CONSENT_PHRASE } from "../offers/payAfterFiling.js";
import { sendOpsAlert } from "../ops/alerts.js";
import { queueOrderEmail } from "../orderEmails/worker.js";
import { cancelPaymentIntent, placeReplacementHold, retrievePaymentIntent } from "../stripe/restClient.js";
import { claimOrder, releaseOrder } from "./holdLock.js";

/**
 * Replaces a card hold that is about to end, with the customer's documented
 * consent (Damian, 6 Nov 2026). The consent is the wording Stripe reports they
 * saw at checkout, stored on the order. Nothing else permits this.
 *
 * The new hold is placed first and must be capturable before the order moves
 * to it, so the order is never left with nothing. Every outcome reaches a
 * person: the customer is emailed, and a failure alerts the operator.
 */
export const MAX_REPLACEMENT_ATTEMPTS = 3;
/** A bank's answer rarely changes within hours, and each try is visible to it. */
export const HOURS_BETWEEN_ATTEMPTS = 6;

export type ReplaceOutcome =
  | { kind: "replaced"; paymentIntentId: string; oldHoldStillOpen: boolean }
  | { kind: "refused"; code: string; detail: string }
  | { kind: "failed"; code: string; detail: string; attempts: number };

export interface ReplaceDeps {
  alert: (title: string, message: string) => Promise<unknown>;
}

interface HoldRow {
  order_id: string;
  filing_session_id: string;
  payment_status: string;
  stripe_payment_intent_id: string | null;
  total_cents: number;
  currency: string | null;
  line_items: Array<{ offer_code?: string }> | null;
  cancelled_at: Date | null;
  proof_of_filing_at: Date | null;
  superseded_payment_intent_ids: string[] | null;
  saved_card_authorized_at: Date | null;
  saved_card_authorization_text: string | null;
  replacement_attempts: number | null;
  sunbiz_submitted_at: Date | null;
  fulfillment_status: string;
  stripe_livemode: boolean | null;
}

/** Whether this order's customer agreed to a replacement hold, on record. */
export function hasReplacementConsent(order: Pick<HoldRow, "saved_card_authorized_at" | "saved_card_authorization_text">): boolean {
  return Boolean(order.saved_card_authorized_at && order.saved_card_authorization_text?.includes(REPLACEMENT_CONSENT_PHRASE));
}

export async function replaceHold(
  pool: Pool,
  orderId: string,
  deps: ReplaceDeps = { alert: sendOpsAlert }
): Promise<ReplaceOutcome> {
  if (!(await claimOrder(pool, orderId))) return { kind: "refused", code: "order_busy", detail: "another step is running on this order" };
  try {
    return await replaceClaimedHold(pool, orderId, deps);
  } finally {
    await releaseOrder(pool, orderId);
  }
}

async function replaceClaimedHold(pool: Pool, orderId: string, deps: ReplaceDeps): Promise<ReplaceOutcome> {
  const { rows } = await pool.query<HoldRow>(
    `SELECT order_id, filing_session_id, payment_status, stripe_payment_intent_id, total_cents, currency, line_items, cancelled_at,
            proof_of_filing_at, superseded_payment_intent_ids, saved_card_authorized_at, saved_card_authorization_text, replacement_attempts, sunbiz_submitted_at, fulfillment_status, stripe_livemode
     FROM orders WHERE order_id = $1`,
    [orderId]
  );
  const order = rows[0];
  if (!order) return { kind: "refused", code: "order_not_found", detail: "order not found" };
  if (!hasDiyPackage(order.line_items ?? [])) return { kind: "refused", code: "not_a_diy_package", detail: "this is for DIY_PACKAGE orders" };
  // A hold that lapsed before filing can be renewed too: without one the order
  // can't file. After filing the saved card covers it, so that is left alone.
  const lapsed = order.payment_status === "released" && !order.sunbiz_submitted_at;
  if (order.cancelled_at || order.proof_of_filing_at || (order.payment_status !== "authorized" && !lapsed) || !order.stripe_payment_intent_id) {
    return { kind: "refused", code: "no_hold_to_replace", detail: `this order has no open hold to replace (${order.payment_status})` };
  }
  if (!hasReplacementConsent(order)) {
    return { kind: "refused", code: "no_replacement_consent", detail: "this order has no documented consent to a replacement hold" };
  }
  const attempts = order.replacement_attempts ?? 0;
  if (attempts >= MAX_REPLACEMENT_ATTEMPTS) {
    return { kind: "refused", code: "replacement_attempts_used", detail: `${attempts} replacement attempts have been made on this hold` };
  }

  const oldId = order.stripe_payment_intent_id;
  const fail = async (code: string, detail: string): Promise<ReplaceOutcome> => {
    const used = attempts + 1;
    await pool.query(
      `UPDATE orders SET replacement_attempts = $2, replacement_last_attempt_at = now(), replacement_last_error = $3 WHERE order_id = $1`,
      [orderId, used, detail.slice(0, 500)]
    );
    await deps.alert("A replacement card hold failed", `Order ${orderId}, attempt ${used} of ${MAX_REPLACEMENT_ATTEMPTS}. The current hold ${oldId} still stands. ${detail}`);
    // Once per hold, so a retry does not email the customer again.
    await queueOrderEmail(pool, {
      orderId,
      filingSessionId: order.filing_session_id,
      emailTypes: ["hold_replacement_failed"],
      paymentMode: "hold",
      dedupeKey: oldId,
      details: { filing_submitted: Boolean(order.sunbiz_submitted_at) },
    });
    return { kind: "failed", code, detail, attempts: used };
  };

  const original = await retrievePaymentIntent(oldId);
  const stillHeld = original.status === "requires_capture";
  if ((!stillHeld && !lapsed) || !original.customer || !original.payment_method) {
    return fail("hold_not_replaceable", `the hold is ${original.status}, or has no saved card`);
  }

  let replacement;
  try {
    replacement = await placeReplacementHold({
      customerId: original.customer,
      paymentMethodId: original.payment_method,
      amountCents: order.total_cents,
      currency: order.currency || "usd",
      idempotencyKey: `replace-${orderId}-${oldId}-${attempts + 1}`,
      metadata: { order_id: orderId, kind: "replacement_hold", replaces: oldId },
      receiptEmail: original.receipt_email,
    });
  } catch (err) {
    return fail("replacement_declined", describeError(err));
  }
  if (replacement.status !== "requires_capture") {
    // It holds nothing we can use, and must not sit open on the customer's card.
    await cancelPaymentIntent(replacement.id, `cancel-replacement-${replacement.id}`).catch(() => undefined);
    return fail("replacement_not_capturable", `the new hold came back ${replacement.status}`);
  }

  const moved = await pool.query(
    `UPDATE orders SET stripe_payment_intent_id = $2, payment_status = 'authorized', capture_before = NULL, hold_expiry_flagged_at = NULL,
            hold_final_flagged_at = NULL, filing_approved_at = NULL, replacement_attempts = 0, replacement_last_error = NULL,
            replacement_last_attempt_at = now(), superseded_payment_intent_ids = $3::jsonb, superseded_open = $5
      WHERE order_id = $1 AND stripe_payment_intent_id = $4 AND payment_status IN ('authorized', 'released') AND cancelled_at IS NULL`,
    [orderId, replacement.id, JSON.stringify([...(order.superseded_payment_intent_ids ?? []), oldId]), oldId, stillHeld]
  );
  if (!moved.rowCount) {
    // Never cancel the hold the order now points at: a replayed key can hand
    // this call the same hold that another call already moved the order to.
    const { rows: now } = await pool.query<{ stripe_payment_intent_id: string | null }>(`SELECT stripe_payment_intent_id FROM orders WHERE order_id = $1`, [orderId]);
    if (now[0]?.stripe_payment_intent_id !== replacement.id) {
      await cancelPaymentIntent(replacement.id, `cancel-replacement-${replacement.id}`);
    }
    return { kind: "refused", code: "order_changed", detail: "the order changed while replacing" };
  }

  let oldHoldStillOpen = false;
  if (stillHeld) {
    try {
      await cancelPaymentIntent(oldId, `cancel-superseded-${oldId}`);
      await pool.query(`UPDATE orders SET superseded_open = false WHERE order_id = $1`, [orderId]);
    } catch (err) {
      oldHoldStillOpen = true;
      await deps.alert("A replaced card hold is still open", `Order ${orderId}. The sweep will retry cancelling ${oldId}. The customer has two holds until then. ${describeError(err)}`);
    }
  }
  // A hold that lapsed may have stopped a filing that was waiting to start.
  // The same rule the webhook applied when the first hold was placed.
  if (lapsed && order.fulfillment_status === "not_ready" && (order.stripe_livemode !== false || process.env.TEST_MODE_ORDERS_FILE === "true")) {
    const { rows: session } = await pool.query<{ filing_data: { registered_agent_path?: string } | null; registered_agent_status: string | null }>(
      `SELECT filing_data, registered_agent_status FROM filing_sessions WHERE filing_session_id = $1`,
      [order.filing_session_id]
    );
    if (session[0]?.filing_data?.registered_agent_path !== "customer" || session[0]?.registered_agent_status === "accepted") {
      await pool.query(`UPDATE orders SET fulfillment_status = 'ready', fulfillment_ready_at = now() WHERE order_id = $1 AND fulfillment_status = 'not_ready'`, [orderId]);
    }
  }
  await queueOrderEmail(pool, {
    orderId,
    filingSessionId: order.filing_session_id,
    emailTypes: ["hold_replaced"],
    paymentMode: "hold",
    dedupeKey: replacement.id,
  });
  return { kind: "replaced", paymentIntentId: replacement.id, oldHoldStillOpen };
}
