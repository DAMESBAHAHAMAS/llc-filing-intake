-- Rollback for migrations/0032. Kept outside migrations/ because the runner
-- applies every .sql file in that folder. Run by hand.
--
-- Safe only while no order points at PREMIUM v3 (orders keep offer_code +
-- offer_version in line_items). If one does, retire v3 instead of deleting it.
BEGIN;
DELETE FROM offers WHERE offer_code = 'PREMIUM' AND offer_version = 'v3';
UPDATE offers SET status = 'active' WHERE offer_code = 'PREMIUM' AND offer_version = 'v2';
DELETE FROM schema_migrations WHERE version = '0032_offer_master_finance_ready';
COMMIT;
