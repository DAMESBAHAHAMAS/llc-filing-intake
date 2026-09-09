-- stripe_webhook_events — the idempotency mechanism for the Stripe
-- webhook handler. Primary key is the Stripe event ID itself (`event.id`,
-- e.g. "evt_..."), not a generated key: verify signature -> is event.id
-- already a row here? yes: return 200, do nothing further; no: insert
-- this row, update order/session state, enqueue downstream work (PDF,
-- CRM Deal) in the same transaction. Never do PDF/CRM/email inline in the
-- webhook handler itself.
--
-- RECONSTRUCTED, 2026-09-09: applied live on 2026-08-28, no file
-- committed until now. See DECISIONS.md, "Schema/migration drift" entry.

CREATE TABLE stripe_webhook_events (
  id                  text PRIMARY KEY,
  type                text NOT NULL,
  order_id            uuid REFERENCES orders (order_id),
  processing_result   text,
  payload             jsonb NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  processed_at        timestamptz
);

CREATE INDEX idx_stripe_webhook_events_order ON stripe_webhook_events (order_id);

ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;
