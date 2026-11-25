/**
 * When the registered-agent acceptance email may (re)send.
 *
 * Since 25 Nov 2026 (website ST06) the customer can send the request from
 * Article III, before checkout. These rules keep one live request per
 * agent: a repeat click, a second device, or the post-payment webhook must
 * not send again (each send expires the previous link, so a duplicate would
 * break the link the agent may already be holding).
 */

const ACCEPTANCE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // same 7 days as the token itself

export interface LatestAcceptanceRow {
  status: string;
  registered_agent_email: string;
  registered_agent_name: string;
  requested_at: string | Date | null;
}

/** Post-payment send (routes/webhooksStripe.ts): skip while a live request is already out. */
export function shouldSendAfterPayment(registeredAgentPath: string | undefined, registeredAgentStatus: string | null): boolean {
  if (registeredAgentPath !== "customer") return false;
  return registeredAgentStatus !== "accepted" && registeredAgentStatus !== "acceptance_requested";
}

/**
 * True when the latest request is still live for this same agent name and
 * email, so POST /api/registered-agent/request-acceptance should answer
 * "already requested" instead of sending again. Pass force to resend anyway.
 */
export function isDuplicateAcceptanceRequest(
  latest: LatestAcceptanceRow | undefined,
  name: string,
  email: string,
  now: Date = new Date(),
): boolean {
  if (!latest || latest.status !== "acceptance_requested" || !latest.requested_at) return false;
  const requestedAt = new Date(latest.requested_at).getTime();
  if (Number.isNaN(requestedAt) || now.getTime() - requestedAt > ACCEPTANCE_TOKEN_TTL_MS) return false;
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  return same(latest.registered_agent_email, email) && same(latest.registered_agent_name, name);
}
