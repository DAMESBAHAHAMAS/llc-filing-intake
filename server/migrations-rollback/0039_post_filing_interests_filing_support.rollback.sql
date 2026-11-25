-- Rollback for migrations/0039. Run by hand, after reverting the code that
-- reads filing_support (postFiling/interests.ts). Drops the customers' choices
-- for that card.
BEGIN;
ALTER TABLE post_filing_interests DROP COLUMN IF EXISTS filing_support;
DELETE FROM schema_migrations WHERE version = '0039_post_filing_interests_filing_support';
COMMIT;
