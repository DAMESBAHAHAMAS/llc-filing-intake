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

-- Replacement holds: how many were tried on the current hold, and why the last
-- one failed. Consent comes from saved_card_authorization_text (0023), the
-- exact wording Stripe reports the customer saw.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS replacement_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS replacement_last_attempt_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS replacement_last_error text;

-- One filing per LLC. The key is a normalised filing name, claimed when a
-- filing is approved, so two orders can't both be approved and then submitted.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS filing_name_key text;
CREATE UNIQUE INDEX orders_one_open_filing_per_name ON orders (filing_name_key)
  WHERE filing_name_key IS NOT NULL AND cancelled_at IS NULL;

-- A short claim on the order while an operator step talks to Stripe, so two
-- money steps can't overlap. It lapses by itself if the process dies.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS hold_op_until timestamptz;
-- A replaced hold not yet confirmed cancelled. The sweep finishes the job.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS superseded_open boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS hold_unknown_flagged_at timestamptz;

-- Every order so far came through Stripe test mode. Mark them, so the sweeps
-- can skip them once a live key is in place.
UPDATE orders SET stripe_livemode = false WHERE stripe_livemode IS NULL;
