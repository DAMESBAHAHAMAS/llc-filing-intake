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

/** PAYMENT_CAPTURE_MODE=immediate turns holds off everywhere (rollback
 *  switch). Anything else, including unset, keeps the rule on. */
export function holdsEnabled(): boolean {
  return (process.env.PAYMENT_CAPTURE_MODE ?? "hold").toLowerCase() !== "immediate";
}
