/**
 * Pure decision rules for card holds (pay-after-filing). Kept free of I/O
 * so every branch is unit-tested (test/holdState.test.ts).
 */

export type OrderPaymentStatus = "pending" | "authorized" | "paid" | "failed" | "released" | "refunded";

/**
 * What a completed Checkout Session means for an order.
 *  - "paid": money collected at checkout (no hold).
 *  - "authorized": a hold was placed; money is collected later, on proof of filing.
 *  - "ignore": nothing to do (already recorded, or no payment happened).
 */
export function classifyCheckoutCompletion(
  sessionPaymentStatus: string | undefined,
  paymentIntentId: string | null | undefined,
  orderPaymentStatus: string
): "paid" | "authorized" | "ignore" {
  if (sessionPaymentStatus === "paid" && orderPaymentStatus !== "paid") return "paid";
  if (sessionPaymentStatus === "unpaid" && paymentIntentId && orderPaymentStatus === "pending") return "authorized";
  return "ignore";
}

/**
 * Money was collected on a hold (a capture, or the saved-card fallback
 * after the hold expired). Deliberately NOT "pending": for orders paid at
 * checkout, payment_intent.succeeded can arrive before
 * checkout.session.completed, and that event is the one that starts
 * filing and creates the Deal — letting this event mark the order paid
 * first would skip both.
 */
export function shouldMarkPaidOnPaymentIntentSucceeded(orderPaymentStatus: string): boolean {
  return orderPaymentStatus === "authorized" || orderPaymentStatus === "released";
}

/**
 * When a payment ends without money kept (hold released, or refunded),
 * an order whose filing has not started yet must stop; one whose filing
 * is already under way keeps its fulfillment status for a person to review.
 */
export function fulfillmentAfterPaymentEnds(fulfillmentStatus: string): string {
  return fulfillmentStatus === "ready" ? "not_ready" : fulfillmentStatus;
}

export interface HeldOrderRow {
  order_id: string;
  capture_before: Date | null;
  proof_of_filing_at: Date | null;
  hold_expiry_flagged_at: Date | null;
}

/** Holds within `windowHours` of expiry, with no proof of filing yet and not already flagged. */
export function ordersNeedingExpiryFlag(rows: HeldOrderRow[], now: Date, windowHours = 48): string[] {
  const limit = now.getTime() + windowHours * 3600 * 1000;
  return rows
    .filter((r) => r.capture_before && !r.proof_of_filing_at && !r.hold_expiry_flagged_at && r.capture_before.getTime() <= limit)
    .map((r) => r.order_id);
}

/** Stripe error codes that mean the hold can no longer be captured. */
export function holdNoLongerCapturable(stripeErrorCode: string | undefined, paymentIntentStatus?: string): boolean {
  if (paymentIntentStatus === "canceled") return true;
  return stripeErrorCode === "payment_intent_unexpected_state" || stripeErrorCode === "charge_expired_for_capture";
}
