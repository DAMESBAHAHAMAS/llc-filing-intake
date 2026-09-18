-- Allows a filing_documents row to exist before an order/payment exists,
-- for Requirement 1 (pre-payment PDF visibility — 2026-09-18 requirement
-- handoff): the customer-facing PDF must be generated and retained as
-- evidence at intake completion, not gated behind payment. order_id was
-- previously NOT NULL, which made that impossible — every row required an
-- already-paid order to reference.
--
-- A pre-payment document is identified by order_id IS NULL. The partial
-- unique index keeps exactly one pre-payment document per filing session
-- (idempotent regeneration: the same session completing intake twice does
-- not accumulate duplicate rows) without constraining post-payment
-- fulfillment, which still inserts a fresh row per attempt as before
-- (order_id NOT NULL there, so this index does not apply to those rows).

ALTER TABLE filing_documents ALTER COLUMN order_id DROP NOT NULL;

CREATE UNIQUE INDEX idx_filing_documents_session_prepayment
  ON filing_documents (filing_session_id)
  WHERE order_id IS NULL;

COMMENT ON TABLE filing_documents IS
  'The authoritative retained PDF artifact. order_id IS NULL identifies the single pre-payment evidence copy generated at intake completion (Requirement 1, 2026-09-18); order_id NOT NULL identifies a post-payment fulfillment attempt (fresh regeneration each attempt, never mutated) — fulfillment_transmissions.document_id points at the exact bytes actually transmitted for that attempt.';
