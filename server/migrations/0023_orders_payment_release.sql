-- 0023: Payment release candidate (DECISIONS.md, 2026-11-04 "Payment release
-- candidate"). Additive, apart from two widened CHECK constraints.
--
-- Damian's rule: he pays Sunbiz first, and the customer's card is charged
-- only after Florida confirms the filing with a document number. These
-- columns record what that rule needs to know about an order.

-- How checkout was asked to take payment. A session that completes unpaid
-- is a hold only when this says 'hold'. On an 'immediate' order it is a
-- delayed payment method, which must not be treated or described as a hold.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS capture_mode text;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_capture_mode_check;
ALTER TABLE orders ADD CONSTRAINT orders_capture_mode_check
  CHECK (capture_mode IS NULL OR capture_mode IN ('hold', 'immediate'));

-- livemode of the Stripe event that secured the order. false means a test
-- payment, which must never reach a real address.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_livemode boolean;

-- The saved-card authorization, as Stripe reports it on the completed
-- Checkout Session. Stripe records no tick for custom_text, so this is the
-- exact text shown and the moment the customer completed checkout with it.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS saved_card_authorized_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS saved_card_authorization_text text;

-- Saved-card charges. Each decline moves to a new attempt number, so the
-- next try gets a new Stripe idempotency key and is not a replay of the
-- decline. The PaymentIntent id stops a second charge once one has gone
-- through, however late its webhook arrives.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS saved_card_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS saved_card_payment_intent_id text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deferred_attempts integer NOT NULL DEFAULT 0;

-- The customer cancelled, or the filing cannot go ahead. A cancelled order
-- is never filed and its saved card is never charged.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_reason text;

-- The saved card is detached once the order closes.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS saved_card_detached_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS saved_card_detach_error text;

-- A hold can end while an order waits for its registered agent. The order
-- stays open, so filing may start on a released hold unless it was
-- cancelled; the saved card covers the charge after Florida confirms.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_fulfillment_requires_paid;
ALTER TABLE orders ADD CONSTRAINT orders_fulfillment_requires_paid
  CHECK (
    fulfillment_status = 'not_ready'
    OR payment_status IN ('authorized', 'paid')
    OR (payment_status = 'released' AND cancelled_at IS NULL)
    OR (payment_status IN ('released', 'refunded') AND fulfillment_status <> 'ready')
  );

-- A customer email that was deliberately not sent (the order moved on
-- before its turn came). Not a failure, so it needs a state of its own.
ALTER TABLE crm_sync_queue DROP CONSTRAINT IF EXISTS crm_sync_queue_status_check;
ALTER TABLE crm_sync_queue ADD CONSTRAINT crm_sync_queue_status_check
  CHECK (status IN ('pending', 'processing', 'synced', 'failed', 'dead_letter', 'skipped'));

COMMENT ON COLUMN orders.saved_card_authorized_at IS
  'When the customer completed a Checkout Session showing saved_card_authorization_text.';
COMMENT ON COLUMN orders.saved_card_attempts IS
  'Declined saved-card attempts. The next attempt uses a new Stripe idempotency key.';
