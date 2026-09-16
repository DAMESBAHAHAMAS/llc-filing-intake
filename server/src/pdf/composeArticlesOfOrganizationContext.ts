import { formatAddress } from "./formatAddress.js";
import { mapEffectiveDateOption, computeAnnualReportDueDate } from "./effectiveDate.js";
import type { ArticleIVTitle, AuthorizedPersonInput, FilingSessionRecord } from "./types.js";

export interface ArticlesOfOrganizationContext {
  llc_name: string;
  principal_address: string;
  mailing_address: string;
  registered_agent_name: string;
  registered_agent_florida_address: string;
  authorized_persons: { article_iv_title: ArticleIVTitle; name: string; address: string }[];
  effective_date_option: "Immediate" | "Future" | "Backdated";
  effective_date?: string;
  annual_report_due_date?: string;
  other_provisions: string;
}

/**
 * Fails loudly on a missing/blank required value instead of letting it
 * through. This matters specifically because render_pdf.py's Jinja2
 * Environment does not use StrictUndefined — a missing context key
 * renders as a silent blank in the PDF, not an error. This function is
 * the only backstop against that for a legal document.
 */
function required(value: string | undefined | null, field: string): string {
  if (!value || !value.trim()) {
    throw new Error(`Cannot build PDF context: missing required field "${field}"`);
  }
  return value;
}

/**
 * THE ONLY PLACE application filing data is translated into
 * articles_of_organization.html.j2's field names. See
 * GATE2-PDF-CONTEXT.md for the full template variable contract this
 * function is responsible for satisfying.
 */
export function composeArticlesOfOrganizationContext(
  input: FilingSessionRecord
): ArticlesOfOrganizationContext {
  const llc_name = required(input.llc_name, "llc_name");

  const principal_address = formatAddress({
    street: required(input.principal_street, "principal_street"),
    city: required(input.principal_city, "principal_city"),
    state: required(input.principal_state, "principal_state"),
    zip: required(input.principal_zip, "principal_zip"),
    country: input.principal_country,
  });

  // mailing_same === "Yes" -> use the principal address values (no copy
  // ever happens in the funnel itself, see GATE2-CHECKOUT-STATUS.md /
  // LLCFilingIntake.tsx's mailingSame==="Yes" branch — it only shows a
  // note, it never writes mailingStreet etc.). "No" requires its own,
  // fully-populated mailing address.
  const mailing_address =
    input.mailing_same === "Yes"
      ? principal_address
      : formatAddress({
          street: required(input.mailing_street, 'mailing_street (mailing_same is "No")'),
          city: required(input.mailing_city, 'mailing_city (mailing_same is "No")'),
          state: required(input.mailing_state, 'mailing_state (mailing_same is "No")'),
          zip: required(input.mailing_zip, 'mailing_zip (mailing_same is "No")'),
          country: input.mailing_country,
        });

  const registered_agent_name = required(input.agent_name, "agent_name");
  const registered_agent_florida_address = formatAddress({
    street: required(input.agent_street, "agent_street"),
    unit: input.agent_unit,
    city: required(input.agent_city, "agent_city"),
    state: required(input.agent_state, "agent_state"),
    zip: required(input.agent_zip, "agent_zip"),
  });

  const authorized_persons = composeAuthorizedPersons(input);

  const effective_date_option = mapEffectiveDateOption(input.effective_date_option);

  // Only "Future"/"Backdated" carry an effective_date at all — the
  // template's own Article V branch never references effective_date or
  // annual_report_due_date under "Immediate", so nothing is computed or
  // fabricated for that case.
  let effective_date: string | undefined;
  let annual_report_due_date: string | undefined;
  if (effective_date_option !== "Immediate") {
    effective_date = required(
      input.effective_date,
      `effective_date (effective_date_option resolved to "${effective_date_option}")`
    );
    annual_report_due_date = computeAnnualReportDueDate(effective_date);
  }

  return {
    llc_name,
    principal_address,
    mailing_address,
    registered_agent_name,
    registered_agent_florida_address,
    authorized_persons,
    effective_date_option,
    effective_date,
    annual_report_due_date,
    // Optional by template design ({% if other_provisions %} ... {% else
    // %} "No other provisions." {% endif %}) — an empty string is a
    // valid, intentional value, not a missing one.
    other_provisions: input.other_provisions ?? "",
  };
}

/**
 * Picks whichever of members/managers matches management_structure (the
 * intake UI only ever populates one of them — the other retains its
 * unused default entry) and appends every 5th+ overflow person exactly
 * as recorded, title included. Never infers a title from array position;
 * every person must already carry article_iv_title on the record.
 */
function composeAuthorizedPersons(
  input: FilingSessionRecord
): { article_iv_title: ArticleIVTitle; name: string; address: string }[] {
  const primary: AuthorizedPersonInput[] =
    input.management_structure === "Manager-Managed" ? input.managers : input.members;
  const all = [...primary, ...input.additional_authorized_persons];

  if (all.length === 0) {
    throw new Error("Cannot build PDF context: at least one authorized person is required");
  }

  return all.map((person, i) => {
    if (person.article_iv_title !== "AMBR" && person.article_iv_title !== "MGR") {
      throw new Error(
        `Cannot build PDF context: authorized_persons[${i}] ("${person.name}") has no valid article_iv_title`
      );
    }
    return {
      article_iv_title: person.article_iv_title,
      name: required(person.name, `authorized_persons[${i}].name`),
      address: formatAddress({
        street: required(person.street, `authorized_persons[${i}].street`),
        city: required(person.city, `authorized_persons[${i}].city`),
        state: required(person.state, `authorized_persons[${i}].state`),
        zip: required(person.zip, `authorized_persons[${i}].zip`),
      }),
    };
  });
}
