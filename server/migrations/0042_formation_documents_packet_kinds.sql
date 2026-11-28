-- T195 (EIN fulfillment). Decided by Damian, 27 Nov 2026: the bank-ready
-- packet is the Articles of Organization, the IRS EIN confirmation letter
-- (CP 575), the Operating Agreement and the Banking Resolution, released
-- together in the customer portal once the EIN is recorded. Packages without
-- an Operating Agreement get the Articles and the EIN letter only.
--
-- This lets formation_documents also hold the two documents we receive
-- instead of generate: the filed Articles (from Sunbiz) and the EIN letter
-- (from the IRS). A received document has no template and is never a draft.
--
-- Storage only. Nothing here records the EIN, releases a packet or sends
-- anything. Every existing row is an Operating Agreement or a Banking
-- Resolution with a template, and the new rules still accept those rows.
-- Constraint name checked in production on 27 Nov 2026.

ALTER TABLE formation_documents DROP CONSTRAINT IF EXISTS formation_documents_kind_check;
ALTER TABLE formation_documents ADD CONSTRAINT formation_documents_kind_check
  CHECK (kind IN ('operating_agreement', 'banking_resolution', 'articles_of_organization', 'ein_confirmation_letter'));

-- Generated documents keep a template; received documents have none.
ALTER TABLE formation_documents ALTER COLUMN template DROP NOT NULL;

ALTER TABLE formation_documents DROP CONSTRAINT IF EXISTS formation_documents_template_by_kind;
ALTER TABLE formation_documents ADD CONSTRAINT formation_documents_template_by_kind CHECK (
  (kind IN ('operating_agreement', 'banking_resolution') AND template IS NOT NULL)
  OR (kind IN ('articles_of_organization', 'ein_confirmation_letter') AND template IS NULL AND draft = false)
);
