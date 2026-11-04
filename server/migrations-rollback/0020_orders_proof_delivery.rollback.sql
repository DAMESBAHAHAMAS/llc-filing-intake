-- Rollback for 0020_orders_proof_delivery. Roll the code back first: the
-- collection gate in routes/orders.ts reads these columns.
ALTER TABLE orders DROP COLUMN IF EXISTS proof_delivery_error;
ALTER TABLE orders DROP COLUMN IF EXISTS proof_delivery_message_id;
ALTER TABLE orders DROP COLUMN IF EXISTS proof_delivered_at;
DELETE FROM schema_migrations WHERE version = '0020_orders_proof_delivery';
