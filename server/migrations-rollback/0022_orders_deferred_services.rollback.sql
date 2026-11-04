-- Rollback for 0022_orders_deferred_services. Roll the code back first.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_deferred_cents_check;
ALTER TABLE orders
  DROP COLUMN IF EXISTS deferred_cents,
  DROP COLUMN IF EXISTS deferred_service_ref,
  DROP COLUMN IF EXISTS deferred_payment_intent_id,
  DROP COLUMN IF EXISTS deferred_requested_at,
  DROP COLUMN IF EXISTS deferred_charged_at,
  DROP COLUMN IF EXISTS deferred_charge_error;
DELETE FROM schema_migrations WHERE version = '0022_orders_deferred_services';
