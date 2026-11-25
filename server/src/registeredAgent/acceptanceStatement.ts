/**
 * T144 D12: the signed Registered Agent Acceptance Statement and the agent's
 * Article III signature line, both built ONLY from the server-side acceptance
 * row (registered_agent_acceptances, migration 0033), never from filing_data.
 */
import {
  isEntityName,
  normalizeName,
  RA_STATEMENTS,
  tokenRef,
  type StoredAcceptance,
} from "./acceptanceRecord.js";

export type StatementContextResult =
  | { ok: true; context: Record<string, unknown> }
  | { ok: false; missingFields: string[] };

const DATE_ET = { timeZone: "America/New_York", year: "numeric", month: "long", day: "numeric" } as const;

/** "November 25, 2026 at 10:31 AM EST" in Florida (Eastern) time. */
export function floridaDateTime(iso: string): string {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-US", DATE_ET).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(d);
  return `${date} at ${time}`;
}

function s(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** "Riley Agent" or, for a business agent, "Riley Agent, for SUNSHINE AGENTS INC". */
function signedBy(signature: string, agentName: string): string {
  return isEntityName(agentName) && normalizeName(signature) !== normalizeName(agentName) ? `${signature}, for ${agentName}` : signature;
}

export function buildAcceptanceStatementContext(acc: StoredAcceptance | null): StatementContextResult {
  if (!acc) return { ok: false, missingFields: ["registered_agent_acceptance (the agent has not accepted)"] };
  const missing: string[] = [];
  if (!s(acc.signature_name)) missing.push("signature_name (accepted without a typed signature)");
  const statement = RA_STATEMENTS[s(acc.statement_version)];
  if (!statement) missing.push("statement_version");
  for (const k of ["accepted_agent_name", "accepted_agent_address", "accepted_llc_name"] as const) if (!s(acc[k])) missing.push(k);
  const at = acc.accepted_at ? new Date(acc.accepted_at) : null;
  if (!at || Number.isNaN(at.getTime())) missing.push("accepted_at");
  if (missing.length) return { ok: false, missingFields: missing };
  return {
    ok: true,
    context: {
      llc_name: s(acc.accepted_llc_name).toUpperCase(),
      registered_agent_name: s(acc.accepted_agent_name),
      registered_agent_florida_address: s(acc.accepted_agent_address),
      statement_text: statement,
      statement_version: s(acc.statement_version),
      signature_name: signedBy(s(acc.signature_name), s(acc.accepted_agent_name)),
      accepted_at_display: floridaDateTime(at!.toISOString()),
      accepted_at_iso: at!.toISOString(),
      ip: s(acc.accepted_ip) || "not recorded",
      user_agent: s(acc.accepted_user_agent) || "not recorded",
      token_ref: tokenRef(acc.acceptance_token_id),
    },
  };
}

/**
 * The agent's Article III signature line, or null. Printed only while the
 * filing still names the agent and address the agent accepted (compared
 * case-, accent-, punctuation- and space-insensitively); a changed agent
 * gets the Zoho Sign anchors instead of someone else's signature.
 */
export function registeredAgentSignatureForArticles(
  acc: StoredAcceptance | null,
  filingData: { registered_agent_name?: unknown; registered_agent_florida_address?: unknown }
): { name: string; date: string } | null {
  if (!acc) return null;
  const sig = s(acc.signature_name);
  const at = acc.accepted_at ? new Date(acc.accepted_at) : null;
  if (!sig || !at || Number.isNaN(at.getTime())) return null;
  const same = (a: unknown, b: unknown) => normalizeName(s(a)) !== "" && normalizeName(s(a)) === normalizeName(s(b));
  if (!same(acc.accepted_agent_name, filingData.registered_agent_name)) return null;
  if (!same(acc.accepted_agent_address, filingData.registered_agent_florida_address)) return null;
  return { name: signedBy(sig, s(acc.accepted_agent_name)), date: new Intl.DateTimeFormat("en-US", DATE_ET).format(at) };
}
