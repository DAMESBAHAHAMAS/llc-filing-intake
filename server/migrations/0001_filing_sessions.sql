-- filing_sessions — the durable, primary record for a single visitor's
-- journey through the funnel. Written before any downstream Zoho sync is
-- attempted (standing rule: CRM is a downstream sync target, not the
-- system of record). filing_session_id is minted server-side by the
-- application (POST /api/session/stage) before any PII exists — the
-- DEFAULT here is a safety net, not the primary generation path.

CREATE TABLE filing_sessions (
  filing_session_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  current_stage           text,
  email                   text,
  phone                   text,
  full_name               text,
  country                 text,
  entity_name_primary     text,
  entity_name_backup      text,
  name_check_results      jsonb,

  order_total_cents       integer,
  payment_status          text,
  payment_ref             text,

  pdf_generated_at        timestamptz,
  pdf_storage_ref         text,

  crm_lead_id             text,
  crm_deal_id             text,
  crm_sync_status         text,
  crm_last_synced_at      timestamptz,

  utm_source              text,
  utm_medium              text,
  utm_campaign            text,

  abandoned_at            timestamptz
);

CREATE INDEX idx_filing_sessions_email ON filing_sessions (email) WHERE email IS NOT NULL;
CREATE INDEX idx_filing_sessions_current_stage ON filing_sessions (current_stage);
CREATE INDEX idx_filing_sessions_crm_sync_status ON filing_sessions (crm_sync_status);

-- Keep updated_at honest on every UPDATE, independent of application code
-- remembering to set it.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_filing_sessions_updated_at
  BEFORE UPDATE ON filing_sessions
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
