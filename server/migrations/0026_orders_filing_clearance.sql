-- 0026: Controls on the manual capture path (Damian, 6 Nov 2026).
--   filing_approved_at: a person cleared this order to file, after Stripe
--     confirmed a capturable authorization. Required before submission.
--   hold_final_flagged_at: the second expiry escalation, at 24 hours.
--   superseded_payment_intent_ids: holds replaced by a newer one, kept so a
--     late event from an old hold is recognised and ignored.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS filing_approved_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS hold_final_flagged_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS superseded_payment_intent_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

-- One Florida document number collects on one order.
CREATE UNIQUE INDEX orders_one_document_number ON orders (upper(proof_of_filing_ref))
  WHERE proof_of_filing_ref IS NOT NULL AND sunbiz_submitted_at IS NOT NULL;
