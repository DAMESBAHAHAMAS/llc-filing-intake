# The $139 manual capture path: test and go-live

Every step that touches live money or production needs Damian's approval first. An agent does not hold the live key, click Publish, or enter a card.

## Before anything
1. Pay the Render invoice and confirm it cleared. Everything below runs on Render.
2. In the Stripe Dashboard, in live mode, confirm the account is active, the statement descriptor is right, and the merchant of record is the entity named in the Terms.
3. Create a restricted live key with: Checkout Sessions write, PaymentIntents write, Customers write, PaymentMethods write (the card is detached after an order closes), Prices read, Charges read (every PaymentIntent read expands the latest charge, which is where the hold deadline lives). Add Refunds write only if refunds will not be done in the Dashboard. Try the key in a sandbox first.
4. Create the live webhook endpoint at `https://llc-data-spine.onrender.com/api/webhooks/stripe` with the same 7 events as the test endpoint. Set its API version to `2025-03-31.basil` or later. An older version also reports `charge.refunded` when a hold is cancelled. The server ignores that, but check the version on the first stored event: `SELECT payload->>'api_version' FROM stripe_webhook_events ORDER BY processed_at DESC LIMIT 1;`

## Deploy, with Damian's approval
5. From a checkout of the PR #10 branch, on a machine with `DATABASE_URL`, run `npm run migrate`. Render does not run migrations, and `main` does not have these files until step 6. `/health` must then report `0027_orders_open_questions`. Do not paste the files by hand: the runner records them, and a hand-applied file fails the next run. The migrations only add, so the running code is unaffected. 0026 also marks every existing order as test mode.
6. Merge backend PR #9, then PR #10, into `main`, in one window. `main` auto-deploys, so the merge is the release. Wait for the deploy to finish.
7. Close leftovers before the key changes:
   `SELECT order_id, payment_status FROM orders WHERE stripe_livemode IS NOT TRUE AND payment_status = 'authorized';`
   Cancel each one through `/cancel`. A test-mode order writes nothing to Zoho, even one with an old Deal. Leave any `pending` rows where they are: `/cancel` refuses them, and the sweeps ignore them.
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
Approve, then file immediately, then record. Approval is the last check before Florida is paid, so if approve refuses, do not file. Record any filing that really happened, even if a response looks wrong.

1. Approve: `POST /api/orders/ORDER_ID/approve-filing`. It refuses a cancelled or unready order (it must be `requires_review`, or `rejected` for a correction), an agent who has not accepted and missing Articles. It asks Stripe whether the hold is capturable for the full amount with at least 24 hours left, claims the LLC name so no other open order can file it, and records the real deadline. A claim is released only by cancelling that order. An approval lasts 4 hours. From here the registered agent is locked.
   - A second approval with no filing recorded answers `already_approved`, however old the first one is, because Florida may have been paid. Check Sunbiz. If it was filed, record it (step 3). If it was not, send `{"confirm_not_filed":true}`. That goes on the filing's history.
   - If an approved order has to change first, for example a new registered agent, and it was not filed: `POST /api/orders/ORDER_ID/withdraw-approval` with `{"confirm_not_filed":true}`.
2. File at Sunbiz and pay Florida straight away.
3. Record it: `POST /api/orders/ORDER_ID/submitted-to-sunbiz` with `{"tracking_number":"..."}`. The tracking number only exists after filing, so this records what happened and does not stop anything.
   - With an approval it always records, even if the approval is over 4 hours old or the hold has since ended. You get an alert saying so, and the order can still reach proof of filing, where the saved card is charged if no hold is left.
   - With no approval it refuses `filing_not_approved`. If the filing really went in, send `{"tracking_number":"...","filed_without_approval_reason":"what happened"}`. It records the filing, keeps the reason on the filing's history and alerts you.
   - It still refuses a cancelled order, an order with no Sunbiz filing, a live test, a confirmed filing and an order that was never paid for.
4. When Florida confirms, open the Sunbiz record and read the document number and the LLC name from it. Then `POST /api/orders/ORDER_ID/proof-of-filing` with `{"document_number":"L26000123456","verified_entity_name":"Exact Name LLC"}`. It captures $139. A number on another order, a tracking number, or a different number on a retry is refused. A step skipped before filing, such as an agent who never accepted, does not stop this: Florida has been paid, so you get an alert and the order collects.

If Florida rejects a filing: `POST /api/orders/ORDER_ID/filing-rejected` with the reason. That clears the approval. When the correction is ready, approve again, adding `{"llc_name":"Corrected Name LLC"}` if the name changed so that name is checked before Florida is paid. File at once, then `POST /api/orders/ORDER_ID/resubmitted-to-sunbiz`. It records in the same way as step 3, and takes `filed_without_approval_reason` too. A name given at approval is carried through, so the order takes that name and new Articles are stored. Other changes go in `corrections` (see `server/API.md`). If that step answers 502 the Articles could not be generated and nothing changed: call it again. If the hold ended while the customer was correcting it, renew it first (see below).

If proof answers `entity_name_not_verified` because Sunbiz shows a name this order does not hold: `POST /api/orders/ORDER_ID/correct-filing-name` with `{"llc_name":"Name On Sunbiz LLC","reason":"..."}`, then call proof again. It claims the name, stores matching Articles and emails nobody. Never record a rejection Florida did not make, and never type a name Sunbiz does not show.

If you need to cancel: `/cancel` on an order approved with no filing recorded answers `approved_for_filing`, however old the approval is, because Florida may have been paid and a cancelled filing can't be recorded or collected. Check Sunbiz. If it was filed, record the filing. If it was not, send `{"confirm_not_filed":true}`. A live test is exempt. `/release-hold` keeps the same guards, and is refused once a filing is submitted.

If a payment comes in another way: `POST /api/orders/ORDER_ID/payment-received`. It is refused while a charge has no clear answer (`collection_unknown`) and if Stripe lists a payment for the order (`already_collected`). Call proof of filing again first: that settles it. Do not ask the customer to pay another way until it has. After a Stripe error the alert says whether the card may have been charged.

If Articles gave up: fix the cause, then `POST /api/orders/ORDER_ID/retry-articles`. An order whose worker died goes back in the queue by itself within about 30 minutes, with an alert.

If you typed the wrong document number and nothing was collected or sent: `POST /api/orders/ORDER_ID/correct-document-number` with the number and a reason. The change is recorded on the filing.

If a step answers `order_busy`, another step is running on that order. Wait and try again. A claim ends by itself after 3 minutes.

## A hold running out
The hold sweep reads Stripe's own `capture_before`. It alerts at 48 hours and again at 24 hours, retries an alert that failed, and raises any hold Stripe gives no deadline for.
- Within 48 hours, the sweep places a new hold by itself on a hold that is still standing, if the customer agreed to the wording at checkout. It tries 3 times, 6 hours apart, and emails the customer when a new hold is placed or when it can't be. It leaves alone an order that can't move, because a hold should not sit on a customer's funds while nothing is happening: a rejected filing, Articles that gave up, and a customer's agent who declined or never answered. It says so in its expiry alerts, and the hold then runs out. It also leaves alone an order approved in the last 4 hours, because a new hold clears the approval. It checks all of this again just before placing a hold.
- A hold that has ended is never renewed automatically, however it ended. The sweep sends one alert for an order with no proof that is not cancelled and was never submitted or is rejected. Ask the customer. If they agree, `POST /api/orders/ORDER_ID/replace-authorization` with `{"customer_agreed":"how they agreed, and when"}`. That is kept on the filing's history. It also works after the 3 tries are used. A filing with Florida that was not rejected does not need this: the saved card covers it. If they don't agree, `/cancel` it.
- On a hold still standing, the same route without `customer_agreed` does by hand what the sweep does. It places the new hold first, moves the order to it, and only then cancels the old one. If the bank refuses or wants the customer, the old hold stands.
- Before placing a hold it looks in Stripe for one already placed for this order, for example after a lost response, and uses that. If it can't look, it places nothing and counts a failed attempt.
- If Stripe gives no answer when placing a hold, or the server stopped partway, a hold may be on the card with nothing pointing at it. The route answers 502 and the alert says so. You don't need to retry, and retrying is safe: it reuses the same Stripe key, so it can't place a second hold. The order remembers until this is settled. Every sweep pass looks, even after the 3 tries. It moves the order to that hold if the order would have been renewed, and otherwise cancels it. Cancelling, releasing, recording proof and a rejection also look for it and cancel it. You get an alert when one is cancelled, and by name if one can't be, so cancel that one in Stripe. The question closes once a look at least an hour later finds nothing.
- For a moment the customer has two holds. If cancelling the old one fails you are told, and the sweep keeps trying until Stripe confirms.
- A replaced order must be approved again before filing.
- If no hold can be placed before filing, the order can't file. If the customer wants to try the same card again, use `replace-authorization` with `customer_agreed`. There is no way to take a different card on an open order: `/cancel` it, which frees the LLC name, and the customer places a new order. Tell the customer first, because the cancel emails them that the order is cancelled.
- A notice that gave up can be sent again: `POST /api/orders/ORDER_ID/emails/hold_replaced/resend`, or `hold_replacement_failed`.
- Money on a hold the order does not use, whether replaced or untracked, raises an alert and stops the order: approve, proof and renewal answer `stray_capture_unresolved`. Refund that payment in Stripe. Do not release the order's own hold. The refund clears the block. The same goes for money on a cancelled order, or a second payment on a paid one: the alert says which, and that one needs a refund.
- A capture in the Dashboard with no proof raises `Money collected with no proof of filing`. Do not capture in the Dashboard.

## Stopping
- A hold that should not stand: `POST /api/orders/ORDER_ID/cancel`.
- Stop new sales: run `diy_139_on_sale.rollback.sql`, so checkout refuses. It also restores what the go-live script retired. If the go-live script never ran, the offer is still a draft and checkout already refuses.
- Keep the live key and the live webhook secret on Render until every live hold is captured or released. Restoring the test key with live holds open would make captures fail and live webhooks get rejected. Check first:
  `SELECT order_id FROM orders WHERE stripe_livemode = true AND payment_status = 'authorized';`
