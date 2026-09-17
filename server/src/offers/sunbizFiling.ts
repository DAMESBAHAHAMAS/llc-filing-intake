/**
 * offer_codes whose presence in an order's line_items means "this order
 * includes an actual Articles of Organization filing with the state" —
 * i.e. needs the Sunbiz fax-fulfillment pipeline (orders.fulfillment_status
 * -> 'ready'). EIN-only, Registered-Agent-only, or Credentials-Kit-only
 * orders never touch that pipeline at all.
 *
 * Its own module (not defined inline in routes/webhooksStripe.ts) so
 * routes/registeredAgent.ts can reuse the exact same test when a
 * registered agent accepts after an order is already paid
 * (reevaluateFulfillmentAfterAcceptance) without a route-to-route import.
 */
const SUNBIZ_FILING_OFFER_CODES = new Set(["FASTTRACK", "PREMIUM", "DIY_STATE_FEE"]);

export function needsSunbizFiling(lineItems: Array<{ offer_code?: string }>): boolean {
  return lineItems.some((li) => li.offer_code && SUNBIZ_FILING_OFFER_CODES.has(li.offer_code));
}
