-- 0032 — Offer Master: the $997 tier is named Finance-Ready everywhere.
--
-- Decision (Damian, 25 Nov 2026; Zoho task A6Y2-T144, Dispatch 8): the catalog,
-- /pricing and the intake package step all call the $997 tier "Finance-Ready",
-- with the full corporate launch suite in its inclusions. The PRICE DOES NOT
-- CHANGE: v3 keeps v2's $997 amount and the same Stripe Product and Price
-- (prod_V8sRO1rlCP2jfq / price_1UefElDo01bXdbWSTnb5H2yX). No Stripe object is
-- created or edited by this migration.
--
-- "An offer version is a record" (0012): v2 is retired, never overwritten, and
-- v3 replaces it. offer_code PREMIUM and CRM intent LLC_FORMATION_PREMIUM stay:
-- sunbizFiling.ts, einBundleRule.ts, houseAgentRule.ts, ein/onboarding.ts and
-- zoho/client.ts key off them. Full-price PREMIUM checkout stays closed
-- (offers/closedOffers.ts); online, Finance-Ready is sold only as the $139
-- kickoff hold (offers/financeReadyKickoff.ts).
--
-- Rollback: migrations-rollback/0032_offer_master_finance_ready.rollback.sql.

-- Retire v2 first: idx_offers_one_active_per_code allows one active version.
DO $$
DECLARE
  retired integer;
BEGIN
  UPDATE offers SET status = 'retired'
   WHERE offer_code = 'PREMIUM' AND offer_version = 'v2' AND status = 'active'
     AND unit_amount_cents = 99700 AND stripe_price_id = 'price_1UefElDo01bXdbWSTnb5H2yX';
  GET DIAGNOSTICS retired = ROW_COUNT;
  IF retired <> 1 THEN
    RAISE EXCEPTION '0032: expected to retire 1 active PREMIUM v2 row at $997, retired %', retired;
  END IF;
END $$;

INSERT INTO offers
  (offer_code, offer_version, display_name, crm_intent, stripe_product_id, stripe_price_id, unit_amount_cents, internal_cost_cents, inclusions, exclusions, sla_clock_start, status, notes)
VALUES
  ('PREMIUM', 'v3', 'Florida LLC Formation — Finance-Ready', 'LLC_FORMATION_PREMIUM',
   'prod_V8sRO1rlCP2jfq', 'price_1UefElDo01bXdbWSTnb5H2yX', 99700, NULL,
   '["Everything in Bank-Ready", "Federal EIN filing", "3 years Florida registered agent service", "Company Credentials Kit", "Custom Operating Agreement and Banking Resolution", "Member certificates and member ledger", "Custom launch website, company domain and branded email", "90-day structured business credit roadmap", "Strategy kickoff call with Damian to set your custom scope"]'::jsonb,
   '[]'::jsonb,
   'on_payment_confirmed', 'active',
   'Finance-Ready (renamed from Premium) per Damian 25 Nov 2026, A6Y2-T144 Dispatch 8. Same $997 Stripe Price as v2. Full-price checkout stays closed (closedOffers.ts); sold online only as the $139 kickoff hold (financeReadyKickoff.ts), remaining $858 collected only after Damian''s scope review.');
