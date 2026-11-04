import type { Pool } from "pg";
import { describeError } from "../db/describeError.js";
import { sendOpsAlert } from "../ops/alerts.js";
import { detachPaymentMethod, retrievePaymentIntent, StripeApiError, type StripePaymentIntent } from "../stripe/restClient.js";

export interface SavedCardCleanupDeps {
  retrievePaymentIntent: (id: string) => Promise<StripePaymentIntent>;
  detachPaymentMethod: (id: string) => Promise<unknown>;
  alert: (message: string) => Promise<void>;
}

const defaultDeps: SavedCardCleanupDeps = {
  retrievePaymentIntent,
  detachPaymentMethod,
  alert: async (message) => {
    await sendOpsAlert("Saved card could not be detached", message);
  },
};

/** Stripe refuses to detach a card that is already detached, which is the outcome wanted. */
function alreadyDetached(err: unknown): boolean {
  return err instanceof StripeApiError && err.httpStatus === 400 && /not attached/i.test(err.message);
}

/**
 * The customer agreed "we use the saved card only for this order", so the
 * card comes off the Stripe Customer once the order closes: paid with no
 * service charge still to come, refunded, or cancelled. A refund of an
 * earlier charge still works after this. Runs from the card-hold poller,
 * because a webhook must not make network calls inside its transaction, and
 * a failure is retried on the next pass.
 */
export async function runSavedCardCleanupOnce(pool: Pool, deps: SavedCardCleanupDeps = defaultDeps): Promise<{ detached: number; failed: number }> {
  const { rows } = await pool.query<{ order_id: string; stripe_payment_intent_id: string; saved_card_detach_error: string | null }>(
    `SELECT order_id, stripe_payment_intent_id, saved_card_detach_error FROM orders
     WHERE authorized_at IS NOT NULL AND stripe_payment_intent_id IS NOT NULL AND saved_card_detached_at IS NULL
       AND (
         (payment_status = 'paid' AND (deferred_cents = 0 OR deferred_charged_at IS NOT NULL))
         OR payment_status = 'refunded'
         OR (cancelled_at IS NOT NULL AND payment_status <> 'authorized')
       )
     ORDER BY authorized_at ASC LIMIT 20`
  );

  let detached = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const pi = await deps.retrievePaymentIntent(row.stripe_payment_intent_id);
      if (pi.payment_method) {
        await deps.detachPaymentMethod(pi.payment_method).catch((err) => {
          if (!alreadyDetached(err)) throw err;
        });
      }
      await pool.query(`UPDATE orders SET saved_card_detached_at = now(), saved_card_detach_error = NULL WHERE order_id = $1`, [row.order_id]);
      detached++;
    } catch (err) {
      failed++;
      const detail = describeError(err);
      console.error(`[saved card] could not detach for order ${row.order_id}: ${detail}`);
      await pool.query(`UPDATE orders SET saved_card_detach_error = $2 WHERE order_id = $1`, [row.order_id, detail]);
      if (!row.saved_card_detach_error) await deps.alert(`Order ${row.order_id}: ${detail}. It will be retried.`);
    }
  }
  return { detached, failed };
}
