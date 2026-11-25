-- ST17 (A6Y2-T144 item 6): EIN onboarding through the Zoho CRM Portal.
--
-- Owner decision (25 Nov 2026): identity documents are collected through the
-- Zoho CRM Portal and stored only in Zoho CRM (Deal field Passport_Photo_Page).
-- This table holds NO identity data and no file. One row per Zoho Deal that
-- carries an EIN order (the passport lives on the Deal, so invites and
-- retention are decided per Deal, not per order). Written only by
-- ein/portalJobs.ts.

CREATE TABLE ein_portal_deals (
  zoho_deal_id        text PRIMARY KEY,
  filing_session_id   uuid NOT NULL REFERENCES filing_sessions(filing_session_id),
  first_order_id      uuid NOT NULL REFERENCES orders(order_id),

  -- Portal invite. pending: not yet sent (or interrupted); invited: Zoho
  -- accepted it (or the Contact was already a portal user); failed: retried
  -- after an hour; blocked: needs a person (no Contact on the Deal, email
  -- mismatch, or too many failures).
  invite_status       text NOT NULL DEFAULT 'pending'
                      CHECK (invite_status IN ('pending', 'invited', 'failed', 'blocked')),
  invite_attempts     integer NOT NULL DEFAULT 0,
  invite_claimed_at   timestamptz,
  invited_at          timestamptz,
  zoho_contact_id     text,

  -- Sweep state. closed_seen_at: when the sweep first saw the Deal cancelled
  -- or refunded (cleared again if that stops being true), so later edits to
  -- the Deal can never restart the 30 days.
  docs_received_at    timestamptz,
  closed_seen_at      timestamptz,
  passport_purged_at  timestamptz,
  next_check_at       timestamptz NOT NULL DEFAULT now(),
  retired_at          timestamptz,
  last_error          text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ein_portal_deals_sweep_idx ON ein_portal_deals (next_check_at) WHERE retired_at IS NULL;
CREATE INDEX ein_portal_deals_invite_idx ON ein_portal_deals (invite_status) WHERE invite_status IN ('pending', 'failed');

-- Same convention as every other table: RLS on, no policies, so only the
-- service role used by this server can read or write it.
ALTER TABLE ein_portal_deals ENABLE ROW LEVEL SECURITY;
