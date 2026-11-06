-- Puts the $139 DIY filing on sale. Not a migration: run by hand, only after
-- Damian approves, in the go-live window, with the live key in place.
--
-- Every other active offer points at a test-mode Price, so it is retired here
-- and cannot reach Stripe with a live key. Each is marked, and comes back with
-- diy_139_on_sale.rollback.sql or through its own decision. It stops, changing
-- nothing, unless exactly one draft DIY_PACKAGE row exists.
BEGIN;
DO $$
BEGIN
  IF (SELECT count(*) FROM offers WHERE offer_code = 'DIY_PACKAGE' AND offer_version = 'v1' AND status = 'draft') <> 1 THEN
    RAISE EXCEPTION 'expected exactly one draft DIY_PACKAGE row';
  END IF;
END $$;
UPDATE offers SET status = 'retired', notes = coalesce(notes, '') || ' [retired for diy_139 go-live]', updated_at = now()
 WHERE status = 'active' AND offer_code <> 'DIY_PACKAGE';
UPDATE offers SET status = 'active', updated_at = now()
 WHERE offer_code = 'DIY_PACKAGE' AND offer_version = 'v1' AND status = 'draft';
COMMIT;
