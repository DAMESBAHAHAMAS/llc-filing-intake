import { needsSunbizFiling } from "./sunbizFiling.js";

/**
 * Damian's rule (29 Sep 2026): for any order that includes a filing, the
 * customer's card is held at checkout and the money is collected only
 * after proof of filing is delivered. Filing orders are the Sunbiz
 * formation packages (see sunbizFiling.ts) and the federal EIN filing
 * services. Orders with no filing in them (a Registered Agent term or a
 * Credentials Kit on its own) are collected at checkout as before.
 */
const EIN_FILING_OFFER_CODES = new Set(["EIN_FILING", "EIN_FILING_EXPRESS"]);

export function requiresPayAfterFiling(lineItems: Array<{ offer_code?: string }>): boolean {
  return (
    needsSunbizFiling(lineItems) || lineItems.some((li) => li.offer_code && EIN_FILING_OFFER_CODES.has(li.offer_code))
  );
}

/**
 * Decision (Damian, 2 Oct 2026 14:45 ET): services delivered after the LLC
 * filing are charged when that service is complete. For an order that
 * includes a Sunbiz filing, the EIN line items are held at checkout but
 * NOT collected at proof of filing; they are charged to the saved card
 * once the EIN is issued. An EIN-only order has no Articles to wait for,
 * so its whole total is collected when the EIN is issued (deferred 0).
 */
export function deferredServiceCents(
  lineItems: Array<{ offer_code?: string; unit_amount_cents?: number; quantity?: number }>
): number {
  if (!needsSunbizFiling(lineItems)) return 0;
  return lineItems
    .filter((li) => li.offer_code && EIN_FILING_OFFER_CODES.has(li.offer_code))
    .reduce((sum, li) => sum + (li.unit_amount_cents ?? 0) * (li.quantity ?? 1), 0);
}

/** The line shown above Stripe's pay button on a held formation order.
 *  Wording approved by Damian (Scorecard Launch Drafts doc, 2 Oct 2026). */
export const HOLD_CHECKOUT_MESSAGE =
  "Your card is held, not charged. We charge it only after your Florida LLC is filed. If filing takes more than 7 days, we charge this card once it's filed.";

/** PAYMENT_CAPTURE_MODE=immediate turns holds off everywhere (rollback
 *  switch). Anything else, including unset, keeps the rule on. */
export function holdsEnabled(): boolean {
  return (process.env.PAYMENT_CAPTURE_MODE ?? "hold").toLowerCase() !== "immediate";
}
