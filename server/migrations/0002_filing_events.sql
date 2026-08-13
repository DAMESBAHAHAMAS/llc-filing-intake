-- filing_events — append-only audit trail. Every stage transition writes
-- one row here. Never UPDATE or DELETE from this table at the application
-- layer; a correction is a new row, not an edit, the same discipline as
-- this project's GAPS.md/DECISIONS.md registers.

CREATE TABLE filing_events (
  id                  bigserial PRIMARY KEY,
  filing_session_id   uuid NOT NULL REFERENCES filing_sessions (filing_session_id),
  event_type          text NOT NULL,
  payload             jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_filing_events_session ON filing_events (filing_session_id, created_at);
CREATE INDEX idx_filing_events_type ON filing_events (event_type);
