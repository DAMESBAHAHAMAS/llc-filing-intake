-- A6Y2-T144 Dispatch 13: the post-filing roadmap on the Thank You page (ST17).
--
-- One row per filing session: which of the three post-filing topics the
-- customer flagged on /checkout/success, plus their optional note for the
-- licence and permit check. Written by routes/postFilingInterests.ts; the
-- job in postFiling/interests.ts copies it to the Zoho Deal field
-- Post_Filing_Interests (multi-select) and adds the note as a Deal note.
-- No identity data. Additive only; no existing table changes.
--
-- version / synced_version: every change bumps version; the job records the
-- version it copied to Zoho, so a change made while a copy is in flight is
-- copied on the next pass instead of being lost.

CREATE TABLE post_filing_interests (
  filing_session_id  uuid PRIMARY KEY REFERENCES filing_sessions(filing_session_id),

  bank_account       boolean NOT NULL DEFAULT false,
  licenses_permits   boolean NOT NULL DEFAULT false,
  tax_compliance     boolean NOT NULL DEFAULT false,
  license_note       text CHECK (license_note IS NULL OR char_length(license_note) <= 500),

  version            integer NOT NULL DEFAULT 1,
  synced_version     integer NOT NULL DEFAULT 0,
  note_synced        text,
  zoho_deal_id       text,
  crm_attempts       integer NOT NULL DEFAULT 0,
  crm_claimed_at     timestamptz,
  next_sync_at       timestamptz NOT NULL DEFAULT now(),
  crm_synced_at      timestamptz,
  -- Set when the copy needs a person (no verified Deal after every retry,
  -- or Zoho refused the write); an ops alert is sent once.
  crm_blocked_at     timestamptz,
  last_error         text,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX post_filing_interests_sync_idx ON post_filing_interests (next_sync_at)
  WHERE synced_version < version AND crm_blocked_at IS NULL;

-- Same convention as every other table: RLS on, no policies, so only the
-- service role used by this server can read or write it.
ALTER TABLE post_filing_interests ENABLE ROW LEVEL SECURITY;
