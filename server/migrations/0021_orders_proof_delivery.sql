-- 0021: Record that proof of filing reached the customer before collection.
--
-- Business rule (Damian, 29 Sep 2026): funds are collected only after proof
-- of filing is delivered. Until now the code recorded the proof and captured
-- in the same request without telling the customer anything. These columns
-- hold the delivery result; routes/orders.ts refuses to collect a held
-- payment unless proof_delivered_at is set. See DECISIONS.md, 2026-11-04.
--
-- Additive and nullable. Under the code before this migration, the columns
-- are simply unused.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS proof_delivered_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS proof_delivery_message_id text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS proof_delivery_error text;

COMMENT ON COLUMN orders.proof_delivered_at IS
  'When the email provider accepted the customer''s proof-of-filing email. Accepted by the provider, not confirmed in the inbox. A held payment is not collected until this is set.';
COMMENT ON COLUMN orders.proof_delivery_message_id IS
  'The email provider''s id for the proof-of-filing email.';
COMMENT ON COLUMN orders.proof_delivery_error IS
  'Why the last delivery attempt failed. Cleared on success.';
