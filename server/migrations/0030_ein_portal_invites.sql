-- ST17 (A6Y2-T144 item 6): EIN onboarding through the Zoho CRM Portal.
--
-- Owner decision (25 Nov 2026): identity documents are collected through the
-- Zoho CRM Portal and stored only in Zoho CRM. This table holds NO identity
-- data and no file: only which order's customer was invited, when, and the
-- timestamps the daily sweep needs (docs received, cancellation first seen,
-- passport cleared). Written only by ein/portalJobs.ts.

CREATE TABLE ein_portal_invites (
  order_id            uuid PRIMARY KEY REFERENCES orders(order_id),
  filing_session_id   uuid NOT NULL REFERENCES filing_sessions(filing_session_id),
  zoho_deal_id        text NOT NULL,
  zoho_contact_id     text,
  -- pending: claimed, invite not yet confirmed; invited: Zoho accepted the
  -- invite; failed: retried on a later tick; blocked: will not succeed
  -- without a person (no Contact on the Deal, or the Contact's email does not
  -- match the customer's).
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'invited', 'failed', 'blocked')),
  attempts            integer NOT NULL DEFAULT 0,
  last_error          text,
  invited_at          timestamptz,
  docs_received_at    timestamptz,
  closed_seen_at      timestamptz,
  passport_purged_at  timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ein_portal_invites_open_idx
  ON ein_portal_invites (status)
  WHERE passport_purged_at IS NULL;

-- Same convention as every other table: RLS on, no policies, so only the
-- service role used by this server can read or write it.
ALTER TABLE ein_portal_invites ENABLE ROW LEVEL SECURITY;
