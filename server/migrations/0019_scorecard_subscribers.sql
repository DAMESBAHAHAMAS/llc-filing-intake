-- Scorecard lead funnel (SA4-T38): one row per sign-up, plus the five
-- scheduled emails (day 0, 2, 4, 7, 10). Unsubscribe is a timestamp on the
-- subscriber; the sender skips every pending email for an unsubscribed row.

CREATE TABLE scorecard_subscribers (
  id                 bigserial PRIMARY KEY,
  email              text NOT NULL,
  first_name         text NOT NULL,
  country            text NOT NULL,
  llc_status         text NOT NULL,
  lead_intent        text NOT NULL,
  utm_source         text,
  utm_medium         text,
  utm_campaign       text,
  utm_content        text,
  is_test            boolean NOT NULL DEFAULT false,
  unsubscribe_token  text NOT NULL UNIQUE,
  unsubscribed_at    timestamptz,
  crm_lead_id        text,
  crm_synced_at      timestamptz,
  crm_attempts       integer NOT NULL DEFAULT 0,
  crm_next_at        timestamptz NOT NULL DEFAULT now(),
  crm_last_error     text,
  preview_sent_at    timestamptz,
  signed_up_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX scorecard_subscribers_email_idx ON scorecard_subscribers (lower(email));

CREATE TABLE scorecard_emails (
  id                   bigserial PRIMARY KEY,
  subscriber_id        bigint NOT NULL REFERENCES scorecard_subscribers (id),
  step                 integer NOT NULL CHECK (step BETWEEN 1 AND 5),
  -- 0 for the scheduled email; 1, 2, 3 for a Scorecard re-send after a repeat sign-up.
  seq                  integer NOT NULL DEFAULT 0,
  send_at              timestamptz NOT NULL,
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts             integer NOT NULL DEFAULT 0,
  claimed_at           timestamptz,
  sent_at              timestamptz,
  provider_message_id  text,
  last_error           text,
  UNIQUE (subscriber_id, step, seq)
);

CREATE INDEX scorecard_emails_due_idx ON scorecard_emails (send_at) WHERE status = 'pending';

-- Same convention as every other table here: RLS on, no policies. The service
-- connects directly as the table owner; nothing is readable through the public API.
ALTER TABLE scorecard_subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE scorecard_emails ENABLE ROW LEVEL SECURITY;
