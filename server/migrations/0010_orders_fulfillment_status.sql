-- orders fulfillment columns — Sunbiz-fulfillment (fax transmission)
-- readiness/progress tracking. Written ONLY by the verified webhook
-- handler (webhook/stripeWebhookService.ts), in the same transaction as
-- payment_status = 'paid' — never client-writable, never set
-- independently of a verified payment (enforced below by
-- orders_fulfillment_requires_paid). fulfillment_run_after is the
-- backoff gate for the fulfillment worker's claim query
-- (fulfillment/fulfillmentWorker.ts), reusing sync/backoff.ts's existing
-- schedule rather than inventing a second one.
--
-- RECONSTRUCTED, 2026-09-09: applied live on 2026-09-01, no file
-- committed until now. See DECISIONS.md, "Schema/migration drift" entry.

ALTER TABLE orders ADD COLUMN fulfillment_status text NOT NULL DEFAULT 'not_ready'
  CHECK (fulfillment_status IN ('not_ready', 'ready', 'in_progress', 'transmitted', 'failed', 'requires_review'));
ALTER TABLE orders ADD COLUMN fulfillment_ready_at timestamptz;
ALTER TABLE orders ADD COLUMN fulfillment_started_at timestamptz;
ALTER TABLE orders ADD COLUMN fulfillment_completed_at timestamptz;
ALTER TABLE orders ADD COLUMN fulfillment_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN fulfillment_last_error text;
ALTER TABLE orders ADD COLUMN fulfillment_run_after timestamptz;

ALTER TABLE orders ADD CONSTRAINT orders_fulfillment_requires_paid
  CHECK (fulfillment_status = 'not_ready' OR payment_status = 'paid');

COMMENT ON COLUMN orders.fulfillment_status IS
  'Sunbiz-fulfillment readiness/progress. Written ONLY by webhook/stripeWebhookService.ts, in the same transaction as payment_status = ''paid''. Never client-writable, never set independently of a verified payment. See migration 0010.';

COMMENT ON COLUMN orders.fulfillment_run_after IS
  'Backoff gate for the fulfillment worker''s claim query (fulfillment/fulfillmentWorker.ts) — reuses sync/backoff.ts''s existing schedule. NULL or a past timestamp means eligible now.';

CREATE INDEX idx_orders_fulfillment_status ON orders (fulfillment_status);
