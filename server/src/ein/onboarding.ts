import { BUNDLES_EIN, DIY_BASE_OFFER_CODE, EIN_OFFER_CODES } from "../offers/einBundleRule.js";

/**
 * ST17 (A6Y2-T144 item 6): EIN onboarding through the Zoho CRM Portal.
 *
 * Owner decision (25 Nov 2026): the passport photo page is collected through the
 * Zoho CRM Portal and stored only in Zoho CRM, on the customer's Deal. This server
 * never receives or stores it. Here: which package an order is, whether it includes
 * the EIN, and the configuration everything EIN-portal reads. Pure functions only.
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

/** Offer codes whose order carries the EIN filing (bought alone or in a bundle). */
export const EIN_CARRYING_CODES: readonly string[] = [...BUNDLES_EIN, ...EIN_OFFER_CODES];

/** True when what the session paid for (or holds a card for) includes the EIN. */
export function einIncluded(codes: string[]): boolean {
  return codes.some((c) => EIN_CARRYING_CODES.includes(c));
}

// ── Configuration ─────────────────────────────────────────────────────────

export interface EinPortalConfig {
  /** Owner switch. Off: no portal link anywhere, no invites, no Zoho writes. */
  enabled: boolean;
  /** The Zoho CRM Portal sign-in URL (https only). Empty until the portal exists. */
  portalUrl: string;
  /** Zoho portal user type (user group) id for the customers' group. Empty: no invites. */
  portalUserTypeId: string;
  /** Deal field API names (created in Zoho 25 Nov 2026; overridable by env). */
  docsReceivedField: string;
  docsReceivedAtField: string;
  passportField: string;
  einIssuedDateField: string;
  /** Deal Stage values that count as cancelled for the purge. */
  purgeStages: string[];
  /** Deal Payment_Status values that count as refunded for the purge. */
  purgePaymentStatuses: string[];
  /** Days after EIN issue, or after cancellation/refund, before the passport is cleared. */
  purgeDays: number;
  /** Only orders held or paid within this many days are invited (no old-order backfill). */
  inviteLookbackDays: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** An absolute https URL without credentials, or "" (never relative or javascript:). */
export function safeHttpsUrl(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : "";
  } catch {
    return "";
  }
}

function list(value: string | undefined, fallback: string): string[] {
  const items = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : fallback.split(",");
}

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * A Zoho field API name. A missing, empty or malformed value falls back to the
 * default (the field created in Zoho), so a typo can never silently switch the
 * sweep or the purge off; einPortalConfigIssues reports it.
 */
function apiName(value: string | undefined, fallback: string): string {
  const v = (value ?? "").trim();
  return FIELD_NAME.test(v) ? v : fallback;
}

const FIELD_DEFAULTS = {
  EIN_DOCS_RECEIVED_FIELD: "EIN_Docs_Received",
  EIN_DOCS_RECEIVED_AT_FIELD: "EIN_Docs_Received_At",
  EIN_PASSPORT_FIELD: "Passport_Photo_Page",
  EIN_ISSUED_DATE_FIELD: "EIN_Issued_Date",
} as const;

export function einPortalConfig(env: NodeJS.ProcessEnv = process.env): EinPortalConfig {
  const userType = (env.EIN_PORTAL_USER_TYPE_ID ?? "").trim();
  return {
    enabled: env.EIN_ONBOARDING_ENABLED === "true",
    portalUrl: safeHttpsUrl(env.EIN_PORTAL_URL),
    portalUserTypeId: /^\d+$/.test(userType) ? userType : "",
    docsReceivedField: apiName(env.EIN_DOCS_RECEIVED_FIELD, FIELD_DEFAULTS.EIN_DOCS_RECEIVED_FIELD),
    docsReceivedAtField: apiName(env.EIN_DOCS_RECEIVED_AT_FIELD, FIELD_DEFAULTS.EIN_DOCS_RECEIVED_AT_FIELD),
    passportField: apiName(env.EIN_PASSPORT_FIELD, FIELD_DEFAULTS.EIN_PASSPORT_FIELD),
    einIssuedDateField: apiName(env.EIN_ISSUED_DATE_FIELD, FIELD_DEFAULTS.EIN_ISSUED_DATE_FIELD),
    purgeStages: list(env.EIN_PURGE_STAGES, "Cancelled"),
    purgePaymentStatuses: list(env.EIN_PURGE_PAYMENT_STATUSES, "Refunded"),
    purgeDays: positiveInt(env.EIN_PASSPORT_PURGE_DAYS, 30),
    inviteLookbackDays: positiveInt(env.EIN_PORTAL_INVITE_LOOKBACK_DAYS, 30),
  };
}

/**
 * Settings that are set but unusable, for the startup check (index.ts). Field names
 * and numbers fall back to their defaults; a bad portal URL or user type id leaves
 * the link or the invites off.
 */
export function einPortalConfigIssues(env: NodeJS.ProcessEnv = process.env): string[] {
  const issues: string[] = [];
  const set = (name: string) => env[name] !== undefined && env[name] !== "";
  for (const [name, fallback] of Object.entries(FIELD_DEFAULTS)) {
    if (set(name) && !FIELD_NAME.test((env[name] as string).trim())) issues.push(`${name} is not a Zoho API name; using ${fallback}`);
  }
  if (!set("EIN_PORTAL_URL")) issues.push("EIN_PORTAL_URL is not set: no portal link, no invites");
  else if (!safeHttpsUrl(env.EIN_PORTAL_URL)) issues.push("EIN_PORTAL_URL is not an https URL: no portal link, no invites");
  if (!set("EIN_PORTAL_USER_TYPE_ID")) issues.push("EIN_PORTAL_USER_TYPE_ID is not set: no invites");
  else if (!/^\d+$/.test((env.EIN_PORTAL_USER_TYPE_ID as string).trim())) issues.push("EIN_PORTAL_USER_TYPE_ID is not numeric: no invites");
  for (const name of ["EIN_PASSPORT_PURGE_DAYS", "EIN_PORTAL_INVITE_LOOKBACK_DAYS"]) {
    if (set(name) && !(Number.isInteger(Number(env[name])) && Number(env[name]) > 0)) issues.push(`${name} is not a positive whole number; using 30`);
  }
  return issues;
}

/** The portal link customers may be shown: only when switched on and the URL is set. */
export function portalUrlFor(cfg: EinPortalConfig): string | null {
  return cfg.enabled && cfg.portalUrl ? cfg.portalUrl : null;
}

/** Invites go out only when switched on, the portal URL is set and the user type is known. */
export function invitesEnabled(cfg: EinPortalConfig): boolean {
  return portalUrlFor(cfg) !== null && cfg.portalUserTypeId !== "";
}

/** The sweep runs whenever switched on (the field names always have a value). */
export function sweepEnabled(cfg: EinPortalConfig): boolean {
  return cfg.enabled && cfg.passportField !== "";
}
