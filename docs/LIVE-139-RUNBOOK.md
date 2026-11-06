# One controlled $139 live payment, with no Florida filing

Every step that touches live money or production needs Damian's approval first. An agent does not hold the live key, click Publish, or enter a card.

## Before anything
1. Pay the Render invoice and confirm services are not at risk of suspension.
2. In the Stripe Dashboard, in live mode, confirm the account is active, the statement descriptor is right, and the Price `price_1UYioTDo01bXdbWSznszpIVx` is active at $139.00 USD.
3. Create the restricted live key: Checkout Sessions write, PaymentIntents write, Prices read, Customers write, PaymentMethods write, Refunds write.
4. Create the live webhook endpoint at `https://llc-data-spine.onrender.com/api/webhooks/stripe` with the same 7 events as the test endpoint.

## Deploy, with Damian's approval
5. Merge backend PR #9, then this PR, in one window. Render does not run migrations: apply `0021` to `0025` and `0020` by hand, before the code that needs them, and read `/health` after.
6. Save the current list of active offers: `SELECT offer_code, offer_version FROM offers WHERE status = 'active';`. It is what a rollback restores. Do not run `migrations-golive/diy_139_on_sale.sql` yet. The test does not need it.
7. On `llc-data-spine`, set together: the live `STRIPE_SECRET_KEY`, the live `STRIPE_WEBHOOK_SECRET`, `LIVE_TEST_ENABLED=true`, `LIVE_TEST_EMAIL` (Damian's address). Remove `PAYMENT_CAPTURE_MODE`, or set it to `hold`. Generate a new `OPERATOR_API_KEY`.
8. Run `npm run verify:prices` with the live key. It must report the live Price at $139.

## The test, about 10 minutes
9. Damian approves the charge.
10. Start it:
    `curl -X POST https://llc-data-spine.onrender.com/api/operator/live-test/checkout -H "x-operator-key: $OPERATOR_API_KEY"`
    Keep the `order_id`. Open the `checkout_url`.
11. Damian pays with his own card. Stripe shows "Internal payment test. No LLC is filed."
12. Check the hold. In Stripe the PaymentIntent is `requires_capture`, and the card is not charged. In the database:
    `SELECT payment_status, fulfillment_status, stripe_livemode FROM orders WHERE order_id = '...';`
    Expect `authorized`, `not_ready`, `true`.
13. Collect it through the same route a real order uses:
    `curl -X POST https://llc-data-spine.onrender.com/api/orders/ORDER_ID/proof-of-filing -H "x-operator-key: $OPERATOR_API_KEY" -H "Content-Type: application/json" -d '{"document_number":"TEST-139"}'`
14. Check the result. In Stripe the payment is succeeded at $139.00. In the database, `paid`, `not_ready`, and `proof_of_filing_ref` is `TEST-139`.
15. Prove nothing else happened. Each must return 0 rows:
    `SELECT 1 FROM crm_sync_queue WHERE order_id = 'ORDER_ID';`
    `SELECT 1 FROM filing_documents WHERE order_id = 'ORDER_ID';`
    Confirm no email arrived.
16. Refund the $139 in the Stripe Dashboard and confirm the order becomes `refunded`. Stripe keeps its processing fee on a refund.

## Close the test
17. Remove `LIVE_TEST_ENABLED` and `LIVE_TEST_EMAIL` from Render.
18. Selling starts only after a separate approval: run `migrations-golive/diy_139_on_sale.sql`, merge and publish the website PR, then repeat `verify:prices`.

## If something goes wrong
- A hold that should not stand: cancel the PaymentIntent in the Stripe Dashboard.
- Stop all live checkout: restore the test key and secret on Render. If `diy_139_on_sale.sql` has run, run its rollback and restore the offers saved in step 6.
- A test order cannot file. It is refused by `needsSunbizFiling`, the fulfillment worker, the Sunbiz routes and the `orders_live_test_never_files` constraint.
