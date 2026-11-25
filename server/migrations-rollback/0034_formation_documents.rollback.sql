-- Rollback for migrations/0034. Run by hand. Deletes generated agreements.
BEGIN;
DROP TABLE IF EXISTS formation_documents;
DROP TABLE IF EXISTS operating_agreement_status;
DELETE FROM schema_migrations WHERE version = '0034_formation_documents';
COMMIT;
