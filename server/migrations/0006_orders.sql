-- orders — one row per checkout attempt, created and durably persisted
-- BEFORE any Stripe Checkout Session is created (GOVERNANCE.md #2: never
-- call a payment processor before the order record exists). Line item
-- amounts are read from this service's own OFFER_LINE_ITEMS table
-- (server/src/checkout/checkoutService.ts) — never from the client, and
-- not fetched from Stripe at request time either, so order persistence
-- and Stripe reachability are independent failure modes, matching the
-- Gate 2 checkout-integration requirement that an order-persistence
-- failure and a Stripe-API failure are handled distinctly.
--
-- status starts 'pending' (row written, Stripe not yet called),
-- moves to 'checkout_created' once stripe.checkout.sessions.create()
-- succeeds, or 'checkout_failed' if that call errors — the row is never
-- deleted in either case, only its status/failure_reason updated.

CREATE TABLE orders (
  order_id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filing_session_id           uuid NOT NULL REFERENCES filing_sessions (filing_session_id),

  crm_intent                  text NOT NULL,
  product                     text NOT NULL,
  line_items                  jsonb NOT NULL,
  total_cents                 integer NOT NULL,
  currency                    text NOT NULL DEFAULT 'usd',

  status                      text NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'checkout_created', 'checkout_failed')),
  stripe_checkout_session_id  text,
  failure_reason               text,

  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_filing_session ON orders (filing_session_id);
CREATE INDEX idx_orders_status ON orders (status);

-- set_updated_at() already exists (migration 0001).
CREATE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
