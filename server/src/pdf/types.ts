/**
 * The canonical shape a "filing session" must provide for
 * composeArticlesOfOrganizationContext to produce a valid PDF context.
 *
 * NOTE (see GATE2-CHECKOUT-STATUS.md §3 and the Gate-2 funnel-data audit):
 * the live `filing_sessions` Postgres table (server/src/db, migration
 * 0001) does not currently have columns for most of these fields — it
 * only stores funnel-tracking metadata (email, current_stage, payment
 * status, etc.), not the Articles-of-Organization content itself. That
 * content today lives only in the frontend's browser-local IntakeContext
 * state until a one-shot POST to the legacy Cloudflare Worker
 * (llc-worker.js), which does not persist it in a queryable form either.
 * This type defines what a fully-populated record SHOULD contain: the
 * composer is built and tested against it via fixtures (server/test/pdf),
 * not against a live database row, because no such row exists yet. Wiring
 * this to real storage is a schema/ingestion decision, out of scope here.
 */

export type ArticleIVTitle = "AMBR" | "MGR";

export interface AuthorizedPersonInput {
  name: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  /** Set once, at the moment the person is added — never inferred from
   *  which array (members/managers/additional) the record currently sits
   *  in. See florida-business-launchpad's IntakeContext.tsx PersonCard. */
  article_iv_title: ArticleIVTitle;
}

export interface FilingSessionRecord {
  llc_name: string;

  principal_street: string;
  principal_city: string;
  principal_state: string;
  principal_zip: string;
  principal_country?: string;

  mailing_same: "Yes" | "No";
  mailing_street?: string;
  mailing_city?: string;
  mailing_state?: string;
  mailing_zip?: string;
  mailing_country?: string;

  agent_choice: "damian" | "own";
  agent_name: string;
  agent_street: string;
  agent_unit?: string;
  agent_city: string;
  agent_state: string;
  agent_zip: string;

  management_structure: "Member-Managed" | "Manager-Managed";
  members: AuthorizedPersonInput[];
  managers: AuthorizedPersonInput[];
  /** 5th+ authorized person, whichever role — see AuthorizedPersonInput. */
  additional_authorized_persons: AuthorizedPersonInput[];

  /**
   * As sent by the funnel today: "Immediately" | "Future Date". Also
   * accepts the template's own canonical values ("Immediate" | "Future" |
   * "Backdated") in case an upstream source ever sends those directly.
   * See effectiveDate.ts — mapEffectiveDateOption is the one place this
   * is translated.
   */
  effective_date_option: string;
  /** Required (YYYY-MM-DD) when effective_date_option resolves to
   *  anything other than "Immediate". */
  effective_date?: string;

  other_provisions?: string;

  /**
   * Present in the funnel's submission payload (signer_name,
   * representative_role) but NOT a template variable — the template's
   * signature section is filled by Zoho Sign text-tag anchors
   * ({{zs_authorized_signature}} etc.), rendered as literal text, not
   * Jinja substitution. Carried here for completeness/realism only; the
   * composer intentionally does not read or emit them. See §5 contract.
   */
  signer_name?: string;
  representative_role?: string;
}
