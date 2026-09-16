-- Adds the fields the Gate 2 "internal order" spec requires that
-- migration 0006 didn't yet have: a payment_status distinct from the
-- checkout flow's own status, and a snapshot of which CRM Deal this
-- order is tied to. orders has 0 rows in every environment this has run
-- in so far, so a plain rename is safe — no data to migrate.
--
-- Renaming orders.status -> orders.checkout_status (not adding a
-- differently-named field alongside the old one): the existing column
-- already tracks exactly what "checkout_status" means (pending /
-- checkout_created / checkout_failed — the state of creating the Stripe
-- Checkout Session itself), it was just named "status" before this
-- table had a second, distinct status concept to disambiguate from.
ALTER TABLE orders RENAME COLUMN status TO checkout_status;

-- Separate from checkout_status on purpose: checkout_status describes
-- whether we successfully created a Stripe Checkout Session;
-- payment_status describes whether the customer has actually paid.
-- Stays 'pending' everywhere for now — the webhook that transitions it
-- to 'paid'/'failed'/'refunded' is explicitly a later task (not built by
-- checkoutService.ts, which never writes this column).
ALTER TABLE orders ADD COLUMN payment_status text NOT NULL DEFAULT 'pending'
  CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded'));

-- Snapshot of the CRM Deal this order is associated with. Column exists
-- for a future CRM-Deal-at-checkout feature; checkoutService.ts does not
-- populate it today (a CRM Deal sync was drafted concurrently by another
-- session during this task and was not adopted here — see
-- GATE2-CHECKOUT-INTEGRATION-STATUS.md §0/§9 — this column is kept,
-- unused and nullable, since it's already live in the shared dev
-- database and harmless to leave in place).
ALTER TABLE orders ADD COLUMN crm_deal_id text;

CREATE INDEX idx_orders_checkout_status ON orders (checkout_status);
