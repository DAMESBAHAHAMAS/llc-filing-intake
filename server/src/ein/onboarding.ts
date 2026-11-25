import { createHash } from "node:crypto";
import { BUNDLES_EIN, DIY_BASE_OFFER_CODE, EIN_OFFER_CODES } from "../offers/einBundleRule.js";
import { signEinOnboardingToken } from "./onboardingToken.js";

/**
 * ST17 (A6Y2-T144 item 6): rules for the tokenized EIN / Form SS-4 onboarding.
 * Pure functions only; the route (routes/einOnboarding.ts) does the I/O.
 */

// ── Package and eligibility ───────────────────────────────────────────────

export type OrderPackage = "DIY" | "BANK_READY" | "PREMIUM";

/**
 * The package a filing session bought, from the offer codes on its authorized or
 * paid orders (offers/einUpsell.ts orderedOfferCodes). Null when none.
 */
export function packageFromCodes(codes: string[]): OrderPackage | null {
  if (codes.includes("PREMIUM")) return "PREMIUM";
  if (codes.includes("FASTTRACK")) return "BANK_READY";
  if (codes.includes(DIY_BASE_OFFER_CODE)) return "DIY";
  return null;
}

/** True when what the session paid for (or holds a card for) includes the EIN. */
export function einIncluded(codes: string[]): boolean {
  return codes.some((c) => BUNDLES_EIN.includes(c) || EIN_OFFER_CODES.includes(c));
}

// ── Configuration ─────────────────────────────────────────────────────────

export interface EinOnboardingConfig {
  /** Owner switch: the form accepts nothing until this is true. */
  enabled: boolean;
  /** HMAC secret for link tokens. */
  tokenSecret: string;
  /** Owner decision pending: whether the signed token is required (default yes). */
  requireToken: boolean;
  /** Zoho Deal field API name for "EIN Docs Received"; empty until an admin creates it. */
  einDocsReceivedField: string;
  frontendBaseUrl: string;
}

export function einOnboardingConfig(env: NodeJS.ProcessEnv = process.env): EinOnboardingConfig {
  return {
    enabled: env.EIN_ONBOARDING_ENABLED === "true",
    tokenSecret: env.EIN_ONBOARDING_TOKEN_SECRET ?? "",
    requireToken: env.EIN_ONBOARDING_REQUIRE_TOKEN !== "false",
    einDocsReceivedField: (env.EIN_DOCS_RECEIVED_FIELD ?? "").trim(),
    frontendBaseUrl: (env.FRONTEND_BASE_URL ?? "").replace(/\/$/, ""),
  };
}

/** The form is open only when switched on and, if tokens are required, a secret exists. */
export function onboardingOpen(cfg: EinOnboardingConfig): boolean {
  return cfg.enabled && (!cfg.requireToken || cfg.tokenSecret.length >= 32);
}

/** Token for the success page and the confirmation email, or null when the form is not open. */
export function onboardingTokenFor(cfg: EinOnboardingConfig, filingSessionId: string, nowSeconds?: number): string | null {
  if (!onboardingOpen(cfg) || !cfg.tokenSecret) return null;
  return signEinOnboardingToken(cfg.tokenSecret, filingSessionId, nowSeconds);
}

/**
 * The magic link for the confirmation email, or null when the form is not open. The
 * token goes in the fragment (#t=…): browsers never send a fragment to a server, and
 * Google Analytics leaves it out of page_location, so it stays out of logs and analytics.
 */
export function onboardingUrlFor(cfg: EinOnboardingConfig, filingSessionId: string, nowSeconds?: number): string | null {
  if (!onboardingOpen(cfg) || !cfg.frontendBaseUrl) return null;
  const params = new URLSearchParams({ filing_session_id: filingSessionId });
  const token = onboardingTokenFor(cfg, filingSessionId, nowSeconds);
  const hash = token ? `#${new URLSearchParams({ t: token }).toString()}` : "";
  return `${cfg.frontendBaseUrl}/onboarding/ein?${params.toString()}${hash}`;
}

// ── Form SS-4 summary ─────────────────────────────────────────────────────

export interface Ss4SummaryLine {
  line: string;
  label: string;
  value: string;
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * The SS-4 lines we can pre-fill from the filing, for the customer to review. Only
 * facts we hold are shown; the team confirms the rest before filing. The legal
 * name is ALL CAPS, as on Sunbiz.
 */
export function buildSs4Summary(filingData: Record<string, unknown> | null, fallbackName: string | null): Ss4SummaryLine[] {
  const data = filingData ?? {};
  const name = (text(data.llc_name) || text(fallbackName)).toUpperCase();
  const persons = Array.isArray(data.authorized_persons) ? (data.authorized_persons as Array<Record<string, unknown>>) : [];
  const members = persons.filter((p) => text(p.article_iv_title) === "AMBR").length;
  const effective = text(data.effective_date_option) === "Immediate" ? "Date the Articles are filed" : text(data.effective_date);

  const lines: Ss4SummaryLine[] = [
    { line: "1", label: "Legal name of entity", value: name },
    { line: "4a–4b", label: "Mailing address", value: text(data.mailing_address) },
    { line: "5a–5b", label: "Street address", value: text(data.principal_address) },
    { line: "6", label: "State where the business is located", value: "Florida" },
    { line: "7a", label: "Responsible party", value: "From step 1" },
    { line: "7b", label: "SSN, ITIN or EIN", value: "None (foreign individual)" },
    { line: "8a–8c", label: "LLC, number of members, organized in the U.S.", value: members > 0 ? `Yes · ${members} · Yes` : "Yes · Yes" },
    {
      line: "9a",
      label: "Type of entity",
      value: members === 1 ? "Other: Foreign-owned U.S. disregarded entity" : members > 1 ? "Partnership" : "",
    },
    { line: "10", label: "Reason for applying", value: "Started new business" },
    { line: "11", label: "Date business started", value: effective },
    { line: "12", label: "Closing month of accounting year", value: "December" },
  ];
  return lines.filter((l) => l.value !== "");
}

// ── Attestation ───────────────────────────────────────────────────────────

/**
 * DRAFT wording, pending counsel approval (DECISIONS.md 2026-11-22: the SS-4
 * Third-Party Designee authorization needs counsel-approved wording). The form
 * stays closed (EIN_ONBOARDING_ENABLED) until the owner approves the final text;
 * change the version whenever the text changes.
 */
export const ATTESTATION_VERSION = "draft-2026-11-25";

export function attestationText(llcName: string): string {
  return (
    `I confirm that the information I have given is true, correct and complete to the best of my knowledge, ` +
    `and that I do not have a U.S. Social Security Number or Individual Taxpayer Identification Number. ` +
    `I authorize Damian Knowles and his team to prepare and submit IRS Form SS-4 for ${llcName || "my LLC"} ` +
    `on my behalf and to act as the Third-Party Designee named on that form.`
  );
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

// ── Submission validation ─────────────────────────────────────────────────

export const PASSPORT_TYPES = ["image/jpeg", "image/png", "application/pdf"] as const;
export const PASSPORT_MAX_BYTES = 10 * 1024 * 1024;
export const RESPONSIBLE_PARTY_TITLES = ["Member", "Managing Member", "Manager"] as const;

export interface ResponsibleParty {
  full_legal_name: string;
  title: string;
  citizenship_country: string;
  address_street: string;
  address_city: string;
  address_region: string;
  address_postal_code: string;
  address_country: string;
  phone: string;
}

export interface ValidSubmission {
  responsibleParty: ResponsibleParty;
  signatureName: string;
  attestationVersion: string;
  passport: { filename: string; contentType: string; bytes: Buffer };
}

export type SubmissionCheck = { ok: true; value: ValidSubmission } | { ok: false; message: string };

const SSN_LIKE = /\b\d{3}-?\d{2}-?\d{4}\b/;
const MAX_FIELD = 200;

/** File signatures, so a renamed file of another type is refused. */
function sniffType(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return null;
}

const clean = (v: unknown) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");

/**
 * Validates the POST body. Never accepts anything that looks like an SSN or ITIN
 * (postal codes and phone numbers excepted), and checks the passport by its bytes,
 * not just its declared type.
 */
export function validateSubmission(body: unknown): SubmissionCheck {
  const b = (body ?? {}) as Record<string, unknown>;
  const rp = (b.responsible_party ?? {}) as Record<string, unknown>;
  const party: ResponsibleParty = {
    full_legal_name: clean(rp.full_legal_name),
    title: clean(rp.title),
    citizenship_country: clean(rp.citizenship_country),
    address_street: clean(rp.address_street),
    address_city: clean(rp.address_city),
    address_region: clean(rp.address_region),
    address_postal_code: clean(rp.address_postal_code),
    address_country: clean(rp.address_country),
    phone: clean(rp.phone),
  };
  const required: Array<keyof ResponsibleParty> = ["full_legal_name", "title", "citizenship_country", "address_street", "address_city", "address_country"];
  for (const key of required) {
    if (!party[key]) return { ok: false, message: "Please complete every required field." };
  }
  for (const [key, value] of Object.entries(party) as Array<[keyof ResponsibleParty, string]>) {
    if (value.length > MAX_FIELD) return { ok: false, message: "One of your answers is too long." };
    if (key !== "address_postal_code" && key !== "phone" && SSN_LIKE.test(value)) {
      return { ok: false, message: "Do not enter an SSN or ITIN on this page." };
    }
  }
  if (!(RESPONSIBLE_PARTY_TITLES as readonly string[]).includes(party.title)) return { ok: false, message: "Choose your role in the LLC." };
  if (b.no_ssn_confirmed !== true) return { ok: false, message: "Confirm that you do not have an SSN or ITIN." };

  const sig = (b.signature ?? {}) as Record<string, unknown>;
  const signatureName = clean(sig.typed_name);
  if (sig.agreed !== true || !signatureName) return { ok: false, message: "Type your name and tick the box to sign." };
  if (signatureName.toLowerCase() !== party.full_legal_name.toLowerCase()) {
    return { ok: false, message: "Your signature must match your full legal name." };
  }
  const attestationVersion = clean(b.attestation_version);
  if (attestationVersion !== ATTESTATION_VERSION) {
    return { ok: false, message: "This form has been updated. Please reload the page and sign again." };
  }

  const passport = (b.passport ?? {}) as Record<string, unknown>;
  const contentType = clean(passport.content_type);
  const data = typeof passport.data_base64 === "string" ? passport.data_base64 : "";
  if (!(PASSPORT_TYPES as readonly string[]).includes(contentType) || !data) {
    return { ok: false, message: "Upload a JPG, PNG or PDF of your passport photo page." };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return { ok: false, message: "We couldn't read that file. Please choose it again." };
  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0) return { ok: false, message: "That file is empty. Please choose it again." };
  if (bytes.length > PASSPORT_MAX_BYTES) return { ok: false, message: "The passport file is larger than 10 MB." };
  if (sniffType(bytes) !== contentType) return { ok: false, message: "That file is not a JPG, PNG or PDF. Please choose it again." };

  const ext = contentType === "application/pdf" ? "pdf" : contentType === "image/png" ? "png" : "jpg";
  return {
    ok: true,
    value: {
      responsibleParty: party,
      signatureName,
      attestationVersion,
      // The customer's own filename is not kept: it can carry personal data.
      passport: { filename: `passport-photo-page.${ext}`, contentType, bytes },
    },
  };
}
