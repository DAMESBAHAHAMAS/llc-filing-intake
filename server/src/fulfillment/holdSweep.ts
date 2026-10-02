import type { Pool } from "pg";
import { describeError } from "../db/describeError.js";
import { holdDetails, retrievePaymentIntent, type StripePaymentIntent } from "../stripe/restClient.js";
import { ordersNeedingExpiryFlag, type HeldOrderRow } from "../payments/holdState.js";
import { sendOpsAlert } from "../ops/alerts.js";

export interface HoldSweepDeps {
  retrievePaymentIntent: (id: string) => Promise<StripePaymentIntent>;
  now: () => Date;
  alert: (message: string) => Promise<void>;
}

const defaultDeps: HoldSweepDeps = {
  retrievePaymentIntent,
  now: () => new Date(),
  alert: async (message) => {
    await sendOpsAlert("Card hold expires within 48 hours", message);
  },
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

  const held = await pool.query<HeldOrderRow>(
    `SELECT order_id, capture_before, proof_of_filing_at, hold_expiry_flagged_at FROM orders
     WHERE payment_status = 'authorized' AND capture_before IS NOT NULL`
  );
  const flagged = ordersNeedingExpiryFlag(held.rows, deps.now());
  for (const orderId of flagged) {
    await pool.query(`UPDATE orders SET hold_expiry_flagged_at = now() WHERE order_id = $1`, [orderId]);
    const row = held.rows.find((r) => r.order_id === orderId);
    await deps.alert(
      `Order ${orderId}: card hold expires ${row?.capture_before?.toISOString()} and there is no proof of filing yet.`
    );
  }
  return { recorded, flagged };
}
