# Gate 2 — Stripe Checkout Success/Cancel Return Routes Status

Two repos, one task: backend (`llc-filing-intake`, this repo) and frontend
(`florida-business-launchpad`, the sibling repo the checkout URLs actually redirect to). Nothing
committed, pushed, or deployed in either. The Stripe checkout-creation and webhook-verification
architecture is unmodified — this task builds the missing customer-facing return path and closes
the placeholder-`APP_BASE_URL` gap; it does not touch pricing, Products, Prices, the webhook, or
payment authority (all reproven unchanged, not rebuilt — see "Automated Test Results").

## 1. Actual Frontend Origin

Audited before writing anything (per this task's §1), not assumed:

| Environment | Origin | Evidence |
|---|---|---|
| Local dev | `http://localhost:8080` | `florida-business-launchpad/vite.config.ts`'s `server.port` |
| Production | `https://florida-business-launchpad.lovable.app` | `public/sitemap.xml` and `public/robots.txt`'s `Sitemap:` line — both canonical, both agree |

No existing checkout/review page was found (`grep -rln "checkout/session\|checkout_url\|crm_intent" src` →
zero matches) — the frontend has no UI wired to `POST /checkout/session` yet; this task's "real
Stripe test" (§10 below) therefore drives checkout creation the same way the prior two Gate 2
tasks did, via direct API calls, and picks up from there with real browser interaction once a
real `checkout_url` exists. This app also has **no existing dynamic route segments anywhere**
(`grep` of `App.tsx` — every route is a flat, static path) — a `/filing/:id/...` pattern would
have been the first of its kind. The design below deliberately avoids introducing one (see §2).

## 2. Success Route

`GET /checkout/success?session_id={CHECKOUT_SESSION_ID}` — `florida-business-launchpad/src/pages/CheckoutSuccess.tsx`,
registered in `App.tsx`. Built with Stripe's own `{CHECKOUT_SESSION_ID}` placeholder as the sole
identifier — not `filing_session_id` or `order_id` in a path segment, per this task's explicit
§2 guidance ("prefer Stripe's supported Checkout Session reference mechanism") and to close the
exact manipulation vector §13 asks about (see §8). Contains no secret keys, no DB credentials, no
payment data — only the Stripe-generated session id, which Stripe itself already puts in the URL.

`stripeCheckoutClient.ts`'s `success_url` was changed from the placeholder:

```diff
- success_url: `${APP_BASE_URL}/filing/${filingSessionId}/confirmation?session_id={CHECKOUT_SESSION_ID}`
+ success_url: `${APP_BASE_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`
```

## 3. Cancel Route

`GET /checkout/cancel?session_id={CHECKOUT_SESSION_ID}` — `src/pages/CheckoutCancel.tsx`. Same
identifier scheme as success (Stripe also supports the `{CHECKOUT_SESSION_ID}` placeholder in
`cancel_url`, confirmed live — see §10, step 7). Chosen so the cancel page can look up
`filing_session_id`/`crm_intent` for its "retry" action without the customer re-entering anything.

```diff
- cancel_url: `${APP_BASE_URL}/filing/${filingSessionId}/checkout`
+ cancel_url: `${APP_BASE_URL}/checkout/cancel?session_id={CHECKOUT_SESSION_ID}`
```

## 4. Environment Configuration

`APP_BASE_URL` (backend, `server/.env`) now documents and uses the real per-environment values
found in §1, using the existing pattern (a single env var read once, no source change needed to
switch environments):

```
local dev:            http://localhost:8080
production (Lovable): https://florida-business-launchpad.lovable.app
```

Local `server/.env` was updated from the `.example`-domain placeholder to `http://localhost:8080`
(used for the live proof, §10). The **deployed** Render service's own `APP_BASE_URL` was
**deliberately not touched** — this task does not deploy, and the correct production value is
documented above for whoever next updates that service's environment. Frontend side: no new env
var was needed — `src/lib/checkoutStatus.ts` reuses the existing `VITE_DATA_SPINE_URL` pattern
already established by `LLCFilingIntake.tsx` (same fallback literal, same env var name), per
§12's instruction to use the existing configuration pattern rather than inventing a second one.

## 5. Success-Page Payment-State Logic

The state-determination logic is a pure, exported function —
`determineSuccessPageState(response)` in `src/lib/checkoutStatus.ts` — kept separate from the
React component specifically so it's unit-testable without a DOM (this repo's `vitest.config.ts`
runs in a plain Node environment; no jsdom/testing-library is configured, and adding either
wasn't warranted for one task — the existing convention, `canonicalFilingData.ts`, is exactly
this same "extract the pure logic, test that" pattern, followed here rather than invented).

```
A. "paid"          — response.payment_status === 'paid' (and ONLY that)
B. "processing"    — checkout_status === 'checkout_created' but not yet paid
C. "not_confirmed" — checkout_status === 'checkout_failed', or any other non-paid state
D. "invalid"        — no order found for this session id
```

The page performs **zero writes** — every call it makes is a `GET`. State B polls
`GET /checkout/session-status` every 3s for up to ~60s (bounded, not an unbounded loop) while
still `processing`; nothing about polling ever mutates anything, so polling faster, slower, or
not at all changes only how quickly the customer sees an update, never the underlying truth.

## 6. Cancel Behavior

`CheckoutCancel.tsx` reads the order via the same `GET /checkout/session-status` (no separate
read path invented). If the order is genuinely cancelable (found, not paid), it shows "Payment
was not completed," preserves everything, and offers **Try checkout again** — which calls
`POST /checkout/session` with the `filing_session_id`/`crm_intent` the status response already
returned. If the session actually turns out to be paid already (stale bookmark, back-button after
a later successful payment), the page does **not** show a false cancellation — `determineCancelPageState`
routes that case to a distinct "already paid, here's the confirmation" message instead
(`src/lib/checkoutStatus.ts`'s own test file, "invalid — order is actually already paid," covers
this explicitly).

## 7. Retry Behavior

`checkoutService.createCheckoutSession` (backend, `server/src/checkout/checkoutService.ts`) now
checks for an existing **non-paid** order for the same `(filing_session_id, crm_intent)` before
inserting a new one:

```sql
SELECT order_id FROM orders
WHERE filing_session_id = $1 AND crm_intent = $2 AND payment_status != 'paid'
ORDER BY created_at DESC LIMIT 1
```

Found → reuse that `order_id` (update its `line_items`/`total_cents`/`checkout_status`,
never insert a second row). Not found → insert as before (unchanged first-attempt behavior,
verified by the pre-existing `checkoutService.test.ts` suite still passing unmodified). A
**paid** order is never reused — a distinct order gets created instead (verified,
`checkoutReturnRoutes.test.ts` "C", second test).

"Old Checkout Session remains historically identifiable" (this task's explicit requirement) is
satisfied without new schema: every Checkout Session creation — reused order or not — is logged
to the existing `filing_events` table (`event_type: 'checkout_session_created'`, payload includes
`stripe_checkout_session_id` and `reused_order`). `orders.stripe_checkout_session_id` itself only
ever holds the *current* session id (overwritten on reuse), but the full history of every attempt
survives in `filing_events` — reusing existing infrastructure rather than adding a second
event-log mechanism, matching the standing rule from the webhook task.

## 8. Authorization/Security Findings

Audited explicitly, per this task's §13:

| Concern | Finding |
|---|---|
| Order ID manipulation | `GET /checkout/session-status` and both return pages take a Stripe Checkout Session id (`cs_...`), never an `order_id` — `order_id` appears in this codebase only as server-generated *output* (unchanged from the prior webhook task's audit) |
| Filing session ID manipulation | Not present on either return route's URL at all — nothing to manipulate |
| Cross-customer access | Tested live with two real, distinct filing sessions/orders (`checkoutReturnRoutes.test.ts` §B) — customer A's session id never returns customer B's data, and substituting a `filing_session_id`/`order_id` value where a `session_id` is expected returns 404, not a leak (different id format never matches `orders.stripe_checkout_session_id`) |
| Unauthorized order lookup | The response is deliberately minimal — no email, name, address, or `filing_data`, verified by an explicit test asserting those keys are `undefined` in the response |
| Exposure of sensitive information | 404s return `{"found": false}` only — no DB error text, no stack trace, no hint about what *does* exist |

**The gap, documented rather than papered over (per this task's explicit instruction):** this app
has no user accounts, login, or session mechanism of any kind — every route in this service is
unauthenticated by design (a standing architectural fact, not something this task changed or
could fix without a genuine redesign, which was out of scope). The return routes' only protection
is that the Stripe Checkout Session id is a long, Stripe-generated, effectively unguessable
token — the same "magic link" trust model e-commerce confirmation pages commonly use without a
login wall. **The real, if narrow, residual risk:** anyone who obtains a specific `session_id`
(shared screenshot, browser history on a shared machine, a leaked referrer) could view that one
order's non-sensitive summary (product, amounts, checkout status) — never PII, never able to
mark it paid, never able to browse to a *different* order. This is the same class of gap already
documented for `/checkout/session` in the prior checkout-integration report; this task does not
close it (would require actual authentication — out of scope, "do not invent a weak workaround"
per the instructions) but does keep the exposed surface to the minimum the retry feature needs.

## 9. Automated Test Results

**New tests, backend** — `server/test/checkout/checkoutReturnRoutes.test.ts` (8 tests): session-status
lookup (found/404/400/idempotent-on-refresh), cross-customer isolation, retry-reuse
(no-duplicate-Order, and paid-orders-never-reused), cancel-state preservation. All passing.

**New tests, frontend** — `src/lib/__tests__/checkoutStatus.test.ts` (10 tests): every success-page
state transition (A/B/C/D), the explicit "browser cannot fake paid" assertion (wrong case, wrong
value, absent field — none produce `"paid"`), cancel-page state logic, currency formatting. All
passing.

Mapped against this task's §15 checklist:

| # | Requirement | Covered by |
|---|---|---|
| 1 | Paid Order displays confirmation | `checkoutStatus.test.ts` "A. paid"; live, §10 |
| 2 | Pending Order — no false confirmation | `checkoutStatus.test.ts` "B. processing"; live, §10 (the page showed "Confirming your payment" while Stripe had already said paid but our webhook hadn't landed yet) |
| 3 | Unpaid Order remains unpaid | `checkoutReturnRoutes.test.ts` "D"; live |
| 4 | Invalid Order reference handled safely | `checkoutReturnRoutes.test.ts` "A" (404, no leak); `checkoutStatus.test.ts` "D. invalid" |
| 5 | Success-page refresh is idempotent | `checkoutReturnRoutes.test.ts` "A" (5 reads, row count unchanged); live, §10 |
| 6 | Cancel preserves Order | `checkoutReturnRoutes.test.ts` "D"; live |
| 7 | Cancel preserves Filing Session | `checkoutReturnRoutes.test.ts` "D"; live |
| 8 | Retry doesn't duplicate Order | `checkoutReturnRoutes.test.ts` "C"; live |
| 9 | Browser cannot mark Order paid | `checkoutStatus.test.ts`'s explicit payment-authority test; the success/cancel pages contain no code path that ever calls anything but `GET` |
| 10 | Browser cannot access another customer's Order | `checkoutReturnRoutes.test.ts` "B" |
| 11 | Existing webhook payment flow remains intact | `test/webhook/*` (18 tests, byte-for-byte unmodified files, still passing) |

## 10. Real Stripe TEST Mode Results

Performed live, end to end, exactly as specified — not substituted with mocks anywhere in this
section:

1. Real backend intake (`POST /api/session/stage`) → `filing_session_id 7c3a387a-...`, `current_stage: "complete"`.
2. `POST /checkout/session` → real Order `2688d7d5-...`, real Stripe test Checkout Session, `reused_order: false`.
3. **Verified live against Stripe** that `success_url`/`cancel_url` on the real session are
   `http://localhost:8080/checkout/success?session_id={CHECKOUT_SESSION_ID}` and
   `.../checkout/cancel?session_id={CHECKOUT_SESSION_ID}` — the real frontend routes, not a
   placeholder.
4. Opened the real `checkout_url` in a browser — confirmed `$125.00 + $4.00 = $129.00`, Sandbox badge.
5. **Cancel test**: clicked Stripe's own "Back" link (which is `cancel_url`) — landed on the real,
   locally-running `/checkout/cancel` page (`document.title` verified: `"Checkout canceled"`),
   which rendered "Payment was not completed" with a working "Try checkout again" button.
6. **Verified via direct DB query** at this point: `orders.payment_status: "pending"`,
   `checkout_status: "checkout_created"`, `filing_sessions.current_stage: "complete"` — both
   fully preserved.
7. **Retry test**: clicked "Try checkout again" on the real cancel page → redirected to a *new*
   real Stripe Checkout Session. Verified live: `orders` still has exactly **1** row for this
   filing session, its `stripe_checkout_session_id` now points at the new session, and
   `filing_events` carries **both** session ids (`reused_order: false` then `true`) — the old one
   remains historically identifiable exactly as required.
8. Completed payment on the new session with Stripe's official test card
   (`4242 4242 4242 4242`, `12/34`, `123`) — including honestly checking Stripe's own "I am an AI
   agent acting on behalf of someone else" disclosure, since that's accurate.
9. **Verified live against Stripe**: `status: "complete"`, `payment_status: "paid"`, `amount_total: 12900`.
10. **The critical proof (§11 of this task):** landed on the real, running `/checkout/success`
    page immediately after — before any webhook had been delivered — and it showed **"Confirming
    your payment… Just a moment…"**, not a false "paid" message. A direct DB query at that exact
    moment confirmed `orders.payment_status` was still `"pending"` even though Stripe had already
    said `"paid"` — proving, live, that reaching the success URL is not itself treated as proof
    of payment.
11. Delivered the real post-payment session data to the webhook (same locally-signed-real-data
    technique as the prior two tasks — no public URL exists in this environment for Stripe to push
    to directly; see `GATE2-STRIPE-WEBHOOK-STATUS.md` §12 for the full explanation, unchanged
    here) → `200 {"result":"paid"}`.
12. **The success page updated itself automatically**, via its own polling, from "Confirming your
    payment" to **"PAYMENT CONFIRMED — You're all set — Florida LLC Formation — DIY. We received
    your payment of $129.00."** — no manual refresh needed.
13. **Refreshed the page** (a real browser navigation, not a soft reload) — identical paid state
    shown.
14. **Verified after both the auto-update and the refresh**: exactly **1** order for this filing
    session, exactly **1** `stripe_webhook_events` row for that order, `filing_sessions` untouched.

No live/production charge — Stripe TEST mode throughout (`livemode: false`, confirmed at every
API check).

## 11. Confirmation: No Duplicate Orders Created

Across the entire cancel → retry → pay → refresh sequence: **exactly one** `orders` row existed
at every point, confirmed by direct query after each step (§10, steps 7 and 14). The
`checkoutReturnRoutes.test.ts` suite (§9) covers this same guarantee automatically and repeatably.

## 12. Confirmation: The Browser Cannot Establish Payment

Structural, not just tested: `src/pages/CheckoutSuccess.tsx` and `CheckoutCancel.tsx` contain
**zero** `POST`/`PUT`/`PATCH`/`DELETE` calls to anything that touches `payment_status` — the only
non-`GET` call anywhere in either file is the cancel page's explicit, customer-initiated "Try
checkout again," which calls the pre-existing, unmodified `POST /checkout/session` (creates/reuses
a *pending* order — never sets anything to paid). `orders.payment_status = 'paid'` remains
settable in exactly one place in the entire backend — `webhook/stripeWebhookService.ts`'s
signature-and-payment-verified `UPDATE`, unchanged by this task (confirmed: `git diff` shows that
file untouched). Proven live in §10, step 10: Stripe itself reporting `paid` did not change our
own `payment_status` until the verified webhook actually ran.

## 13. Remaining Gate 2 Blockers

1. **§8's authorization gap** — no real authentication anywhere in this system; the return
   routes rely on Stripe's session id as an unguessable-but-unauthenticated token. Documented,
   not fixed (would require a genuine auth system, explicitly out of this task's scope).
2. **No checkout-initiation UI exists in the frontend yet** — `LLCFormationPackages`/pricing pages
   don't call `POST /checkout/session` today (confirmed in the audit, §1). This task built the
   *return* path; wiring an actual "Pay now" button into the funnel is a distinct, not-yet-started
   piece of work.
3. **Production `APP_BASE_URL`** on the deployed Render service still needs to be set to
   `https://florida-business-launchpad.lovable.app` by hand (or via Render's own tooling) before
   go-live — this task deliberately did not touch the live deployment (§20: no deploy).
4. Unrelated, unchanged from prior reports: `filing_sessions.payment_status`/`order_total_cents`/
   `payment_ref` remain unused legacy columns (documented `NON-AUTHORITATIVE`, not dropped); no
   Stripe webhook handling for `checkout.session.expired`/`async_payment_failed` (out of scope,
   not requested); `orders.crm_deal_id` stays `NULL` until Deal-at-checkout is deliberately built.
5. **Pre-existing test flakiness, unrelated to this task** (documented per §19's instruction to
   keep this separate): backend — the well-documented cross-file-parallelism artifact from prior
   reports; confirmed 81/81 clean with `--no-file-parallelism`. Frontend —
   `src/pages/__tests__/hero-spacing.test.ts` (2 tests, CSS layout assertions on `Index.tsx`) fails
   under the default `vitest run`; confirmed via `git log`/`git diff` this file and `Index.tsx`
   were untouched by this task, and the failure is pre-existing static-source-text matching
   unrelated to checkout — not a regression introduced here.
