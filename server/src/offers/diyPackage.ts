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
