-- Rollback for migrations/0033. Run by hand. Drops the stored agent signatures.
BEGIN;
ALTER TABLE registered_agent_acceptances
  DROP COLUMN IF EXISTS signature_name,
  DROP COLUMN IF EXISTS signature_consent,
  DROP COLUMN IF EXISTS accepted_user_agent,
  DROP COLUMN IF EXISTS statement_version,
  DROP COLUMN IF EXISTS accepted_agent_name,
  DROP COLUMN IF EXISTS accepted_agent_address,
  DROP COLUMN IF EXISTS accepted_llc_name;
DELETE FROM schema_migrations WHERE version = '0033_registered_agent_acceptance_signature';
COMMIT;
