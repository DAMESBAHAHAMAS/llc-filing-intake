-- orders — one row per checkout attempt for a filing_session. Created
-- BEFORE the Stripe Checkout Session (standing rule: never charge before
-- the order record is durably persisted). line_items/total_cents describe
-- what was offered at checkout time; the actual amount charged is always
-- whatever Stripe's Price IDs resolve to server-side, never a number
-- trusted from the client.
--
-- RECONSTRUCTED, 2026-09-09: applied live on 2026-08-28, no file
-- committed until now. See DECISIONS.md, "Schema/migration drift" entry.

CREATE TABLE orders (
  order_id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filing_session_id           uuid NOT NULL REFERENCES filing_sessions (filing_session_id),
  crm_intent                  text NOT NULL,
  product                     text NOT NULL,
  line_items                  jsonb NOT NULL,
  total_cents                 integer NOT NULL,
  currency                    text NOT NULL DEFAULT 'usd',
  checkout_status             text NOT NULL DEFAULT 'pending'
                                CHECK (checkout_status IN ('pending', 'checkout_created', 'checkout_failed')),
  stripe_checkout_session_id  text,
  failure_reason              text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_filing_session ON orders (filing_session_id);
CREATE INDEX idx_orders_status ON orders (checkout_status);

CREATE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
