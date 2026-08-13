-- crm_sync_queue — every Zoho CRM write is queued here and processed
-- asynchronously by the sync worker, never inline with the request that
-- created the session/event write (standing rule: a CRM failure must
-- never block the user). Enqueued in the SAME transaction as the
-- filing_sessions/filing_events write that triggered it.
--
-- Backoff schedule (enforced in application code, not here):
--   attempt 1 fails -> retry in  1m
--   attempt 2 fails -> retry in  5m
--   attempt 3 fails -> retry in 15m
--   attempt 4 fails -> retry in  1h
--   attempt 5 fails -> retry in  6h
--   attempt 6 fails -> retry in 24h
--   attempt 6's retry also fails -> dead_letter (max_attempts defaults to 6)
-- A 401 triggers one immediate token-refresh + retry that does NOT
-- increment `attempts` — see server/src/sync/worker.ts.

CREATE TABLE crm_sync_queue (
  id                  bigserial PRIMARY KEY,
  filing_session_id   uuid NOT NULL REFERENCES filing_sessions (filing_session_id),
  sync_type           text NOT NULL,
  payload_snapshot    jsonb NOT NULL,
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'processing', 'synced', 'failed', 'dead_letter')),
  attempts            integer NOT NULL DEFAULT 0,
  max_attempts        integer NOT NULL DEFAULT 6,
  run_after           timestamptz NOT NULL DEFAULT now(),
  locked_at           timestamptz,
  locked_by           text,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- The job-claiming query filters on status + run_after and orders by
-- run_after — this index carries that query directly.
CREATE INDEX idx_crm_sync_queue_claim ON crm_sync_queue (status, run_after);
CREATE INDEX idx_crm_sync_queue_session ON crm_sync_queue (filing_session_id);

CREATE TRIGGER trg_crm_sync_queue_updated_at
  BEFORE UPDATE ON crm_sync_queue
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
