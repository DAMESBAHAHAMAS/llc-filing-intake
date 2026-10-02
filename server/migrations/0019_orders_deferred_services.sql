-- 0019: Services delivered after the LLC filing are charged when complete.
--
-- Decision (Damian, 2 Oct 2026 14:45 ET, Terms "Services after your LLC
-- is filed"): an EIN ordered with a formation package is charged when the
-- EIN is issued, not when the Articles are filed. At checkout the hold
-- still covers the whole order. When proof of filing arrives, only the
-- formation part is collected (partial capture releases the rest); the
-- deferred part is charged to the card saved at checkout once the EIN is
-- issued (routes/orders.ts, POST /api/orders/:id/service-complete).

ALTER TABLE orders ADD COLUMN IF NOT EXISTS deferred_cents integer NOT NULL DEFAULT 0;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_deferred_cents_check;
ALTER TABLE orders ADD CONSTRAINT orders_deferred_cents_check CHECK (deferred_cents >= 0 AND deferred_cents <= total_cents);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deferred_service_ref text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deferred_payment_intent_id text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deferred_requested_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deferred_charged_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deferred_charge_error text;

COMMENT ON COLUMN orders.deferred_cents IS
  'Part of total_cents charged only when a post-filing service (EIN) is complete. Not collected at proof of filing.';
