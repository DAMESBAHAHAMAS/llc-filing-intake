import { HOUSE_REGISTERED_AGENT, type FilingSessionRecord } from "./types.js";

/**
 * Operating Agreement (Premium inclusion) — context builder.
 *
 * Same contract as buildPdfContext() for the Articles: a missing value is
 * returned as a named completeness gap, never filled with a made-up value.
 * render_pdf.py's StrictUndefined is the second line of defence.
 *
 * The wording lives in templates/operating_agreement_*.html.j2 and comes
 * from the "Operating Agreement Templates for Review" doc. Until Damian
 * approves that wording, OPERATING_AGREEMENT_WORDING_APPROVED stays false
 * and every rendered PDF carries a "not for customer delivery" banner.
 * Flipping it is a one-line change that needs a DECISIONS.md entry citing
 * his approval.
 */
export const OPERATING_AGREEMENT_WORDING_APPROVED = false;

export type OperatingAgreementTemplate = "operating_agreement_single_member" | "operating_agreement_multi_member";

/** Facts that only exist once the Articles are filed (proof of filing). */
export interface FiledArticles {
  /** Date the Division of Corporations filed the Articles, YYYY-MM-DD. */
  filing_date?: string;
  /** Sunbiz document number, e.g. L26000123456. */
  document_number?: string;
}

export interface OperatingAgreementMemberInput {
  name?: string;
  address?: string;
  /** Free text as the customer gave it, e.g. "$1,000 cash". Optional: left blank to write in. */
  contribution?: string;
  /** Ownership percentage, 0-100. Required for multi-member. */
  percentage?: number;
}

/**
 * Inputs the filing interview does not collect today. All optional for a
 * member-managed single-member LLC; required as noted otherwise.
 */
export interface OperatingAgreementInputs {
  /**
   * Members, when they differ from the Article IV list. Required when the
   * Articles list a manager, because Article IV then names managers, not
   * owners. Otherwise the Article IV authorized members are the members.
   */
  members?: OperatingAgreementMemberInput[];
  /** Single-member only, optional: named successor in Section 16. */
  successor_name?: string;
  /** Multi-member only, required: Section 9A cap, e.g. "$25,000". */
  borrowing_limit?: string;
  /** Multi-member only, required: Section 16 buy-out payment period in months. */
  payment_period_months?: number;
  /** Multi-member only, required: Section 12 tax representative's name. */
  partnership_representative?: string;
}

export type OperatingAgreementContextResult =
  | { ok: true; template: OperatingAgreementTemplate; context: Record<string, unknown> }
  | { ok: false; missingFields: string[] };

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-10-01" -> "October 1, 2026". Anything that is not a valid ISO date is returned as null. */
export function formatLegalDate(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

/** ["A"] -> "A"; ["A","B"] -> "A and B"; ["A","B","C"] -> "A, B and C". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function formatPercentage(p: number): string {
  return `${Number.isInteger(p) ? p : Number(p.toFixed(2))}%`;
}

export function buildOperatingAgreementContext(
  filingData: Partial<FilingSessionRecord>,
  filed: FiledArticles,
  inputs: OperatingAgreementInputs = {},
  options: { wordingApproved?: boolean } = {}
): OperatingAgreementContextResult {
  const missing: string[] = [];

  if (!isNonEmptyString(filingData.llc_name)) missing.push("llc_name");
  if (!isNonEmptyString(filingData.principal_address)) missing.push("principal_address");
  if (!isNonEmptyString(filingData.mailing_address)) missing.push("mailing_address");

  // Filing facts: the agreement cites the filed Articles, so it can only be
  // generated after proof of filing.
  let filingDate: string | null = null;
  if (!isNonEmptyString(filed.filing_date)) {
    missing.push("filing_date (from proof of filing)");
  } else {
    filingDate = formatLegalDate(filed.filing_date);
    if (!filingDate) missing.push("filing_date (must be YYYY-MM-DD)");
  }
  if (!isNonEmptyString(filed.document_number)) missing.push("document_number (from proof of filing)");

  // Effective date: Immediate = the filing date; otherwise the date on the Articles.
  let effectiveDate: string | null = null;
  const option = filingData.effective_date_option;
  if (!option) {
    missing.push("effective_date_option");
  } else if (option === "Immediate") {
    effectiveDate = filingDate;
  } else if (!isNonEmptyString(filingData.effective_date)) {
    missing.push("effective_date");
  } else {
    effectiveDate = formatLegalDate(filingData.effective_date);
    if (!effectiveDate) missing.push("effective_date (must be YYYY-MM-DD)");
  }

  // Registered agent: same rule as the Articles. House path is server-stamped.
  let registeredAgentName = "";
  let registeredAgentAddress = "";
  if (filingData.registered_agent_path === "house") {
    registeredAgentName = HOUSE_REGISTERED_AGENT.name;
    registeredAgentAddress = HOUSE_REGISTERED_AGENT.florida_address;
  } else if (filingData.registered_agent_path === "customer") {
    if (!isNonEmptyString(filingData.registered_agent_name)) missing.push("registered_agent_name");
    if (!isNonEmptyString(filingData.registered_agent_florida_address)) missing.push("registered_agent_florida_address");
    registeredAgentName = filingData.registered_agent_name ?? "";
    registeredAgentAddress = filingData.registered_agent_florida_address ?? "";
  } else {
    missing.push("registered_agent_path (must be 'house' or 'customer')");
  }

  // Management follows Article IV: any manager listed = manager-managed.
  const persons = filingData.authorized_persons ?? [];
  if (persons.length === 0) missing.push("authorized_persons (at least one required)");
  const managers = persons.filter((p) => p.article_iv_title === "MGR");
  const management: "member" | "manager" = managers.length > 0 ? "manager" : "member";
  const managerNames = managers.map((p) => p.name).filter(isNonEmptyString);
  if (management === "manager" && managerNames.length !== managers.length) {
    missing.push("authorized_persons: every manager needs a name");
  }

  // Members: explicit input wins; otherwise the Article IV authorized members.
  let members: OperatingAgreementMemberInput[];
  if (inputs.members && inputs.members.length > 0) {
    members = inputs.members;
  } else if (management === "member") {
    members = persons.map((p) => ({ name: p.name, address: p.address }));
  } else {
    members = [];
    missing.push("members (the Articles list a manager, so the owners must be given separately)");
  }

  members.forEach((m, i) => {
    if (!isNonEmptyString(m.name)) missing.push(`members[${i}].name`);
    if (!isNonEmptyString(m.address)) missing.push(`members[${i}].address`);
  });

  const multi = members.length > 1;
  const template: OperatingAgreementTemplate = multi
    ? "operating_agreement_multi_member"
    : "operating_agreement_single_member";

  if (multi) {
    let total = 0;
    members.forEach((m, i) => {
      if (typeof m.percentage !== "number" || !Number.isFinite(m.percentage) || m.percentage <= 0 || m.percentage > 100) {
        missing.push(`members[${i}].percentage (multi-member: 0-100 required)`);
      } else {
        total += m.percentage;
      }
    });
    const allHavePercentages = members.every((m) => typeof m.percentage === "number" && Number.isFinite(m.percentage));
    if (allHavePercentages && Math.abs(total - 100) > 0.01) {
      missing.push(`members percentages must total 100 (they total ${Number(total.toFixed(2))})`);
    }
    if (!isNonEmptyString(inputs.borrowing_limit)) missing.push("borrowing_limit (multi-member, Section 9A)");
    if (
      typeof inputs.payment_period_months !== "number" ||
      !Number.isInteger(inputs.payment_period_months) ||
      inputs.payment_period_months <= 0
    ) {
      missing.push("payment_period_months (multi-member, Section 16, whole months)");
    }
    if (!isNonEmptyString(inputs.partnership_representative)) {
      missing.push("partnership_representative (multi-member, Section 12)");
    }
  }

  if (missing.length > 0) return { ok: false, missingFields: missing };

  const base = {
    draft: !(options.wordingApproved ?? OPERATING_AGREEMENT_WORDING_APPROVED),
    llc_name: filingData.llc_name,
    principal_address: filingData.principal_address,
    mailing_address: filingData.mailing_address,
    registered_agent_name: registeredAgentName,
    registered_agent_florida_address: registeredAgentAddress,
    filing_date: filingDate,
    document_number: filed.document_number!.trim(),
    effective_date: effectiveDate,
    management,
    manager_names: joinNames(managerNames),
  };

  if (!multi) {
    const m = members[0];
    return {
      ok: true,
      template,
      context: {
        ...base,
        member: { name: m.name, address: m.address, contribution: m.contribution?.trim() ?? "" },
        successor_name: inputs.successor_name?.trim() ?? "",
      },
    };
  }

  return {
    ok: true,
    template,
    context: {
      ...base,
      members: members.map((m) => ({
        name: m.name,
        address: m.address,
        contribution: m.contribution?.trim() ?? "",
        percentage: formatPercentage(m.percentage as number),
      })),
      borrowing_limit: inputs.borrowing_limit!.trim(),
      payment_period_months: inputs.payment_period_months,
      partnership_representative: inputs.partnership_representative!.trim(),
    },
  };
}
