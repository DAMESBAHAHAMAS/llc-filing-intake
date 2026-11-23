/**
 * Sunbiz Fax Audit Number: the portal (efile.sunbiz.org) issues one per fax filing, and its
 * cover sheet instructs the filer to "Type the fax audit number on the top and bottom of all
 * pages of the document." Shape, as printed on the cover sheet: a letter, eleven digits, a
 * space and a check digit, e.g. "H26000099999 3".
 *
 * The number is only known after the portal creates the filing, so the Articles are rendered
 * again with it. The PDF service prints it in the top and bottom margin of every page, as
 * "(((H26000099999 3)))". It is validated here and again in render_pdf.py because it is placed
 * inside a CSS string.
 */
export const FAX_AUDIT_NUMBER_PATTERN = /^[A-Z]\d{11} \d$/;

export function isValidFaxAuditNumber(value: unknown): value is string {
  return typeof value === "string" && FAX_AUDIT_NUMBER_PATTERN.test(value);
}
