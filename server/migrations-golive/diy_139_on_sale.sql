-- Puts the $139 DIY filing on sale. Not a migration: run by hand, only after
-- Damian approves, in the go-live window, with the live key in place.
--
-- Every other active offer points at a test-mode Price, so it is retired here
-- and cannot reach Stripe with a live key. Each gets a live Price and comes
-- back through its own decision. Undo with diy_139_on_sale.rollback.sql.
BEGIN;
UPDATE offers SET status = 'retired', updated_at = now()
 WHERE status = 'active' AND offer_code <> 'DIY_PACKAGE';
UPDATE offers SET status = 'active', updated_at = now()
 WHERE offer_code = 'DIY_PACKAGE' AND offer_version = 'v1' AND status = 'draft';
COMMIT;
