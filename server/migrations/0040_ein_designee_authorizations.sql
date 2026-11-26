-- ST17 / A6Y2-T144: the customer's e-signature authorizing Damian Knowles as
-- Third-Party Designee on IRS Form SS-4 (wording approved by Damian, 26 Nov 2026).
--
-- Written only by POST /api/ein/designee-authorization (routes/einDesignee.ts),
-- which is off until EIN_DESIGNEE_ESIGN_ENABLED=true. The server supplies the
-- statement version, its full text and SHA-256, the signing time, the IP and the
-- user agent; the customer supplies only their typed name and optional title.
-- One row per session and statement version: the first signature stands.
-- No identity documents. Additive only; no existing table changes.

CREATE TABLE ein_designee_authorizations (
  id                    bigserial PRIMARY KEY,
  filing_session_id     uuid NOT NULL REFERENCES filing_sessions(filing_session_id),
  -- The held or paid order the signing page was opened from.
  order_id              uuid NOT NULL REFERENCES orders(order_id),

  statement_version     text NOT NULL,
  statement_text        text NOT NULL,
  statement_sha256      text NOT NULL,

  signer_name           text NOT NULL,
  signer_title          text,
  -- The LLC name shown above the statement (SS-4 line 1).
  entity_name           text NOT NULL,
  consent               boolean NOT NULL,

  -- Server time, never the browser's clock.
  signed_at             timestamptz NOT NULL,
  -- Clause 1: one year after signing (sooner if the EIN is assigned first).
  authority_expires_at  timestamptz NOT NULL,
  ip                    text,
  user_agent            text,

  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ein_designee_authorizations_one_per_version UNIQUE (filing_session_id, statement_version),
  CONSTRAINT ein_designee_authorizations_consent CHECK (consent)
);

-- Same convention as every other table: RLS on, no policies, so only the
-- service role used by this server can read or write it.
ALTER TABLE ein_designee_authorizations ENABLE ROW LEVEL SECURITY;
