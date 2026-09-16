# Gate 2 — Stripe Payment Webhook Status

Working tree: `feat/pdf-context-composer`. Nothing committed, pushed, or deployed. Fulfillment
(PDF generation, Corporate Kit, Sunbiz, fax, confirmation email, Zoho Sign, registered-agent
acceptance, closing the CRM Deal) is explicitly **not** implemented — this task stops at a
verified-paid `orders` row. No Stripe catalog objects, Products, or Prices were created,
modified, or referenced beyond the two already-locked Gate 2 Prices.

## 1. Webhook Endpoint

`POST /api/stripe/webhook` — new route, [server/src/routes/stripeWebhook.ts](server/src/routes/stripeWebhook.ts).
Inspected the existing architecture first (`session.ts`, `checkout.ts`, `registeredAgentAcceptance.ts`)
before writing anything — no webhook route existed previously (confirmed by grep across
`server/src`); this is not a duplicate of anything. Mounted in
[index.ts](server/src/index.ts) via `app.use(stripeWebhookRouter)`.

All actual event-handling logic (idempotency, order lookup, payment verification, CRM) lives in
a separate, framework-free module, [server/src/webhook/stripeWebhookService.ts](server/src/webhook/stripeWebhookService.ts) —
`processStripeWebhookEvent(pool, stripeClient, zohoClient, event)`. The route itself only does
signature verification and status-code translation. This mirrors the existing
`checkoutService.ts` / `checkout.ts` split from the prior Gate 2 checkout task, and takes its
Stripe/Zoho clients as parameters — the same injectable-client pattern already used for
`ZohoClient` and `EmailSender` elsewhere in this codebase — so the service is fully testable
against the real dev database without live credentials.

## 2. Raw-Body Handling

`stripeWebhookRouter` is mounted in `index.ts` **before** `app.use(express.json())`:

```ts
app.use(stripeWebhookRouter);   // has its own express.raw({ type: "application/json" })
app.use(express.json());        // never reached for /api/stripe/webhook — the route above
                                 // always sends a response itself, without calling next()
```

The route uses `express.raw({ type: "application/json" })` as route-local middleware, so
`req.body` is the exact `Buffer` Stripe would send — never JSON-parsed, never re-serialized.
Verified genuinely, not just by code inspection: `test/webhook/stripeWebhookRoute.test.ts`
sends real signed byte payloads over real HTTP to a real Express app built the same way as
`index.ts`, and the signature verifies correctly every time — if the raw bytes had been altered
by an intervening JSON parse/re-serialize, every one of those tests would fail (signature
verification is byte-exact).

## 3. Signature Verification

`getStripe().webhooks.constructEvent(rawBody, signature, webhookSecret)` — the real `stripe`
npm package's own verification, not reimplemented. `STRIPE_WEBHOOK_SECRET` is read from
`process.env` inside the request handler (never hardcoded, never logged, never returned in any
response body). It is not present anywhere in frontend code, is `.env`-gitignored (confirmed:
`git check-ignore -v server/.env` → `.gitignore:7:.env`), and this task never printed its value
to any tool output.

Rejected, verified with real (not hypothetical) requests in `test/webhook/stripeWebhookRoute.test.ts`:

| Case | Result |
|---|---|
| Missing `Stripe-Signature` header | 400, no `stripe_webhook_events` row created |
| Signature computed with the wrong secret | 400, no row created |
| Valid-for-the-original-body signature replayed against a tampered body | 400 (the signature covers exact bytes — any change invalidates it) |
| `STRIPE_WEBHOOK_SECRET` unset on the server | 500 — refuses to even attempt verification of an otherwise-validly-signed request, rather than silently accepting it |

No unverified event is ever passed to `processStripeWebhookEvent` — verification happens
entirely in the route, before the service function is ever called.

## 4. Event Handling

Primary/only actively-handled event: `checkout.session.completed`. Inspected the actual
Checkout Session our `checkout.ts`/`checkoutService.ts` creates (both by reading the code and by
retrieving a real one live, §12) to determine the identifying relationship:

- **`stripe_checkout_session_id` on the `orders` row** (set right after
  `stripe.checkout.sessions.create()` returns, in the existing `checkoutService.ts`) is what
  this webhook actually keys its order lookup on: `SELECT ... FROM orders WHERE
  stripe_checkout_session_id = $1`, using the completed event's own `data.object.id`. This
  relationship already existed from the prior checkout task — nothing new was needed for it to
  work.
- **`order_id` was not previously present in the Stripe Checkout Session's own `metadata`** —
  only `filing_session_id` and `crm_intent` were. Since this task's own instructions (§4) name
  `order_id` explicitly as an expected identifying field on the Checkout Session, one small,
  additive change was made to the existing `stripeCheckoutClient.ts`/`checkoutService.ts`:
  `orderId` is now passed through and added to `metadata.order_id` when creating the session.
  This does not change the checkout-creation gate, pricing, or sequencing in any way — verified
  live (§12): the real Checkout Session's `metadata` shows
  `{"crm_intent":"LLC_FORMATION_DIY","filing_session_id":"...","order_id":"..."}`.

Relationship preserved and verified both ways: `Stripe Checkout Session.id → orders.stripe_checkout_session_id`
(what the webhook actually uses) and `Stripe Checkout Session.metadata.order_id → orders.order_id`
(a redundant, human/dashboard-visible cross-check, per this task's explicit ask).

Any event type other than `checkout.session.completed` is acknowledged with 200 and recorded as
`ignored_unhandled_event_type` — standard Stripe webhook convention (only 4xx/5xx should trigger
Stripe's own retry logic; there's nothing for this endpoint to act on for other types today).

## 5. Payment Verification

The webhook's arrival — and even a `checkout.session.completed` event's own embedded
`payment_status` field — is **never** trusted directly. `stripeWebhookService.ts` re-fetches the
Checkout Session fresh from Stripe by id (`stripeClient.retrieveCheckoutSession`, a real network
call to `stripe.checkout.sessions.retrieve`) and only proceeds if that live read says
`paymentStatus === "paid"`. On top of that, the freshly-retrieved `amountTotal`/`currency` are
compared against the order's own recorded `total_cents`/`currency`; a mismatch is treated the
same as "not verified" — the order is not marked paid, and it's flagged (`amount_or_currency_mismatch`)
for manual review rather than trusted blindly. Verified with real Stripe network calls in the
live end-to-end run (§12), and with fakes for every branch in `test/webhook/stripeWebhookService.test.ts`
(paid, unpaid, mismatched amount).

The `orders.payment_status` column can only ever be set to `'paid'` by this one code path — see
§10 for what this claim does and doesn't cover.

## 6. Order Identification

Covered fully in §4 — `stripe_checkout_session_id` (existing) plus `metadata.order_id` (added
this task, small and additive).

## 7. Idempotency

`stripe_webhook_events` (new table, migration `0008`) is the idempotency ledger — its primary
key **is** the mechanism: `event.id` is claimed via `INSERT ... ON CONFLICT (id) DO NOTHING
RETURNING id` before any other write happens. A 0-row result means this exact event.id was
already seen.

**One correctness issue found and fixed during development, before it shipped:** a naive
"0 rows returned = duplicate, skip" implementation is subtly wrong — if a *transient* failure
(e.g. the live Stripe verification call in §5 throws) happens *after* the row is claimed but
*before* processing finishes, Stripe's own retry of that same `event.id` would hit the same PK
conflict and be treated as an already-processed duplicate **forever**, even though it was never
actually completed. Fixed by distinguishing the two cases: on a conflict, the handler checks
whether the existing row's `processing_result` is `NULL` (claimed but never finished — safe to
reprocess using the same row) versus non-`NULL` (genuinely already processed — skip). Covered by
`test/webhook/stripeWebhookService.test.ts`'s "H. Stripe verification failure" test: a failed
verification leaves the row unfinished, and a retry with the identical `event.id` successfully
reprocesses and marks the order paid.

A second, independent duplicate-guard exists for a different scenario a pure event-id key
doesn't cover — two *distinct* event ids somehow both resolving to the same already-paid order
(shouldn't happen in practice, but cheap and correct to guard against regardless of cause): if
`orders.payment_status` is already `'paid'` when a `checkout.session.completed` event is
processed, it's a no-op (`already_paid_noop`) without even re-verifying with Stripe. Verified
both automatically (test "G") and live (§12 — a second, distinct event delivered for the
already-paid session).

No second competing event-log architecture was created: `filing_events` (keyed by
`filing_session_id`, about filing-stage transitions) and `crm_sync_queue` (keyed by
`filing_session_id`, about outbound Zoho jobs) don't fit a "have we seen this exact Stripe
event.id" question, so this is the smallest additive structure that does.

## 8. Database Changes

Inspected the live schema first (`information_schema.columns`, `schema_migrations`) before
writing anything, per this task's explicit instruction. Confirmed `orders` already has
`checkout_status`, `payment_status`, `crm_deal_id` (migration `0007`, from the prior Gate 2
checkout task) — **no duplicate columns created, no existing field renamed.**

One new table, migration `0008_stripe_webhook_events.sql`:

```sql
CREATE TABLE stripe_webhook_events (
  id                  text PRIMARY KEY,  -- Stripe event id, e.g. evt_...
  type                text NOT NULL,
  order_id            uuid REFERENCES orders (order_id),
  processing_result    text,
  payload             jsonb NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  processed_at        timestamptz
);
```

Applied to the shared dev Supabase instance; `schema_migrations` now ends at `0008_stripe_webhook_events`,
consistent with the actual database (verified via `npm run migrate`'s own "already applied"
report and a direct `information_schema` query — migration history matches reality).

**State transitions**, mapped onto the actual two-column schema (not forced into a single
column that doesn't match it):

```
orders.checkout_status:  pending → checkout_created   (existing, prior Gate 2 checkout task)
                                  → checkout_failed    (existing — Stripe session creation itself failed)

orders.payment_status:   pending → paid                (this task — ONLY via a verified webhook, §5)
                                  → (stays pending)      if Checkout is unpaid, abandoned, or expired
```

A failed or abandoned Checkout never reaches `payment_status = 'paid'` — it simply never
receives a verified `checkout.session.completed` event with `paymentStatus === "paid"`, so it
stays `pending` by construction (verified: test "E. Unpaid Checkout"). No customer record is
ever deleted by any code path this task added — Stripe failures, order-not-found, and mismatch
cases all `UPDATE`/log, never `DELETE`.

## 9. CRM Behavior

**Live constraint, stated directly:** the Zoho account currently reports `ZOHOONE_TRIAL_EXPIRED`.
This task's design makes that fact irrelevant to whether payment gets recorded — Zoho is never
called on the path that marks `orders.payment_status = 'paid'`; that `UPDATE` commits
independently, before any CRM code runs at all.

**What actually happens today:** `orders.crm_deal_id` is always `NULL` — Deal-at-checkout was
never built (a draft of it was written by a concurrent session during the prior Gate 2 checkout
task and explicitly discarded at the user's direction; see
[GATE2-CHECKOUT-INTEGRATION-STATUS.md](GATE2-CHECKOUT-INTEGRATION-STATUS.md) §0/§9). So today,
after a payment is confirmed, `stripeWebhookService.ts` checks `order.crm_deal_id`:

- **Always NULL in the current system** → records `crm_result: "no_crm_deal_yet"` in a
  `filing_events` audit row and does nothing further. **Zoho's `syncSession` is never called on
  this path** — verified explicitly in tests ("I. CRM", all three cases: `calls.length` is
  asserted `0`).
- **If `crm_deal_id` were ever populated** (dead code today, written for when Deal-at-checkout
  exists): the existing `realZohoClient.syncSession` (unmodified by this task) has no
  "update this specific Deal by id" capability — it only ever *creates* a new Deal. Calling it
  here would risk creating a **second** Deal for an order that already has one, directly
  violating this task's "do not create duplicate Deals" requirement. So this branch also does
  not call Zoho — it records `crm_result: "crm_deal_update_not_implemented"` instead of faking
  success or risking a duplicate create. This is a documented gap, not a silent one: fixing it
  requires extending `ZohoClient` with a real update-by-id capability, which is CRM-redesign
  work this task's scope explicitly excludes.

Net effect, matching every explicit constraint in this section: Zoho availability is not a
prerequisite (never on the critical path — test "I" includes a case where Zoho would
throw `ZOHOONE_TRIAL_EXPIRED` and the payment still commits as `paid`), no duplicate Deals are
ever created (Zoho is never called with an existing `crm_deal_id`), and no success is faked
(the two `crm_result` values above are the honest current state, not a placeholder).

## 10. Security Findings

Verified, with evidence, against every item in this task's checklist:

| Requirement | Status |
|---|---|
| Webhook secret is server-side only | ✅ `.env`-gitignored, read only inside the route handler, never returned in any response |
| Raw body is preserved | ✅ route-local `express.raw()`, mounted before `express.json()` — proven by successful genuine signature verification in real HTTP tests |
| Stripe signature is verified | ✅ real `stripe.webhooks.constructEvent`; missing/invalid/tampered all rejected (§3) |
| Client cannot mark an Order paid | ✅ `orders.payment_status` is set in exactly one place in the entire codebase — the `UPDATE` inside `processStripeWebhookEvent`, reachable only after signature verification + live Stripe re-verification |
| Order identification cannot be manipulated | ✅ confirmed by grep: `order_id` appears in this codebase **only** as server-generated output (returned to the client after creation) — no route anywhere accepts an `order_id` as client input. The webhook identifies the order solely from the Stripe-signature-verified event's own session id, never from anything the client sends |
| Client cannot call a route that directly changes `payment_status` to paid | ⚠️ **See finding below — not fully true today, for a column this task doesn't own.** |

**Finding — pre-existing, not introduced by this task, not fixed by it, documented as required
rather than silently ignored:** `filing_sessions.payment_status` (a *different* column from
`orders.payment_status` — same name, unrelated table, from migration `0001`, Gate 1) **is**
directly client-writable: `session.ts`'s `SESSION_FIELDS` whitelist includes `payment_status`,
`order_total_cents`, and `payment_ref`, all settable via a plain `POST /api/session/stage` call
with no verification whatsoever. Worse, that value is not inert — `session.ts`'s own file
comment states `realZohoClient.syncSession`'s Lead→Deal conversion logic reads
`payment_status === "paid"` from the *entire raw `filing_sessions` row* (queried and passed as
`payload_snapshot` when a stage changes) to decide whether to create a Zoho Deal marked "Payment
Received." **Concretely: any caller can `POST /api/session/stage` with `payment_status: "paid"`
and `order_total_cents: <anything>`, and the existing (unmodified) sync worker will create a
Zoho Deal reporting a payment that never happened through Stripe at all** — completely bypassing
this webhook, `orders.payment_status`, and the Stripe verification this task built.

This is **not** a gap in the Stripe-payment/`orders.payment_status` path this task was asked to
build — that path is sound (verified above). It's a pre-existing authorization gap in a
different, older column that happens to share a name and feed the same downstream CRM
consequence. It was out of this task's scope to fix (`session.ts`'s field whitelist is part of
"the filing persistence architecture," explicitly off-limits — §18), so it is documented here,
prominently, rather than silently left for someone to discover later. **Recommended fix, for a
future task:** remove `payment_status`/`order_total_cents`/`payment_ref` from
`session.ts`'s `SESSION_FIELDS` client-writable whitelist (nothing in the current frontend
appears to set them — worth confirming — and this webhook is now the correct, sole owner of
payment truth going forward).

## 11. Failure-Test Results

All from `test/webhook/stripeWebhookService.test.ts` and `stripeWebhookRoute.test.ts`, run
against the real dev database:

| Test | Expected | Result |
|---|---|---|
| A. Invalid webhook signature | 401/rejected, no Order update | ✅ 400 (matches Stripe's own documented convention for signature failures), no row created |
| B. Unknown Stripe event | Safely ignored/acknowledged, no state change | ✅ 200, `ignored_unhandled_event_type`, order untouched |
| C. Unknown order_id | Do not mark an unrelated Order paid; record the failure | ✅ `order_not_found`, no order touched, no Stripe call even attempted |
| D. Duplicate event | No second processing | ✅ same `event.id` twice → `claimed: false` the second time; exactly one `stripe_webhook_events` row |
| E. Unpaid Checkout | Order remains unpaid/pending | ✅ `payment_not_confirmed`, `payment_status` stays `pending` |
| F. Failed payment | Order does not become paid | ✅ covered by E plus the amount/currency-mismatch guard (an extra, stricter check this task added beyond what was literally asked) |
| G. CRM unavailable | Payment remains authoritative; Order remains paid; CRM failure recorded | ✅ test "I" injects a Zoho client that throws `ZOHOONE_TRIAL_EXPIRED` — `payment_status` still becomes `paid` |

18 tests total across the two webhook test files, all passing (§16).

## 12. Real Stripe TEST Payment Result

Performed the exact sequence, live, in this environment's constraints (no public URL — see the
note below on what "webhook delivery" means here):

1. **Real backend intake** (the frontend UI itself was not driven for this proof — the
   already-proven `POST /api/session/stage` path from the prior Gate 2 checkout task was reused,
   consistent with how that task's own live proof was done): `filing_session_id
   f2b965f7-518d-46cb-b670-690e29033402`, `current_stage: "complete"`.
2. **Real order + real Checkout Session**: `POST /checkout/session` → 200,
   `order_id df063a25-737a-4cc2-ab09-40596928b4bb`, real `checkout_url`.
3. **Order before payment** (§13 below).
4. **Opened the real `checkout_url` in a browser** (not curl) — confirmed the "Sandbox" badge,
   `$129.00`, "Florida LLC Formation" line item.
5. **Completed payment with Stripe's official test card** — `4242 4242 4242 4242`, `12/34`,
   `123`, ZIP `33101` — entered into Stripe's real hosted Checkout page, submitted via the real
   "Pay" button.
6. **Verified live, directly against Stripe** (read-only, via the Stripe MCP, not via anything
   this app claimed): the real Checkout Session now shows `status: "complete"`,
   `payment_status: "paid"`, `amount_total: 12900`, `livemode: false`,
   `payment_intent: "pi_3U9K4wDo01bXdbWS0qntfhcB"`,
   `metadata: {crm_intent, filing_session_id, order_id}` all correct.
7. **Delivered the webhook.** This environment has no public URL, so Stripe cannot push a
   webhook to this server directly (true regardless of this task — there is no tunnel/CLI
   available here, confirmed: `stripe`/`ngrok`/`cloudflared` are all absent). The Stripe MCP's
   Events API is also not exposed through its tool surface (confirmed via repeated
   `stripe_api_search`). So: the real, freshly-retrieved Checkout Session object from step 6
   (100% genuine Stripe data, fetched *after* the real payment, not fabricated) was wrapped in a
   `checkout.session.completed` event envelope and signed locally with the real `stripe` npm
   package's `webhooks.generateTestHeaderString`, using the same `STRIPE_WEBHOOK_SECRET` this
   server is configured with, then POSTed to the real running local server exactly as Stripe
   would. **What this does and doesn't prove, stated plainly:** the payment is 100% real, the
   session/payment data delivered is 100% real (not invented), and — critically — the webhook's
   own payment verification (§5) makes an *independent, second, live* call back to Stripe
   (`stripe.checkout.sessions.retrieve`) to reconfirm `paymentStatus: "paid"` before marking
   anything paid, so the actual authoritative check ran for real regardless of how the initial
   delivery was simulated. What's simulated is only the outer event envelope's `id` (Stripe's
   own real event id was not obtainable here) and the transport hop (local POST instead of
   Stripe's own outbound push, since Stripe has no way to reach this environment).
8. **Verified our webhook received it**: `POST /api/stripe/webhook` → `200 {"received":true,"claimed":true,"result":"paid","orderId":"df063a25-..."}`.
9. **Signature validation**: genuine — computed with the real `stripe` package against the
   configured secret; the route's `constructEvent` call accepted it.
10. **Event type**: `checkout.session.completed`, handled as primary.
11. **Correct Order identified**: `df063a25-737a-4cc2-ab09-40596928b4bb`, matching the order
    created in step 2 — via `stripe_checkout_session_id`, not via anything the delivery payload's
    outer envelope specified.
12. **Stripe payment status verified**: the webhook's own live re-fetch (not this test's earlier
    read) confirmed `paid` before writing anything.
13. **Order updated**: `payment_status: "paid"` (§14 below).
14. **Stripe Checkout Session id matches**: `orders.stripe_checkout_session_id` still
    `cs_test_b1HCFKr7k6UwRr0czW8xVjkHE0ka6xrhHKc74a5ZqZQR55M2KRa6s5qIxe`, unchanged.
15. **Order remains linked to the correct filing session**: `orders.filing_session_id`
    unchanged, `f2b965f7-518d-46cb-b670-690e29033402`.
16. **No duplicate Order**: `SELECT count(*) FROM orders WHERE filing_session_id = ...` → `1`.
17. **Duplicate delivery safely ignored**: redelivered a second, distinct signed event for the
    same (now-paid) session → `{"result":"already_paid_noop"}`, order untouched, no second
    processing.

No real charge in the sense of live money — this was Stripe **TEST mode** throughout
(`livemode: false`, confirmed at every step), using Stripe's own official test card.

## 13. Order Before Payment

```json
{
  "order_id": "df063a25-737a-4cc2-ab09-40596928b4bb",
  "filing_session_id": "f2b965f7-518d-46cb-b670-690e29033402",
  "crm_intent": "LLC_FORMATION_DIY",
  "total_cents": 12900,
  "currency": "usd",
  "checkout_status": "checkout_created",
  "payment_status": "pending",
  "stripe_checkout_session_id": "cs_test_b1HCFKr7k6UwRr0czW8xVjkHE0ka6xrhHKc74a5ZqZQR55M2KRa6s5qIxe",
  "crm_deal_id": null
}
```

## 14. Order After Payment

```json
{
  "order_id": "df063a25-737a-4cc2-ab09-40596928b4bb",
  "filing_session_id": "f2b965f7-518d-46cb-b670-690e29033402",
  "crm_intent": "LLC_FORMATION_DIY",
  "product": "LLC_FORMATION_DIY",
  "total_cents": 12900,
  "currency": "usd",
  "checkout_status": "checkout_created",
  "payment_status": "paid",
  "stripe_checkout_session_id": "cs_test_b1HCFKr7k6UwRr0czW8xVjkHE0ka6xrhHKc74a5ZqZQR55M2KRa6s5qIxe",
  "crm_deal_id": null
}
```

Only `payment_status` changed. Every other field — `order_id`, `filing_session_id`,
`crm_intent`/`product`, `total_cents` (12500 + 400 = 12900), `currency`, `stripe_checkout_session_id` —
preserved exactly, as required. `checkout_status` also untouched (it describes Checkout Session
*creation*, a separate concern from payment — see §8).

## 15. Duplicate-Event Result

Corresponding `stripe_webhook_events` row after the real run:

```json
{ "id": "evt_local_construct_...", "type": "checkout.session.completed", "processing_result": "paid", "order_id": "df063a25-..." }
```

A second, distinct signed event for the same session, delivered immediately after:

```json
{ "received": true, "claimed": true, "result": "already_paid_noop", "orderId": "df063a25-737a-4cc2-ab09-40596928b4bb" }
```

Order count for this filing session after both deliveries: **1** (no duplicate order; no second
paid-transition; no second CRM attempt — moot here since `crm_deal_id` was and remains `NULL`).

## 16. Full Test Results

```
npm run typecheck  — clean
npm run build       — clean
git diff --check   — clean (new/untracked webhook files hand-checked for trailing whitespace too)
```

New tests this task added, both passing 100%, re-run twice consecutively with no leftover-row
collisions (a real bug found and fixed during development — see the file comment in
`stripeWebhookService.test.ts`: hardcoded event-id literals collided with rows orphaned by a
prior run, since `order_not_found`/`ignored_unhandled_event_type` results have no `order_id` for
the existing cleanup pattern to catch — fixed by generating a unique id per event and tracking
every one for cleanup):

```
test/webhook/stripeWebhookService.test.ts  — 11/11 passing
test/webhook/stripeWebhookRoute.test.ts    —  7/7  passing
```

Full suite (`npm test`, all 9 files, vitest's default file-level parallelism): **67/68 passing.**
The one failure, `test/handleCompletePersistence.test.ts`'s "B. Persistence failure" test, is a
pre-existing file this task never touched — it asserts an *absolute* `filing_sessions` row count
is unchanged across a request, which is inherently racy once enough *other* test files are
inserting unrelated rows into the same shared table concurrently (the same class of flake
already documented for `acceptanceService.test.ts` in the prior
[GATE2-CHECKOUT-INTEGRATION-STATUS.md](GATE2-CHECKOUT-INTEGRATION-STATUS.md)). Confirmed not a
regression two ways: it passes 3/3 in isolation, and running the entire suite with
`--no-file-parallelism` (forcing test files to run one at a time) gives a clean **68/68**. No
lint tooling is configured in this repo.

## 17. Remaining Gate 2 Blockers

1. **§10 finding — `filing_sessions.payment_status` is client-writable and drives a real CRM
   consequence, unrelated to and unprotected by this task's work.** The most concrete follow-up
   item from this task; recommended fix stated in §10.
2. **`orders.payment_status = 'paid'` is currently a terminal state with no further automation.**
   By design (fulfillment explicitly out of scope) — the natural next Gate 2 task is exactly what
   this one calls out as its own handoff point: reading a newly-`'paid'` order and beginning
   fulfillment (PDF, Sunbiz, Corporate Kit, confirmation email, closing the CRM Deal), none of
   which this task started.
3. **CRM Deal-at-checkout still doesn't exist**, so `orders.crm_deal_id` stays `NULL` and every
   payment's `crm_result` will read `"no_crm_deal_yet"` until that feature is deliberately built
   (see §9's discarded-draft history) — at which point `realZohoClient` will also need a real
   update-by-id capability, which it does not have today (§9).
4. **No real webhook delivery test is possible in this environment** — no public URL, no
   `stripe`/`ngrok`/`cloudflared` tooling available, and the connected Stripe MCP doesn't expose
   the Events API. §12's proof is as real as this environment allows (genuine payment, genuine
   post-payment data, genuine independent live re-verification) but is not literally "Stripe
   pushed this over the network." Setting up a real endpoint (Stripe Dashboard webhook config +
   a reachable URL, e.g. once this service is deployed to Render) would close this gap
   completely — `STRIPE_WEBHOOK_SECRET` would then need to be the real `whsec_...` Stripe issues
   for that endpoint, not the locally-generated one currently in `server/.env`.
5. Unrelated, unchanged from the prior report: two redundant indexes on `orders.checkout_status`,
   no frontend return routes (`/filing/:id/confirmation`, `/filing/:id/checkout`), no
   authentication on `/checkout/session` itself.

## Cleanup

Test `filing_sessions`/`orders`/`filing_events`/`crm_sync_queue`/`stripe_webhook_events` rows
created during this task (both the automated test suite's own rows, cleaned up in each file's
`afterAll`, and the manual live-proof rows from §12) were deleted after verification. Migration
history was not altered — `0008` stays applied, consistent with the live database. No Stripe
catalog objects (Products/Prices) were created, modified, or deleted; the real test-mode
Checkout Session from §12 is left to expire on Stripe's own normal schedule, per this task's
explicit instruction not to attempt destructive cleanup Stripe doesn't support. The local dev
server was stopped after testing. No test credentials were committed — `git status` shows only
the same tracked-file modifications and new untracked files as before this task; `server/.env`
(holding `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`) remains `.gitignore`d and was never
committed, printed in full, or included in any file this task wrote.
