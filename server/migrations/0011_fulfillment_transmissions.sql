-- Fax transmission layer: the production fulfillment engine that turns a
-- 'ready' order (migration 0010) into a generated, retained PDF and a
-- transmitted fax. Purely additive — two new tables, one new nullable
-- column on `orders`. No existing column/row touched. Reversible (two
-- DROP TABLEs, one DROP COLUMN). `orders`/`filing_sessions` have real
-- rows by the time this runs in some environments, but this migration
-- creates nothing that requires backfilling them.
--
-- filing_documents — the authoritative, retained artifact. Every
-- generated Articles-of-Organization PDF is stored here as bytes, not
-- just referenced by a path/URL, so "prove precisely what was
-- transmitted" never depends on an external store's retention policy or
-- a since-changed file. Small volume (one row per fulfillment attempt,
-- a few hundred KB each) makes Postgres bytea the right call over
-- standing up a new storage dependency for this — and GOVERNANCE.md
-- rule 9 explicitly rules out Supabase Storage regardless ("Never build
-- against Supabase Auth, Storage, Realtime, or Edge Functions").
CREATE TABLE filing_documents (
  id                bigserial PRIMARY KEY,
  filing_session_id uuid NOT NULL REFERENCES filing_sessions (filing_session_id),
  order_id          uuid NOT NULL REFERENCES orders (order_id),

  document_type     text NOT NULL DEFAULT 'articles_of_organization'
                       CHECK (document_type IN ('articles_of_organization')),
  content_type      text NOT NULL DEFAULT 'application/pdf',
  byte_size         integer NOT NULL,
  sha256            text NOT NULL,
  pdf_bytes         bytea NOT NULL,

  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_filing_documents_order ON filing_documents (order_id);
CREATE INDEX idx_filing_documents_session ON filing_documents (filing_session_id);

COMMENT ON TABLE filing_documents IS
  'The authoritative retained PDF artifact. One row per fulfillment attempt (fresh regeneration each attempt, never mutated) — fulfillment_transmissions.document_id points at the exact bytes actually transmitted for that attempt.';

-- fulfillment_transmissions — one row per EXPLICIT transmission attempt.
-- Mirrors registered_agent_acceptances (migration 0005): a single status
-- column on the parent row (orders.fulfillment_status) remains the fast,
-- authoritative "is this order done" read; this table is the full,
-- append-style history a retry can add to without ever mutating a prior
-- attempt's record. UNIQUE(order_id, attempt_number) is the idempotency
-- backstop: two processes racing to record the SAME attempt cannot both
-- succeed, and a genuine new attempt (an explicit retry) always gets a
-- new, higher attempt_number — never overwrites a previous one.
CREATE TABLE fulfillment_transmissions (
  id                      bigserial PRIMARY KEY,
  order_id                uuid NOT NULL REFERENCES orders (order_id),
  filing_session_id       uuid NOT NULL REFERENCES filing_sessions (filing_session_id),
  -- Nullable: a transmission row is created for every explicit attempt
  -- BEFORE PDF generation runs, so an attempt that fails during PDF
  -- generation itself (never reaches "there is a PDF to send") still
  -- gets a recorded status/failure_reason/attempt_number — it just never
  -- acquires a document. Populated as soon as generation succeeds, prior
  -- to any transmission call.
  document_id             bigint REFERENCES filing_documents (id),

  attempt_number          integer NOT NULL,

  -- 'fax' is the only destination type implemented; the column exists
  -- (rather than being hardcoded as a comment) so a future destination
  -- type (e.g. a direct Sunbiz e-filing API, if one ever exists) is a
  -- new allowed value here, not a schema rewrite.
  destination_type        text NOT NULL DEFAULT 'fax' CHECK (destination_type IN ('fax')),
  -- Both destination columns are populated from configuration
  -- (FULFILLMENT_FAX_DESTINATION_NUMBER / _LABEL env vars) at the moment
  -- of transmission — NEVER a literal in application code. This table
  -- records what was configured *at send time*, so changing the env var
  -- later (e.g. swapping the Phase 1 test number for the real Sunbiz fax
  -- number) never rewrites history for attempts already made.
  destination_label       text,
  destination_value       text NOT NULL,

  provider                text NOT NULL DEFAULT 'telnyx',
  provider_transmission_id text,

  status                  text NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'submitted', 'delivered', 'failed')),
  failure_reason          text,

  -- The one-time-use capability URL Telnyx is given as `media_url` to
  -- fetch this attempt's PDF (GET /api/fax-media/:token — routes/faxMedia.ts).
  -- Same "store the hash, never the raw secret" discipline as
  -- registered_agent_acceptances.acceptance_token_id (migration 0005's
  -- comment) — the raw token exists only in memory and in the URL handed
  -- to the fax provider, never persisted.
  media_access_token_id   text UNIQUE,
  media_access_expires_at timestamptz,

  submitted_at            timestamptz,
  completed_at            timestamptz,

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  UNIQUE (order_id, attempt_number),

  -- Schema-level proof of the "retain the exact PDF that was sent"
  -- requirement: it is structurally impossible for a row to claim it was
  -- submitted/delivered without pointing at the document that was
  -- actually transmitted.
  CHECK (status NOT IN ('submitted', 'delivered') OR document_id IS NOT NULL)
);

CREATE INDEX idx_fulfillment_transmissions_order ON fulfillment_transmissions (order_id);
-- Carries the reconciliation worker's claim query (poll every 'submitted'
-- transmission for a terminal provider status).
CREATE INDEX idx_fulfillment_transmissions_status ON fulfillment_transmissions (status);
CREATE INDEX idx_fulfillment_transmissions_media_token ON fulfillment_transmissions (media_access_token_id);

CREATE TRIGGER trg_fulfillment_transmissions_updated_at
  BEFORE UPDATE ON fulfillment_transmissions
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE fulfillment_transmissions IS
  'One row per explicit fax transmission attempt. Written only by fulfillment/fulfillmentWorker.ts. Never mutated to represent a different attempt — a retry always inserts a new row with the next attempt_number.';

-- Backoff scheduling for a failed attempt awaiting retry, reusing the
-- exact convention orders.fulfillment_status already established
-- (migration 0010) and the same naming as crm_sync_queue.run_after
-- (migration 0003) — NULL/past = eligible now. Read by the fulfillment
-- claim query alongside fulfillment_status = 'ready'.
ALTER TABLE orders ADD COLUMN fulfillment_run_after timestamptz;

COMMENT ON COLUMN orders.fulfillment_run_after IS
  'Backoff gate for the fulfillment worker''s claim query (fulfillment/fulfillmentWorker.ts) — reuses sync/backoff.ts''s existing schedule. NULL or a past timestamp means eligible now.';
