-- Rollback for migrations/0016. Kept outside migrations/ because the
-- runner applies every .sql file in that folder. Run by hand.
BEGIN;
DELETE FROM offers
 WHERE offer_version = 'v2'
   AND offer_code IN ('DIY_SERVICE_FEE', 'REGISTERED_AGENT_3YR', 'EIN_FILING_EXPRESS');
UPDATE offers SET status = 'active'
 WHERE offer_version = 'v1' AND offer_code IN ('DIY_SERVICE_FEE', 'REGISTERED_AGENT_3YR');
UPDATE offers SET status = 'draft'
 WHERE offer_version = 'v1' AND offer_code = 'EIN_FILING_EXPRESS';
DELETE FROM schema_migrations WHERE version = '0016_offer_master_pricing_2026_09_17';
COMMIT;
