-- T144 Dispatch 12: the registered agent's signed acceptance, kept server-side.
--
-- The agent types their full name under the statutory statement on the
-- acceptance page (POST /api/registered-agent/accept). The signature and its
-- audit details live on the acceptance row, which only the token holder's
-- accept call writes, never in the client-writable filing_sessions.filing_data.
-- accepted_at and accepted_ip already exist (0005).
--
-- accepted_agent_name / accepted_agent_address / accepted_llc_name record what
-- the agent accepted. The Articles print the agent's signature only while the
-- filing still names that same agent at that same address.
--
-- Additive and nullable. The accept route works before this is applied (the
-- signature is then not stored, and is not required unless
-- RA_ACCEPT_REQUIRE_SIGNATURE=true).

ALTER TABLE registered_agent_acceptances
  ADD COLUMN IF NOT EXISTS signature_name text,
  ADD COLUMN IF NOT EXISTS signature_consent boolean,
  ADD COLUMN IF NOT EXISTS accepted_user_agent text,
  ADD COLUMN IF NOT EXISTS statement_version text,
  ADD COLUMN IF NOT EXISTS accepted_agent_name text,
  ADD COLUMN IF NOT EXISTS accepted_agent_address text,
  ADD COLUMN IF NOT EXISTS accepted_llc_name text;

COMMENT ON COLUMN registered_agent_acceptances.signature_name IS
  'The agent''s typed full name (T144 D12). NULL for a button-only acceptance.';
