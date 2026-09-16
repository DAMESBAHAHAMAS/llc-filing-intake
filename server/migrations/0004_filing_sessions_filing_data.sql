-- Adds the ONE canonical, structured-filing-data column to filing_sessions.
-- Purely additive — nullable, no default beyond NULL, no existing column
-- touched, no data rewritten. Not destructive.
--
-- Why a single jsonb column instead of ~25 new scalar columns: this data
-- (LLC name, addresses, registered agent, authorized persons, effective
-- date, other provisions, signer) has exactly one consumer shape today —
-- server/src/pdf/types.ts's FilingSessionRecord, the PDF composer's own
-- input type — and needs to serve several more (HTML review, checkout,
-- future Sunbiz submission, Corporate Kit, CRM) without each of them
-- inventing its own copy. A jsonb column holding that one shape is the
-- single source of truth; a wide scalar schema would just be the same
-- data duplicated into columns, and would need a migration every time a
-- template field is added or Article IV's shape changes.
--
-- What's deliberately NOT duplicated in here: email, phone, full_name
-- already have their own top-level columns (migration 0001) and stay
-- there — this column holds everything else.
ALTER TABLE filing_sessions ADD COLUMN filing_data jsonb;

COMMENT ON COLUMN filing_sessions.filing_data IS
  'Canonical structured filing data — see server/src/pdf/types.ts FilingSessionRecord for the authoritative shape. The one source PDF generation, checkout, CRM, Sunbiz submission, and the Corporate Kit all read from.';
