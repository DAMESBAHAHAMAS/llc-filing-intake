/**
 * The DIY filing sold as one $139 Stripe Price. The total is three amounts,
 * and the breakdown is kept because the state fee and the service fee are
 * not the same money (DECISIONS.md, 2026-09-17 "Package pricing").
 */
export const DIY_PACKAGE_OFFER_CODE = "DIY_PACKAGE";

export const DIY_PACKAGE_BREAKDOWN = [
  { code: "DIY_STATE_FEE", label: "Florida state filing fee", cents: 12_500 },
  { code: "DIY_CERT_OF_STATUS", label: "Certificate of Status", cents: 500 },
  { code: "DIY_SERVICE_FEE", label: "Service fee", cents: 900 },
] as const;

export const DIY_PACKAGE_TOTAL_CENTS = DIY_PACKAGE_BREAKDOWN.reduce((sum, part) => sum + part.cents, 0);

/** Shown at checkout, so the customer sees what the $139 is made of. */
export const DIY_PACKAGE_BREAKDOWN_LINE =
  "Your $139 includes the $125 Florida state filing fee, the $5 Certificate of Status and our $9 service fee.";

/** What a hold does to the customer's money (Damian, 6 Nov 2026). */
export const HOLD_FUNDS_DISCLOSURE =
  "This is a temporary hold of $139, not a charge. Until it is charged or released, it can reduce the balance or credit available on your card.";

export function hasDiyPackage(lineItems: Array<{ offer_code?: string }>): boolean {
  return lineItems.some((li) => li.offer_code === DIY_PACKAGE_OFFER_CODE);
}

/** The DIY total, sold either as one $139 Price or as its three parts. */
export function diyTotalCents(amounts: Map<string, number>): number {
  const single = amounts.get(DIY_PACKAGE_OFFER_CODE);
  if (single !== undefined) return single;
  return DIY_PACKAGE_BREAKDOWN.reduce((sum, part) => sum + (amounts.get(part.code) ?? NaN), 0);
}

/** Which decided totals to check. While only DIY_PACKAGE is on sale, the
 *  other offers have no live Price and are retired, which is not a mismatch. */
export function parityDecisionsFor(decided: Record<string, number>, amounts: Map<string, number>): Array<[string, number]> {
  const entries = Object.entries(decided);
  return amounts.has(DIY_PACKAGE_OFFER_CODE) ? entries.filter(([code]) => code === "DIY" || amounts.has(code)) : entries;
}

/** What is wrong with a Price to be sold live. Empty means it is right. */
export function livePriceProblems(price: { active: boolean; unit_amount: number | null; currency: string; livemode?: boolean }): string[] {
  const problems: string[] = [];
  if (price.livemode !== true) problems.push("the Price is not a live-mode Price");
  if (!price.active) problems.push("the Price is not active");
  if (price.unit_amount !== DIY_PACKAGE_TOTAL_CENTS) problems.push(`the Price is ${price.unit_amount}, not ${DIY_PACKAGE_TOTAL_CENTS}`);
  if (price.currency !== "usd") problems.push(`the Price is in ${price.currency}, not usd`);
  return problems;
}
