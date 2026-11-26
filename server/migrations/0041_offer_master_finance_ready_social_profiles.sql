-- 0041 — Offer Master: Finance-Ready includes 3 branded social media profiles and 3 launch posts.
--
-- Decision (Damian, 26 Nov 2026; Zoho task A6Y2-T144, post-147 polish): the website's
-- Finance-Ready card lists "3 Branded Social Media Profiles + 3 Launch Posts" (website
-- PR #147, src/lib/conversionCopy.ts SOCIAL_PROFILES_DELIVERABLE). This migration adds the
-- same line, word for word, to the catalog so order fulfilment matches the card 1:1.
--
-- The PRICE DOES NOT CHANGE: PREMIUM v4 keeps v3's $997 amount and the same Stripe
-- Product and Price (prod_V8sRO1rlCP2jfq / price_1UefElDo01bXdbWSTnb5H2yX). No Stripe
-- object is created or edited by this migration. offer_code PREMIUM and CRM intent
-- LLC_FORMATION_PREMIUM stay, so no code changes: every rule matches on offer_code, and
-- GET /api/offers serves whichever row is active.
--
-- What changes: one inclusion is added after "Custom launch website, company domain and
-- branded email" (the card's order). Everything else is v3's list unchanged.
--
-- "An offer version is a record" (0012): v3 is retired, never overwritten, and v4
-- replaces it. Orders that already point at PREMIUM v3 (the $139 kickoff's
-- selected_package line) keep pointing at v3.
--
-- Rollback: migrations-rollback/0041_offer_master_finance_ready_social_profiles.rollback.sql.

-- Retire v3 first: idx_offers_one_active_per_code allows one active version.
DO $$
DECLARE
  retired integer;
BEGIN
  UPDATE offers SET status = 'retired'
   WHERE offer_code = 'PREMIUM' AND offer_version = 'v3' AND status = 'active'
     AND unit_amount_cents = 99700 AND stripe_price_id = 'price_1UefElDo01bXdbWSTnb5H2yX';
  GET DIAGNOSTICS retired = ROW_COUNT;
  IF retired <> 1 THEN
    RAISE EXCEPTION '0041: expected to retire 1 active PREMIUM v3 row at $997, retired %', retired;
  END IF;
END $$;

INSERT INTO offers
  (offer_code, offer_version, display_name, crm_intent, stripe_product_id, stripe_price_id, unit_amount_cents, internal_cost_cents, inclusions, exclusions, sla_clock_start, status, notes)
VALUES
  ('PREMIUM', 'v4', 'Florida LLC Formation — Finance-Ready', 'LLC_FORMATION_PREMIUM',
   'prod_V8sRO1rlCP2jfq', 'price_1UefElDo01bXdbWSTnb5H2yX', 99700, NULL,
   '["Everything in Bank-Ready", "Federal EIN filing", "3 years Florida registered agent service", "Company Credentials Kit", "Custom Operating Agreement and Banking Resolution", "Member certificates and member ledger", "Custom launch website, company domain and branded email", "3 Branded Social Media Profiles + 3 Launch Posts", "90-day structured business credit roadmap", "Strategy kickoff call with Damian to set your custom scope"]'::jsonb,
   '[]'::jsonb,
   'on_payment_confirmed', 'active',
   'Finance-Ready, $997, now with 3 branded social media profiles and 3 launch posts, per Damian 26 Nov 2026 (A6Y2-T144 post-147 polish), matching the website card. Same $997 Stripe Price as v3.');

-- Exactly one active version per offer_code, and exactly one active PREMIUM.
DO $$
DECLARE
  active_premium integer;
  duplicated integer;
BEGIN
  SELECT count(*) INTO active_premium FROM offers WHERE offer_code = 'PREMIUM' AND status = 'active';
  IF active_premium <> 1 THEN
    RAISE EXCEPTION '0041: expected exactly 1 active PREMIUM row, found %', active_premium;
  END IF;
  SELECT count(*) INTO duplicated FROM (
    SELECT offer_code FROM offers WHERE status = 'active' GROUP BY offer_code HAVING count(*) > 1
  ) d;
  IF duplicated <> 0 THEN
    RAISE EXCEPTION '0041: % offer_code(s) have more than one active row', duplicated;
  END IF;
END $$;
