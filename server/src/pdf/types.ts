/**
 * The authoritative shape of filing_sessions.filing_data (migration
 * 0004). This is the ONE source PDF generation, checkout, CRM, Sunbiz
 * submission, and the Corporate Kit all read from — see that column's
 * comment. Every field the Jinja2 template
 * (templates/articles_of_organization.html.j2) references is enumerated
 * here; buildPdfContext() in context.ts is the only place that maps this
 * shape onto the template's exact variable names.
 */
export interface AuthorizedPerson {
  article_iv_title: string; // "AMBR" or "MGR" per the template's key
  name: string;
  address: string;
}

export type EffectiveDateOption = "Immediate" | "Future" | "Backdated";

export type RegisteredAgentPath = "house" | "customer";

export interface FilingSessionRecord {
  llc_name: string;
  principal_address: string;
  mailing_address: string;

  /**
   * Path A (house RA): the server ALWAYS stamps
   * DAMIAN_KNOWLES_HOUSE_RA below regardless of what (if anything) the
   * client sent — frozen rule, non-negotiable, non-editable client-side.
   * Path B (customer RA): name/address come from filing_data, but are
   * only usable in the PDF once registered_agent_status = 'accepted'
   * (see registered_agent_acceptances) — a typed name is not acceptance.
   */
  registered_agent_path: RegisteredAgentPath;
  registered_agent_name?: string;
  registered_agent_florida_address?: string;

  authorized_persons: AuthorizedPerson[];

  effective_date_option: EffectiveDateOption;
  effective_date?: string; // required if Future/Backdated
  annual_report_due_date?: string; // required if Future/Backdated

  other_provisions?: string;
}

/**
 * Server-authoritative Path A registered agent identity. Frozen rule:
 * customer cannot alter these client-side under any circumstance when
 * "house RA" is selected — the server stamps these into the PDF context
 * regardless of what the browser sends for RA fields in that case.
 */
export const HOUSE_REGISTERED_AGENT = {
  name: "Damian Knowles",
  florida_address: "3850 South University Drive, Unit #291921, Davie, Florida 33329",
} as const;
