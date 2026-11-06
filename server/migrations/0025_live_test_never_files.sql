-- 0025: A live payment test can never enter fulfillment.
--
-- The application already refuses this (offers/liveTest.ts). This makes the
-- database refuse it too, whatever code or hand-written SQL tries.
ALTER TABLE orders ADD CONSTRAINT orders_live_test_never_files
  CHECK (
    fulfillment_status = 'not_ready'
    OR NOT (line_items @> '[{"offer_code":"LIVE_TEST_NO_FILING"}]'::jsonb)
  );
