-- T144 D12 re-review follow-up: what the acceptance email named, kept on the
-- request row when the email is sent (registeredAgent/acceptanceEmail.ts).
-- The accept step records and the details page shows these server-written
-- values, not the client-writable filing_data at click time.
-- Additive and nullable; requests sent before this is applied fall back to
-- filing_data as before. Numbered 0035 because 0034 is taken by #32.
ALTER TABLE registered_agent_acceptances
  ADD COLUMN IF NOT EXISTS requested_agent_address text,
  ADD COLUMN IF NOT EXISTS requested_llc_name text;
