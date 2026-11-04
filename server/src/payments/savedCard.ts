import { chargeSavedCard, StripeApiError, type StripePaymentIntent } from "../stripe/restClient.js";
import { describeError } from "../db/describeError.js";

export type SavedCardOutcome =
  | { kind: "charged"; paymentIntentId: string; status: string }
  | { kind: "declined"; detail: string }
  | { kind: "error"; detail: string };

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

export async function attemptSavedCardCharge(params: {
  original: Pick<StripePaymentIntent, "customer" | "payment_method">;
  orderId: string;
  prefix: "fallback" | "deferred";
  declinedAttempts: number;
  amountCents: number;
  currency: string;
  metadata: Record<string, string>;
}): Promise<SavedCardOutcome> {
  const { original } = params;
  if (!original.customer || !original.payment_method) {
    return { kind: "error", detail: "no saved card on the original payment" };
  }
  try {
    const charged = await chargeSavedCard({
      customerId: original.customer,
      paymentMethodId: original.payment_method,
      amountCents: params.amountCents,
      currency: params.currency,
      idempotencyKey: savedCardIdempotencyKey(params.prefix, params.orderId, params.declinedAttempts),
      metadata: params.metadata,
    });
    return { kind: "charged", paymentIntentId: charged.id, status: charged.status };
  } catch (err) {
    return { kind: isCardDecline(err) ? "declined" : "error", detail: describeError(err) };
  }
}
