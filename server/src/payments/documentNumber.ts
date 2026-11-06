/**
 * Florida gives a domestic LLC a document number of L, a two-digit year and
 * nine digits, such as L26000123456. Collection depends on this value, so a
 * typing slip or a Sunbiz tracking number must not pass as proof that
 * Florida confirmed the filing.
 */
const FLORIDA_LLC_DOCUMENT_NUMBER = /^L\d{11}$/;

export function isFloridaLlcDocumentNumber(value: string): boolean {
  return FLORIDA_LLC_DOCUMENT_NUMBER.test(value.trim().toUpperCase());
}
