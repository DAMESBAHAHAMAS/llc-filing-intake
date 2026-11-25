-- ST17: failure tracking for the EIN portal sweep (ein/portalJobs.ts).
--
-- failing_since: when the current run of failures for this Deal began (Deal
-- read, EIN Docs Received write, or passport purge); NULL after a clean pass.
-- alerted_error: the failure text already alerted on, so each distinct
-- failure alerts once instead of every hour. Additive only; no data changes.

ALTER TABLE ein_portal_deals ADD COLUMN failing_since timestamptz;
ALTER TABLE ein_portal_deals ADD COLUMN alerted_error text;
