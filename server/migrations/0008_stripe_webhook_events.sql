-- stripe_webhook_events — idempotency ledger for POST /api/stripe/webhook.
-- Smallest additive structure for this purpose: neither filing_events
-- (keyed by filing_session_id, about filing-stage transitions) nor
-- crm_sync_queue (keyed by filing_session_id, about outbound Zoho jobs)
-- fits — this is keyed by Stripe's own event id and is specifically
-- about "have we already processed this exact webhook delivery."
--
-- The primary key IS the idempotency mechanism: the webhook handler
-- INSERTs a row for event.id before doing any processing (ON CONFLICT DO
-- NOTHING); a 0-row result means this exact event was already claimed
-- (by this delivery attempt or an earlier one) and processing is skipped
-- entirely — Stripe redelivers the same event.id on retry, never a new
-- one, so this is both correct and sufficient. processing_result and
-- order_id are filled in by a follow-up UPDATE once processing finishes
-- (both start NULL between claim and completion).
CREATE TABLE stripe_webhook_events (
  id                  text PRIMARY KEY,  -- Stripe event id, e.g. evt_...
  type                text NOT NULL,
  order_id            uuid REFERENCES orders (order_id),
  processing_result    text,
  payload             jsonb NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  processed_at        timestamptz
);

CREATE INDEX idx_stripe_webhook_events_order ON stripe_webhook_events (order_id);
