/**
 * Florida requires a registered agent's physical street address, and the
 * promise says "no P.O. Box". Spacing, dots and dashes vary in what people
 * type, so this matches the letters rather than one spelling. Words that only
 * start the same way ("Port Orange Blvd") do not match: the shorter forms need
 * a number after them.
 */
const PO_BOX_PATTERNS = [
  /\bp[\s.\-]*o[\s.\-]*box\b/i, // P.O. Box, P. O. Box, PO Box, POBox, P O Box, P-O-Box
  /\bp[\s.\-]*o[\s.\-]*b[\s.\-]*#?\s*\d/i, // POB 123, P.O.B. 123
  /\bpost[\s.\-]*office[\s.\-]*(box|drawer)\b/i,
  /\bpost[\s.\-]*box\b/i,
  /^\s*box\s*#?\s*\d/i, // Box 123, as the whole start of a street line
];

export function looksLikePoBox(address: unknown): boolean {
  if (typeof address !== "string") return false;
  const text = address.normalize("NFKC");
  return PO_BOX_PATTERNS.some((pattern) => pattern.test(text));
}
