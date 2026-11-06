-- 0020: The DIY filing as one live $139 Stripe Price.
--
-- Damian confirmed the live Product and Price on 6 Nov 2026. The total stays
-- $125 Florida state filing fee + $5 Certificate of Status + $9 service fee
-- (DECISIONS.md, 2026-09-17), and every order keeps that breakdown.
--
-- Inserted as 'draft', so this migration sells nothing: GET /api/offers and
-- checkout read active rows only. migrations-golive/diy_139_on_sale.sql puts
-- it on sale, in the go-live window, after Damian approves. The live test
-- reads this row for its Price, so it needs no active offer.
INSERT INTO offers
  (offer_code, offer_version, display_name, crm_intent, stripe_product_id, stripe_price_id, unit_amount_cents,
   inclusions, exclusions, sla_clock_start, status, notes)
VALUES
  ('DIY_PACKAGE', 'v1', 'DIY Florida LLC Filing ($125 state fee + $5 Certificate of Status + $9 service fee)', 'LLC_FORMATION_DIY',
   'prod_VZsZFe9UUb3HFX', 'price_1UYioTDo01bXdbWSznszpIVx', 13900,
   '["$125 Florida state filing fee", "$5 Certificate of Status", "$9 service fee"]'::jsonb,
   '[]'::jsonb, 'on_payment_confirmed', 'draft',
   'One live Price. DIY total = 125 + 5 + 9 = $139, per the 2026-09-17 pricing decision.');
