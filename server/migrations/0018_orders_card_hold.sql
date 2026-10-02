-- 0018: Card holds — collect payment only after proof of filing.
--
-- Business rule (Damian, 29 Sep 2026): a customer's card is not charged
-- until proof of filing is delivered. Checkout therefore places a HOLD
-- (Stripe manual capture) and the money is collected only when proof of
-- filing — the filed Articles with a Sunbiz document number — is
-- recorded. See DECISIONS.md, 2026-09-30 "Card holds".
--
-- Consequences for this table:
--   * payment_status gains 'authorized' (hold placed, not yet collected)
--     and 'released' (hold cancelled or expired before collection).
--   * Filing must be able to start while the card is only held, so
--     orders_fulfillment_requires_paid (0010) now also accepts
--     'authorized'. It still refuses fulfillment for pending, failed,
--     released or refunded orders.
--   * New columns record the PaymentIntent, the hold's expiry, the
--     proof of filing, and when the money was collected.

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check
  CHECK (payment_status IN ('pending', 'authorized', 'paid', 'failed', 'released', 'refunded'));

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_fulfillment_requires_paid;
ALTER TABLE orders ADD CONSTRAINT orders_fulfillment_requires_paid
  CHECK (
    fulfillment_status = 'not_ready'
    OR payment_status IN ('authorized', 'paid')
    -- A hold that expires, or a refund, after filing has started leaves the
    -- filing record in place for review; filing cannot START in these states.
    OR (payment_status IN ('released', 'refunded') AND fulfillment_status <> 'ready')
  );

ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS authorized_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS capture_before timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS extended_authorization boolean;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS hold_expiry_flagged_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS proof_of_filing_ref text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS proof_of_filing_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS captured_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS capture_error text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS released_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_stripe_payment_intent_id
  ON orders (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_authorized_capture_before
  ON orders (capture_before) WHERE payment_status = 'authorized';

COMMENT ON COLUMN orders.capture_before IS
  'When the card hold expires (Stripe charge.payment_method_details.card.capture_before). Filled by fulfillment/holdSweep.ts. Collection must happen before this moment.';
COMMENT ON COLUMN orders.proof_of_filing_ref IS
  'Sunbiz document number of the filed Articles — the proof of filing that allows the held payment to be collected.';
