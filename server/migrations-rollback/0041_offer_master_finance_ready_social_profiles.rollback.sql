-- Rollback for migrations/0041. Kept outside migrations/ because the runner
-- applies every .sql file in that folder. Run by hand.
--
-- Safe only while no order points at PREMIUM v4 (orders keep offer_code +
-- offer_version in line_items). If one does, retire v4 instead of deleting it.
BEGIN;
DELETE FROM offers WHERE offer_code = 'PREMIUM' AND offer_version = 'v4';
UPDATE offers SET status = 'active' WHERE offer_code = 'PREMIUM' AND offer_version = 'v3';
DELETE FROM schema_migrations WHERE version = '0041_offer_master_finance_ready_social_profiles';
COMMIT;
