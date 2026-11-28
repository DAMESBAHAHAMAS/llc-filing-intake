-- Rollback for migrations/0042. Kept outside migrations/ because the runner
-- applies every .sql file in that folder. Run by hand, after reverting any
-- code that stores the Articles or the EIN letter.
--
-- Deletes every stored Articles of Organization and EIN letter: export them
-- first if any exist. Operating Agreements and Banking Resolutions are kept.
BEGIN;
DELETE FROM formation_documents WHERE kind IN ('articles_of_organization', 'ein_confirmation_letter');
ALTER TABLE formation_documents DROP CONSTRAINT IF EXISTS formation_documents_template_by_kind;
ALTER TABLE formation_documents ALTER COLUMN template SET NOT NULL;
ALTER TABLE formation_documents DROP CONSTRAINT IF EXISTS formation_documents_kind_check;
ALTER TABLE formation_documents ADD CONSTRAINT formation_documents_kind_check
  CHECK (kind IN ('operating_agreement', 'banking_resolution'));
DELETE FROM schema_migrations WHERE version = '0042_formation_documents_packet_kinds';
COMMIT;
