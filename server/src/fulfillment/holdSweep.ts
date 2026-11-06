import type { Pool } from "pg";
import { describeError } from "../db/describeError.js";
import { cancelPaymentIntent } from "../stripe/restClient.js";
import { holdDetails, retrievePaymentIntent, type StripePaymentIntent } from "../stripe/restClient.js";
import { ordersNeedingExpiryFlag, ordersNeedingFinalFlag, type HeldOrderRow } from "../payments/holdState.js";
import { sendOpsAlert } from "../ops/alerts.js";
import { APPROVAL_VALID_HOURS } from "../payments/filingClearance.js";
import { HOURS_BETWEEN_ATTEMPTS, MAX_REPLACEMENT_ATTEMPTS, replaceHold, type ReplaceOutcome } from "../payments/replaceHold.js";

/** With a live key, a test-mode hold can't be read and would only fail. */
function liveOnly(): string {
  return /^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY ?? "") ? "AND stripe_livemode = true" : "";
}

export interface HoldSweepDeps {
  retrievePaymentIntent: (id: string) => Promise<StripePaymentIntent>;
  now: () => Date;
  alert: (message: string) => Promise<void>;
  replace: (pool: Pool, orderId: string) => Promise<ReplaceOutcome>;
}

const defaultDeps: HoldSweepDeps = {
  retrievePaymentIntent,
  now: () => new Date(),
  // sendOpsAlert reports failure instead of throwing. Throwing here is what
  // keeps the flag unset, so the next pass tries again.
  alert: async (message) => {
    const sent = await sendOpsAlert("Card hold needs attention", message);
    if (!sent.ok || sent.channel === "log") throw new Error(sent.error ?? "the alert reached no person");
  },
  replace: (pool, orderId) => replaceHold(pool, orderId),
};

/**
 * One pass of the card-hold watch:
 *  1. Records each held order's expiry (Stripe reports it on the charge).
 *  2. Flags held orders within 48 hours of expiry that still have no
 *     proof of filing, so the filing can be pushed through or the hold
 *     released on purpose instead of lapsing silently.
 */
export async function runHoldSweepOnce(pool: Pool, deps: HoldSweepDeps = defaultDeps): Promise<{ recorded: number; flagged: string[] }> {
  let recorded = 0;
  const missing = await pool.query<{ order_id: string; stripe_payment_intent_id: string }>(
    `SELECT order_id, stripe_payment_intent_id FROM orders
     WHERE payment_status = 'authorized' AND stripe_payment_intent_id IS NOT NULL AND capture_before IS NULL
       ${liveOnly()}
     ORDER BY authorized_at ASC NULLS FIRST LIMIT 20`
  );
  for (const row of missing.rows) {
    try {
      const pi = await deps.retrievePaymentIntent(row.stripe_payment_intent_id);
      const { captureBefore, extended } = holdDetails(pi);
      if (captureBefore) {
        await pool.query(`UPDATE orders SET capture_before = $2, extended_authorization = $3 WHERE order_id = $1`, [
          row.order_id,
          captureBefore,
          extended,
        ]);
        recorded++;
      }
    } catch (err) {
      console.error(`[hold sweep] could not read hold for order ${row.order_id}:`, describeError(err));
    }
  }

  // A hold with no readable deadline can't be watched, so a person must know.
  const unknown = await pool.query<{ order_id: string }>(
    `SELECT order_id FROM orders
     WHERE payment_status = 'authorized' AND capture_before IS NULL AND hold_unknown_flagged_at IS NULL
       AND authorized_at IS NOT NULL AND authorized_at < $1 ${liveOnly()}`,
    [new Date(deps.now().getTime() - 3600 * 1000)]
  );
  for (const row of unknown.rows) {
    try {
      await deps.alert(`Order ${row.order_id}: Stripe gives no deadline for this card hold, so it can't be monitored. Check the key's Charges permission.`);
      await pool.query(`UPDATE orders SET hold_unknown_flagged_at = now() WHERE order_id = $1`, [row.order_id]);
    } catch (err) {
      console.error(`[hold sweep] alert failed for order ${row.order_id}:`, describeError(err));
    }
  }

  // Finish cancelling replaced holds, including after a crash mid-replace.
  const open = await pool.query<{ order_id: string; superseded_payment_intent_ids: string[] | null }>(
    `SELECT order_id, superseded_payment_intent_ids FROM orders WHERE superseded_open = true`
  );
  for (const row of open.rows) {
    try {
      for (const id of row.superseded_payment_intent_ids ?? []) {
        const pi = await deps.retrievePaymentIntent(id);
        if (pi.status === "requires_capture") await cancelPaymentIntent(id, `cancel-superseded-${id}`);
      }
      await pool.query(`UPDATE orders SET superseded_open = false WHERE order_id = $1`, [row.order_id]);
    } catch (err) {
      console.error(`[hold sweep] could not cancel a replaced hold on order ${row.order_id}:`, describeError(err));
      await deps.alert(`Order ${row.order_id}: a replaced card hold is still open. Cancel it in Stripe.`).catch(() => undefined);
    }
  }

  const held = await pool.query<HeldOrderRow>(
    `SELECT order_id, capture_before, proof_of_filing_at, hold_expiry_flagged_at, hold_final_flagged_at FROM orders
     WHERE payment_status = 'authorized' AND capture_before IS NOT NULL`
  );
  const expiring = (orderId: string) => held.rows.find((r) => r.order_id === orderId)?.capture_before?.toISOString();
  // The alert goes first. If it fails, the flag stays unset and the next pass
  // tries again, so a person is not left unaware.
  const flagged: string[] = [];
  for (const orderId of ordersNeedingExpiryFlag(held.rows, deps.now())) {
    try {
      await deps.alert(`Order ${orderId}: card hold expires ${expiring(orderId)} and there is no proof of filing yet.`);
      await pool.query(`UPDATE orders SET hold_expiry_flagged_at = now() WHERE order_id = $1`, [orderId]);
      flagged.push(orderId);
    } catch (err) {
      console.error(`[hold sweep] alert failed for order ${orderId}:`, describeError(err));
    }
  }
  // One alert per order per pass: the next pass escalates.
  for (const orderId of ordersNeedingFinalFlag(held.rows, deps.now()).filter((id) => !flagged.includes(id))) {
    try {
      await deps.alert(`Order ${orderId}: card hold ends within 24 hours (${expiring(orderId)}). Replace it now, or it will lapse.`);
      await pool.query(`UPDATE orders SET hold_final_flagged_at = now() WHERE order_id = $1`, [orderId]);
    } catch (err) {
      console.error(`[hold sweep] alert failed for order ${orderId}:`, describeError(err));
    }
  }

  // Consent covers a hold about to end, so a hold that ended waits for a person.
  const ended = await pool.query<{ order_id: string }>(
    `SELECT order_id FROM orders
     WHERE payment_status = 'released' AND hold_lapsed_flagged_at IS NULL AND cancelled_at IS NULL AND proof_of_filing_at IS NULL
       AND (sunbiz_submitted_at IS NULL OR fulfillment_status = 'rejected')
       AND line_items @> '[{"offer_code":"DIY_PACKAGE"}]'::jsonb ${liveOnly()}`
  );
  for (const row of ended.rows) {
    try {
      await deps.alert(`Order ${row.order_id}: its card hold has ended, so it can't file. If the customer agrees to a new hold, use replace-authorization with customer_agreed. Otherwise use /cancel.`);
      await pool.query(`UPDATE orders SET hold_lapsed_flagged_at = now() WHERE order_id = $1`, [row.order_id]);
    } catch (err) {
      console.error(`[hold sweep] alert failed for order ${row.order_id}:`, describeError(err));
    }
  }

  // A standing $139 hold within 48 hours of ending is renewed, if the customer
  // agreed. replaceHold checks consent again and handles every outcome. A
  // rejected filing may wait 60 days for a reply, so no hold sits on the card
  // meanwhile. Renewing clears an approval, so one in use is left to run out.
  const expiring48 = await pool.query<{ order_id: string; replacement_last_attempt_at: Date | null }>(
    `SELECT order_id, replacement_last_attempt_at FROM orders
     WHERE cancelled_at IS NULL AND proof_of_filing_at IS NULL AND replacement_attempts < $2
       AND payment_status = 'authorized' AND capture_before IS NOT NULL AND capture_before <= $1
       AND fulfillment_status <> 'rejected'
       AND (filing_approved_at IS NULL OR filing_approved_at <= $3)
       AND line_items @> '[{"offer_code":"DIY_PACKAGE"}]'::jsonb`,
    [new Date(deps.now().getTime() + 48 * 3600 * 1000), MAX_REPLACEMENT_ATTEMPTS, new Date(deps.now().getTime() - APPROVAL_VALID_HOURS * 3600 * 1000)]
  );
  const waitMs = HOURS_BETWEEN_ATTEMPTS * 3600 * 1000;
  for (const row of expiring48.rows) {
    if (row.replacement_last_attempt_at && deps.now().getTime() - new Date(row.replacement_last_attempt_at).getTime() < waitMs) continue;
    try {
      await deps.replace(pool, row.order_id);
    } catch (err) {
      console.error(`[hold sweep] replacement failed for order ${row.order_id}:`, describeError(err));
    }
  }
  return { recorded, flagged };
}
