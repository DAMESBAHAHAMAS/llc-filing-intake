import { chargeSavedCard, listPaymentIntents, refundState, StripeApiError, type StripePaymentIntent } from "../stripe/restClient.js";
import { describeError } from "../db/describeError.js";

export type SavedCardOutcome =
  | { kind: "charged"; paymentIntentId: string; status: string }
  | { kind: "declined"; detail: string }
  /** `unknown`: Stripe gave no clear answer, so the money may have moved. */
  | { kind: "error"; detail: string; unknown: boolean };

/** Set on the saved-card charge, so its payment_intent.succeeded is recognised. */
export const SAVED_CARD_CHARGE_REASON = "hold_expired_before_proof_of_filing";

/**
 * Stripe stores the result under an idempotency key, declines included, so
 * retrying a declined charge with the same key only replays the decline.
 * Each decline therefore moves to a new attempt number, and so a new key.
 *
 * A decline is the only thing that does. After a network failure or a 5xx
 * nobody knows whether the charge went through, so the next try must reuse
 * the key: a new one could charge the customer twice.
 */
export function savedCardIdempotencyKey(prefix: "fallback" | "deferred", orderId: string, declinedAttempts: number): string {
  return `${prefix}-${orderId}-${declinedAttempts + 1}`;
}

/** Stripe answers 402 when the card itself refused the charge. */
export function isCardDecline(err: unknown): boolean {
  return err instanceof StripeApiError && err.httpStatus === 402;
}

/** A timeout, a 5xx or a key still in use says nothing about what Stripe did. Any other refusal means it did nothing. */
export function stripeResultUnknown(err: unknown): boolean {
  if (!(err instanceof StripeApiError)) return true;
  return err.httpStatus >= 500 || err.httpStatus === 409;
}

/**
 * Money Stripe holds, or is taking, for this order. Deferred service charges
 * are money for something else, and money refunded in full is not held. A
 * payment whose refund state can't be read stops the caller: guessing either
 * way could charge the customer twice, or report a charge that isn't there.
 */
export async function findCollectedPayment(customerId: string, orderId: string): Promise<StripePaymentIntent | null> {
  const intents = await listPaymentIntents(customerId);
  for (const pi of intents) {
    if (pi.metadata?.order_id !== orderId || pi.metadata?.kind === "deferred_service") continue;
    if (pi.status === "processing") return pi;
    if (pi.status !== "succeeded") continue;
    const refunded = refundState(pi);
    if (refunded === undefined) throw new Error(`Stripe did not say whether ${pi.id} was refunded`);
    if (!refunded) return pi;
  }
  return null;
}

export async function attemptSavedCardCharge(params: {
  original: Pick<StripePaymentIntent, "customer" | "payment_method" | "receipt_email">;
  orderId: string;
  prefix: "fallback" | "deferred";
  declinedAttempts: number;
  amountCents: number;
  currency: string;
  metadata: Record<string, string>;
  description?: string;
}): Promise<SavedCardOutcome> {
  const { original } = params;
  if (!original.customer || !original.payment_method) {
    return { kind: "error", detail: "no saved card on the original payment", unknown: false };
  }
  try {
    const charged = await chargeSavedCard({
      customerId: original.customer,
      paymentMethodId: original.payment_method,
      amountCents: params.amountCents,
      currency: params.currency,
      idempotencyKey: savedCardIdempotencyKey(params.prefix, params.orderId, params.declinedAttempts),
      metadata: params.metadata,
      description: params.description,
      receiptEmail: original.receipt_email,
    });
    return { kind: "charged", paymentIntentId: charged.id, status: charged.status };
  } catch (err) {
    if (isCardDecline(err)) return { kind: "declined", detail: describeError(err) };
    return { kind: "error", detail: describeError(err), unknown: stripeResultUnknown(err) };
  }
}
