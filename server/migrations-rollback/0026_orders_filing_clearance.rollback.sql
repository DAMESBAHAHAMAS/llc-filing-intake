DROP INDEX IF EXISTS orders_one_document_number;
ALTER TABLE orders DROP COLUMN IF EXISTS filing_approved_at;
ALTER TABLE orders DROP COLUMN IF EXISTS hold_final_flagged_at;
ALTER TABLE orders DROP COLUMN IF EXISTS superseded_payment_intent_ids;
