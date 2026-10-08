-- Rollback for 0019_scorecard_subscribers (SA4-T38). Only the two Scorecard tables
-- are touched. Safe while they hold no real data; if sign-ups exist, export them first.
DROP TABLE IF EXISTS scorecard_emails;
DROP TABLE IF EXISTS scorecard_subscribers;
DELETE FROM schema_migrations WHERE version = '0019_scorecard_subscribers';
