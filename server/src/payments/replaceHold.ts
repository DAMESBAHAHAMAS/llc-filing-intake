import type { Pool, PoolClient } from "pg";
import { describeError } from "../db/describeError.js";
import { diyBreakdownFor, hasDiyPackage } from "../offers/diyPackage.js";
import { REPLACEMENT_CONSENT_PHRASE } from "../offers/payAfterFiling.js";
import { sendOpsAlert } from "../ops/alerts.js";
import { alertEmailsNotQueued, enqueueCustomerEmails } from "../orderEmails/worker.js";
import { cancelPaymentIntent, holdDetails, listPaymentIntents, placeReplacementHold, retrievePaymentIntent, type StripePaymentIntent } from "../stripe/restClient.js";
import { approvalCurrent } from "./filingClearance.js";
import { claimOrder, releaseOrder } from "./holdLock.js";
import { isCardDecline, stripeResultUnknown } from "./savedCard.js";

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
 *
 * A request Stripe never answered may still have placed a hold. The order
 * remembers that (`replacement_unknown_at`) from before the request is sent, so
 * a crash counts too, until that hold is taken or cancelled.
 */
export const MAX_REPLACEMENT_ATTEMPTS = 3;
/** A bank's answer rarely changes within hours, and each try is visible to it. */
export const HOURS_BETWEEN_ATTEMPTS = 6;
/** The sweep renews a hold this close to its end. */
export const RENEWAL_WINDOW_HOURS = 48;
/** How long Stripe may still be working on a request we stopped waiting for. */
export const UNKNOWN_RESULT_SETTLE_MS = 3600 * 1000;

export type ReplaceOutcome =
  | { kind: "replaced"; paymentIntentId: string; oldHoldStillOpen: boolean }
  | { kind: "refused"; code: string; detail: string }
  | { kind: "failed"; code: string; detail: string; attempts: number };

export interface ReplaceDeps {
  alert: (title: string, message: string) => Promise<unknown>;
}

const OPS_ALERTS: ReplaceDeps = { alert: sendOpsAlert };

/** Bank said no; Stripe gave no answer; nothing was sent to the bank at all; or the key returned a hold already gone. */
type FailureKind = "declined" | "no_answer" | "nothing_placed" | "key_spent";

export interface RenewalFacts {
  fulfillment_status: string;
  filing_approved_at: Date | string | null;
  registered_agent_status?: string | null;
  filing_data?: { registered_agent_path?: string } | null;
  /** Articles are stored for this order. */
  has_articles?: boolean | null;
}

interface HoldRow extends RenewalFacts {
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
  replacement_key_seq: number | null;
  replacement_unknown_at: Date | null;
  replacement_last_attempt_at: Date | null;
  capture_before: Date | null;
  stray_capture_pi: string | null;
  sunbiz_submitted_at: Date | null;
  stripe_livemode: boolean | null;
}

/** Whether this order's customer agreed to a replacement hold, on record. */
export function hasReplacementConsent(order: Pick<HoldRow, "saved_card_authorized_at" | "saved_card_authorization_text">): boolean {
  return Boolean(order.saved_card_authorized_at && order.saved_card_authorization_text?.includes(REPLACEMENT_CONSENT_PHRASE));
}

/**
 * Why an order can't move for now, in words for a person. Its hold should not
 * sit on the customer's funds meanwhile, so nothing renews it by itself.
 */
export function stuckOn(order: RenewalFacts): string | null {
  if (order.fulfillment_status === "rejected") return "Florida rejected the filing and we are waiting for the customer";
  if (order.fulfillment_status === "failed") return "its Articles could not be generated";
  if (order.fulfillment_status === "in_progress") return "its Articles are still being generated";
  const agentGone = order.filing_data?.registered_agent_path === "customer" && ["declined", "expired"].includes(order.registered_agent_status ?? "");
  if (agentGone && ["not_ready", "ready", "requires_review"].includes(order.fulfillment_status)) {
    return "its registered agent did not accept, and we are waiting for the customer";
  }
  if (order.fulfillment_status === "requires_review" && !order.has_articles) return "it has no Articles, so it can't be approved";
  return null;
}

/** Fills `has_articles` for a query over orders `o`. */
export const HAS_ARTICLES = `articles.order_id IS NOT NULL AS has_articles`;
export const JOIN_ARTICLES = `LEFT JOIN (SELECT DISTINCT order_id FROM filing_documents) articles ON articles.order_id = o.order_id`;

/** Stuck, or an approval is in use, which a renewal would clear. */
function cannotRenewByItself(order: RenewalFacts, now: Date): string | null {
  return stuckOn(order) ?? (approvalCurrent(order.filing_approved_at, now) ? "an approval is in use" : null);
}

/** The sweep's own rules, read again under the claim: the list it works from can be seconds old. */
function sweepStopsHere(order: HoldRow, now: Date): string | null {
  const blocked = cannotRenewByItself(order, now);
  if (blocked) return blocked;
  if (!order.capture_before || new Date(order.capture_before).getTime() - now.getTime() > RENEWAL_WINDOW_HOURS * 3600 * 1000) return "the hold is not near its end";
  const last = order.replacement_last_attempt_at;
  if (last && now.getTime() - new Date(last).getTime() < HOURS_BETWEEN_ATTEMPTS * 3600 * 1000) return "the last attempt was too recent";
  return null;
}

async function readHold(pool: Pool, orderId: string): Promise<HoldRow | undefined> {
  const { rows } = await pool.query<HoldRow>(
    `SELECT o.order_id, o.filing_session_id, o.payment_status, o.stripe_payment_intent_id, o.total_cents, o.currency, o.line_items, o.cancelled_at,
            o.proof_of_filing_at, o.superseded_payment_intent_ids, o.saved_card_authorized_at, o.saved_card_authorization_text, o.replacement_attempts,
            o.replacement_key_seq, o.replacement_unknown_at, o.replacement_last_attempt_at, o.capture_before, o.stray_capture_pi, o.filing_approved_at,
            o.sunbiz_submitted_at, o.fulfillment_status, o.stripe_livemode, fs.registered_agent_status, fs.filing_data, ${HAS_ARTICLES}
     FROM orders o LEFT JOIN filing_sessions fs ON fs.filing_session_id = o.filing_session_id ${JOIN_ARTICLES} WHERE o.order_id = $1`,
    [orderId]
  );
  return rows[0];
}

export async function replaceHold(
  pool: Pool,
  orderId: string,
  deps: ReplaceDeps = OPS_ALERTS,
  customerAgreed?: string,
  sweepAt?: Date
): Promise<ReplaceOutcome> {
  const claim = await claimOrder(pool, orderId);
  if (!claim) return { kind: "refused", code: "order_busy", detail: "another step is running on this order" };
  try {
    return await replaceClaimedHold(pool, orderId, deps, customerAgreed, sweepAt);
  } finally {
    await releaseOrder(pool, orderId, claim);
  }
}

/** The sweep's renewal. Unlike a person's, it stops if the order changed after the sweep listed it. */
export function renewHoldFromSweep(pool: Pool, orderId: string, deps: ReplaceDeps = OPS_ALERTS): Promise<ReplaceOutcome> {
  return replaceHold(pool, orderId, deps, undefined, new Date());
}

function nearItsEnd(pi: StripePaymentIntent, now: Date): boolean {
  const { captureBefore } = holdDetails(pi);
  return Boolean(captureBefore) && (captureBefore as Date).getTime() - now.getTime() <= RENEWAL_WINDOW_HOURS * 3600 * 1000;
}

function isUnknownToOrder(pi: StripePaymentIntent, order: HoldRow): boolean {
  const known = new Set([order.stripe_payment_intent_id, ...(order.superseded_payment_intent_ids ?? [])]);
  return pi.metadata?.order_id === order.order_id && !known.has(pi.id);
}

/**
 * A hold Stripe placed for this order that the order doesn't know about: the
 * response was lost, or the process died before the move.
 */
async function findUntrackedHolds(customerId: string, order: HoldRow): Promise<StripePaymentIntent[]> {
  const intents = await listPaymentIntents(customerId);
  return intents.filter((pi) => pi.status === "requires_capture" && isUnknownToOrder(pi, order));
}

/** The same search for a hold to get rid of, so it includes one Stripe is still confirming. */
async function findOpenStrays(customerId: string, order: HoldRow): Promise<StripePaymentIntent[]> {
  const intents = await listPaymentIntents(customerId);
  const stillOpen = (pi: StripePaymentIntent) => pi.status === "requires_capture" || (pi.metadata?.kind === "replacement_hold" && !["succeeded", "canceled"].includes(pi.status));
  return intents.filter((pi) => stillOpen(pi) && isUnknownToOrder(pi, order));
}

async function cancelStrays(pool: Pool, order: HoldRow, strays: StripePaymentIntent[], deps: ReplaceDeps): Promise<void> {
  const cancelled: string[] = [];
  for (const pi of strays) {
    try {
      await cancelPaymentIntent(pi.id, `cancel-untracked-${pi.id}`);
      cancelled.push(pi.id);
    } catch (err) {
      await deps.alert("A card hold nothing tracks is still open", `Order ${order.order_id}: ${pi.id} could not be cancelled, and the sweep keeps trying. The customer has this hold on top of anything else on the order, so cancel it in Stripe. ${describeError(err)}`);
    }
  }
  if (cancelled.length) {
    // The old key would replay a hold that no longer exists.
    await pool.query(`UPDATE orders SET replacement_key_seq = replacement_key_seq + 1 WHERE order_id = $1`, [order.order_id]);
    await deps.alert("A card hold nothing tracked was cancelled", `Order ${order.order_id}: ${cancelled.join(", ")}, left by a request Stripe never answered. It was not collected.`);
  }
}

/**
 * For a step that closes an order or takes its money: a hold from a lost answer
 * must not stay on the card. Only runs when one may exist. Never throws: the
 * sweep keeps looking until the question is settled.
 */
export async function closeUntrackedHolds(pool: Pool, orderId: string, deps: ReplaceDeps = OPS_ALERTS): Promise<void> {
  try {
    const order = await readHold(pool, orderId);
    if (!order?.replacement_unknown_at || !order.stripe_payment_intent_id) return;
    const current = await retrievePaymentIntent(order.stripe_payment_intent_id);
    if (!current.customer) return;
    await cancelStrays(pool, order, await findOpenStrays(current.customer, order), deps);
  } catch (err) {
    await deps.alert("A card hold nothing tracks may still be open", `Order ${orderId}: Stripe could not be checked for a hold left by an unanswered request, and the sweep keeps trying. ${describeError(err)}`);
  }
}

/**
 * Finishes a request that got no answer, with or without attempts left. A hold
 * the order would have renewed onto is taken. Any other is cancelled, because
 * nothing else on the order will ever look at it. The question closes only
 * once a look long after the request finds nothing.
 */
export async function settleUnknownReplacement(pool: Pool, orderId: string, deps: ReplaceDeps = OPS_ALERTS, now: Date = new Date()): Promise<void> {
  const claim = await claimOrder(pool, orderId);
  if (!claim) return;
  try {
    const order = await readHold(pool, orderId);
    if (!order?.replacement_unknown_at || !order.stripe_payment_intent_id) return;
    const current = await retrievePaymentIntent(order.stripe_payment_intent_id);
    const strays = current.customer ? await findOpenStrays(current.customer, order) : [];
    if (!strays.length) {
      // Whatever that request did is over, and nothing of it stands. Its key
      // can only replay that, a stored 500 or a hold cancelled since, so the
      // next attempt must reach the bank with a new one.
      if (now.getTime() - new Date(order.replacement_unknown_at).getTime() >= UNKNOWN_RESULT_SETTLE_MS) {
        await pool.query(`UPDATE orders SET replacement_unknown_at = NULL, replacement_key_seq = replacement_key_seq + 1 WHERE order_id = $1`, [orderId]);
      }
      return;
    }
    const usable = strays.find((pi) => pi.status === "requires_capture");
    const stillHeld = current.status === "requires_capture";
    const orderOpen = order.payment_status === "authorized" && !order.cancelled_at && !order.proof_of_filing_at && !order.stray_capture_pi;
    if (usable && stillHeld && orderOpen && hasReplacementConsent(order) && !cannotRenewByItself(order, now)) {
      await moveToReplacement(pool, order, usable, true, false, undefined, deps);
      await cancelStrays(pool, order, strays.filter((pi) => pi.id !== usable.id), deps);
      return;
    }
    await cancelStrays(pool, order, strays, deps);
  } finally {
    await releaseOrder(pool, orderId, claim);
  }
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
              replacement_attempts = 0, replacement_last_error = NULL, replacement_last_attempt_at = now(), replacement_unknown_at = NULL, replacement_key_seq = 0,
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
        details: { hold_ended: lapsed },
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

/** The move, then the old hold goes. A capturable new hold is the caller's to prove. */
async function moveToReplacement(
  pool: Pool,
  order: HoldRow,
  replacement: StripePaymentIntent,
  stillHeld: boolean,
  lapsed: boolean,
  customerAgreed: string | undefined,
  deps: ReplaceDeps
): Promise<ReplaceOutcome> {
  const orderId = order.order_id;
  const oldId = order.stripe_payment_intent_id as string;
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

async function replaceClaimedHold(pool: Pool, orderId: string, deps: ReplaceDeps, customerAgreed: string | undefined, sweepAt: Date | undefined): Promise<ReplaceOutcome> {
  const order = await readHold(pool, orderId);
  if (!order) return { kind: "refused", code: "order_not_found", detail: "order not found" };
  if (!hasDiyPackage(order.line_items ?? [])) return { kind: "refused", code: "not_a_diy_package", detail: "this is for DIY_PACKAGE orders" };
  // A filing with Florida is covered by the saved card, unless it came back rejected.
  const rejected = order.fulfillment_status === "rejected";
  const lapsed = order.payment_status === "released" && (!order.sunbiz_submitted_at || rejected);
  if (order.cancelled_at || order.proof_of_filing_at || (order.payment_status !== "authorized" && !lapsed) || !order.stripe_payment_intent_id) {
    return { kind: "refused", code: "no_hold_to_replace", detail: `this order has no open hold to replace (${order.payment_status})` };
  }
  if (order.stray_capture_pi) {
    return { kind: "refused", code: "stray_capture_unresolved", detail: `money landed on ${order.stray_capture_pi}, which this order does not use; refund it first` };
  }
  if (lapsed && !customerAgreed) {
    return { kind: "refused", code: "customer_agreement_required", detail: "this hold has ended; say how the customer agreed to a new one in customer_agreed" };
  }
  if (!hasReplacementConsent(order)) {
    return { kind: "refused", code: "no_replacement_consent", detail: "this order has no documented consent to a replacement hold" };
  }
  const attempts = order.replacement_attempts ?? 0;
  // The limit stops unattended retries. With customer agreement, a person and
  // the customer are acting. A lost answer must still be finished, and its
  // repeat uses the same key, so the bank sees nothing new.
  if (attempts >= MAX_REPLACEMENT_ATTEMPTS && !customerAgreed && !order.replacement_unknown_at) {
    return { kind: "refused", code: "replacement_attempts_used", detail: `${attempts} replacement attempts have been made on this hold` };
  }
  if (sweepAt) {
    const stop = sweepStopsHere(order, sweepAt);
    if (stop) return { kind: "refused", code: "not_for_the_sweep", detail: stop };
  }

  const oldId = order.stripe_payment_intent_id;
  const keySeq = order.replacement_key_seq ?? 0;
  // The customer hears that their bank said no only if it did. Once the tries
  // have run out they hear no new hold was placed, without blaming the bank.
  // The attempt and the notice commit together, ahead of the alert, so a crash can't lose the notice.
  const fail = async (code: string, detail: string, kind: FailureKind, stillHeld?: boolean): Promise<ReplaceOutcome> => {
    const used = attempts + 1;
    const client = await pool.connect();
    let emailQueued = true;
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE orders SET replacement_attempts = $2, replacement_last_attempt_at = now(), replacement_last_error = $3, replacement_key_seq = $4, replacement_unknown_at = $5 WHERE order_id = $1`,
        [orderId, used, detail.slice(0, 500), keySeq + (kind === "declined" || kind === "key_spent" ? 1 : 0), kind === "declined" ? null : kind === "no_answer" ? new Date() : order.replacement_unknown_at]
      );
      if (kind === "declined" || used >= MAX_REPLACEMENT_ATTEMPTS) {
        // Once per hold, so a retry does not email the customer again.
        emailQueued = await enqueueCustomerEmails(client, {
          orderId,
          filingSessionId: order.filing_session_id,
          emailTypes: ["hold_replacement_failed"],
          paymentMode: "hold",
          dedupeKey: oldId,
          details: { filing_submitted: Boolean(order.sunbiz_submitted_at) && !rejected, bank_declined: kind === "declined" },
        });
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    if (!emailQueued) await alertEmailsNotQueued(orderId, "the failed renewal email");
    const held = stillHeld === undefined ? (lapsed ? false : undefined) : stillHeld;
    const holdNow = held === undefined ? `The current hold ${oldId} could not be read.` : held ? `The current hold ${oldId} still stands.` : `Its hold ${oldId} has ended.`;
    const maybe = kind === "no_answer" ? " Stripe gave no answer, so a new hold may be on the card. The sweep looks for it on every pass, and takes it or cancels it. Cancelling or capturing this order cancels it too." : "";
    await deps.alert("A replacement card hold failed", `Order ${orderId}, attempt ${used}. ${holdNow}${maybe} ${detail}`);
    return { kind: "failed", code, detail, attempts: used };
  };

  let original: StripePaymentIntent;
  try {
    original = await retrievePaymentIntent(oldId);
  } catch (err) {
    return fail("replacement_lookup_failed", `could not read the current hold: ${describeError(err)}`, "nothing_placed");
  }
  const stillHeld = original.status === "requires_capture";
  if ((!stillHeld && !lapsed) || !original.customer || !original.payment_method) {
    return fail("hold_not_replaceable", `the hold is ${original.status}, or has no saved card`, "nothing_placed", stillHeld);
  }
  // The customer's consent covers a hold about to end, and a repeat of a call
  // that already worked lands here too. The column is empty right after a
  // renewal, so the deadline comes from Stripe. Refused before anything is
  // tried, so this uses up no attempt.
  if (!sweepAt && stillHeld && !customerAgreed && !order.replacement_unknown_at && !nearItsEnd(original, new Date())) {
    return { kind: "refused", code: "hold_not_near_end", detail: `this hold does not end within ${RENEWAL_WINDOW_HOURS} hours, so the customer's consent does not cover a new one. If they asked for one, say how in customer_agreed` };
  }

  // Unable to see what exists, a new hold could be a second one.
  let untracked: StripePaymentIntent[];
  try {
    untracked = await findUntrackedHolds(original.customer, order);
  } catch (err) {
    return fail("replacement_lookup_failed", `could not check Stripe for an earlier hold: ${describeError(err)}`, "nothing_placed", stillHeld);
  }
  if (untracked.length > 1) {
    await deps.alert("More than one untracked card hold", `Order ${orderId}: ${untracked.map((pi) => pi.id).join(", ")}. The order is taking ${untracked[0].id}. Cancel the others in Stripe.`);
  }

  let replacement = untracked[0];
  if (!replacement) {
    await pool.query(`UPDATE orders SET replacement_unknown_at = now() WHERE order_id = $1`, [orderId]);
    try {
      replacement = await placeReplacementHold({
        customerId: original.customer,
        paymentMethodId: original.payment_method,
        amountCents: order.total_cents,
        currency: order.currency || "usd",
        idempotencyKey: `replace-${orderId}-${oldId}-${keySeq + 1}`,
        metadata: { order_id: orderId, kind: "replacement_hold", replaces: oldId },
        description: diyBreakdownFor(order.line_items, order.total_cents),
        receiptEmail: original.receipt_email,
      });
    } catch (err) {
      // A repeat with this key can't place a second hold: Stripe replays the
      // answer, or refuses while the first request is still running.
      if (isCardDecline(err)) return fail("replacement_declined", describeError(err), "declined", stillHeld);
      if (!stripeResultUnknown(err)) return fail("replacement_refused", describeError(err), "nothing_placed", stillHeld);
      return fail("replacement_result_unknown", describeError(err), "no_answer", stillHeld);
    }
    // Stripe replays the first answer for a key, however the hold has changed
    // since. Only a fresh read can show there is something to move to.
    let fresh: StripePaymentIntent;
    try {
      fresh = await retrievePaymentIntent(replacement.id);
    } catch (err) {
      return fail("replacement_result_unknown", `could not read the new hold ${replacement.id}: ${describeError(err)}`, "no_answer", stillHeld);
    }
    if (fresh.status === "canceled" || fresh.status === "succeeded") {
      return fail("replacement_key_spent", `this request's key returned ${replacement.id}, which is ${fresh.status}, so no new hold was placed. The next attempt uses a new key`, "key_spent", stillHeld);
    }
    replacement = { ...replacement, status: fresh.status };
  }
  if (replacement.status !== "requires_capture") {
    // It holds nothing we can use, and must not sit open on the customer's card.
    try {
      await cancelPaymentIntent(replacement.id, `cancel-replacement-${replacement.id}`);
    } catch {
      return fail("replacement_not_capturable", `the new hold came back ${replacement.status}, and could not be cancelled`, "no_answer", stillHeld);
    }
    return fail("replacement_not_capturable", `the new hold came back ${replacement.status}`, "declined", stillHeld);
  }
  return moveToReplacement(pool, order, replacement, stillHeld, lapsed, customerAgreed, deps);
}
