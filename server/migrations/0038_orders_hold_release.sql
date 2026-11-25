-- 0038 — Day-5 card-hold release (owner's final hold rule, 25 Nov 2026).
--
-- Rule (Damian, 25 Nov 2026; A6Y2-T144 final pre-launch round): a hold is
-- captured when the filing is submitted to Sunbiz; a lapsed hold is never
-- charged off-session; and a hold still uncaptured 120 hours after it was
-- placed is released, the Zoho Deal is updated, and the customer is emailed
-- a Stripe Payment Link for the same amount (payments/holdRelease.ts).
--
-- Additive only: new nullable columns on orders, no data change, no existing
-- constraint touched. Rollback: migrations-rollback/0038_orders_hold_release.rollback.sql.

-- Set when the Day-5 job takes an order (before any Stripe call), so a run that
-- stops halfway is resumed by the next one and never confused with a hold
-- released by an operator or by the customer cancelling.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS hold_release_started_at timestamptz;
-- Set once the hold is cancelled, the Payment Link exists, and the Deal update
-- and customer email are queued.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS hold_auto_released_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_link_id text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_link_url text;
-- The latest error of the Day-5 job for this order (an ops alert is sent when it is first set).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS hold_release_error text;
-- Set when an ops alert was sent INSTEAD of releasing the hold: a hold placed
-- before HOLD_RELEASE_START, or one with proof of filing already recorded.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS hold_release_alerted_at timestamptz;
-- Rule 1: the hold is captured when the Articles are submitted to Sunbiz
-- (POST /api/orders/:orderId/sunbiz-submitted), not when Florida files them.
-- A submitted order is never released by the Day-5 job.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sunbiz_submitted_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sunbiz_submission_ref text;
-- Stripe's cancellation_reason from payment_intent.canceled ("automatic" when
-- the hold lapsed by itself, "abandoned" for the Day-5 job, "requested_by_customer"
-- for an operator release). A lapsed hold still gets the Payment Link.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS hold_cancellation_reason text;
-- The PaymentIntent that actually collected the money when it is not the hold
-- (the customer paid the Day-5 Payment Link), so a later refund finds the order.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS collected_payment_intent_id text;
-- Set when an operator closed (deactivated) the Day-5 Payment Link.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_link_closed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_orders_collected_payment_intent_id
  ON orders (collected_payment_intent_id) WHERE collected_payment_intent_id IS NOT NULL;

COMMENT ON COLUMN orders.hold_auto_released_at IS
  'When the Day-5 job (payments/holdRelease.ts) released this uncaptured hold and queued the Payment Link email.';
COMMENT ON COLUMN orders.payment_link_url IS
  'Stripe Payment Link emailed after the Day-5 release, for the same amount, carrying metadata.order_id.';
