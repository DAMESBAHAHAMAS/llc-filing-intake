import { DIY_PACKAGE_BREAKDOWN_LINE, DIY_PACKAGE_TOTAL_CENTS, hasDiyPackage, holdFundsDisclosure } from "./diyPackage.js";
import { isLiveTestOrder } from "./liveTest.js";
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
    needsSunbizFiling(lineItems) ||
    isLiveTestOrder(lineItems) ||
    lineItems.some((li) => li.offer_code && EIN_FILING_OFFER_CODES.has(li.offer_code))
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

/** The line shown on a held formation order. Wording approved by Damian
 *  (Scorecard Launch Drafts doc, 2 Oct 2026). */
export const HOLD_CHECKOUT_MESSAGE =
  "Your card is held, not charged. We charge it only after your Florida LLC is filed. If filing takes more than 7 days, we charge this card once it's filed.";

/** The saved-card authorization shown above Stripe's pay button. */
export const SAVED_CARD_AUTHORIZATION =
  "By completing checkout, you authorize us to keep your card on file with Stripe. If your hold ends before Florida confirms your filing, you authorize us to charge that card once, without contacting you first, for the order total shown at checkout, after Florida confirms it. We use the saved card only for this order.";

/** The phrase that makes a replacement hold permitted on an order. It must
 *  stay in DIY_SAVED_CARD_AUTHORIZATION: replaceHold.ts looks for it in the
 *  text the customer saw. */
export const REPLACEMENT_CONSENT_PHRASE = "place a new temporary hold on that card";

/** The $139 order's authorization (Damian, 6 Nov 2026). Not yet approved
 *  wording in Cliq. */
export const DIY_SAVED_CARD_AUTHORIZATION =
  `By completing checkout, you authorize us to keep your card on file with Stripe for this order. If your hold is about to end before Florida confirms your filing, you authorize us to ${REPLACEMENT_CONSENT_PHRASE} for the same amount, and we will email you when we do. If no hold is in place when Florida confirms your filing, you authorize us to charge that card once, for the order total shown at checkout, without contacting you first. We use the saved card only for this order.`;

/** The line below the pay button on a $139 order. */
export const DIY_HOLD_CHECKOUT_MESSAGE = "Your card is held, not charged. We charge it only after Florida confirms your LLC filing.";

/** The same authorization for an EIN-only hold, which Florida never
 *  confirms. This adaptation is not yet approved wording. */
export const SAVED_CARD_AUTHORIZATION_EIN_ONLY =
  "By completing checkout, you authorize us to keep your card on file with Stripe. If your hold ends before your EIN is issued, you authorize us to charge that card once, without contacting you first, for the order total shown at checkout, after it is issued. We use the saved card only for this order.";

/** Approved 2 Oct 2026. Shown when an EIN is charged after the filing. */
export const LATER_SERVICES_LINE = "Services such as EIN filing are charged when that service is complete, using the card you checked out with.";

/** Internal only: the operator's live payment test. No LLC is filed. */
export const LIVE_TEST_CHECKOUT_MESSAGE =
  "Internal payment test. No LLC is filed. Your card is held and charged only after the test confirmation step.";

/** The text a held Checkout Session shows, for custom_text. */
export function holdCheckoutText(lineItems: Array<{ offer_code?: string; unit_amount_cents?: number; quantity?: number }>): {
  submit: string;
  afterSubmit?: string;
} {
  if (isLiveTestOrder(lineItems)) return { submit: LIVE_TEST_CHECKOUT_MESSAGE };
  if (!needsSunbizFiling(lineItems)) return { submit: SAVED_CARD_AUTHORIZATION_EIN_ONLY };
  if (hasDiyPackage(lineItems)) {
    const total = lineItems.reduce((sum, li) => sum + (li.unit_amount_cents ?? 0) * (li.quantity ?? 1), 0) || DIY_PACKAGE_TOTAL_CENTS;
    return {
      submit: DIY_SAVED_CARD_AUTHORIZATION,
      afterSubmit: `${DIY_HOLD_CHECKOUT_MESSAGE} ${DIY_PACKAGE_BREAKDOWN_LINE} ${holdFundsDisclosure(total)}`,
    };
  }
  const later = deferredServiceCents(lineItems) > 0 ? ` ${LATER_SERVICES_LINE}` : "";
  return { submit: SAVED_CARD_AUTHORIZATION, afterSubmit: `${HOLD_CHECKOUT_MESSAGE}${later}` };
}

/** PAYMENT_CAPTURE_MODE=immediate turns holds off everywhere (rollback
 *  switch). Anything else, including unset, keeps the rule on. */
export function holdsEnabled(): boolean {
  return (process.env.PAYMENT_CAPTURE_MODE ?? "hold").toLowerCase() !== "immediate";
}

/** The rollback switch exists for test mode. With a live key it would charge
 *  a customer before Florida confirms, so checkout refuses instead. */
export function immediateChargeForbidden(lineItems: Array<{ offer_code?: string }>, env: NodeJS.ProcessEnv = process.env): boolean {
  const liveKey = /^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY ?? "");
  return liveKey && requiresPayAfterFiling(lineItems) && !holdsEnabled();
}
