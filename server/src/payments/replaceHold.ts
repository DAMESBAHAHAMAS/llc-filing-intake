import type { Pool, PoolClient } from "pg";
import { describeError } from "../db/describeError.js";
import { hasDiyPackage } from "../offers/diyPackage.js";
import { REPLACEMENT_CONSENT_PHRASE } from "../offers/payAfterFiling.js";
import { sendOpsAlert } from "../ops/alerts.js";
import { alertEmailsNotQueued, enqueueCustomerEmails, queueOrderEmail } from "../orderEmails/worker.js";
import { cancelPaymentIntent, listPaymentIntents, placeReplacementHold, retrievePaymentIntent, type StripePaymentIntent } from "../stripe/restClient.js";
import { claimOrder, releaseOrder } from "./holdLock.js";
import { isCardDecline } from "./savedCard.js";

/**
 * Replaces a card hold that is about to end, with the customer's documented
 * consent (Damian, 6 Nov 2026). The consent is the wording Stripe reports they
 * saw at checkout, stored on the order. It covers a hold about to end, so a
 * hold that already ended is renewed only by a person who says how the customer
 * agreed (`customerAgreed`). The sweep never does that.
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
  deps: ReplaceDeps = { alert: sendOpsAlert },
  customerAgreed?: string
): Promise<ReplaceOutcome> {
  const claim = await claimOrder(pool, orderId);
  if (!claim) return { kind: "refused", code: "order_busy", detail: "another step is running on this order" };
  try {
    return await replaceClaimedHold(pool, orderId, deps, customerAgreed);
  } finally {
    await releaseOrder(pool, orderId, claim);
  }
}

/**
 * A hold Stripe placed for this order that the order doesn't know about: the
 * response was lost, or the process died before the move.
 */
async function findUntrackedHolds(customerId: string, order: HoldRow): Promise<StripePaymentIntent[]> {
  const known = new Set([order.stripe_payment_intent_id, ...(order.superseded_payment_intent_ids ?? [])]);
  const intents = await listPaymentIntents(customerId);
  return intents.filter((pi) => pi.status === "requires_capture" && pi.metadata?.order_id === order.order_id && !known.has(pi.id));
}

/** A lapse can stop a filing waiting to start. The same rule the webhook applied to the first hold. */
async function returnToReady(client: PoolClient, order: HoldRow): Promise<void> {
  if (order.fulfillment_status !== "not_ready" || (order.stripe_livemode === false && process.env.TEST_MODE_ORDERS_FILE !== "true")) return;
  const { rows } = await client.query<{ filing_data: { registered_agent_path?: string } | null; registered_agent_status: string | null }>(
    `SELECT filing_data, registered_agent_status FROM filing_sessions WHERE filing_session_id = $1`,
    [order.filing_session_id]
  );
  if (rows[0]?.filing_data?.registered_agent_path === "customer" && rows[0]?.registered_agent_status !== "accepted") return;
  await client.query(`UPDATE orders SET fulfillment_status = 'ready', fulfillment_ready_at = now() WHERE order_id = $1 AND fulfillment_status = 'not_ready'`, [order.order_id]);
}

/**
 * The order, its flags and the customer's email change together, so a crash
 * leaves either the old state or the new one. `superseded_open` stays true
 * until the old hold is confirmed cancelled, so the sweep can finish that.
 */
async function moveOrderToHold(
  pool: Pool,
  order: HoldRow,
  newHoldId: string,
  oldHoldStanding: boolean,
  lapsed: boolean,
  customerAgreed: string | undefined
): Promise<{ moved: boolean; emailQueued: boolean }> {
  const oldId = order.stripe_payment_intent_id as string;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const moved = await client.query(
      `UPDATE orders SET stripe_payment_intent_id = $2, payment_status = 'authorized', capture_before = NULL, hold_expiry_flagged_at = NULL,
              hold_final_flagged_at = NULL, hold_unknown_flagged_at = NULL, hold_lapsed_flagged_at = NULL, filing_approved_at = NULL,
              replacement_attempts = 0, replacement_last_error = NULL, replacement_last_attempt_at = now(),
              superseded_payment_intent_ids = $3::jsonb, superseded_open = superseded_open OR $5::boolean
        WHERE order_id = $1 AND stripe_payment_intent_id = $4 AND payment_status IN ('authorized', 'released')
          AND cancelled_at IS NULL AND proof_of_filing_at IS NULL`,
      [order.order_id, newHoldId, JSON.stringify([...(order.superseded_payment_intent_ids ?? []), oldId]), oldId, oldHoldStanding]
    );
    let emailQueued = true;
    if (moved.rowCount) {
      if (lapsed) await returnToReady(client, order);
      if (customerAgreed) {
        await client.query(`INSERT INTO filing_events (filing_session_id, event_type, payload) VALUES ($1, 'hold_renewed_by_agreement', $2)`, [
          order.filing_session_id,
          JSON.stringify({ order_id: order.order_id, customer_agreed: customerAgreed, replaces: oldId, payment_intent: newHoldId }),
        ]);
      }
      emailQueued = await enqueueCustomerEmails(client, {
        orderId: order.order_id,
        filingSessionId: order.filing_session_id,
        emailTypes: ["hold_replaced"],
        paymentMode: "hold",
        dedupeKey: newHoldId,
      });
    }
    await client.query("COMMIT");
    return { moved: Boolean(moved.rowCount), emailQueued };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function replaceClaimedHold(pool: Pool, orderId: string, deps: ReplaceDeps, customerAgreed: string | undefined): Promise<ReplaceOutcome> {
  const { rows } = await pool.query<HoldRow>(
    `SELECT order_id, filing_session_id, payment_status, stripe_payment_intent_id, total_cents, currency, line_items, cancelled_at,
            proof_of_filing_at, superseded_payment_intent_ids, saved_card_authorized_at, saved_card_authorization_text, replacement_attempts, sunbiz_submitted_at, fulfillment_status, stripe_livemode
     FROM orders WHERE order_id = $1`,
    [orderId]
  );
  const order = rows[0];
  if (!order) return { kind: "refused", code: "order_not_found", detail: "order not found" };
  if (!hasDiyPackage(order.line_items ?? [])) return { kind: "refused", code: "not_a_diy_package", detail: "this is for DIY_PACKAGE orders" };
  // A filing with Florida is covered by the saved card, unless it came back rejected.
  const lapsed = order.payment_status === "released" && (!order.sunbiz_submitted_at || order.fulfillment_status === "rejected");
  if (order.cancelled_at || order.proof_of_filing_at || (order.payment_status !== "authorized" && !lapsed) || !order.stripe_payment_intent_id) {
    return { kind: "refused", code: "no_hold_to_replace", detail: `this order has no open hold to replace (${order.payment_status})` };
  }
  if (lapsed && !customerAgreed) {
    return { kind: "refused", code: "customer_agreement_required", detail: "this hold has ended; say how the customer agreed to a new one in customer_agreed" };
  }
  if (!hasReplacementConsent(order)) {
    return { kind: "refused", code: "no_replacement_consent", detail: "this order has no documented consent to a replacement hold" };
  }
  const attempts = order.replacement_attempts ?? 0;
  // The limit stops unattended retries. With a lapsed hold, a person and the customer are acting.
  if (attempts >= MAX_REPLACEMENT_ATTEMPTS && !lapsed) {
    return { kind: "refused", code: "replacement_attempts_used", detail: `${attempts} replacement attempts have been made on this hold` };
  }

  const oldId = order.stripe_payment_intent_id;
  // `definite` is false when we don't know why it failed. The customer hears
  // that their bank said no only if it did, or once the tries have run out.
  const fail = async (code: string, detail: string, definite = true): Promise<ReplaceOutcome> => {
    const used = attempts + 1;
    await pool.query(
      `UPDATE orders SET replacement_attempts = $2, replacement_last_attempt_at = now(), replacement_last_error = $3 WHERE order_id = $1`,
      [orderId, used, detail.slice(0, 500)]
    );
    await deps.alert("A replacement card hold failed", `Order ${orderId}, attempt ${used}. ${lapsed ? `Its hold ${oldId} has already ended.` : `The current hold ${oldId} still stands.`} ${detail}`);
    if (definite || used >= MAX_REPLACEMENT_ATTEMPTS) {
      // Once per hold, so a retry does not email the customer again.
      await queueOrderEmail(pool, {
        orderId,
        filingSessionId: order.filing_session_id,
        emailTypes: ["hold_replacement_failed"],
        paymentMode: "hold",
        dedupeKey: oldId,
        details: { filing_submitted: Boolean(order.sunbiz_submitted_at) },
      });
    }
    return { kind: "failed", code, detail, attempts: used };
  };

  const original = await retrievePaymentIntent(oldId);
  const stillHeld = original.status === "requires_capture";
  if ((!stillHeld && !lapsed) || !original.customer || !original.payment_method) {
    return fail("hold_not_replaceable", `the hold is ${original.status}, or has no saved card`);
  }

  // Unable to see what exists, a new hold could be a second one.
  let untracked: StripePaymentIntent[];
  try {
    untracked = await findUntrackedHolds(original.customer, order);
  } catch (err) {
    return fail("replacement_lookup_failed", `could not check Stripe for an earlier hold: ${describeError(err)}`, false);
  }
  if (untracked.length > 1) {
    await deps.alert("More than one untracked card hold", `Order ${orderId}: ${untracked.map((pi) => pi.id).join(", ")}. The order is taking ${untracked[0].id}. Cancel the others in Stripe.`);
  }

  let replacement = untracked[0];
  if (!replacement) {
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
      // After a timeout a hold may exist. The next attempt finds it by its metadata.
      return isCardDecline(err) ? fail("replacement_declined", describeError(err)) : fail("replacement_result_unknown", describeError(err), false);
    }
  }
  if (replacement.status !== "requires_capture") {
    // It holds nothing we can use, and must not sit open on the customer's card.
    await cancelPaymentIntent(replacement.id, `cancel-replacement-${replacement.id}`).catch(() => undefined);
    return fail("replacement_not_capturable", `the new hold came back ${replacement.status}`);
  }

  const { moved, emailQueued } = await moveOrderToHold(pool, order, replacement.id, stillHeld, lapsed, customerAgreed);
  if (!moved) {
    // Never cancel the hold the order now points at: a replayed key can hand
    // this call the same hold that another call already moved the order to.
    const { rows: now } = await pool.query<{ stripe_payment_intent_id: string | null }>(`SELECT stripe_payment_intent_id FROM orders WHERE order_id = $1`, [orderId]);
    if (now[0]?.stripe_payment_intent_id !== replacement.id) {
      await cancelPaymentIntent(replacement.id, `cancel-replacement-${replacement.id}`).catch((err) =>
        deps.alert("A new card hold is still open", `Order ${orderId} changed during a replacement, and ${replacement.id} could not be cancelled. Cancel it in Stripe. ${describeError(err)}`)
      );
    }
    return { kind: "refused", code: "order_changed", detail: "the order changed while replacing" };
  }
  if (!emailQueued) await alertEmailsNotQueued(orderId, "the hold renewal email");

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
  return { kind: "replaced", paymentIntentId: replacement.id, oldHoldStillOpen };
}
