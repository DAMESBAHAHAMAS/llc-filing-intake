/**
 * Banking Resolution — context builder (T144 Dispatch 10, DRAFT).
 *
 * Damian asked (25 Nov 2026) for standard single- and multi-member LLC banking
 * resolutions "for my review". The wording in templates/banking_resolution_*
 * is a DRAFT: every page prints "DRAFT – pending owner approval" whatever the
 * settings, and nothing generates it unless BANKING_RESOLUTION_ENABLED=true
 * (off by default). Same contract as the Operating Agreement: a missing value
 * is a named gap, never invented.
 */
import type { FilingSessionRecord } from "./types.js";
import { formatLegalDate, type FiledArticles } from "./operatingAgreementContext.js";

export type BankingResolutionTemplate = "banking_resolution_single_member" | "banking_resolution_multi_member";
export type SigningRule = "any_one" | "any_two" | "all";

export interface BankingResolutionInputs {
  /** The owners, when they differ from Article IV (required when the Articles list a manager). */
  members?: Array<{ name?: string }>;
  /** Who may operate the accounts. Default: the managers (manager-managed) or the members. */
  authorized_signers?: Array<{ name?: string; title?: string }>;
  /** Default: any one Authorized Signer acting alone. */
  signing_rule?: SigningRule;
}

export type BankingResolutionContextResult =
  | { ok: true; template: BankingResolutionTemplate; context: Record<string, unknown> }
  | { ok: false; missingFields: string[] };

/** Off unless BANKING_RESOLUTION_ENABLED=true (Damian has not approved the wording). */
export function bankingResolutionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BANKING_RESOLUTION_ENABLED === "true";
}

const RULE_TEXT: Record<SigningRule, string> = {
  any_one: "acting alone",
  any_two: "acting together with any one other Authorized Signer",
  all: "acting only together with all the other Authorized Signers",
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function buildBankingResolutionContext(
  filingData: Partial<FilingSessionRecord>,
  filed: FiledArticles,
  inputs: BankingResolutionInputs = {}
): BankingResolutionContextResult {
  const missing: string[] = [];
  const llcName = str(filingData.llc_name).toUpperCase();
  if (!llcName) missing.push("llc_name");
  const filingDate = filed.filing_date ? formatLegalDate(filed.filing_date) : null;
  if (!filingDate) missing.push("filing_date (YYYY-MM-DD, from proof of filing)");
  const docNo = str(filed.document_number);
  if (!docNo) missing.push("document_number (from proof of filing)");

  const persons = filingData.authorized_persons ?? [];
  const managers = persons.filter((p) => p.article_iv_title === "MGR" && str(p.name)).map((p) => str(p.name));
  const managerManaged = managers.length > 0;

  let members: string[];
  if (inputs.members && inputs.members.length > 0) members = inputs.members.map((m) => str(m.name));
  else if (!managerManaged) members = persons.map((p) => str(p.name));
  else {
    members = [];
    missing.push("members (the Articles list a manager, so the owners must be given separately)");
  }
  members.forEach((m, i) => { if (!m) missing.push(`members[${i}].name`); });

  const rule: SigningRule = inputs.signing_rule ?? "any_one";
  if (!RULE_TEXT[rule]) missing.push("signing_rule (any_one, any_two or all)");

  const single = members.length === 1;
  const defaultSigners = managerManaged
    ? managers.map((name) => ({ name, title: "Manager" }))
    : members.map((name) => ({ name, title: single ? "Sole Member" : "Member" }));
  const signers = (inputs.authorized_signers && inputs.authorized_signers.length > 0
    ? inputs.authorized_signers.map((s) => ({ name: str(s.name), title: str(s.title) }))
    : defaultSigners);
  if (signers.length === 0) missing.push("authorized_signers");
  signers.forEach((s, i) => {
    if (!s.name) missing.push(`authorized_signers[${i}].name`);
    if (!s.title) missing.push(`authorized_signers[${i}].title`);
  });
  if (rule === "any_two" && signers.length < 2) missing.push("signing_rule any_two needs at least two Authorized Signers");

  if (missing.length) return { ok: false, missingFields: missing };

  // Who adopts the resolution by written consent: the managers of a
  // manager-managed LLC, otherwise every member.
  const signersOfConsent = managerManaged
    ? managers.map((name) => ({ role: "Manager", name }))
    : members.map((name) => ({ role: single ? "Sole Member" : "Member", name }));
  const adoptedBy = managerManaged
    ? (managers.length === 1 ? "the sole manager" : "all of the managers")
    : (single ? "the sole member" : "all of the members");

  return {
    ok: true,
    template: single ? "banking_resolution_single_member" : "banking_resolution_multi_member",
    context: {
      draft: true,
      llc_name: llcName,
      document_number: docNo,
      filing_date: filingDate,
      adoption_date_label: "Date of the last signature below",
      adopted_by: adoptedBy,
      signing_rule_text: RULE_TEXT[rule],
      authorized_signers: signers,
      signers_of_consent: signersOfConsent,
    },
  };
}
