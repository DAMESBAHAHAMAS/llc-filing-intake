-- Registered agent acceptance flow (Path B — customer's own RA).
-- Typing a name into a form is not acceptance: this table is the durable
-- record of an actual acceptance action (an emailed link + token, gating
-- the filing on a real response) for a customer-provided registered
-- agent. filing_sessions.registered_agent_status is the fast-read
-- authoritative status the Gate 2 filing gate checks; this table is the
-- full request/response history behind it (can have multiple rows per
-- session across retries/resends).
--
-- RECONSTRUCTED, 2026-09-09: applied live on 2026-08-27, no file
-- committed until now. See DECISIONS.md, "Schema/migration drift" entry.

CREATE TABLE registered_agent_acceptances (
  id                        bigserial PRIMARY KEY,
  filing_session_id         uuid NOT NULL REFERENCES filing_sessions (filing_session_id),
  status                    text NOT NULL
                              CHECK (status IN ('pending', 'acceptance_requested', 'accepted', 'declined', 'expired', 'email_failed')),
  requested_at              timestamptz,
  accepted_at               timestamptz,
  registered_agent_name     text NOT NULL,
  registered_agent_email    text NOT NULL,
  accepted_ip               text,
  acceptance_token_id       text NOT NULL UNIQUE,
  acceptance_version        text NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_registered_agent_acceptances_session ON registered_agent_acceptances (filing_session_id, created_at);
CREATE INDEX idx_registered_agent_acceptances_token ON registered_agent_acceptances (acceptance_token_id);

CREATE TRIGGER trg_registered_agent_acceptances_updated_at
  BEFORE UPDATE ON registered_agent_acceptances
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

ALTER TABLE registered_agent_acceptances ENABLE ROW LEVEL SECURITY;

-- filing_sessions.registered_agent_status: the fast-read authoritative
-- status the Gate 2 filing gate reads directly (no join required). NULL
-- means no registered agent has been selected yet (Path A/house RA never
-- needs this table at all — see server-authoritative RA stamping in the
-- PDF/order-creation path).
ALTER TABLE filing_sessions ADD COLUMN registered_agent_status text
  CHECK (registered_agent_status IS NULL OR registered_agent_status IN
    ('pending', 'acceptance_requested', 'accepted', 'declined', 'expired', 'email_failed'));

COMMENT ON COLUMN filing_sessions.registered_agent_status IS
  'Authoritative status the Gate 2 filing gate reads. NULL = no registered agent selected yet. See registered_agent_acceptances for the durable request/response history.';
