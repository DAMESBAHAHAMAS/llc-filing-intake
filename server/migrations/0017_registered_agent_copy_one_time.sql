-- 0017 — Registered Agent copy: "$98 one time for 3 years".
--
-- Damian, 2026-09-27: the Registered Agent is $98 once for the full
-- three-year term. 0016's inclusion text ("Pay for two years at $49/year;
-- the third year is free") could be read as an annual charge. Copy only:
-- price, Stripe price id and status are unchanged, so this edits the
-- active v2 row in place rather than adding a v3.
UPDATE offers
   SET inclusions = '["3 years of Florida registered agent service", "$98 one time for all 3 years — no recurring charge"]'::jsonb,
       notes = '$98 one time for 3 years (DECISIONS.md 2026-09-17 pricing; copy per Damian 2026-09-27). Same Stripe price as v1 (unit_amount 9800).'
 WHERE offer_code = 'REGISTERED_AGENT_3YR' AND offer_version = 'v2';
