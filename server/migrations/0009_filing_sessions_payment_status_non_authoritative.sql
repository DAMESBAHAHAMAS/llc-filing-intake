-- Documentation-only migration (no schema change): explicitly demotes
-- filing_sessions.payment_status now that orders.payment_status (0007)
-- is the canonical, webhook-only payment field. Gate 2's payment-authority
-- security fix also stopped POST /api/session/stage from accepting this
-- field from the client at all (see server/src/routes/session.ts) — this
-- comment documents that decision at the schema level so it can't be
-- missed by reading the column alone.
--
-- RECONSTRUCTED, 2026-09-09: applied live on 2026-08-28, no file
-- committed until now. See DECISIONS.md, "Schema/migration drift" entry.

COMMENT ON COLUMN filing_sessions.payment_status IS
  'NON-AUTHORITATIVE / legacy (Gate 1). Not client-writable since Gate 2''s payment-authority security fix — POST /api/session/stage no longer accepts this field. Never trust this column for payment, CRM, fulfillment, or Order-state decisions. The canonical payment field is orders.payment_status, set only by the verified Stripe webhook.';
