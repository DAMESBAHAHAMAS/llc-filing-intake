-- Rollback for migrations/0036. Run by hand.
BEGIN;
ALTER TABLE operating_agreement_status DROP COLUMN IF EXISTS deal_sync_error;
ALTER TABLE orders DROP COLUMN IF EXISTS sunbiz_filing_date;
DELETE FROM schema_migrations WHERE version = '0036_formation_followups';
COMMIT;
