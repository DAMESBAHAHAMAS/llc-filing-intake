-- Rollback for migrations/0029. Kept outside migrations/ because the
-- runner applies every .sql file in that folder. Run by hand.
--
-- Safe only while no order has been placed against the v2 rows: orders keep an
-- offer_code + offer_version snapshot in line_items, and this deletes the v2
-- rows they would point at. If orders exist, retire v2 instead of deleting it.
BEGIN;
DELETE FROM offers
 WHERE offer_version = 'v2'
   AND offer_code IN ('FASTTRACK', 'PREMIUM');
UPDATE offers SET status = 'active'
 WHERE offer_version = 'v1'
   AND offer_code IN ('FASTTRACK', 'PREMIUM');
DELETE FROM schema_migrations WHERE version = '0029_offer_master_bank_ready_premium_997';
COMMIT;
