/**
 * Restricted-word list for Florida entity names. NOT exhaustive and NOT
 * independently verified against the current text of Fla. Stat. 605 /
 * 607 and the FL Division of Corporations' own restricted-word guidance
 * — this is a reasonable, commonly-cited starting set. Flagged here
 * rather than presented as authoritative: replace/expand this list from
 * an actual compliance review before relying on it for anything beyond
 * a soft warning, which is all the frozen rule requires ("restricted-
 * word hits are a warning, not a rejection").
 */
export const RESTRICTED_WORDS: string[] = [
  "bank",
  "banking",
  "trust",
  "trust company",
  "attorney",
  "attorneys",
  "lawyer",
  "university",
  "college",
  "insurance",
  "insurer",
  "reinsurance",
  "olympic",
  "cooperative",
  "federal",
  "united states",
  "reserve",
  "fbi",
  "cia",
  "secret service",
  "treasury",
  "state department",
];

export function findRestrictedWordHits(name: string): string[] {
  const lower = name.toLowerCase();
  return RESTRICTED_WORDS.filter((word) => lower.includes(word));
}
