/**
 * EIN billing rule (owner decision, 2026-11-22): the Federal EIN is sold as an
 * add-on to File It (DIY) only. Bank-Ready (FASTTRACK) and Premium already
 * include it, so selling it again would charge the customer twice.
 *
 * The storefront already refuses to offer the add-on on a bundled tier
 * (frontend offerTiers.ts), but the browser is not a control: this is the same
 * rule enforced where the money moves, in the same style as houseAgentRule.ts.
 */
export const EIN_OFFER_CODES: readonly string[] = ["EIN_FILING", "EIN_FILING_EXPRESS"];
export const BUNDLES_EIN: readonly string[] = ["FASTTRACK", "PREMIUM"];

/** The offer that marks an order as File It (DIY). Every DIY order carries it. */
export const DIY_BASE_OFFER_CODE = "DIY_STATE_FEE";

const isEin = (code: string) => EIN_OFFER_CODES.includes(code);
const isBundle = (code: string) => BUNDLES_EIN.includes(code);

export type EinLineIssue =
  /** The cart holds two different EIN offers (standard and express). */
  | "duplicate_ein_in_cart"
  /** The cart pairs EIN with a tier that already includes it. */
  | "bundled_in_cart"
  /** The session already paid for a tier that includes EIN. */
  | "already_included"
  /** The session already has an EIN order. */
  | "already_ordered";

/**
 * Why a checkout must be refused because it would charge for the EIN twice, or
 * null when it is fine. `alreadyOrderedCodes` must be the offer codes on this
 * session's orders that are authorized or paid; abandoned, failed, released or
 * refunded orders do not count, so a customer is never blocked by money that
 * was not actually taken.
 */
export function einLineIssue(requestedCodes: string[], alreadyOrderedCodes: string[]): EinLineIssue | null {
  const requestedEin = [...new Set(requestedCodes.filter(isEin))];
  if (requestedEin.length === 0) return null;
  if (requestedEin.length > 1) return "duplicate_ein_in_cart";
  if (requestedCodes.some(isBundle)) return "bundled_in_cart";
  if (alreadyOrderedCodes.some(isBundle)) return "already_included";
  if (alreadyOrderedCodes.some(isEin)) return "already_ordered";
  return null;
}

/**
 * Whether a session may be offered the post-payment EIN upsell: it bought File
 * It, and nothing it has paid for includes or already covers the EIN.
 */
export function einUpsellEligible(orderedCodes: string[]): boolean {
  return orderedCodes.includes(DIY_BASE_OFFER_CODE) && !orderedCodes.some(isBundle) && !orderedCodes.some(isEin);
}
