-- Rollback for migrations/0035. Run by hand.
BEGIN;
ALTER TABLE registered_agent_acceptances
  DROP COLUMN IF EXISTS requested_agent_address,
  DROP COLUMN IF EXISTS requested_llc_name;
DELETE FROM schema_migrations WHERE version = '0035_registered_agent_request_snapshot';
COMMIT;
