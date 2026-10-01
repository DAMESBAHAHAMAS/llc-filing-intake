import { HOUSE_REGISTERED_AGENT, type FilingSessionRecord } from "./types.js";
import { formatLegalDate, type FiledArticles } from "./operatingAgreementContext.js";

/**
 * Formation package: the branded delivery every filer receives after the
 * state files their Articles (Damian's rule: every LLC filer, not only
 * Premium). Parts, in order:
 *
 *   1. Cover letter            (rendered: formation_cover_letter)
 *   2. Articles of Organization (the PDF already generated for filing)
 *   3. State filing confirmation (the document received from Sunbiz)
 *   4. Operating Agreement      (rendered, Premium only)
 *   5. Next steps               (rendered: formation_next_steps)
 *
 * Same rules as the other documents: a missing value is a named gap,
 * never invented, and until Damian approves the wording every rendered
 * page carries the "not for customer delivery" banner. No delivery step
 * is wired: assembling a package sends nothing.
 */
export const FORMATION_PACKAGE_WORDING_APPROVED = false;

export type PackageTier = "diy" | "fasttrack" | "premium";

export interface FormationPackageOrder {
  customer_first_name?: string;
  /** The amount collected on the order, in cents. */
  order_total_cents?: number;
  package?: PackageTier;
  ein_ordered?: boolean;
  /** Public Formation Review booking page. */
  booking_link?: string;
}

export type ContextResult = { ok: true; context: Record<string, unknown> } | { ok: false; missingFields: string[] };

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

const PACKAGE_TIERS: PackageTier[] = ["diy", "fasttrack", "premium"];

export function formatUsd(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function includesOperatingAgreement(tier: PackageTier): boolean {
  return tier === "premium";
}

export function buildCoverLetterContext(
  filingData: Partial<FilingSessionRecord>,
  filed: FiledArticles,
  order: FormationPackageOrder,
  options: { wordingApproved?: boolean } = {}
): ContextResult {
  const missing: string[] = [];

  if (!isNonEmptyString(order.customer_first_name)) missing.push("customer_first_name");
  if (!isNonEmptyString(filingData.llc_name)) missing.push("llc_name");
  if (!isNonEmptyString(filingData.principal_address)) missing.push("principal_address");
  if (!order.package || !PACKAGE_TIERS.includes(order.package)) missing.push("package (diy, fasttrack or premium)");
  if (typeof order.order_total_cents !== "number" || !Number.isInteger(order.order_total_cents) || order.order_total_cents <= 0) {
    missing.push("order_total_cents (the amount collected)");
  }
  if (!isNonEmptyString(order.booking_link)) missing.push("booking_link");

  let filingDate: string | null = null;
  if (!isNonEmptyString(filed.filing_date)) missing.push("filing_date (from proof of filing)");
  else if (!(filingDate = formatLegalDate(filed.filing_date))) missing.push("filing_date (must be YYYY-MM-DD)");
  if (!isNonEmptyString(filed.document_number)) missing.push("document_number (from proof of filing)");

  const effectiveOnFiling = filingData.effective_date_option === "Immediate";
  let effectiveDate: string | null = null;
  if (!filingData.effective_date_option) missing.push("effective_date_option");
  else if (effectiveOnFiling) effectiveDate = filingDate;
  else if (!isNonEmptyString(filingData.effective_date)) missing.push("effective_date");
  else if (!(effectiveDate = formatLegalDate(filingData.effective_date))) missing.push("effective_date (must be YYYY-MM-DD)");

  let registeredAgentName = "";
  if (filingData.registered_agent_path === "house") registeredAgentName = HOUSE_REGISTERED_AGENT.name;
  else if (filingData.registered_agent_path === "customer") {
    if (!isNonEmptyString(filingData.registered_agent_name)) missing.push("registered_agent_name");
    registeredAgentName = filingData.registered_agent_name ?? "";
  } else missing.push("registered_agent_path (must be 'house' or 'customer')");

  if (missing.length > 0) return { ok: false, missingFields: missing };

  return {
    ok: true,
    context: {
      draft: !(options.wordingApproved ?? FORMATION_PACKAGE_WORDING_APPROVED),
      customer_first_name: order.customer_first_name!.trim(),
      llc_name: filingData.llc_name,
      filing_date: filingDate,
      document_number: filed.document_number!.trim(),
      effective_on_filing: effectiveOnFiling,
      effective_date: effectiveDate,
      registered_agent_name: registeredAgentName,
      principal_address: filingData.principal_address,
      includes_operating_agreement: includesOperatingAgreement(order.package!),
      order_total: formatUsd(order.order_total_cents!),
      booking_link: order.booking_link!.trim(),
    },
  };
}

export function buildNextStepsContext(
  order: FormationPackageOrder,
  options: { wordingApproved?: boolean } = {}
): ContextResult {
  if (!order.package || !PACKAGE_TIERS.includes(order.package)) {
    return { ok: false, missingFields: ["package (diy, fasttrack or premium)"] };
  }
  return {
    ok: true,
    context: {
      draft: !(options.wordingApproved ?? FORMATION_PACKAGE_WORDING_APPROVED),
      includes_operating_agreement: includesOperatingAgreement(order.package),
      ein_ordered: order.ein_ordered === true,
    },
  };
}

export interface FormationPackageParts {
  coverLetter?: Buffer;
  articles?: Buffer;
  filingConfirmation?: Buffer;
  operatingAgreement?: Buffer;
  nextSteps?: Buffer;
}

/**
 * Puts the parts in package order and refuses an incomplete package:
 * Premium needs the Operating Agreement, the others must not carry one.
 */
export function orderPackageParts(
  tier: PackageTier,
  parts: FormationPackageParts
): { ok: true; parts: Buffer[] } | { ok: false; missingFields: string[] } {
  const missing: string[] = [];
  if (!parts.coverLetter) missing.push("coverLetter");
  if (!parts.articles) missing.push("articles");
  if (!parts.filingConfirmation) missing.push("filingConfirmation (the state's filing confirmation)");
  if (!parts.nextSteps) missing.push("nextSteps");
  if (includesOperatingAgreement(tier) && !parts.operatingAgreement) missing.push("operatingAgreement (Premium)");
  if (!includesOperatingAgreement(tier) && parts.operatingAgreement) {
    missing.push(`operatingAgreement given for a ${tier} order, which doesn't include one`);
  }
  if (missing.length > 0) return { ok: false, missingFields: missing };

  const ordered = [parts.coverLetter!, parts.articles!, parts.filingConfirmation!];
  if (parts.operatingAgreement) ordered.push(parts.operatingAgreement);
  ordered.push(parts.nextSteps!);
  return { ok: true, parts: ordered };
}
