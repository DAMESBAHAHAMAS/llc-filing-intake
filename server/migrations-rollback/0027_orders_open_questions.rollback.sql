ALTER TABLE orders DROP COLUMN IF EXISTS replacement_unknown_at;
ALTER TABLE orders DROP COLUMN IF EXISTS replacement_key_seq;
ALTER TABLE orders DROP COLUMN IF EXISTS approved_unrecorded_at;
ALTER TABLE orders DROP COLUMN IF EXISTS filing_approved_name;
ALTER TABLE orders DROP COLUMN IF EXISTS collection_unknown_at;
ALTER TABLE orders DROP COLUMN IF EXISTS stray_capture_pi;
