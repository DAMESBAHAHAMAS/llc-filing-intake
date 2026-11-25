-- T144 Dispatch 10: the Operating Agreement (and, once approved, the Banking
-- Resolution) generated for Bank-Ready and Finance-Ready filings, and the
-- deliverable status copied to the Zoho Deal (Deals.Operating_Agreement_Stat).
-- Additive. Numbered 0034 because 0033 is taken by the registered-agent
-- signature migration (llc-filing-intake#30).

-- One status row per verified Zoho Deal (formation/operatingAgreementJob.ts).
CREATE TABLE IF NOT EXISTS operating_agreement_status (
  crm_deal_id         text PRIMARY KEY,
  filing_session_id   uuid NOT NULL,
  -- The held or paid order whose package includes the agreement (NULL when none does).
  order_id            uuid,
  status              text NOT NULL
                        CHECK (status IN ('Not Included', 'Pending Generation', 'Generated', 'Delivered')),
  deal_synced_status  text,
  last_error          text,
  alerted_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Generated documents, kept server-side. Nothing is sent from here.
CREATE TABLE IF NOT EXISTS formation_documents (
  id                  bigserial PRIMARY KEY,
  order_id            uuid NOT NULL,
  filing_session_id   uuid NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('operating_agreement', 'banking_resolution')),
  template            text NOT NULL,
  draft               boolean NOT NULL,
  byte_size           integer NOT NULL,
  sha256              text NOT NULL,
  pdf_bytes           bytea NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, kind)
);

ALTER TABLE operating_agreement_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE formation_documents ENABLE ROW LEVEL SECURITY;
