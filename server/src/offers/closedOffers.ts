/**
 * Offers that exist in the catalog but are not sold right now.
 *
 * Launch scope (2 Oct 2026): DIY and FastTrack only. Premium stays closed
 * until its delivery process, including the Operating Agreement, passes
 * one full validation cycle. The website hides it too (frontend
 * offer-catalog.ts CLOSED_PACKAGE_IDS); this is the server-side guard so
 * a hand-made request can't buy it either.
 *
 * CLOSED_OFFER_CODES (comma-separated) overrides the default; set it to
 * an empty string to reopen everything.
 */
export const DEFAULT_CLOSED_OFFER_CODES = ["PREMIUM"];

export function closedOfferCodes(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.CLOSED_OFFER_CODES;
  if (raw === undefined) return new Set(DEFAULT_CLOSED_OFFER_CODES);
  return new Set(
    raw
      .split(",")
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean)
  );
}

export function closedCodesIn(codes: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const closed = closedOfferCodes(env);
  return codes.filter((c) => closed.has(c.toUpperCase()));
}
