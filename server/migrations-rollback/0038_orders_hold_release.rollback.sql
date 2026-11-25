-- Rollback for migrations/0038. Kept outside migrations/ because the runner
-- applies every .sql file in that folder. Run by hand, after switching the job
-- off (HOLD_RELEASE_ENABLED=off) or reverting payments/holdRelease.ts.
-- Drops the Payment Link record of any order already released by the job;
-- copy those rows first if they are needed.
BEGIN;
DROP INDEX IF EXISTS idx_orders_collected_payment_intent_id;
ALTER TABLE orders DROP COLUMN IF EXISTS payment_link_closed_at;
ALTER TABLE orders DROP COLUMN IF EXISTS collected_payment_intent_id;
ALTER TABLE orders DROP COLUMN IF EXISTS hold_cancellation_reason;
ALTER TABLE orders DROP COLUMN IF EXISTS sunbiz_submission_ref;
ALTER TABLE orders DROP COLUMN IF EXISTS sunbiz_submitted_at;
ALTER TABLE orders DROP COLUMN IF EXISTS hold_release_alerted_at;
ALTER TABLE orders DROP COLUMN IF EXISTS hold_release_error;
ALTER TABLE orders DROP COLUMN IF EXISTS payment_link_url;
ALTER TABLE orders DROP COLUMN IF EXISTS payment_link_id;
ALTER TABLE orders DROP COLUMN IF EXISTS hold_auto_released_at;
ALTER TABLE orders DROP COLUMN IF EXISTS hold_release_started_at;
DELETE FROM schema_migrations WHERE version = '0038_orders_hold_release';
COMMIT;
