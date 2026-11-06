# The $139 manual capture path: test and go-live

Every step that touches live money or production needs Damian's approval first. An agent does not hold the live key, click Publish, or enter a card.

## Before anything
1. Pay the Render invoice and confirm it cleared. Everything below runs on Render.
2. In the Stripe Dashboard, in live mode, confirm the account is active, the statement descriptor is right, and the merchant of record is the entity named in the Terms.
3. Create a restricted live key with: Checkout Sessions write, PaymentIntents write, Customers write, PaymentMethods write (the card is detached after an order closes), Prices read, Charges read (every PaymentIntent read expands the latest charge, which is where the hold deadline lives). Add Refunds write only if refunds will not be done in the Dashboard. Try the key in a sandbox first.
4. Create the live webhook endpoint at `https://llc-data-spine.onrender.com/api/webhooks/stripe` with the same 7 events as the test endpoint.

## Deploy, with Damian's approval
5. From a checkout of the PR #10 branch, on a machine with `DATABASE_URL`, run `npm run migrate`. Render does not run migrations, and `main` does not have these files until step 6. `/health` must then report `0026_orders_filing_clearance`. Do not paste the files by hand: the runner records them, and a hand-applied file fails the next run. The migrations only add, so the running code is unaffected. 0026 also marks every existing order as test mode.
6. Merge backend PR #9, then PR #10, into `main`, in one window. `main` auto-deploys, so the merge is the release. Wait for the deploy to finish.
7. Close leftovers before the key changes:
   `SELECT order_id, payment_status FROM orders WHERE stripe_livemode IS NOT TRUE AND payment_status IN ('pending', 'authorized');`
   Cancel each one through `/cancel`.
8. On `llc-data-spine`, set together: the live `STRIPE_SECRET_KEY`, the live `STRIPE_WEBHOOK_SECRET`, `LIVE_TEST_ENABLED=true`, `LIVE_TEST_EMAIL` (Damian's address), a new `OPERATOR_API_KEY`. `CLIQ_WEBHOOK_URL` must be set: a hold alert that only reaches the logs counts as failed. `TEST_MODE_ORDERS_FILE` must not be set. Remove `PAYMENT_CAPTURE_MODE`, or set it to `hold`.
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
1. Approve: `POST /api/orders/ORDER_ID/approve-filing`. It asks Stripe whether the hold is capturable for the full amount with at least 24 hours left, claims the LLC name so no other open order can file it, and records the real deadline. A claim is released only by cancelling that order. An approval lasts 24 hours.
2. File at Sunbiz and pay Florida, then `POST /api/orders/ORDER_ID/submitted-to-sunbiz` with `{"tracking_number":"..."}`. It refuses without a current approval, and asks Stripe again first. If it refuses, do not file.
3. When Florida confirms, open the Sunbiz record and read the document number and the LLC name from it. Then `POST /api/orders/ORDER_ID/proof-of-filing` with `{"document_number":"L26000123456","verified_entity_name":"Exact Name LLC"}`. It captures $139. A number on another order, a tracking number, or a different number on a retry is refused.

If Florida rejects a filing: `POST /api/orders/ORDER_ID/filing-rejected` with the reason. That clears the approval. When the correction is ready, approve again, then `POST /api/orders/ORDER_ID/resubmitted-to-sunbiz`. It asks Stripe again and rechecks a corrected name.

If you typed the wrong document number and nothing was collected or sent: `POST /api/orders/ORDER_ID/correct-document-number` with the number and a reason. The change is recorded on the filing.

If a step answers `order_busy`, another step is running on that order. Wait and try again. A claim ends by itself after 3 minutes.

## A hold running out
The hold sweep reads Stripe's own `capture_before`. It alerts at 48 hours and again at 24 hours, retries an alert that failed, and raises any hold Stripe gives no deadline for.
- Within 48 hours, and for a hold that lapsed before filing, the sweep places a new hold by itself, if the customer agreed to the wording at checkout. It tries 3 times, 6 hours apart, and emails the customer when a new hold is placed or when it can't be. A hold a person released is never renewed.
- `POST /api/orders/ORDER_ID/replace-authorization` does the same by hand. It places the new hold first, moves the order to it, and only then cancels the old one. If the bank refuses or wants the customer, the old hold stands.
- For a moment the customer has two holds. If cancelling the old one fails you are told, and the sweep keeps trying until Stripe confirms.
- A replaced order must be approved again before filing.
- If no hold can be placed before filing, the order can't file. Help the customer authorize again, or `/cancel` it.
- A hold captured after it was replaced raises an alert and does not mark the order paid. Refund or release one of the two.

## Stopping
- A hold that should not stand: `POST /api/orders/ORDER_ID/cancel`.
- Stop all live checkout: restore the test key and secret on Render. If the go-live script ran, run `diy_139_on_sale.rollback.sql`, which also restores what it retired.
