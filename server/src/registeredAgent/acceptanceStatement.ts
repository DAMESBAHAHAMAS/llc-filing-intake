/**
 * T144 D12: context for templates/registered_agent_acceptance_statement.html.j2,
 * the signed Registered Agent Acceptance Statement kept with the filing.
 *
 * Built only from filing_data.registered_agent_acceptance written by POST
 * /api/registered-agent/accept. A button-only acceptance (before the typed
 * signature was required) has no signature to print and is reported as a gap.
 */
import type { RegisteredAgentAcceptanceRecord } from "./acceptanceRecord.js";

export type StatementContextResult =
  | { ok: true; context: Record<string, unknown> }
  | { ok: false; missingFields: string[] };

/** "November 25, 2026 at 10:31 AM EST" in Florida (Eastern) time. */
export function floridaDateTime(iso: string): string {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "long", day: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(d);
  return `${date} at ${time}`;
}

export function buildAcceptanceStatementContext(filingData: Record<string, unknown>): StatementContextResult {
  const rec = filingData.registered_agent_acceptance as Partial<RegisteredAgentAcceptanceRecord> | undefined;
  if (!rec || typeof rec !== "object") return { ok: false, missingFields: ["registered_agent_acceptance (the agent has not accepted)"] };
  const missing: string[] = [];
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  if (rec.method !== "typed_signature" || !s(rec.signature_name)) missing.push("signature_name (accepted without a typed signature)");
  for (const k of ["llc_name", "registered_agent_name", "registered_agent_florida_address", "statement_text", "statement_version", "token_ref"] as const) {
    if (!s(rec[k])) missing.push(k);
  }
  if (!s(rec.accepted_at) || Number.isNaN(Date.parse(s(rec.accepted_at)))) missing.push("accepted_at");
  if (missing.length) return { ok: false, missingFields: missing };
  return {
    ok: true,
    context: {
      llc_name: s(rec.llc_name).toUpperCase(),
      registered_agent_name: s(rec.registered_agent_name),
      registered_agent_florida_address: s(rec.registered_agent_florida_address),
      statement_text: s(rec.statement_text),
      statement_version: s(rec.statement_version),
      signature_name: s(rec.signature_name),
      accepted_at_display: floridaDateTime(s(rec.accepted_at)),
      accepted_at_iso: new Date(s(rec.accepted_at)).toISOString(),
      ip: s(rec.ip) || "not recorded",
      user_agent: s(rec.user_agent) || "not recorded",
      token_ref: s(rec.token_ref),
    },
  };
}

/** For the Articles (Article III, own agent): the signed line, or null. */
export function registeredAgentSignatureForArticles(filingData: Record<string, unknown>): { name: string; date: string } | null {
  const rec = filingData.registered_agent_acceptance as Partial<RegisteredAgentAcceptanceRecord> | undefined;
  const name = typeof rec?.signature_name === "string" ? rec.signature_name.trim() : "";
  const at = typeof rec?.accepted_at === "string" ? rec.accepted_at : "";
  if (!rec || rec.method !== "typed_signature" || !name || Number.isNaN(Date.parse(at))) return null;
  const date = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "long", day: "numeric" }).format(new Date(at));
  return { name, date };
}
