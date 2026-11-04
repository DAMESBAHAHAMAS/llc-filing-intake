-- Rollback for 0023_orders_payment_release. Roll the code back first: the
-- routes and workers read these columns. Let customer emails drain first,
-- and clear any 'skipped' rows, or the old status constraint will refuse.
DELETE FROM crm_sync_queue WHERE status = 'skipped';
ALTER TABLE crm_sync_queue DROP CONSTRAINT IF EXISTS crm_sync_queue_status_check;
ALTER TABLE crm_sync_queue ADD CONSTRAINT crm_sync_queue_status_check
  CHECK (status IN ('pending', 'processing', 'synced', 'failed', 'dead_letter'));

UPDATE orders SET fulfillment_status = 'not_ready' WHERE payment_status = 'released' AND fulfillment_status = 'ready';
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_fulfillment_requires_paid;
ALTER TABLE orders ADD CONSTRAINT orders_fulfillment_requires_paid
  CHECK (
    fulfillment_status = 'not_ready'
    OR payment_status IN ('authorized', 'paid')
    OR (payment_status IN ('released', 'refunded') AND fulfillment_status <> 'ready')
  );

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_capture_mode_check;
ALTER TABLE orders
  DROP COLUMN IF EXISTS capture_mode,
  DROP COLUMN IF EXISTS stripe_livemode,
  DROP COLUMN IF EXISTS saved_card_authorized_at,
  DROP COLUMN IF EXISTS saved_card_authorization_text,
  DROP COLUMN IF EXISTS saved_card_attempts,
  DROP COLUMN IF EXISTS saved_card_payment_intent_id,
  DROP COLUMN IF EXISTS deferred_attempts,
  DROP COLUMN IF EXISTS cancelled_at,
  DROP COLUMN IF EXISTS cancellation_reason,
  DROP COLUMN IF EXISTS saved_card_detached_at,
  DROP COLUMN IF EXISTS saved_card_detach_error;
DELETE FROM schema_migrations WHERE version = '0023_orders_payment_release';
