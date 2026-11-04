-- Rollback for 0024_orders_filing_submission. Roll the code back first: the
-- routes and workers read these columns.
UPDATE orders SET fulfillment_status = 'requires_review' WHERE fulfillment_status = 'rejected';
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_fulfillment_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_fulfillment_status_check
  CHECK (fulfillment_status IN ('not_ready', 'ready', 'in_progress', 'transmitted', 'failed', 'requires_review'));

ALTER TABLE orders
  DROP COLUMN IF EXISTS sunbiz_tracking_number,
  DROP COLUMN IF EXISTS sunbiz_submitted_at,
  DROP COLUMN IF EXISTS sunbiz_resubmitted_at,
  DROP COLUMN IF EXISTS sunbiz_rejected_at,
  DROP COLUMN IF EXISTS sunbiz_rejection_reason,
  DROP COLUMN IF EXISTS sunbiz_rejection_count,
  DROP COLUMN IF EXISTS other_payment_at,
  DROP COLUMN IF EXISTS other_payment_method,
  DROP COLUMN IF EXISTS other_payment_reference,
  DROP COLUMN IF EXISTS other_payment_cents;
DELETE FROM schema_migrations WHERE version = '0024_orders_filing_submission';
