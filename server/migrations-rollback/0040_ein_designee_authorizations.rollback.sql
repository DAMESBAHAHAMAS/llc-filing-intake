-- Rollback for migrations/0040. Run by hand, after reverting the code that
-- writes it (routes/einDesignee.ts). Deletes every stored designee signature:
-- export the table first if any exist.
BEGIN;
DROP TABLE IF EXISTS ein_designee_authorizations;
DELETE FROM schema_migrations WHERE version = '0040_ein_designee_authorizations';
COMMIT;
