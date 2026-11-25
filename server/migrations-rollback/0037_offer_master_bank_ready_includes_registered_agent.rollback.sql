-- Rollback for migrations/0037. Kept outside migrations/ because the runner
-- applies every .sql file in that folder. Run by hand.
--
-- Safe only while no order points at FASTTRACK v3 (orders keep offer_code +
-- offer_version in line_items). If one does, retire v3 instead of deleting it.
-- Rolling back the catalog alone does not undo the checkout rule in
-- offers/houseAgentRule.ts; revert that code too.
BEGIN;
DELETE FROM offers WHERE offer_code = 'FASTTRACK' AND offer_version = 'v3';
UPDATE offers SET status = 'active' WHERE offer_code = 'FASTTRACK' AND offer_version = 'v2';
DELETE FROM schema_migrations WHERE version = '0037_offer_master_bank_ready_includes_registered_agent';
COMMIT;
