-- 0016 — Offer Master: apply the 2026-09-17 pricing decision.
--
-- Decision (confirmed by Damian 2026-09-26; see DECISIONS.md 2026-09-17
-- "Package pricing"): DIY $139 ($9 service fee + $130 state fees),
-- FastTrack $499, Premium $999, Registered Agent $98, EIN $299,
-- Credentials Kit $89. The storefront (florida-business-launchpad
-- src/data/offer-catalog.ts, e4abff8) already displays these; this table
-- and Stripe were never updated, so checkout would have charged DIY $134.
--
-- "An offer version is a record" (0012): changed prices get a new v2 row
-- and the v1 row is retired, never overwritten. Rollback: see
-- migrations-rollback/0016_offer_master_pricing_2026_09_17.rollback.sql.
--
-- Changes:
--   DIY_SERVICE_FEE       v1 $4  (price_1U9HsR…)  → v2 $9  (new Stripe price)
--   REGISTERED_AGENT_3YR  v1 $100 (price_1U8bhU…) → v2 $98 (same Stripe price,
--                         which already charges $98 — only the displayed
--                         amount here was stale)
--   EIN_FILING_EXPRESS    v1 draft $449 (price_1UDKNX…, inactive in Stripe)
--                         → v2 active $299 (price_1UE0RY…, Stripe metadata
--                         pricing_status=CONFIRMED_2026-09-10)
-- Unchanged: DIY_STATE_FEE $125, DIY_CERT_OF_STATUS $5, FASTTRACK $499,
-- PREMIUM $999, EIN_FILING $299, CREDENTIALS_KIT $89,
-- DIY_CERTIFIED_COPY_ADDON $30.

-- Guard: the DIY service-fee price is created in Stripe as part of the
-- authorized production change; its id replaces the placeholder below
-- before this file is applied. Refuse to run with the placeholder.
DO $$
BEGIN
  IF '__DIY_SERVICE_FEE_V2_PRICE_ID__' LIKE '\_\_%' THEN
    RAISE EXCEPTION '0016: DIY_SERVICE_FEE v2 Stripe price id placeholder not replaced';
  END IF;
END $$;

UPDATE offers SET status = 'retired'
 WHERE offer_version = 'v1'
   AND offer_code IN ('DIY_SERVICE_FEE', 'REGISTERED_AGENT_3YR', 'EIN_FILING_EXPRESS');

INSERT INTO offers
  (offer_code, offer_version, display_name, crm_intent, stripe_product_id, stripe_price_id, unit_amount_cents, internal_cost_cents, inclusions, exclusions, sla_clock_start, status, notes)
VALUES
  ('DIY_SERVICE_FEE', 'v2', 'DIY Processing / Service Fee', 'LLC_FORMATION_DIY',
   'prod_V9b4rBVgiREeGZ', '__DIY_SERVICE_FEE_V2_PRICE_ID__', 900, NULL,
   '[]'::jsonb, '[]'::jsonb, NULL, 'active',
   'Flat $9. DIY total = 125 (DIY_STATE_FEE) + 9 + 5 (DIY_CERT_OF_STATUS) = $139, per the 2026-09-17 pricing decision.'),

  ('REGISTERED_AGENT_3YR', 'v2', 'Florida Registered Agent Service — 3 Years', 'REGISTERED_AGENT',
   'prod_V8tUh6KAuva6qr', 'price_1U8bhUDo01bXdbWSAa44IhWf', 9800, NULL,
   '["3 years of Florida registered agent service", "Pay for two years at $49/year; the third year is free"]'::jsonb,
   '[]'::jsonb, NULL, 'active',
   '$98 per the 2026-09-17 pricing decision. Same Stripe price as v1, which Stripe reports at unit_amount 9800.'),

  ('EIN_FILING_EXPRESS', 'v2', 'EIN Filing Service — Express (Same-Day)', 'EIN_FILING_EXPRESS',
   'prod_VDlv9FbHrhq4S8', 'price_1UE0RYDo01bXdbWSVZii0eTV', 29900, NULL,
   '["Same-day IRS Form SS-4 filing, subject to daily capacity", "Personal document verification before filing", "Same-business-day EIN confirmation letter"]'::jsonb,
   '["Availability gated by the daily same-day capacity governor (20-25 slots/day)"]'::jsonb,
   'on_same_day_capacity_confirmed', 'active',
   '$299, Stripe metadata pricing_status=CONFIRMED_2026-09-10. Replaces the $449 placeholder that 0012 held as draft.');
