-- filing_sessions.filing_data — canonical structured filing data (entity
-- details, addresses, members/managers, EIN info, etc.) collected across
-- the funnel. This is the single source that PDF generation, checkout,
-- CRM sync, Sunbiz submission, and the Corporate Kit all read from — see
-- server/src/pdf/types.ts (FilingSessionRecord) for the authoritative
-- shape once that module exists.
--
-- RECONSTRUCTED, 2026-09-09: this migration was applied directly against
-- the live Supabase project on 2026-08-27 with no corresponding file ever
-- committed to this repo. This file reproduces the live column exactly
-- (verified via information_schema) so schema history is no longer only
-- in Supabase. See DECISIONS.md, "Schema/migration drift" entry.

ALTER TABLE filing_sessions ADD COLUMN filing_data jsonb;

COMMENT ON COLUMN filing_sessions.filing_data IS
  'Canonical structured filing data — see server/src/pdf/types.ts FilingSessionRecord for the authoritative shape. The one source PDF generation, checkout, CRM, Sunbiz submission, and the Corporate Kit all read from.';
