-- orders.payment_status is the canonical, webhook-only payment field
-- (never client-writable) — see the 0009 migration's comment for the
-- explicit statement that filing_sessions.payment_status is NOT this.
-- Set only by the verified Stripe webhook handler
-- (webhook/stripeWebhookService.ts), in the same transaction as any
-- fulfillment_status transition. orders.crm_deal_id records the exactly-
-- one Deal created per paid order (standing CRM sequencing rule: Deal
-- only after a verified webhook, never at intake).
--
-- RECONSTRUCTED, 2026-09-09: applied live on 2026-08-28, no file
-- committed until now. See DECISIONS.md, "Schema/migration drift" entry.

ALTER TABLE orders ADD COLUMN payment_status text NOT NULL DEFAULT 'pending'
  CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded'));

ALTER TABLE orders ADD COLUMN crm_deal_id text;

-- Duplicate of idx_orders_status (both index checkout_status) as found
-- live — reproduced here for fidelity rather than silently dropped;
-- flagged as a minor cleanup opportunity in DECISIONS.md.
CREATE INDEX idx_orders_checkout_status ON orders (checkout_status);
