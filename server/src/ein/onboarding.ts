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
  /** Deal field API names. Only docsReceivedField exists in Zoho today. */
  docsReceivedField: string;
  docsReceivedAtField: string;
  passportField: string;
  einIssuedDateField: string;
  /** Deal stages that count as cancelled for the purge (Zoho Stage values). */
  purgeStages: string[];
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

/** A Zoho field API name, or "" (letters, digits, underscores only). */
function apiName(value: string | undefined, fallback = ""): string {
  const v = (value ?? fallback).trim();
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(v) ? v : "";
}

export function einPortalConfig(env: NodeJS.ProcessEnv = process.env): EinPortalConfig {
  const userType = (env.EIN_PORTAL_USER_TYPE_ID ?? "").trim();
  return {
    enabled: env.EIN_ONBOARDING_ENABLED === "true",
    portalUrl: safeHttpsUrl(env.EIN_PORTAL_URL),
    portalUserTypeId: /^\d+$/.test(userType) ? userType : "",
    docsReceivedField: apiName(env.EIN_DOCS_RECEIVED_FIELD, "EIN_Docs_Received"),
    docsReceivedAtField: apiName(env.EIN_DOCS_RECEIVED_AT_FIELD),
    passportField: apiName(env.EIN_PASSPORT_FIELD),
    einIssuedDateField: apiName(env.EIN_ISSUED_DATE_FIELD),
    purgeStages: (env.EIN_PURGE_STAGES ?? "Cancelled")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    purgeDays: positiveInt(env.EIN_PASSPORT_PURGE_DAYS, 30),
    inviteLookbackDays: positiveInt(env.EIN_PORTAL_INVITE_LOOKBACK_DAYS, 30),
  };
}

/** The portal link customers may be shown: only when switched on and the URL is set. */
export function portalUrlFor(cfg: EinPortalConfig): string | null {
  return cfg.enabled && cfg.portalUrl ? cfg.portalUrl : null;
}

/** Invites go out only when switched on, the portal URL is set and the user type is known. */
export function invitesEnabled(cfg: EinPortalConfig): boolean {
  return portalUrlFor(cfg) !== null && cfg.portalUserTypeId !== "";
}

/** The sweep needs the passport field; the other fields are used when configured. */
export function sweepEnabled(cfg: EinPortalConfig): boolean {
  return cfg.enabled && cfg.passportField !== "";
}
