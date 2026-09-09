-- Extends crm_sync_queue (Gate 1) to also carry order-scoped jobs, rather
-- than introducing a second queue table for Deal creation. Decision,
-- logged in DECISIONS.md: reuse the existing queue + worker + backoff
-- infrastructure (already-approved, already-tested) for the one new job
-- type Gate 2 needs at the CRM layer (order paid -> create exactly one
-- Deal), keyed by order_id instead of filing_session_id. Fulfillment
-- (PDF generation + fax transmission) does NOT use this queue — it uses
-- the orders.fulfillment_status/fulfillment_run_after state machine
-- (migration 0010) directly, since orders already carries its own
-- claim/backoff fields for that worker.

ALTER TABLE crm_sync_queue ADD COLUMN order_id uuid REFERENCES orders (order_id);

CREATE INDEX idx_crm_sync_queue_order ON crm_sync_queue (order_id) WHERE order_id IS NOT NULL;

COMMENT ON COLUMN crm_sync_queue.order_id IS
  'Set only for sync_type=''order_deal'' jobs (exactly-one-Deal-per-paid-order, enqueued by the verified Stripe webhook handler). NULL for the original sync_type=''session_sync'' jobs, which remain keyed by filing_session_id only.';
