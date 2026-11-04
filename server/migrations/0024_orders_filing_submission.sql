-- 0024: Record the Sunbiz submission on the order, and what follows it.
--
-- Damian's rule (DECISIONS.md, 2026-11-04, register #180): Damian reviews and
-- files online, pays Florida first, and the card is charged only after Florida
-- confirms with a document number. Until now nothing recorded the submission,
-- so the code could not tell an order Damian had already paid Florida for from
-- one still cancellable.
--
-- Additive, apart from one widened CHECK constraint. Under the code before
-- this migration the columns are simply unused.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS sunbiz_tracking_number text;
-- The first submission. A correction returned in time keeps this filing date.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sunbiz_submitted_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sunbiz_resubmitted_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sunbiz_rejected_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sunbiz_rejection_reason text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sunbiz_rejection_count integer NOT NULL DEFAULT 0;

-- Payment arranged outside Stripe after the card could not be charged.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS other_payment_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS other_payment_method text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS other_payment_reference text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS other_payment_cents integer;

-- 'rejected': Florida rejected a submitted filing, and the hold or saved card
-- stays in place while it is corrected. 0010 was reconstructed after the fact,
-- so the status check is found by what it says rather than by its name.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'orders'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%requires_review%'
      AND pg_get_constraintdef(oid) NOT LIKE '%payment_status%'
  LOOP
    EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE orders ADD CONSTRAINT orders_fulfillment_status_check
  CHECK (fulfillment_status IN ('not_ready', 'ready', 'in_progress', 'transmitted', 'failed', 'requires_review', 'rejected'));

COMMENT ON COLUMN orders.sunbiz_tracking_number IS
  'Sunbiz tracking number of the latest submission. The Sunbiz PIN is not stored here.';
COMMENT ON COLUMN orders.sunbiz_submitted_at IS
  'When the Articles were first submitted to Sunbiz. Set with fulfillment_status = transmitted, after which the order cannot be cancelled unless Florida rejects the filing.';
COMMENT ON COLUMN orders.sunbiz_rejection_reason IS
  'Why Florida rejected the latest submission, as told to the customer.';
COMMENT ON COLUMN orders.other_payment_at IS
  'When payment made outside Stripe was recorded. The order is then paid and its saved card is detached.';
