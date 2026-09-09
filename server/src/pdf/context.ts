import { HOUSE_REGISTERED_AGENT, type FilingSessionRecord } from "./types.js";

export type PdfContextResult =
  | { ok: true; context: Record<string, unknown> }
  | { ok: false; missingFields: string[] };

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Validates filing_data (+ the separately-queried registered agent
 * acceptance status, for Path B) is complete enough to render the
 * Articles of Organization, and builds the exact Jinja2 context if so.
 *
 * Gate 2 test-matrix requirement: a missing/incomplete field surfaces
 * here as a named completeness gap the caller returns to the user — it
 * NEVER reaches render_pdf.py as a fabricated value, and render_pdf.py's
 * own StrictUndefined is the second, independent line of defense if a
 * field were ever missed here (see that file's comments).
 *
 * Article IV (authorized_persons) is treated as REQUIRED here — Florida
 * LLCs must name at least one authorized person/manager to be validly
 * organized, so an empty Article IV would produce a legally deficient
 * document regardless of whether this specific product tier makes
 * collecting it optional at intake. Whether the INTAKE FLOW makes this
 * field optional/deferred is a separate, still-open product question
 * (decision boundary #3, DECISIONS.md) — this validator's answer to "can
 * we file with zero authorized persons" is no, independent of that.
 */
export function buildPdfContext(
  filingData: Partial<FilingSessionRecord>,
  registeredAgentAcceptanceStatus: string | null
): PdfContextResult {
  const missing: string[] = [];

  if (!isNonEmptyString(filingData.llc_name)) missing.push("llc_name");
  if (!isNonEmptyString(filingData.principal_address)) missing.push("principal_address");
  if (!isNonEmptyString(filingData.mailing_address)) missing.push("mailing_address");
  if (!filingData.effective_date_option) missing.push("effective_date_option");

  const persons = filingData.authorized_persons ?? [];
  if (persons.length === 0) {
    missing.push("authorized_persons (at least one required)");
  } else {
    persons.forEach((p, i) => {
      if (!isNonEmptyString(p.name)) missing.push(`authorized_persons[${i}].name`);
      if (!isNonEmptyString(p.address)) missing.push(`authorized_persons[${i}].address`);
      if (!isNonEmptyString(p.article_iv_title)) missing.push(`authorized_persons[${i}].article_iv_title`);
    });
  }

  let registeredAgentName: string;
  let registeredAgentAddress: string;

  if (filingData.registered_agent_path === "house") {
    // Server-stamped, non-negotiable — never trust filing_data's RA
    // fields for this path, even if the client sent something.
    registeredAgentName = HOUSE_REGISTERED_AGENT.name;
    registeredAgentAddress = HOUSE_REGISTERED_AGENT.florida_address;
  } else if (filingData.registered_agent_path === "customer") {
    if (!isNonEmptyString(filingData.registered_agent_name)) missing.push("registered_agent_name");
    if (!isNonEmptyString(filingData.registered_agent_florida_address)) missing.push("registered_agent_florida_address");
    if (registeredAgentAcceptanceStatus !== "accepted") {
      // Typing a name is not acceptance (frozen rule) — this is a hard
      // gate, not a soft warning.
      missing.push("registered_agent_acceptance (Path B requires status='accepted', see registered_agent_acceptances)");
    }
    registeredAgentName = filingData.registered_agent_name ?? "";
    registeredAgentAddress = filingData.registered_agent_florida_address ?? "";
  } else {
    missing.push("registered_agent_path (must be 'house' or 'customer')");
    registeredAgentName = "";
    registeredAgentAddress = "";
  }

  const effectiveDateOption = filingData.effective_date_option;
  if (effectiveDateOption === "Future" || effectiveDateOption === "Backdated") {
    if (!isNonEmptyString(filingData.effective_date)) missing.push("effective_date");
    if (!isNonEmptyString(filingData.annual_report_due_date)) missing.push("annual_report_due_date");
  }

  if (missing.length > 0) {
    return { ok: false, missingFields: missing };
  }

  return {
    ok: true,
    context: {
      llc_name: filingData.llc_name,
      principal_address: filingData.principal_address,
      mailing_address: filingData.mailing_address,
      registered_agent_name: registeredAgentName,
      registered_agent_florida_address: registeredAgentAddress,
      authorized_persons: persons,
      effective_date_option: effectiveDateOption,
      effective_date: filingData.effective_date ?? "",
      annual_report_due_date: filingData.annual_report_due_date ?? "",
      other_provisions: filingData.other_provisions ?? "",
    },
  };
}
