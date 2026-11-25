/**
 * T144 Dispatch 11: IRS Form SS-4 values for a Florida LLC.
 *
 * Builds the field values of the official fillable Form SS-4 (Rev. December
 * 2025, assets/irs/fss4.pdf) from the filing record plus the answers the
 * filing interview does not collect. render_pdf.py POST /generate-ss4 fills
 * the form with them. Nothing calls this automatically: the EIN step is run by
 * the team after the Articles are filed, and the form is never faxed by code.
 *
 * Same contract as the Articles and the Operating Agreement: a missing value
 * comes back as a named gap. Nothing is guessed.
 *
 * Field names are the form's own AcroForm names (prefix
 * "topmostSubform[0].Page1[0]." removed). They change when the IRS revises
 * the form: re-check FIELD and the checkbox states against a new download.
 */
import type { FilingSessionRecord } from "../pdf/types.js";

export const SS4_FORM_REVISION = "Rev. December 2025";

/** Line 10's "specify type" box is about 57pt wide. */
export const LINE10_MAX = 14;

/** Line 9a write-in for a foreign-owned single-member LLC, word for word from the SS-4 instructions. */
export const LINE9A_FOREIGN_OWNED_DE = "Foreign-owned U.S. disregarded entity-Form 5472";
/** The 9a "Other (specify)" box is 180pt wide at a fixed 8pt; the official phrase needs about 6.5pt. */
const LINE9A_FONT_SIZE = 6.5;

/** Text fields, by SS-4 line. */
export const FIELD = {
  line1LegalName: "f1_2[0]",
  line2TradeName: "f1_3[0]",
  line4aMailingStreet: "Line4ReadOrder[0].f1_5[0]",
  line4bMailingCityStateZip: "Line4ReadOrder[0].f1_6[0]",
  line5aStreet: "f1_7[0]",
  line5bCityStateZip: "f1_8[0]",
  line6CountyState: "f1_9[0]",
  line7aResponsibleParty: "f1_10[0]",
  line7bSsnItin: "f1_11[0]",
  line8bMemberCount: "f1_12[0]",
  line9aOtherSpecify: "f1_19[0]",
  line10StartedNewBusinessType: "f1_25[0]",
  line11DateStarted: "f1_31[0]",
  line12ClosingMonth: "f1_32[0]",
  line13Agricultural: "f1_33[0]",
  line13Household: "f1_34[0]",
  line13Other: "f1_35[0]",
  line15FirstWages: "f1_36[0]",
  line16OtherSpecify: "f1_37[0]",
  line17Merchandise: "f1_38[0]",
  designeeName: "f1_40[0]",
  designeePhone: "f1_41[0]",
  designeeAddress: "f1_42[0]",
  designeeFax: "f1_43[0]",
  applicantNameTitle: "f1_44[0]",
  applicantPhone: "f1_45[0]",
  applicantFax: "f1_46[0]",
} as const;

/** Checkbox widgets: field name and the "on" state the form defines for it. */
export const CHECK = {
  line8aLlcYes: { field: "c1_1[0]", on: "/1" },
  line8cOrganizedInUsYes: { field: "c1_2[0]", on: "/1" },
  line9aPartnership: { field: "c1_3[2]", on: "/2" },
  line9aOther: { field: "c1_3[15]", on: "/7" },
  line10StartedNewBusiness: { field: "c1_4[0]", on: "/1" },
  line16Other: { field: "c1_6[11]", on: "/9" },
  line18AppliedBeforeNo: { field: "c1_7[1]", on: "/2" },
} as const;

export interface Ss4Designee {
  name?: string;
  phone?: string;
  fax?: string;
  /** Street, city, state and ZIP on one line. */
  address?: string;
}

/** Answers the filing interview does not collect (EIN step, after filing). */
export interface Ss4Inputs {
  /** Line 7a: the individual who owns or controls the LLC (never a nominee). Required: not taken from the Articles signer. */
  responsible_party_name?: string;
  /**
   * Line 7b. A foreign founder with no SSN or ITIN gets "Foreign" (Dispatch 11,
   * as the international SS-4 is filed). A U.S. number is never accepted here:
   * this tool must not hold one.
   */
  responsible_party_has_ssn_or_itin?: boolean;
  /** Line 8b: number of LLC members. */
  member_count?: number;
  /** Line 6, e.g. "Miami-Dade County, Florida". */
  county_and_state?: string;
  /** Line 10 "Started new business (specify type)", e.g. "Consulting". */
  business_type?: string;
  /** Line 11, YYYY-MM-DD. Defaults to the effective date, else the filing date. */
  date_started?: string;
  /** Line 12. Defaults to December. */
  closing_month?: string;
  /** Line 16 "Other (specify)". */
  principal_activity?: string;
  /** Line 17. */
  principal_products_or_services?: string;
  /** The responsible party's title for the signature line, e.g. "Member". */
  applicant_title?: string;
  applicant_phone?: string;
  applicant_fax?: string;
  /** Section "Third Party Designee". All four are required. */
  designee?: Ss4Designee;
}

export interface Ss4Filed {
  /** Date the Division of Corporations filed the Articles, YYYY-MM-DD. */
  filing_date?: string;
}

export type Ss4Result =
  | {
      ok: true;
      /**
       * Values for render_pdf.py: text by field name, checkboxes as [field, on-state],
       * and a smaller font for a field whose text would not fit at the form's own size.
       */
      values: { text: Record<string, string>; check: Array<[string, string]>; font_size?: Record<string, number> };
      /** The same answers by SS-4 line, for the operator and the audit log. */
      summary: Record<string, string>;
    }
  | { ok: false; missingFields: string[] };

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** "2026-12-10" -> "12/10/2026" (the form's MM/DD/YYYY), or null. */
export function ss4Date(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

/**
 * Splits a canonical U.S. address ("100 S Biscayne Blvd, Suite 300, Miami, FL, 33131")
 * into the form's street line and "City, ST ZIP" line. Returns null when the
 * address does not end in city, state and a 5- or 9-digit ZIP (e.g. foreign).
 */
const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

/** "FL" or "Florida" (any case) -> "FL"; anything else -> null. */
function stateCode(value: string): string | null {
  const v = value.trim();
  if (/^[A-Za-z]{2}$/.test(v) && US_STATES[v.toUpperCase()]) return v.toUpperCase();
  const hit = Object.entries(US_STATES).find(([, name]) => name.toLowerCase() === v.toLowerCase());
  return hit ? hit[0] : null;
}

/**
 * Splits a canonical U.S. address into the form's street line and "City, ST ZIP"
 * line. Accepts the website's "street, [unit,] city, ST, ZIP" and the older
 * "street, city, ST ZIP", with an optional trailing "USA" / "United States".
 * The state must be a real U.S. state code or name. Anything else (foreign
 * addresses, a missing city) returns null, which the builder reports as a gap.
 */
export function splitUsAddress(address: string): { street: string; cityStateZip: string } | null {
  let parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length && /^(usa|us|united states( of america)?)$/i.test(parts[parts.length - 1])) parts = parts.slice(0, -1);
  let zip: string, state: string | null, city: string, street: string[];
  const last = parts[parts.length - 1] ?? "";
  const combined = /^([A-Za-z ]+?)\s+(\d{5}(?:-\d{4})?)$/.exec(last);
  if (/^\d{5}(-\d{4})?$/.test(last)) {
    if (parts.length < 4) return null;
    zip = last;
    state = stateCode(parts[parts.length - 2]);
    city = parts[parts.length - 3];
    street = parts.slice(0, -3);
  } else if (combined) {
    if (parts.length < 3) return null;
    zip = combined[2];
    state = stateCode(combined[1]);
    city = parts[parts.length - 2];
    street = parts.slice(0, -2);
  } else {
    return null;
  }
  if (!state || !city || street.length === 0 || /\d{5}/.test(city)) return null;
  return { street: street.join(", "), cityStateZip: `${city}, ${state} ${zip}` };
}

export function buildSs4Values(
  filingData: Partial<FilingSessionRecord>,
  filed: Ss4Filed,
  inputs: Ss4Inputs = {}
): Ss4Result {
  const missing: string[] = [];

  // Line 1: Sunbiz records LLC names in ALL CAPS.
  const legalName = str(filingData.llc_name).toUpperCase();
  if (!legalName) missing.push("llc_name");

  // Lines 4a/4b mailing, 5a/5b street (only when different).
  const mailing = splitUsAddress(str(filingData.mailing_address));
  if (!mailing) missing.push("mailing_address (a U.S. street, city, state and ZIP for lines 4a-4b)");
  const principal = splitUsAddress(str(filingData.principal_address));
  if (!principal) missing.push("principal_address (a U.S. street, city, state and ZIP for lines 5a-5b)");
  const streetDiffers =
    mailing && principal && (mailing.street !== principal.street || mailing.cityStateZip !== principal.cityStateZip);

  const county = str(inputs.county_and_state);
  if (!county) missing.push("county_and_state (line 6, e.g. \"Miami-Dade County, Florida\")");

  // Line 7: responsible party. Always given explicitly: whoever signed the
  // Articles may be a representative, and the IRS rejects a nominee here.
  const responsible = str(inputs.responsible_party_name);
  if (!responsible) missing.push("responsible_party_name (line 7a, the owner who controls the LLC)");
  if (inputs.responsible_party_has_ssn_or_itin === true) {
    missing.push("responsible party has an SSN or ITIN: apply online or enter it by hand; this tool never holds U.S. tax numbers");
  } else if (inputs.responsible_party_has_ssn_or_itin !== false) {
    missing.push("responsible_party_has_ssn_or_itin (must be false: this form is for a founder with no SSN or ITIN)");
  }

  // Line 8: an LLC organized in the United States (Florida).
  const members = inputs.member_count;
  if (typeof members !== "number" || !Number.isInteger(members) || members < 1) {
    missing.push("member_count (line 8b, whole number of 1 or more)");
  }
  const single = members === 1;

  // Line 10/11.
  const businessType = str(inputs.business_type);
  if (!businessType) missing.push("business_type (line 10, \"Started new business (specify type)\")");
  else if (businessType.length > LINE10_MAX) missing.push(`business_type (line 10 has room for ${LINE10_MAX} characters, e.g. "Consulting")`);
  const startIso =
    str(inputs.date_started) ||
    (filingData.effective_date_option && filingData.effective_date_option !== "Immediate" ? str(filingData.effective_date) : "") ||
    str(filed.filing_date);
  const started = ss4Date(startIso);
  if (!started) missing.push("date_started (line 11, YYYY-MM-DD; or the filing date from proof of filing)");

  const closingMonth = str(inputs.closing_month) || "December";
  if (!MONTHS.includes(closingMonth)) missing.push("closing_month (line 12, a month name)");

  const activity = str(inputs.principal_activity);
  if (!activity) missing.push("principal_activity (line 16, \"Other (specify)\")");
  const products = str(inputs.principal_products_or_services);
  if (!products) missing.push("principal_products_or_services (line 17)");

  const title = str(inputs.applicant_title);
  if (!title) missing.push("applicant_title (signature line, e.g. \"Member\")");

  const d = inputs.designee ?? {};
  for (const k of ["name", "phone", "fax", "address"] as const) {
    if (!str(d[k])) missing.push(`designee.${k} (Third Party Designee)`);
  }

  if (missing.length > 0) return { ok: false, missingFields: missing };

  // Line 9a. A foreign-owned single-member LLC that needs the EIN to file Form
  // 5472: check "Other" and write exactly "Foreign-owned U.S. disregarded
  // entity-Form 5472" (Instructions for Form SS-4, Rev. 12/2025, line 9a,
  // Disregarded entities). The IRS uses the marker to route the EIN for 5472
  // filing. Two or more members default to a partnership.
  const entityOther = single ? LINE9A_FOREIGN_OWNED_DE : "";

  const text: Record<string, string> = {
    [FIELD.line1LegalName]: legalName,
    [FIELD.line4aMailingStreet]: mailing!.street,
    [FIELD.line4bMailingCityStateZip]: mailing!.cityStateZip,
    ...(streetDiffers ? { [FIELD.line5aStreet]: principal!.street, [FIELD.line5bCityStateZip]: principal!.cityStateZip } : {}),
    [FIELD.line6CountyState]: county,
    [FIELD.line7aResponsibleParty]: responsible,
    [FIELD.line7bSsnItin]: "Foreign",
    [FIELD.line8bMemberCount]: String(members),
    ...(single ? { [FIELD.line9aOtherSpecify]: entityOther } : {}),
    [FIELD.line10StartedNewBusinessType]: businessType,
    [FIELD.line11DateStarted]: started!,
    [FIELD.line12ClosingMonth]: closingMonth,
    [FIELD.line13Agricultural]: "0",
    [FIELD.line13Household]: "0",
    [FIELD.line13Other]: "0",
    // Line 15: no employees are expected (line 13 is 0/0/0), so "N/A" per the SS-4 instructions.
    [FIELD.line15FirstWages]: "N/A",
    [FIELD.line16OtherSpecify]: activity,
    [FIELD.line17Merchandise]: products,
    [FIELD.designeeName]: str(d.name),
    [FIELD.designeePhone]: str(d.phone),
    [FIELD.designeeAddress]: str(d.address),
    [FIELD.designeeFax]: str(d.fax),
    [FIELD.applicantNameTitle]: `${responsible}, ${title}`,
    ...(str(inputs.applicant_phone) ? { [FIELD.applicantPhone]: str(inputs.applicant_phone) } : {}),
    ...(str(inputs.applicant_fax) ? { [FIELD.applicantFax]: str(inputs.applicant_fax) } : {}),
  };

  const checks = [
    CHECK.line8aLlcYes,
    CHECK.line8cOrganizedInUsYes,
    single ? CHECK.line9aOther : CHECK.line9aPartnership,
    CHECK.line10StartedNewBusiness,
    CHECK.line16Other,
    CHECK.line18AppliedBeforeNo,
  ];

  const summary: Record<string, string> = {
    "1 Legal name": legalName,
    "4a Mailing address": mailing!.street,
    "4b City, state, ZIP": mailing!.cityStateZip,
    "5a Street address": streetDiffers ? principal!.street : "(same as mailing)",
    "5b City, state, ZIP": streetDiffers ? principal!.cityStateZip : "(same as mailing)",
    "6 County and state": county,
    "7a Responsible party": responsible,
    "7b SSN, ITIN, or EIN": "Foreign",
    "8a LLC": "Yes",
    "8b Members": String(members),
    "8c Organized in the United States": "Yes",
    "9a Type of entity": single ? `Other: ${entityOther}` : "Partnership",
    "10 Reason for applying": `Started new business: ${businessType}`,
    "11 Date business started": started!,
    "12 Closing month": closingMonth,
    "13 Employees": "0 / 0 / 0",
    "15 First date wages paid": "N/A",
    "16 Principal activity": `Other: ${activity}`,
    "17 Products or services": products,
    "18 Applied for an EIN before": "No",
    "Third Party Designee": `${str(d.name)}, ${str(d.address)}, phone ${str(d.phone)}, fax ${str(d.fax)}`,
    "Signature line": `${responsible}, ${title} (signed by the applicant; left blank)`,
  };

  return {
    ok: true,
    values: {
      text,
      check: checks.map((c) => [c.field, c.on]),
      ...(single ? { font_size: { [FIELD.line9aOtherSpecify]: LINE9A_FONT_SIZE } } : {}),
    },
    summary,
  };
}
