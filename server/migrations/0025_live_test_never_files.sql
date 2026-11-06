-- 0025: A live payment test can never enter fulfillment.
--
-- The application already refuses this (offers/liveTest.ts). This makes the
-- database refuse it too, whatever code or hand-written SQL tries.
ALTER TABLE orders ADD CONSTRAINT orders_live_test_never_files
  CHECK (
    fulfillment_status = 'not_ready'
    OR NOT (line_items @> '[{"offer_code":"LIVE_TEST_NO_FILING"}]'::jsonb)
  );

-- One open test at a time, even for two requests at the same instant. A
-- released test stays open until it is closed through /cancel.
CREATE UNIQUE INDEX orders_one_open_live_test ON orders ((1))
  WHERE line_items @> '[{"offer_code":"LIVE_TEST_NO_FILING"}]'::jsonb
    AND payment_status IN ('pending', 'authorized', 'released')
    AND cancelled_at IS NULL;
