// Server copy of the website's src/lib/effectiveDate.ts (florida-business-launchpad, ST08).
// No shared package exists between the two repos: keep both in step by hand.
/**
 * ST08: the effective-date window for Article V.
 *
 * Florida allows an LLC's effective date up to 5 business days before, or
 * 90 calendar days after, the date the Division of Corporations files the
 * Articles (s. 605.0207, Florida Statutes). The window is worked out from the
 * date we expect Florida to receive the filing, in Florida (Eastern) time,
 * skipping weekends and Florida state holidays (s. 110.117, F.S.).
 *
 * All dates are calendar dates as "YYYY-MM-DD" strings, so no time zone can
 * shift a day.
 */

export const BUSINESS_DAYS_BEFORE = 5;
export const CALENDAR_DAYS_AFTER = 90;
/** Business days between today and the day we expect Florida to receive the filing. */
export const EXPECTED_RECEIPT_LEAD_BUSINESS_DAYS = 1;

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

function parse(isoDate: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? d : null;
}
const fmt = (d: Date) => iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());

export function addDays(isoDate: string, days: number): string {
  const d = parse(isoDate);
  if (!d) throw new Error(`Invalid date: ${isoDate}`);
  d.setUTCDate(d.getUTCDate() + days);
  return fmt(d);
}

/** nth (1-based) weekday of a month; n = -1 for the last one. 0 = Sunday. */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return iso(year, month, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDay = new Date(Date.UTC(year, month, 0));
  const back = (lastDay.getUTCDay() - weekday + 7) % 7;
  return iso(year, month, lastDay.getUTCDate() - back);
}

/** A fixed-date holiday on a weekend is observed Friday (Saturday) or Monday (Sunday). */
function observed(isoDate: string): string {
  const day = parse(isoDate)!.getUTCDay();
  return day === 6 ? addDays(isoDate, -1) : day === 0 ? addDays(isoDate, 1) : isoDate;
}

/** Florida state paid holidays (s. 110.117, F.S.) for a year, as observed. */
export function floridaStateHolidays(year: number): Set<string> {
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  return new Set([
    observed(iso(year, 1, 1)),        // New Year's Day
    nthWeekday(year, 1, 1, 3),        // Martin Luther King Jr. Day
    nthWeekday(year, 5, 1, -1),       // Memorial Day
    observed(iso(year, 7, 4)),        // Independence Day
    nthWeekday(year, 9, 1, 1),        // Labor Day
    observed(iso(year, 11, 11)),      // Veterans' Day
    thanksgiving,                     // Thanksgiving Day
    addDays(thanksgiving, 1),         // Friday after Thanksgiving
    observed(iso(year, 12, 25)),      // Christmas Day
    observed(iso(year + 1, 1, 1)),    // next New Year's Day, if observed on Dec 31
  ]);
}

export function isBusinessDay(isoDate: string): boolean {
  const d = parse(isoDate);
  if (!d) return false;
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  return !floridaStateHolidays(d.getUTCFullYear()).has(isoDate);
}

/** Moves by n business days (negative = back). n = 0 rolls forward to a business day. */
export function addBusinessDays(isoDate: string, n: number): string {
  let d = isoDate;
  if (n === 0) {
    while (!isBusinessDay(d)) d = addDays(d, 1);
    return d;
  }
  const step = n > 0 ? 1 : -1;
  let left = Math.abs(n);
  while (left > 0) {
    d = addDays(d, step);
    if (isBusinessDay(d)) left--;
  }
  return d;
}

/** Today's date in Florida (America/New_York), whatever the visitor's time zone. */
export function floridaToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now);
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value);
  return iso(get("year"), get("month"), get("day"));
}

export interface EffectiveDateWindow {
  /** The day we expect Florida to receive (file) the Articles. */
  filingDate: string;
  earliest: string;
  latest: string;
}

/** The window around an expected (or, at submission, the actual) filing date. */
export function windowForFilingDate(filingDate: string): EffectiveDateWindow {
  const filed = addBusinessDays(filingDate, 0);
  return {
    filingDate: filed,
    earliest: addBusinessDays(filed, -BUSINESS_DAYS_BEFORE),
    latest: addDays(filed, CALENDAR_DAYS_AFTER),
  };
}

export function effectiveDateWindow(now: Date = new Date()): EffectiveDateWindow {
  return windowForFilingDate(addBusinessDays(floridaToday(now), EXPECTED_RECEIPT_LEAD_BUSINESS_DAYS));
}

export type EffectiveDateCheck =
  | { ok: true; kind: "Future" | "Backdated" | "SameDay" }
  | { ok: false; error: string };

/** Checks a chosen date against the window; the message names the dates in full. */
export function checkEffectiveDate(value: string, w: EffectiveDateWindow): EffectiveDateCheck {
  if (!value.trim()) return { ok: false, error: "Choose a date, or select \"When Florida files my Articles of Organization\"." };
  if (!parse(value)) return { ok: false, error: "Enter a real date." };
  if (value < w.earliest || value > w.latest)
    return { ok: false, error: `Choose a date from ${formatLongDate(w.earliest)} through ${formatLongDate(w.latest)}.` };
  return { ok: true, kind: value < w.filingDate ? "Backdated" : value > w.filingDate ? "Future" : "SameDay" };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-11-25" → "November 25, 2026": no MM/DD vs DD/MM ambiguity. */
export function formatLongDate(isoDate: string): string {
  const d = parse(isoDate);
  if (!d) return isoDate;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/**
 * First annual report: due by May 1 of the year after the calendar year the
 * Articles become effective (s. 605.0212, F.S.).
 */
export function annualReportDueDate(effectiveDate: string): string {
  const d = parse(effectiveDate);
  return d ? formatLongDate(iso(d.getUTCFullYear() + 1, 5, 1)) : "";
}

/**
 * Pre-submission guard (ST08): a chosen effective date must still fit the
 * window around the day the Articles actually go to Florida. Returns a
 * plain-English problem, or null when the date fits or none was chosen.
 */
export function effectiveDateProblem(
  filingData: { effective_date_option?: string; effective_date?: string },
  submissionDate: string,
): string | null {
  const option = filingData.effective_date_option;
  if (option !== "Future" && option !== "Backdated") return null;
  const date = filingData.effective_date ?? "";
  const check = checkEffectiveDate(date, windowForFilingDate(submissionDate));
  return "error" in check
    ? `Effective date ${date ? formatLongDate(date) : "(missing)"} no longer fits Florida's window for a filing on ${formatLongDate(addBusinessDays(submissionDate, 0))}. Ask the customer for a new date. ${check.error}`
    : null;
}
