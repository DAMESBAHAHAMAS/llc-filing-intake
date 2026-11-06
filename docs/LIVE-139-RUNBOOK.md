# The $139 manual capture path: test and go-live

Every step that touches live money or production needs Damian's approval first. An agent does not hold the live key, click Publish, or enter a card.

## Before anything
1. Pay the Render invoice and confirm it cleared. Everything below runs on Render.
2. In the Stripe Dashboard, in live mode, confirm the account is active, the statement descriptor is right, and the merchant of record is the entity named in the Terms.
3. Create a restricted live key with: Checkout Sessions write, PaymentIntents write, Customers write, PaymentMethods write (the card is detached after an order closes), Prices read, Charges read (every PaymentIntent read expands the latest charge, which is where the hold deadline lives). Add Refunds write only if refunds will not be done in the Dashboard. Try the key in a sandbox first.
4. Create the live webhook endpoint at `https://llc-data-spine.onrender.com/api/webhooks/stripe` with the same 7 events as the test endpoint.

## Deploy, with Damian's approval
5. From a machine with `DATABASE_URL`, run `npm run migrate`. Render does not run migrations. `/health` must then report `0026_orders_filing_clearance`. Do not paste the files by hand: the runner records them, and a hand run makes the next pass fail.
6. Close leftovers before the key changes, because the sweeps take the oldest 20 rows and a test-mode row fails under a live key:
   `SELECT order_id, payment_status FROM orders WHERE stripe_livemode IS NOT TRUE AND payment_status IN ('pending', 'authorized');`
   Mark each one failed or cancel it through `/cancel`.
7. Merge backend PR #9, then PR #10, into `main`, in one window. `main` auto-deploys, so the merge is the release.
8. On `llc-data-spine`, set together: the live `STRIPE_SECRET_KEY`, the live `STRIPE_WEBHOOK_SECRET`, `LIVE_TEST_ENABLED=true`, `LIVE_TEST_EMAIL` (Damian's address), a new `OPERATOR_API_KEY`. Remove `PAYMENT_CAPTURE_MODE`, or set it to `hold`.
9. Run `npm run verify:live-price`. It must report a live key and `OK DIY_PACKAGE (draft): live, active, $139.00 USD`. Do not run `verify:prices` yet: every other active offer has a test Price and it will fail, correctly. Do not run the go-live script yet: the test does not need it.

## The test, about 10 minutes
10. Damian approves the charge.
11. Start it, and keep the `order_id`:
    `curl -X POST https://llc-data-spine.onrender.com/api/operator/live-test/checkout -H "x-operator-key: $OPERATOR_API_KEY"`
12. Damian opens the `checkout_url` and pays with his own card. Stripe shows "Internal payment test. No LLC is filed."
13. Check the hold. In Stripe the PaymentIntent is `requires_capture`, and the card is not charged. In the database:
    `SELECT payment_status, fulfillment_status, stripe_livemode, filing_session_id FROM orders WHERE order_id = 'ORDER_ID';`
    Expect `authorized`, `not_ready`, `true`.
14. Collect it through the same route a real order uses:
    `curl -X POST https://llc-data-spine.onrender.com/api/orders/ORDER_ID/proof-of-filing -H "x-operator-key: $OPERATOR_API_KEY" -H "Content-Type: application/json" -d '{"document_number":"TEST-139"}'`
15. In Stripe the payment is succeeded at $139.00. In the database, `paid`, `not_ready`, and `proof_of_filing_ref` is `TEST-139`.
16. Prove nothing else happened. Each must return 0 rows, using both ids from step 13:
    `SELECT 1 FROM crm_sync_queue WHERE order_id = 'ORDER_ID' OR filing_session_id = 'SESSION_ID';`
    `SELECT 1 FROM filing_documents WHERE order_id = 'ORDER_ID' OR filing_session_id = 'SESSION_ID';`
    Confirm no email arrived.
17. Refund the $139 in the Stripe Dashboard and confirm the order becomes `refunded`. Stripe keeps its processing fee on a refund.
18. Remove `LIVE_TEST_ENABLED` and `LIVE_TEST_EMAIL` from Render.

If the test goes wrong, use `POST /api/orders/ORDER_ID/cancel`, not the Stripe Dashboard. It closes the order, so a new test can start. A released test can never be charged to the saved card, and its card is detached.

## Going on sale, a separate approval
19. Decide the registered agent first. See the launch report: without a live $98 Price, Damian cannot be chosen as agent.
20. Run `migrations-golive/diy_139_on_sale.sql`. It stops unless exactly one draft `DIY_PACKAGE` row exists. Run `npm run verify:prices`: it must pass, including `livemode`.
21. Merge the website PRs in order, #59 then #65 (and #62 where it applies), then Damian publishes in Lovable.

## Operating a real order
Damian pays Florida only after step 1 passes.
1. Approve: `POST /api/orders/ORDER_ID/approve-filing`. It asks Stripe whether the hold is capturable for the full amount with at least 24 hours left, refuses a second filing of the same LLC, and records the real deadline. An approval lasts 24 hours.
2. File at Sunbiz and pay Florida, then `POST /api/orders/ORDER_ID/submitted-to-sunbiz` with `{"tracking_number":"..."}`. It refuses without a current approval.
3. When Florida confirms, open the Sunbiz record and read the document number and the LLC name from it. Then `POST /api/orders/ORDER_ID/proof-of-filing` with `{"document_number":"L26000123456","verified_entity_name":"Exact Name LLC"}`. It captures $139. A number on another order, a tracking number, or a different number on a retry is refused.

## A hold running out
The hold sweep reads Stripe's own `capture_before`. It alerts at 48 hours and again at 24 hours, and retries an alert that failed.
- `POST /api/orders/ORDER_ID/replace-authorization` places a new hold on the saved card first, moves the order to it, and only then cancels the old one. If the bank refuses or wants the customer, the old hold stands and you are alerted.
- For a moment the customer has two holds. If cancelling the old one fails you are told, and you must cancel it in Stripe.
- A replaced order must be approved again before filing.

## Stopping
- A hold that should not stand: `POST /api/orders/ORDER_ID/cancel`.
- Stop all live checkout: restore the test key and secret on Render. If the go-live script ran, run `diy_139_on_sale.rollback.sql`, which also restores what it retired.
