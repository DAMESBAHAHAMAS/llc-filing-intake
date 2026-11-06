-- 0027: What the order must remember until a person or Stripe settles it.
--   replacement_unknown_at: a new hold was requested and no answer is in, so one
--     may stand on the card. Written before the request, so a crash counts too.
--   replacement_key_seq: which idempotency key the next request uses. It moves
--     only after a definite answer: repeating a request with no answer must
--     reuse its key, or the card could get a second hold.
--   approved_unrecorded_at: an approval was given and no filing is recorded, so
--     Florida may have been paid. It outlives filing_approved_at, which a renewal
--     clears, and ends only when the filing is recorded or a person says it
--     was not filed.
--   filing_approved_name: the corrected name an approval was given for, carried
--     to the resubmission.
--   collection_unknown_at: a capture or saved-card charge got no clear answer,
--     so the customer may already have paid.
--   stray_capture_pi: money landed on a hold this order does not use. Nothing
--     more is collected until it is refunded.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS replacement_unknown_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS replacement_key_seq integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS approved_unrecorded_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS filing_approved_name text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS collection_unknown_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stray_capture_pi text;

UPDATE orders SET approved_unrecorded_at = filing_approved_at
 WHERE filing_approved_at IS NOT NULL AND (sunbiz_submitted_at IS NULL OR fulfillment_status = 'rejected');
