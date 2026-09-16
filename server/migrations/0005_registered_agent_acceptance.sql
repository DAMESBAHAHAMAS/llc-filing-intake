-- Registered-agent acceptance workflow. Purely additive: one new nullable
-- column on filing_sessions, one new table. No existing column, table, or
-- row touched or rewritten. Reversible (DROP TABLE / DROP COLUMN). Not
-- destructive.
--
-- registered_agent_status lives on filing_sessions itself (matches the
-- existing pattern of payment_status/crm_sync_status on the same table)
-- because the filing gate (Gate 2 §6) needs a single, fast, authoritative
-- read to decide whether a filing may proceed — it should not have to
-- join out to a history table to answer "is this filing's registered
-- agent accepted?".
--
-- registered_agent_acceptances is a separate table, not a jsonb field on
-- filing_sessions or a reuse of name_check_results/filing_data, because:
--   1. It needs a fast, safe, unauthenticated lookup by acceptance token
--      (the public accept/decline endpoints have no other way to find the
--      filing session) — that needs a real indexed/unique column, not a
--      jsonb scan.
--   2. §7 requires the ability to "issue a new acceptance request without
--      creating a duplicate filing session" after an expiry/decline/
--      email failure — i.e. more than one acceptance attempt can exist
--      per filing session over time. A single jsonb field can hold only
--      one record; a table holds the full history §9 (auditability)
--      needs, with filing_sessions.registered_agent_status remaining the
--      single current-truth field the filing gate reads.
CREATE TABLE registered_agent_acceptances (
  id                      bigserial PRIMARY KEY,
  filing_session_id       uuid NOT NULL REFERENCES filing_sessions (filing_session_id),

  status                  text NOT NULL CHECK (
                            status IN ('pending', 'acceptance_requested', 'accepted', 'declined', 'expired', 'email_failed')
                          ),
  requested_at            timestamptz,
  accepted_at             timestamptz,
  registered_agent_name   text NOT NULL,
  registered_agent_email  text NOT NULL,
  accepted_ip             text,

  -- Per the locked schema: "Do not store a raw reusable token if the
  -- security architecture supports hashed token storage." This column
  -- holds sha256(raw secret token) — a deterministic identifier derived
  -- from the token, never the raw secret itself. The raw secret exists
  -- only in the emailed link and in memory for the instant a request is
  -- verified; it is never persisted anywhere. Unique so a hash can never
  -- collide across two live acceptance records.
  acceptance_token_id     text NOT NULL UNIQUE,
  acceptance_version      text NOT NULL,

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- The accept/decline endpoints' only lookup path.
CREATE INDEX idx_registered_agent_acceptances_token ON registered_agent_acceptances (acceptance_token_id);
-- History-per-filing-session lookups (auditability, reissuance).
CREATE INDEX idx_registered_agent_acceptances_session ON registered_agent_acceptances (filing_session_id, created_at);

CREATE TRIGGER trg_registered_agent_acceptances_updated_at
  BEFORE UPDATE ON registered_agent_acceptances
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

ALTER TABLE filing_sessions ADD COLUMN registered_agent_status text CHECK (
  registered_agent_status IS NULL
  OR registered_agent_status IN ('pending', 'acceptance_requested', 'accepted', 'declined', 'expired', 'email_failed')
);
-- NULL is the seventh, implicit state: "registered agent not chosen yet"
-- — distinct from all six authoritative values above, which all describe
-- a designation that has actually been made.

COMMENT ON COLUMN filing_sessions.registered_agent_status IS
  'Authoritative status the Gate 2 filing gate reads. NULL = no registered agent selected yet. See registered_agent_acceptances for the durable request/response history.';
