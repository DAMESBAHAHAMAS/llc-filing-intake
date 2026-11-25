/**
 * Registered-agent billing rule.
 *
 * 2026-10-23: a session that chose "Use Damian Knowles as my Registered Agent"
 * (filing_data.registered_agent_path = "house") must pay for the 3-year
 * registered agent service. A customer with their own agent ("customer" path)
 * is never affected.
 *
 * 2026-11-25 (Damian, A6Y2-T144 final pre-launch round): Bank-Ready (FASTTRACK)
 * and Finance-Ready (PREMIUM, including the $139 kickoff hold, whose order
 * carries the PREMIUM selected-package line) include the 3-year service at the
 * same prices. So a house-agent checkout is covered by the $98
 * REGISTERED_AGENT_3YR line (File It), by either package in the cart, or by an
 * earlier held or paid order of the session that carried any of them. And the
 * $98 line is refused when a package already includes it, so nobody pays twice
 * (the same idea as einBundleRule.ts).
 */
export const HOUSE_AGENT_OFFER_CODE = "REGISTERED_AGENT_3YR";
export const BUNDLES_HOUSE_AGENT: readonly string[] = ["FASTTRACK", "PREMIUM"];

const covers = (code: string) => code === HOUSE_AGENT_OFFER_CODE || BUNDLES_HOUSE_AGENT.includes(code);

/** Whether these offer codes (a cart, or an earlier order) cover the 3-year agent service. */
export function coversHouseAgent(codes: readonly string[]): boolean {
  return codes.some(covers);
}

/**
 * True when a house-agent checkout must be refused for lack of agent coverage.
 * `alreadyPaid` is true when an earlier held or paid order of the session covers it.
 */
export function houseAgentLineMissing(
  registeredAgentPath: unknown,
  requestedCodes: string[],
  alreadyPaid: boolean,
): boolean {
  if (registeredAgentPath !== "house") return false;
  if (alreadyPaid) return false;
  return !coversHouseAgent(requestedCodes);
}

export type AgentLineIssue =
  /** The cart pairs the $98 agent line with a package that already includes it. */
  | "bundled_in_cart"
  /** An earlier held or paid order of the session already includes or bought it. */
  | "already_included";

/**
 * Why a checkout must be refused because it would charge for the agent service
 * twice, or null. `alreadyOrderedCodes` are the offer codes on the session's
 * held or paid orders (einUpsell.ts orderedOfferCodes).
 */
export function agentLineIssue(requestedCodes: string[], alreadyOrderedCodes: string[]): AgentLineIssue | null {
  if (!requestedCodes.includes(HOUSE_AGENT_OFFER_CODE)) return null;
  if (requestedCodes.some((c) => BUNDLES_HOUSE_AGENT.includes(c))) return "bundled_in_cart";
  if (coversHouseAgent(alreadyOrderedCodes)) return "already_included";
  return null;
}

/**
 * The cart without the $98 agent line when a package in it already includes
 * the service (a website build from before 25 Nov 2026 still sends the pair).
 * Unchanged otherwise.
 */
export function dropBundledAgentLine<T extends { offer_code: string }>(items: T[]): T[] {
  const codes = items.map((i) => i.offer_code);
  if (agentLineIssue(codes, []) !== "bundled_in_cart") return items;
  return items.filter((i) => i.offer_code !== HOUSE_AGENT_OFFER_CODE);
}
