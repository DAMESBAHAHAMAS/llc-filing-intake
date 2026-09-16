import type { AuthorizedPersonInput, FilingSessionRecord } from "../../src/pdf/types.js";

/**
 * Deterministic test fixtures for the PDF context composer. No live
 * `filing_sessions` row exists with this shape yet (see types.ts) — this
 * is the stand-in "filing session data" the task asked for.
 */

const managerA: AuthorizedPersonInput = {
  name: "Alicia Manager",
  street: "10 Business Blvd",
  city: "Fort Lauderdale",
  state: "FL",
  zip: "33301",
  article_iv_title: "MGR",
};
const managerB: AuthorizedPersonInput = {
  name: "Brian Manager",
  street: "11 Business Blvd",
  city: "Fort Lauderdale",
  state: "FL",
  zip: "33301",
  article_iv_title: "MGR",
};
// Overflow persons (5th+). Overflow3 is deliberately AMBR while the
// primary array and the rest of the overflow are MGR — a Member-Managed
// entry mixed into a Manager-Managed filing's overflow, which the real
// UI can produce if a client switches management_structure mid-form
// without the overflow array being cleared (see report — flagged as a
// separate, narrower bug, not fixed here). This is exactly the case that
// proves article_iv_title is read per-record, not inferred from
// management_structure or array position.
const overflow1: AuthorizedPersonInput = {
  name: "Carlos Overflow",
  street: "12 Business Blvd",
  city: "Fort Lauderdale",
  state: "FL",
  zip: "33301",
  article_iv_title: "MGR",
};
const overflow2: AuthorizedPersonInput = {
  name: "Dana Overflow",
  street: "13 Business Blvd",
  city: "Fort Lauderdale",
  state: "FL",
  zip: "33301",
  article_iv_title: "MGR",
};
const overflow3: AuthorizedPersonInput = {
  name: "Erin Overflow",
  street: "14 Business Blvd",
  city: "Fort Lauderdale",
  state: "FL",
  zip: "33301",
  article_iv_title: "AMBR",
};

/**
 * The base fixture: LLC name with designator, principal address,
 * different mailing address, Damian as registered agent, 5 authorized
 * persons mixing MGR/AMBR (2 primary managers + 3 overflow — see above),
 * a future effective date, and other provisions text.
 */
export const baseFixture: FilingSessionRecord = {
  llc_name: "Sunrise Ventures LLC",

  principal_street: "400 S Andrews Ave",
  principal_city: "Fort Lauderdale",
  principal_state: "FL",
  principal_zip: "33301",
  principal_country: "United States",

  mailing_same: "No",
  mailing_street: "PO Box 1234",
  mailing_city: "Miami",
  mailing_state: "FL",
  mailing_zip: "33101",
  mailing_country: "United States",

  agent_choice: "damian",
  agent_name: "Damian Knowles",
  agent_street: "3850 South University Drive",
  agent_unit: "Unit #291921",
  agent_city: "Davie",
  agent_state: "Florida",
  agent_zip: "33329",

  management_structure: "Manager-Managed",
  members: [],
  managers: [managerA, managerB],
  additional_authorized_persons: [overflow1, overflow2, overflow3],

  effective_date_option: "Future Date",
  effective_date: "2026-09-15",

  other_provisions: "The Company shall indemnify its Managers to the fullest extent permitted by law.",

  signer_name: "Damian Knowles",
  representative_role: "Organizer",
};

/** B: customer-provided registered agent, everything else same as base. */
export const ownAgentFixture: FilingSessionRecord = {
  ...baseFixture,
  agent_choice: "own",
  agent_name: "Jordan Smith",
  agent_street: "500 Ocean Drive",
  agent_unit: "",
  agent_city: "Miami Beach",
  agent_state: "Florida",
  agent_zip: "33139",
};

/** C: mailing address same as principal. */
export const mailingSameFixture: FilingSessionRecord = {
  ...baseFixture,
  mailing_same: "Yes",
  mailing_street: undefined,
  mailing_city: undefined,
  mailing_state: undefined,
  mailing_zip: undefined,
  mailing_country: undefined,
};

/** E: immediate effective date — no effective_date, no annual_report_due_date. */
export const immediateEffectiveFixture: FilingSessionRecord = {
  ...baseFixture,
  effective_date_option: "Immediately",
  effective_date: undefined,
};

/** F: future effective date is the base fixture itself. Named alias for clarity. */
export const futureEffectiveFixture: FilingSessionRecord = baseFixture;

/** Member-Managed variant, to exercise the `members` primary-array path. */
export const memberManagedFixture: FilingSessionRecord = {
  ...baseFixture,
  management_structure: "Member-Managed",
  members: [
    { ...managerA, article_iv_title: "AMBR" },
    { ...managerB, article_iv_title: "AMBR" },
  ],
  managers: [],
  additional_authorized_persons: [
    { ...overflow1, article_iv_title: "AMBR" },
    { ...overflow2, article_iv_title: "AMBR" },
    { ...overflow3, article_iv_title: "AMBR" },
  ],
};
