-- Offer Master. Closes the gap flagged in the Gate 2 handoff brief: the
-- browser must only ever send line-item/offer IDENTIFIERS, never an
-- amount/total/price/discount/fee — the server resolves identifiers
-- against this approved commercial catalog. An "offer" is a versioned
-- record, not just a price field: price changes create a NEW version
-- (a new row), the old version's row is never edited, and a historical
-- order keeps whatever offer_code+offer_version it actually paid for
-- (see orders.line_items, which snapshots this at sale time).
--
-- stripe_price_id is the only thing that actually determines what Stripe
-- charges (standing rule: Prices are Stripe Price IDs, never a number
-- computed/stored client-side). unit_amount_cents here is informational
-- only, for display/reporting without a live Stripe round-trip — if it
-- and the live Stripe Price ever disagree, Stripe wins, always.
--
-- Discovery, not invention: every stripe_product_id/stripe_price_id
-- seeded below is a REAL, pre-existing object in the connected Stripe
-- account (acct_1ChHmZDo01bXdbWS, test mode), found via the Stripe MCP
-- before writing this file — a parallel piece of schema/catalog drift to
-- the Supabase one, see DECISIONS.md "Stripe catalog drift" entry. No
-- new Stripe objects were created to seed this table.

CREATE TABLE offers (
  id                  bigserial PRIMARY KEY,
  offer_code          text NOT NULL,
  offer_version       text NOT NULL,
  display_name        text NOT NULL,
  crm_intent          text NOT NULL,
  stripe_product_id   text NOT NULL,
  stripe_price_id     text NOT NULL,
  unit_amount_cents   integer NOT NULL,
  currency            text NOT NULL DEFAULT 'usd',
  internal_cost_cents integer,
  inclusions          jsonb NOT NULL DEFAULT '[]'::jsonb,
  exclusions          jsonb NOT NULL DEFAULT '[]'::jsonb,
  sla_clock_start     text,
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'active', 'retired')),
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE (offer_code, offer_version)
);

-- At most one ACTIVE version per offer_code at any time — "an offer
-- version is a record" means old versions retire (status='retired'),
-- they don't get overwritten, and exactly one version is sellable at
-- once. Checkout resolution only ever selects status='active' rows.
CREATE UNIQUE INDEX idx_offers_one_active_per_code ON offers (offer_code) WHERE status = 'active';
CREATE INDEX idx_offers_status ON offers (status);

CREATE TRIGGER trg_offers_updated_at
  BEFORE UPDATE ON offers
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

ALTER TABLE offers ENABLE ROW LEVEL SECURITY;

-- Seed data: real Stripe test-mode objects, verified via the Stripe MCP
-- on 2026-09-09 (GetProducts/GetPrices against acct_1ChHmZDo01bXdbWS).
--
-- EIN_FILING_EXPRESS is seeded as 'draft', NOT 'active': its Stripe Price
-- (price_1UDKNXDo01bXdbWShnKPln1A, $449.00) carries product metadata
-- pricing_status="PLACEHOLDER_PENDING_DAMIAN_CONFIRMATION" — i.e. someone
-- already flagged this exact price as unconfirmed. The checkout resolver
-- only sells 'active' offers, so this cannot be sold until a human flips
-- it to active after confirming the price. Not silently treated as final.
INSERT INTO offers
  (offer_code, offer_version, display_name, crm_intent, stripe_product_id, stripe_price_id, unit_amount_cents, internal_cost_cents, inclusions, exclusions, sla_clock_start, status, notes)
VALUES
  ('DIY_STATE_FEE', 'v1', 'Florida LLC State Filing Fee', 'LLC_FORMATION_DIY',
   'prod_V8sQl51S7usjjb', 'price_1U9HsDDo01bXdbWStkpesATi', 12500, NULL,
   '["Florida $125 statutory state filing fee, passed through in full"]'::jsonb,
   '["No service markup — this is the state''s fee, not ours"]'::jsonb,
   'on_payment_confirmed', 'active',
   'Always sold together with DIY_SERVICE_FEE and DIY_CERT_OF_STATUS as the 3-item DIY bundle (125+4+5=$134).'),

  ('DIY_SERVICE_FEE', 'v1', 'DIY Processing / Service Fee', 'LLC_FORMATION_DIY',
   'prod_V9b4rBVgiREeGZ', 'price_1U9HsRDo01bXdbWSHUSLnbcO', 400, NULL,
   '[]'::jsonb, '[]'::jsonb, NULL, 'active',
   'Flat $4, not a computed Stripe-processing-fee percentage — see DECISIONS.md decision-boundary #2 note: this appears to already answer the "exact surcharge mechanism" question as a flat passthrough line item, found rather than decided this session; still listed as an open boundary pending explicit confirmation.'),

  ('DIY_CERT_OF_STATUS', 'v1', 'Certificate of Status (Included)', 'LLC_FORMATION_DIY',
   'prod_VDjfuXPnp9Vx30', 'price_1UDICPDo01bXdbWSTIEpJakS', 500, NULL,
   '["Florida $5 Certificate of Status fee, included standard on every DIY filing"]'::jsonb,
   '[]'::jsonb, 'on_payment_confirmed', 'active',
   'Stripe product description states this is standard/included for DIY, not optional. Whether the equivalent is bundled inside FastTrack/Premium''s single price is UNRESOLVED — decision boundary #5.'),

  ('DIY_CERTIFIED_COPY_ADDON', 'v1', 'Certified Copy of Articles (Optional Add-on)', 'LLC_FORMATION_DIY',
   'prod_VDjfjDEzb977sk', 'price_1UDICWDo01bXdbWSZJc68MVg', 3000, NULL,
   '["Certified copy of filed Articles of Organization direct from Sunbiz"]'::jsonb,
   '["Not included by default — customer must add at checkout"]'::jsonb,
   NULL, 'active', 'Optional, customer-selectable.'),

  ('FASTTRACK', 'v1', 'Florida LLC Formation — FastTrack', 'LLC_FORMATION_FASTTRACK',
   'prod_V8sQ6KcbIq0d9w', 'price_1U8ag7Do01bXdbWSrDQBWI8H', 49900, NULL,
   '["Articles of Organization prepared and filed", "Florida $125 state filing fee included", "Business name availability checked before filing", "Filed formation documents delivered digitally", "Email support through filing"]'::jsonb,
   '["EIN filing", "Registered agent service beyond statutory designation", "Company Credentials Kit"]'::jsonb,
   'on_payment_confirmed', 'active', 'Single bundled Stripe Price — not itemized. $499 = $374 service + $125 state fee per the frozen pricing brief.'),

  ('PREMIUM', 'v1', 'Florida LLC Formation — Premium', 'LLC_FORMATION_PREMIUM',
   'prod_V8sRO1rlCP2jfq', 'price_1U8agADo01bXdbWSN7stU2LF', 99900, NULL,
   '["Everything in FastTrack", "Federal EIN filing", "3 years Florida registered agent service", "Company Credentials Kit", "Custom Operating Agreement", "Member certificates and member ledger"]'::jsonb,
   '[]'::jsonb,
   'on_payment_confirmed', 'active', 'Single bundled Stripe Price — not itemized. $999 = $874 service + $125 state fee per the frozen pricing brief.'),

  ('EIN_FILING', 'v1', 'EIN Filing Service (Standard)', 'EIN_FILING',
   'prod_V8sREQTQ0GC3Za', 'price_1U8agEDo01bXdbWSFyTsJj7n', 29900, NULL,
   '["IRS Form SS-4 prepared and filed", "EIN confirmation letter delivered"]'::jsonb,
   '["Same-day issuance — see EIN_FILING_EXPRESS"]'::jsonb,
   'on_payment_confirmed', 'active', 'No government fee component — EIN issuance itself is free from the IRS.'),

  ('EIN_FILING_EXPRESS', 'v1', 'EIN Filing Service — Express (Same-Day)', 'EIN_FILING_EXPRESS',
   'prod_VDlv9FbHrhq4S8', 'price_1UDKNXDo01bXdbWShnKPln1A', 44900, NULL,
   '["Same-day IRS Form SS-4 filing, subject to daily capacity", "Personal document verification before filing", "Same-business-day EIN confirmation letter"]'::jsonb,
   '["Availability gated by the daily same-day capacity governor (20-25 slots/day)"]'::jsonb,
   'on_same_day_capacity_confirmed', 'draft',
   'NOT SELLABLE (status=draft): Stripe product metadata itself flags pricing_status=PLACEHOLDER_PENDING_DAMIAN_CONFIRMATION on this exact price. Do not flip to active without explicit price confirmation.'),

  ('REGISTERED_AGENT_3YR', 'v1', 'Florida Registered Agent Service — 3 Years', 'REGISTERED_AGENT',
   'prod_V8tUh6KAuva6qr', 'price_1U8bhUDo01bXdbWSAa44IhWf', 10000, NULL,
   '["3 years of Florida registered agent service", "First year included at no charge"]'::jsonb,
   '[]'::jsonb, NULL, 'active',
   'Path A / house RA service pricing (server-stamped RA identity — see DECISIONS.md registered-agent handling, not this row).'),

  ('CREDENTIALS_KIT', 'v1', 'Company Credentials Kit', 'CREDENTIALS_KIT',
   'prod_V8u53g3W9fUUNd', 'price_1U8esRDo01bXdbWSoR1I3imJ', 8900, NULL,
   '["Records binder with custom company seal", "Custom-printed Articles of Organization", "Operating Agreement", "Member certificates and member ledger"]'::jsonb,
   '[]'::jsonb, NULL, 'active',
   'v2 "launch price, thin margin by design" per Stripe price metadata — an earlier $147 price (price_1U8cHmDo01bXdbWSnNaHuaPS) is inactive in Stripe, not carried into this table.');
