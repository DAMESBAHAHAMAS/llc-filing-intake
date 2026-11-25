-- 0037 — Offer Master: Bank-Ready includes 3 years of registered agent service.
--
-- Decision (Damian, 25 Nov 2026; Zoho task A6Y2-T144, final pre-launch round):
-- Bank-Ready ($499) and Finance-Ready ($997) include the 3-year Florida
-- registered agent service at the SAME prices. Finance-Ready (PREMIUM v3, 0032)
-- already lists it. This migration does the same for Bank-Ready.
--
-- The PRICE DOES NOT CHANGE: FASTTRACK v3 keeps v2's $499 amount and the same
-- Stripe Product and Price (prod_Vg1H8gZwPtJBWj / price_1UefEhDo01bXdbWSei7ja3gV).
-- No Stripe object is created or edited by this migration.
--
-- What changes: "3 years Florida registered agent service" is added to the
-- inclusions, and v2's only exclusion ("Registered agent service beyond
-- statutory designation (available as a separate add-on)") is removed. The
-- checkout rule that goes with it is in offers/houseAgentRule.ts: a Bank-Ready
-- or Finance-Ready order covers Damian as registered agent without the $98
-- REGISTERED_AGENT_3YR line, and that line is refused on those tiers.
--
-- "An offer version is a record" (0012): v2 is retired, never overwritten, and
-- v3 replaces it. offer_code FASTTRACK and CRM intent LLC_FORMATION_FASTTRACK
-- stay (sunbizFiling.ts, einBundleRule.ts, houseAgentRule.ts, zoho/client.ts).
--
-- Rollback: migrations-rollback/0037_offer_master_bank_ready_includes_registered_agent.rollback.sql.

-- Retire v2 first: idx_offers_one_active_per_code allows one active version.
DO $$
DECLARE
  retired integer;
BEGIN
  UPDATE offers SET status = 'retired'
   WHERE offer_code = 'FASTTRACK' AND offer_version = 'v2' AND status = 'active'
     AND unit_amount_cents = 49900 AND stripe_price_id = 'price_1UefEhDo01bXdbWSei7ja3gV';
  GET DIAGNOSTICS retired = ROW_COUNT;
  IF retired <> 1 THEN
    RAISE EXCEPTION '0037: expected to retire 1 active FASTTRACK v2 row at $499, retired %', retired;
  END IF;
END $$;

INSERT INTO offers
  (offer_code, offer_version, display_name, crm_intent, stripe_product_id, stripe_price_id, unit_amount_cents, internal_cost_cents, inclusions, exclusions, sla_clock_start, status, notes)
VALUES
  ('FASTTRACK', 'v3', 'Florida LLC Formation — Bank-Ready', 'LLC_FORMATION_FASTTRACK',
   'prod_Vg1H8gZwPtJBWj', 'price_1UefEhDo01bXdbWSei7ja3gV', 49900, NULL,
   '["Articles of Organization prepared and filed", "Florida $125 state filing fee included", "Business name availability checked before filing", "Filed formation documents delivered digitally", "Federal EIN (Tax ID) registration — IRS Form SS-4 prepared and filed", "Custom Operating Agreement and Banking Resolution", "3 years Florida registered agent service", "Florida commercial mailing address", "Hardbound Company Credentials Kit shipped to you", "Email support through filing"]'::jsonb,
   '[]'::jsonb,
   'on_payment_confirmed', 'active',
   'Bank-Ready, $499 all-inclusive, now with 3 years of registered agent service, per Damian 25 Nov 2026 (A6Y2-T144 final pre-launch round). Same $499 Stripe Price as v2. The $98 REGISTERED_AGENT_3YR add-on is for File It only (offers/houseAgentRule.ts).');

-- Exactly one active version per offer_code, and exactly one active FASTTRACK.
DO $$
DECLARE
  active_fasttrack integer;
  duplicated integer;
BEGIN
  SELECT count(*) INTO active_fasttrack FROM offers WHERE offer_code = 'FASTTRACK' AND status = 'active';
  IF active_fasttrack <> 1 THEN
    RAISE EXCEPTION '0037: expected exactly 1 active FASTTRACK row, found %', active_fasttrack;
  END IF;
  SELECT count(*) INTO duplicated FROM (
    SELECT offer_code FROM offers WHERE status = 'active' GROUP BY offer_code HAVING count(*) > 1
  ) d;
  IF duplicated <> 0 THEN
    RAISE EXCEPTION '0037: % offer_code(s) have more than one active row', duplicated;
  END IF;
END $$;
