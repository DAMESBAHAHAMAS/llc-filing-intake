-- filing_documents — the authoritative retained PDF artifact. One row
-- per fulfillment attempt (fresh regeneration each attempt, never
-- mutated) — fulfillment_transmissions.document_id points at the exact
-- bytes actually transmitted for that attempt. pdf_bytes is stored
-- directly in Postgres (bytea) — see DECISIONS.md decision-boundary #1
-- (PDF durable storage/serving target) for the open tradeoff discussion;
-- this is one candidate, not a final architectural commitment.
--
-- fulfillment_transmissions — one row per explicit fax transmission
-- attempt (Articles of Organization to the state/IRS). Written only by
-- fulfillment/fulfillmentWorker.ts. Never mutated to represent a
-- different attempt — a retry always inserts a new row with the next
-- attempt_number. media_access_token_id/media_access_expires_at back a
-- signed, expiring download endpoint for the fax provider to fetch the
-- document from (provider defaults to 'telnyx').
--
-- RECONSTRUCTED, 2026-09-09: applied live on 2026-09-01, no file
-- committed until now. See DECISIONS.md, "Schema/migration drift" entry.

CREATE TABLE filing_documents (
  id                  bigserial PRIMARY KEY,
  filing_session_id   uuid NOT NULL REFERENCES filing_sessions (filing_session_id),
  order_id            uuid NOT NULL REFERENCES orders (order_id),
  document_type       text NOT NULL DEFAULT 'articles_of_organization'
                        CHECK (document_type = 'articles_of_organization'),
  content_type        text NOT NULL DEFAULT 'application/pdf',
  byte_size           integer NOT NULL,
  sha256              text NOT NULL,
  pdf_bytes           bytea NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE filing_documents IS
  'The authoritative retained PDF artifact. One row per fulfillment attempt (fresh regeneration each attempt, never mutated) — fulfillment_transmissions.document_id points at the exact bytes actually transmitted for that attempt.';

CREATE INDEX idx_filing_documents_session ON filing_documents (filing_session_id);
CREATE INDEX idx_filing_documents_order ON filing_documents (order_id);

ALTER TABLE filing_documents ENABLE ROW LEVEL SECURITY;

CREATE TABLE fulfillment_transmissions (
  id                          bigserial PRIMARY KEY,
  order_id                    uuid NOT NULL REFERENCES orders (order_id),
  filing_session_id           uuid NOT NULL REFERENCES filing_sessions (filing_session_id),
  document_id                 bigint REFERENCES filing_documents (id),
  attempt_number              integer NOT NULL,
  destination_type            text NOT NULL DEFAULT 'fax' CHECK (destination_type = 'fax'),
  destination_label           text,
  destination_value           text NOT NULL,
  provider                    text NOT NULL DEFAULT 'telnyx',
  provider_transmission_id    text,
  status                      text NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'submitted', 'delivered', 'failed')),
  failure_reason              text,
  media_access_token_id       text UNIQUE,
  media_access_expires_at     timestamptz,
  submitted_at                timestamptz,
  completed_at                timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fulfillment_transmissions_check
    CHECK (status NOT IN ('submitted', 'delivered') OR document_id IS NOT NULL),
  CONSTRAINT fulfillment_transmissions_order_id_attempt_number_key
    UNIQUE (order_id, attempt_number)
);

COMMENT ON TABLE fulfillment_transmissions IS
  'One row per explicit fax transmission attempt. Written only by fulfillment/fulfillmentWorker.ts. Never mutated to represent a different attempt — a retry always inserts a new row with the next attempt_number.';

CREATE INDEX idx_fulfillment_transmissions_order ON fulfillment_transmissions (order_id);
CREATE INDEX idx_fulfillment_transmissions_status ON fulfillment_transmissions (status);
CREATE INDEX idx_fulfillment_transmissions_media_token ON fulfillment_transmissions (media_access_token_id);

CREATE TRIGGER trg_fulfillment_transmissions_updated_at
  BEFORE UPDATE ON fulfillment_transmissions
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

ALTER TABLE fulfillment_transmissions ENABLE ROW LEVEL SECURITY;
