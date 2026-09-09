-- orders.paid_at — the exact moment the verified Stripe webhook
-- transitioned this order to payment_status='paid'. Added because
-- nothing else on this row reliably says "when." fulfillment_ready_at
-- (0010) is set by the same webhook transaction for orders that enter
-- the Sunbiz fax-fulfillment pipeline, but a pure EIN-filing order never
-- goes through that pipeline at all — so it cannot be relied on as a
-- general "paid at" signal. Needed directly by the EIN same-day capacity
-- governor (count-based: how many EIN_FILING_EXPRESS orders already paid
-- today), which has no other correct way to ask "today's paid orders."

ALTER TABLE orders ADD COLUMN paid_at timestamptz;

COMMENT ON COLUMN orders.paid_at IS
  'Set only by the verified Stripe webhook handler, in the same transaction as payment_status = ''paid''. The general-purpose paid-timestamp — use this, not fulfillment_ready_at, for any query that needs "when did this order get paid" regardless of product (e.g. the EIN same-day capacity governor).';

CREATE INDEX idx_orders_paid_at ON orders (paid_at) WHERE paid_at IS NOT NULL;
