-- ST17 (A6Y2-T144 item 6): EIN / Form SS-4 onboarding submissions.
--
-- One row per filing session, written only after the passport photo page has
-- reached the customer's Zoho Deal. The passport image itself is NEVER stored
-- here (or anywhere on this server): only its fingerprint and the Zoho
-- attachment id, so the team can find it and prove which file was received.
--
-- The e-signature is the typed name plus the server's own clock and the
-- client IP / user agent seen by this server. The attestation text the
-- customer saw is identified by version and a SHA-256 of the exact text.
-- No SSN or ITIN column exists, by design: the customer confirms they have none.

CREATE TABLE ein_onboarding_submissions (
  filing_session_id         uuid PRIMARY KEY REFERENCES filing_sessions(filing_session_id),
  order_id                  uuid REFERENCES orders(order_id),
  responsible_party         jsonb NOT NULL,
  no_ssn_confirmed          boolean NOT NULL CHECK (no_ssn_confirmed),

  passport_sha256           text NOT NULL,
  passport_bytes            integer NOT NULL,
  passport_content_type     text NOT NULL,
  zoho_deal_id              text NOT NULL,
  zoho_attachment_id        text,

  signature_typed_name      text NOT NULL,
  attestation_version       text NOT NULL,
  attestation_sha256        text NOT NULL,
  signed_at                 timestamptz NOT NULL DEFAULT now(),
  signer_ip                 text NOT NULL,          -- client IP as forwarded by the edge (True-Client-IP)
  signer_proxy_ip           text,                   -- the socket/proxy address Express saw, for cross-checking
  signer_user_agent         text,

  -- 'uploading' while the passport goes to Zoho (the row is claimed first so a
  -- double submit cannot upload twice), then done_field / done_note / failed.
  crm_status                text NOT NULL DEFAULT 'uploading',
  crm_error                 text,
  created_at                timestamptz NOT NULL DEFAULT now()
);

-- Same rule as every other table (DECISIONS.md, RLS): no Supabase anon/authenticated
-- access. Only the data spine's own connection (which bypasses RLS) reads or writes it.
ALTER TABLE ein_onboarding_submissions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ein_onboarding_submissions IS
  'ST17 EIN onboarding. Passport image lives only on the Zoho Deal; this row holds metadata, the Responsible Party and the e-signature record.';
