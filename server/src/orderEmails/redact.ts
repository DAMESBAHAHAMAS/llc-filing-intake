/**
 * Customer-typed text is echoed back in order emails, so a tax ID or card
 * number typed into a free-text box must not travel by email. Equally,
 * ordinary numbers must survive: a Sunbiz filing cannot be checked from a
 * summary that blanked the customer's phone or ZIP code.
 *
 * Digits are bounded with lookarounds, not \b: "SSN123456789" has no word
 * boundary before the number, so \b lets it through.
 */
const REMOVED = "[removed]";

/** SSN or ITIN in any common punctuation, an EIN, or nine bare digits. */
const TAX_ID = /(?<!\d)(?:\d{3}[-. ]\d{2}[-. ]\d{4}|\d{2}[- ]\d{7}|\d{9})(?!\d)/g;

/** 13 to 19 digits, with any punctuation a person might put between them. */
const CARD_CANDIDATE = /(?<!\d)\d(?:[ .-]{0,3}\d){12,18}(?!\d)/g;

/** The Luhn check every card number passes and most other numbers fail. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Four groups of four is a card to a reader even with a mistyped digit.
 *  Otherwise Luhn decides, so runs of ordinary numbers are left alone. */
function isCardNumber(match: string): boolean {
  const groups = match.split(/[ .-]+/);
  if (groups.length === 4 && groups.every((g) => g.length === 4)) return true;
  return passesLuhn(groups.join(""));
}

function removeCards(text: string): string {
  return text.replace(CARD_CANDIDATE, (match) => (isCardNumber(match) ? REMOVED : match));
}

export function removeSecrets(text: string): string {
  return removeCards(text).replace(TAX_ID, REMOVED);
}

/** Free text from the customer, empty for anything that is not a string. */
export function customerText(value: unknown): string {
  return typeof value === "string" ? removeSecrets(value).trim() : "";
}

const STATE_BEFORE_ZIP = /(?:\b[A-Z]{2}|\bFlorida)[,\s]+$/;

/** As customerText, except that nine digits after a state are a ZIP+4. */
export function addressText(value: unknown): string {
  if (typeof value !== "string") return "";
  const kept = removeCards(value).replace(TAX_ID, (match, offset: number, whole: string) =>
    /^\d{9}$/.test(match) && STATE_BEFORE_ZIP.test(whole.slice(0, offset)) ? match : REMOVED
  );
  return kept.trim();
}

/** A phone number runs to 15 digits (E.164), so only something longer, or
 *  a dashed SSN, is removed. International numbers stay whole. */
export function phoneText(value: unknown): string {
  if (typeof value !== "string") return "";
  if (value.replace(/\D/g, "").length > 15) return REMOVED;
  return value.replace(/(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g, REMOVED).trim();
}
