-- The Sunbiz-fulfillment bridge: the missing link between a verified
-- Stripe payment and Sunbiz filing submission. Purely additive — new
-- columns on `orders`, all either nullable or defaulted, no existing
-- column/row touched, no data rewritten. Reversible (six DROP COLUMNs).
-- Not destructive. `orders` has 0 rows in every environment this has run
-- in so far (verified before writing this migration), so there is
-- nothing to backfill.
--
-- Lives on `orders`, not a new queue table, deliberately: unlike
-- crm_sync_queue (many sync attempts can legitimately exist per
-- filing_session over its lifetime — migration 0003) or
-- registered_agent_acceptances (multiple acceptance requests can be
-- reissued over time — migration 0005), a paid order has exactly one
-- fulfillment job. There is nothing to enqueue more than once per order,
-- so a status column co-located with orders.payment_status matches the
-- registered_agent_status precedent instead (migration 0005's own
-- comment: "the filing gate needs a single, fast, authoritative read...
-- it should not have to join out to a history table").
--
-- fulfillment_status is written EXCLUSIVELY by
-- webhook/stripeWebhookService.ts, in the SAME database transaction that
-- sets payment_status = 'paid' — see that file's updated comment. No
-- other code path (checkout.ts, session.ts, or the frontend) may ever
-- write this column. It is a DERIVED, payment-gated readiness signal,
-- never an independent one — orders.payment_status remains the sole
-- payment authority (GOVERNANCE.md, migration 0009's comment).
--
-- States:
--   not_ready        (default) Order not yet paid. Also the value an
--                     already-paid order from BEFORE this migration would
--                     be stuck at (none exist today — see above) — never
--                     produced by code for an order paid after this
--                     migration ships, since the webhook always makes an
--                     explicit ready/requires_review decision at the
--                     moment it marks payment_status = 'paid'.
--   ready             Payment verified paid AND filing_data was present
--                      at that exact moment. The fulfillment trigger
--                      itself — the signal this migration exists to
--                      create. Reachable today.
--   in_progress       A fulfillment worker has claimed this order and
--                      begun preparing/transmitting the filing. Defined
--                      for forward compatibility; NOT driven by any code
--                      yet — reserved for the not-yet-built, not-yet-
--                      approved Sunbiz transmission worker.
--   transmitted       Sunbiz transmission succeeded. Defined for forward
--                      compatibility; not yet reachable.
--   failed            Sunbiz transmission was attempted and failed;
--                      fulfillment_attempts/fulfillment_last_error record
--                      why. Retryable. Defined for forward compatibility;
--                      not yet reachable.
--   requires_review   An anomaly a human must resolve: paid but
--                      filing_data missing/invalid at confirmation time
--                      (reachable today), or, later, retries exhausted.
ALTER TABLE orders ADD COLUMN fulfillment_status text NOT NULL DEFAULT 'not_ready'
  CHECK (fulfillment_status IN ('not_ready', 'ready', 'in_progress', 'transmitted', 'failed', 'requires_review'));

-- Schema-level enforcement of the payment-gate invariant (belt-and-
-- suspenders alongside the application-layer check in
-- stripeWebhookService.ts): fulfillment may never be anything other than
-- its default on an order that isn't paid. This makes "filing data
-- exists but payment is not confirmed" structurally impossible to
-- misrepresent as fulfillment progress, even via a future bug, a manual
-- UPDATE, or a worker written by someone who hasn't read this comment.
ALTER TABLE orders ADD CONSTRAINT orders_fulfillment_requires_paid
  CHECK (fulfillment_status = 'not_ready' OR payment_status = 'paid');

ALTER TABLE orders ADD COLUMN fulfillment_ready_at timestamptz;
ALTER TABLE orders ADD COLUMN fulfillment_started_at timestamptz;
ALTER TABLE orders ADD COLUMN fulfillment_completed_at timestamptz;
ALTER TABLE orders ADD COLUMN fulfillment_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN fulfillment_last_error text;

-- Carries the future worker's claim query (`WHERE fulfillment_status =
-- 'ready'`); also serves operator dashboards filtering for
-- 'requires_review' today.
CREATE INDEX idx_orders_fulfillment_status ON orders (fulfillment_status);

COMMENT ON COLUMN orders.fulfillment_status IS
  'Sunbiz-fulfillment readiness/progress. Written ONLY by webhook/stripeWebhookService.ts, in the same transaction as payment_status = ''paid''. Never client-writable, never set independently of a verified payment. See migration 0010.';
