/**
 * Registered-agent billing rule (2026-10-23): a session that chose
 * "Use Damian Knowles as my Registered Agent" (filing_data.registered_agent_path
 * = "house") must pay for the 3-year registered agent service. A checkout for
 * such a session is refused unless it carries REGISTERED_AGENT_3YR, or the
 * session already paid for it, or it buys PREMIUM (which includes it).
 * A customer with their own agent ("customer" path) is never affected.
 */
export const HOUSE_AGENT_OFFER_CODE = "REGISTERED_AGENT_3YR";
const BUNDLES_HOUSE_AGENT = ["PREMIUM"];

export function houseAgentLineMissing(
  registeredAgentPath: unknown,
  requestedCodes: string[],
  alreadyPaid: boolean,
): boolean {
  if (registeredAgentPath !== "house") return false;
  if (alreadyPaid) return false;
  return !requestedCodes.some((c) => c === HOUSE_AGENT_OFFER_CODE || BUNDLES_HOUSE_AGENT.includes(c));
}
