export type TemplateEffectiveDateOption = "Immediate" | "Future" | "Backdated";

/**
 * The ONE place the funnel's effective-date values are translated into
 * what articles_of_organization.html.j2 actually checks for.
 *
 * GATE2-CHECKOUT-STATUS.md §4 found this exact mismatch: the funnel
 * (LLCFilingIntake.tsx) sends "Immediately" / "Future Date"; the
 * template's Jinja2 conditionals check for "Immediate" and
 * ("Future", "Backdated"). Neither matched, so Article V would silently
 * render blank. Per instruction, the template is not touched to add
 * aliases — this mapping is the fix, and it lives in exactly one place.
 *
 * "Backdated" is accepted here as an identity passthrough only for
 * forward-compatibility with the template's own vocabulary — the current
 * intake form has no UI path that produces it (only two options are
 * offered: "Immediately" and "Future Date"). No funnel value maps to it
 * today; do not assume it is reachable end-to-end.
 */
const EFFECTIVE_DATE_OPTION_MAP: Record<string, TemplateEffectiveDateOption> = {
  "Immediately": "Immediate",
  "Future Date": "Future",
  // Identity passthrough, in case a caller ever sends an
  // already-canonical value directly.
  "Immediate": "Immediate",
  "Future": "Future",
  "Backdated": "Backdated",
};

export function mapEffectiveDateOption(raw: string): TemplateEffectiveDateOption {
  const mapped = EFFECTIVE_DATE_OPTION_MAP[raw];
  if (!mapped) {
    throw new Error(`Unrecognized effective_date_option: "${raw}"`);
  }
  return mapped;
}

/**
 * Florida's own public filing rule (F.S. 605.0212 / Sunbiz guidance): an
 * LLC's first Annual Report is due between January 1 and May 1 of the
 * calendar year AFTER the year its Articles of Organization become
 * effective.
 *
 * This is NOT a rule "already documented" anywhere in this project —
 * DECISIONS.md, GAPS.md-equivalent, and MASTER_PROJECT_RULES.md were all
 * grepped for "annual report" and none of them state this computation.
 * It is Florida's public statutory rule, reproduced here because nothing
 * internal specifies it. Confirm with the client/an accountant before
 * relying on this for a real filing.
 *
 * Only meaningful when effective_date_option resolves to "Future" or
 * "Backdated" — the template does not render this value at all for
 * "Immediate" (that branch has no effective date yet to compute from).
 */
export function computeAnnualReportDueDate(effectiveDateISO: string): string {
  const effective = new Date(`${effectiveDateISO}T00:00:00Z`);
  if (Number.isNaN(effective.getTime())) {
    throw new Error(`Invalid effective_date: "${effectiveDateISO}"`);
  }
  const dueYear = effective.getUTCFullYear() + 1;
  return `May 1, ${dueYear}`;
}
