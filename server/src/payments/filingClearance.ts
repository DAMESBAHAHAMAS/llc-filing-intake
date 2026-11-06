import { holdDetails, type StripePaymentIntent } from "../stripe/restClient.js";

/**
 * Whether an order may go to Florida (Damian's controls, 6 Nov 2026). Damian
 * pays the state, so the money must be secured first. These are pure rules,
 * read from Stripe's own PaymentIntent, not from the order row.
 */

/** Enough hold left to file and get Florida's answer. */
export const MIN_HOLD_HOURS_TO_FILE = 24;
/** An approval goes stale. The hold it read can change in a day. */
export const APPROVAL_VALID_HOURS = 24;

export type Clearance =
  | { cleared: true; captureBefore: Date; extended: boolean }
  | { cleared: false; code: string; detail: string };

export function clearanceFor(pi: StripePaymentIntent, totalCents: number, now: Date): Clearance {
  if (pi.status !== "requires_capture") {
    return { cleared: false, code: "hold_not_capturable", detail: `the payment is ${pi.status}, not a capturable hold` };
  }
  if (pi.amount_capturable < totalCents) {
    return { cleared: false, code: "hold_amount_short", detail: `only ${pi.amount_capturable} is capturable of ${totalCents}` };
  }
  const { captureBefore, extended } = holdDetails(pi);
  if (!captureBefore) return { cleared: false, code: "hold_expiry_unknown", detail: "Stripe reports no capture deadline for this hold" };
  if (captureBefore.getTime() - now.getTime() < MIN_HOLD_HOURS_TO_FILE * 3600 * 1000) {
    return { cleared: false, code: "hold_expiring", detail: `the hold ends ${captureBefore.toISOString()}; replace it before filing` };
  }
  return { cleared: true, captureBefore, extended: Boolean(extended) };
}

export function approvalCurrent(approvedAt: Date | string | null | undefined, now: Date): boolean {
  if (!approvedAt) return false;
  return now.getTime() - new Date(approvedAt).getTime() < APPROVAL_VALID_HOURS * 3600 * 1000;
}

const LLC_SUFFIX = /\b(L L C|L C|LLC|LC|LTD LIABILITY CO|LTD LIABILITY COMPANY|LIMITED LIABILITY CO|LIMITED LIABILITY COMPANY|LIMITED COMPANY)\s*$/;

/** One LLC name, however it was punctuated. Null when there is no name. */
export function entityNameKey(value: string | null | undefined): string | null {
  const key = (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/['\u2019.]/g, (mark) => (mark === "." ? " " : ""))
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(LLC_SUFFIX, "")
    .trim();
  return key || null;
}

/** For comparing an LLC name typed from Sunbiz with the name on the order. */
export function sameEntityName(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = entityNameKey(a);
  return left !== null && left === entityNameKey(b);
}
