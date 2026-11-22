-- 0029 — Offer Master: Bank-Ready is all-inclusive at $499; Premium is $997.
--
-- Decision (Damian, 2026-11-22): all three tiers are flat, out-the-door
-- prices with the $125 Florida state filing fee already included.
--   File It (DIY)  $139  — unchanged (125 state + 5 Certificate of Status + 9 service)
--   Bank-Ready     $499  — now explicitly includes the state fee, Federal EIN,
--                          Custom Operating Agreement & Banking Resolution,
--                          Florida commercial mailing address and the hardbound
--                          Company Credentials Kit
--   Premium        $997  — was $999 here; consultation-first, closed to direct
--                          checkout (offers/closedOffers.ts)
--
-- "An offer version is a record" (0012): changed offers get a new v2 row and
-- the v1 row is retired, never overwritten. Orders keep the version they paid
-- for in orders.line_items. Rollback: migrations-rollback/0029_*.rollback.sql.
--
-- The offer_code FASTTRACK is kept as the internal identifier (CRM intent
-- LLC_FORMATION_FASTTRACK, sunbizFiling.ts and zoho/client.ts key off it);
-- only the customer-facing name changes to Bank-Ready.
--
-- Stripe objects, created 2026-11-22 in the TEST-mode account
-- acct_1ChHmZDo01bXdbWS (verified livemode=false before writing):
--   FASTTRACK v2  prod_Vg1H8gZwPtJBWj / price_1UefEhDo01bXdbWSei7ja3gV  $499
--   PREMIUM   v2  prod_V8sRO1rlCP2jfq / price_1UefElDo01bXdbWSTnb5H2yX  $997
-- Drift found while doing this: the PREMIUM v1 Stripe Price
-- (price_1U8agADo01bXdbWSN7stU2LF) is $1,499 while this table said $999. Stripe
-- is what charges, so that price would have charged $1,499 had Premium ever
-- been opened. The new $997 Price replaces it; the old Price is left in place
-- (Prices cannot be deleted) and is no longer referenced by an active row.
--
-- Unchanged: DIY_* , EIN_FILING $299, EIN_FILING_EXPRESS $299,
-- REGISTERED_AGENT_3YR $98, CREDENTIALS_KIT $89 (still sold separately to DIY),
-- DIY_CERTIFIED_COPY_ADDON $30.

-- Guard: refuse to run with an unreplaced placeholder or a malformed id.
DO $$
BEGIN
  IF 'price_1UefEhDo01bXdbWSei7ja3gV' NOT LIKE 'price\_%'
     OR 'price_1UefElDo01bXdbWSTnb5H2yX' NOT LIKE 'price\_%'
     OR 'prod_Vg1H8gZwPtJBWj' NOT LIKE 'prod\_%' THEN
    RAISE EXCEPTION '0029: Stripe ids malformed or placeholder not replaced';
  END IF;
END $$;

-- Retire the v1 rows first: idx_offers_one_active_per_code allows only one
-- active version per offer_code. Expect exactly two rows.
DO $$
DECLARE
  retired integer;
BEGIN
  UPDATE offers SET status = 'retired'
   WHERE offer_version = 'v1'
     AND offer_code IN ('FASTTRACK', 'PREMIUM')
     AND status = 'active';
  GET DIAGNOSTICS retired = ROW_COUNT;
  IF retired <> 2 THEN
    RAISE EXCEPTION '0029: expected to retire 2 active v1 rows (FASTTRACK, PREMIUM), retired %', retired;
  END IF;
END $$;

INSERT INTO offers
  (offer_code, offer_version, display_name, crm_intent, stripe_product_id, stripe_price_id, unit_amount_cents, internal_cost_cents, inclusions, exclusions, sla_clock_start, status, notes)
VALUES
  ('FASTTRACK', 'v2', 'Florida LLC Formation — Bank-Ready', 'LLC_FORMATION_FASTTRACK',
   'prod_Vg1H8gZwPtJBWj', 'price_1UefEhDo01bXdbWSei7ja3gV', 49900, NULL,
   '["Articles of Organization prepared and filed", "Florida $125 state filing fee included", "Business name availability checked before filing", "Filed formation documents delivered digitally", "Federal EIN (Tax ID) registration — IRS Form SS-4 prepared and filed", "Custom Operating Agreement and Banking Resolution", "Florida commercial mailing address", "Hardbound Company Credentials Kit shipped to you", "Email support through filing"]'::jsonb,
   '["Registered agent service beyond statutory designation (available as a separate add-on)"]'::jsonb,
   'on_payment_confirmed', 'active',
   'Bank-Ready, $499 all-inclusive per Damian 2026-11-22. Replaces FastTrack v1, which excluded EIN and the Credentials Kit. EIN and the Credentials Kit must NOT be offered as add-ons on this tier (they are included): see offerTiers.ts in the frontend.'),

  ('PREMIUM', 'v2', 'Florida LLC Formation — Premium', 'LLC_FORMATION_PREMIUM',
   'prod_V8sRO1rlCP2jfq', 'price_1UefElDo01bXdbWSTnb5H2yX', 99700, NULL,
   '["Everything in Bank-Ready", "Federal EIN filing", "3 years Florida registered agent service", "Company Credentials Kit", "Custom Operating Agreement", "Member certificates and member ledger"]'::jsonb,
   '[]'::jsonb,
   'on_payment_confirmed', 'active',
   '$997 per Damian 2026-11-22 (v1 was $999 here and $1,499 in Stripe). Consultation-first; closed to direct checkout by offers/closedOffers.ts. Inclusions carried over from v1 apart from the first line.');
