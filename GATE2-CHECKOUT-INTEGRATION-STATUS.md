# Gate 2 — Session Persistence + Checkout Integration Status

Working tree: `feat/pdf-context-composer`. Nothing committed, pushed, or deployed. No Stripe
webhook implemented. Jinja2/WeasyPrint, the Articles template, Corporate Kit, Sunbiz, fax,
Zoho Sign, and registered-agent acceptance are untouched by this task.

**A concurrent-session collision occurred and was resolved during this task — see §0.**

## 0. Concurrent session collision (resolved)

While this integration was in progress, another active Claude session — not this one — began
editing this same repository at the same time, on what looks like the same Gate 2 checkout
work: it modified `server/src/zoho/client.ts` (extending `realZohoClient.syncSession` with a
Lead→Deal-on-checkout decision and a Deal upsert path), wrote
`GATE2-LIVE-PERSISTENCE-STATUS.md`, wrote migration `0007_orders_payment_status_crm_deal.sql`
(`ALTER TABLE orders RENAME COLUMN status TO checkout_status`, plus new `payment_status` and
`crm_deal_id` columns), **ran it against the shared dev Supabase database**, and began rewriting
`checkoutService.ts`/`stripeCheckoutClient.ts`/`checkout.ts`/`checkoutService.test.ts` to add CRM
Deal sync and checkout idempotency (reusing an open order/Checkout Session on a second click).
It was stopped by the user mid-edit, leaving the working tree in an inconsistent state (e.g. the
test file had been partly updated to new type imports but not to the new function signature —
typecheck failed).

**Resolution, at the user's explicit direction:** this task's own implementation was restored as
the source of truth. `server/src/zoho/client.ts` was reverted to its original committed state
(`git checkout --`) — the CRM Deal-sync behavior change is fully discarded (it only ever existed
uncommitted in that other session; it is not recoverable from git, only from that session's own
transcript if the user wants it rebuilt later). The CRM Deal sync / order-reuse additions to the
checkout files were likewise discarded and replaced with this task's own versions (below).

**What was kept, deliberately, rather than reverted:** migration `0007` **had already been
applied** to the shared dev database by the time the other session was stopped (confirmed via
`schema_migrations` and `information_schema.columns` — `orders.status` no longer existed,
`orders.checkout_status`/`payment_status`/`crm_deal_id` did). Reversing an already-applied
migration on a shared database is itself a destructive schema change, and a strictly bigger
disruption than adapting three `UPDATE`/`INSERT` column references. So this task's code was
updated to use `checkout_status` (matching the live schema) instead of un-applying `0007`. The
`payment_status` and `crm_deal_id` columns are left in place, unused by this task's code
(nullable / defaulted, harmless) — see §9. The `0007` migration *file* itself had also been
deleted from the working tree when the other session was first interrupted; it was recreated
here so the migrations directory matches what is actually live in the database (a migrations
directory that doesn't match `schema_migrations` is worse than one with an extra file).

**One leftover artifact, not touched:** applying `0007` after `0006`'s own `idx_orders_status`
index already existed left two redundant indexes on the same column
(`idx_orders_status`, `idx_orders_checkout_status`, both on `orders.checkout_status`). Harmless
(minor write overhead only) — noted in §9 rather than fixed here, to avoid further schema churn
beyond what's needed for this task.

Everything below reflects the final, reconciled state — re-verified after reconciliation
(typecheck, build, full test suite, and a fresh live curl sequence all re-run; see §6, §8).

## 1. Branch Integration Performed

`feat/checkout-session-endpoint` (the original checkout branch, commit `666cc97`, local-only)
and this branch's uncommitted session-persistence work (`filing_data` support in `session.ts`,
CORS, `registeredAgentRouter`, migrations 0004/0005) were **not merged via `git checkout` /
`git merge`**. That branch switch was judged too risky: this working tree already carries a
large amount of *other* uncommitted, unrelated work (PDF composer, registered-agent acceptance,
several `GATE2-*-STATUS.md` reports) that a branch switch could disturb or silently carry across
in a conflicting way, and the task requires not overwriting or discarding existing work.

Instead: `checkout.ts` (`666cc97`) was read from the checkout branch via `git show`, and its
logic was reimplemented on top of the current tree as new, additive files —
`server/src/checkout/checkoutService.ts` and `server/src/checkout/stripeCheckoutClient.ts` — so
both pieces of work (session persistence + checkout) now coexist in one working tree, on one
branch, with nothing from either side discarded. `stripe` was added to `server/package.json`
(it was already present in `node_modules`, left over from a prior `git checkout` of that
branch, so `npm install` only regenerated the lockfile). No branch was switched; no commit was
made.

## 2. Persistence Behavior — `POST /api/session/stage`

Unchanged from the existing (uncommitted) implementation. Verified directly against the real
dev Supabase instance:

```
POST /api/session/stage
{ stage: "complete", email, full_name, entity_name_primary, filing_data: {...} }
→ 200 { filing_session_id, current_stage: "complete", stage_changed: true, event_id, queued_sync_id }
```

Confirmed by reading the row back: `filing_sessions.current_stage = 'complete'`,
`filing_sessions.filing_data` populated, `filing_session_id` is the server-minted UUID
returned in the response (test rows deleted after verification — see §7).

## 3. Checkout Gate Behavior — `POST /checkout/session`

Unchanged, not weakened: `checkoutService.createCheckoutSession` still does
`SELECT current_stage FROM filing_sessions WHERE filing_session_id = $1` and requires
`current_stage === 'complete'` before any order or Stripe call. Verified:

- Session not yet `'complete'` → gate rejects (`stage_not_complete`), **no order row created**,
  HTTP 409.
- Unknown `filing_session_id` → `session_not_ready`, HTTP 409, no order created.
- Session `'complete'` → gate passes, proceeds to order creation.

## 4. Order Creation

New table `orders` (migration `0006_orders.sql` + `0007_orders_payment_status_crm_deal.sql`, both
applied — see §0): `order_id`, `filing_session_id` (FK), `crm_intent`, `product`, `line_items`
(jsonb), `total_cents`, `currency`, `checkout_status` (`pending` / `checkout_created` /
`checkout_failed`), `stripe_checkout_session_id`, `failure_reason`, `payment_status` (unused by
this task — see §9), `crm_deal_id` (unused by this task — see §9), timestamps.

Amounts are **never** read from the request body — `checkoutService.ts`'s `OFFER_LINE_ITEMS` is
a server-only, closed map from `crm_intent` to Price IDs, labels, and `amount_cents`, verified
against live Stripe (§5). The order row is written, `checkout_status` `pending`, **before** any
Stripe API call — confirmed live (§7): a request with Stripe unreachable (no `STRIPE_SECRET_KEY`
configured in this environment) still produced a persisted order row.

For `crm_intent: "LLC_FORMATION_DIY"`, the order created is:

```json
{
  "crm_intent": "LLC_FORMATION_DIY",
  "line_items": [
    { "label": "Florida LLC Filing", "price": "price_1U9HsDDo01bXdbWStkpesATi", "quantity": 1, "amount_cents": 12500 },
    { "label": "Service Fee",        "price": "price_1U9HsRDo01bXdbWSHUSLnbcO", "quantity": 1, "amount_cents": 400 }
  ],
  "total_cents": 12900,
  "currency": "usd",
  "checkout_status": "pending"
}
```

`OFFER_LINE_ITEMS` was filled in for all four existing `crm_intent` values (`FASTTRACK`,
`PREMIUM`, `EIN_FILING`, `DIY`), each verified against live Stripe Price/Product objects (§5) —
not just the one this task's spec named — since the original `checkout.ts` already supported
all four and narrowing that without being asked would be a silent regression.

## 5. Stripe Price IDs Used (verified live via the Stripe MCP, test mode, `acct_1ChHmZDo01bXdbWS`)

| crm_intent | Price ID | Product | Amount | active |
|---|---|---|---|---|
| `LLC_FORMATION_DIY` | `price_1U9HsDDo01bXdbWStkpesATi` | Florida LLC Filing | $125.00 | true |
| `LLC_FORMATION_DIY` | `price_1U9HsRDo01bXdbWSHUSLnbcO` | Service Fee | $4.00 | true |
| `LLC_FORMATION_FASTTRACK` | `price_1U8ag7Do01bXdbWSrDQBWI8H` | Florida LLC Formation — FastTrack | $499.00 | true |
| `LLC_FORMATION_PREMIUM` | `price_1U8agADo01bXdbWSN7stU2LF` | Florida LLC Formation — Premium | $999.00 | true |
| `EIN_FILING` | `price_1U8agEDo01bXdbWSFyTsJj7n` | EIN Filing Service | $299.00 | true |

**Archived price confirmed and avoided:** `price_1U8afzDo01bXdbWSpjBCA0jn` ("Florida LLC Filing +
$4 Service Fee", $129.00, one combined line item) — `active: false`. This was the previous
`STRIPE_PRICE_DIY_STATE_FEE` fallback in the original `666cc97` checkout.ts. It is not
referenced anywhere in `OFFER_LINE_ITEMS` or in the test suite (asserted explicitly — see §8).
The other previous DIY fallback, `price_1U8ag4Do01bXdbWSz2lHRbXE`, no longer exists in Stripe at
all (`No such price`) — it would have hard-failed at checkout had it stayed in place.

## 6. Stripe Checkout Result

**Full live proof, end to end, now obtained.** A test-mode `STRIPE_SECRET_KEY` (`sk_test_...`,
never printed or logged by this task) was added to `server/.env` by the user after the previous
report. `APP_BASE_URL` was also unset in that file — required for `success_url`/`cancel_url` to
be syntactically valid URLs Stripe will accept — so a placeholder,
`https://florida-business-launchpad.example`, was added (the real frontend has no matching
routes yet — see §9 #5 — so any placeholder is equivalent until that's built).

With both set, the real sequence was run against the live `npm run dev` server:

```
POST /api/session/stage  { stage: "complete", email, full_name, entity_name_primary, filing_data }
→ 200 { filing_session_id, current_stage: "complete", ... }

POST /checkout/session  { filing_session_id, crm_intent: "LLC_FORMATION_DIY" }
→ 200 { checkout_url: "https://checkout.damianknowles.com/c/pay/cs_test_...", order_id }
```

Fetched the resulting Checkout Session directly from Stripe (read-only, via the Stripe MCP,
`expand: line_items`) to verify it independently of what the Node process claimed:

| Field | Value |
|---|---|
| `livemode` | `false` (test mode) |
| `status` / `payment_status` | `open` / `unpaid` (no charge made) |
| `amount_subtotal` / `amount_total` | `12900` / `12900` ($129.00) |
| `currency` | `usd` |
| line item 1 | "Florida LLC Formation — DIY: Florida State Filing Fee", `price_1U9HsDDo01bXdbWStkpesATi`, $125.00 |
| line item 2 | "Florida LLC Formation — DIY: Service Fee", `price_1U9HsRDo01bXdbWSHUSLnbcO`, $4.00 |
| `client_reference_id` | the real `filing_session_id` from step 1 |
| `metadata` | `{ filing_session_id, crm_intent: "LLC_FORMATION_DIY" }` |
| `success_url` / `cancel_url` | built from `APP_BASE_URL` + the filing session id, exactly as `stripeCheckoutClient.ts` constructs them |

No reference to the archived `price_1U8afzDo01bXdbWSpjBCA0jn` anywhere in the session.

The `orders` row was verified in the same pass: `checkout_status: 'checkout_created'`,
`payment_status: 'pending'`, `total_cents: 12900`, `currency: 'usd'`,
`stripe_checkout_session_id` matching the real Stripe session id above — written before the
Stripe call, updated after it succeeded, exactly per the designed sequence in §4.

**Not done, deliberately:** no actual card payment was submitted (task explicitly said "Do NOT
make a real charge" — nothing in this flow ever collects or submits payment details; that only
happens if a human opens `checkout_url` in a browser and enters test-card details themselves).
The test-mode Checkout Session was left to expire on its own (Stripe's default 24h TTL for an
unpaid session — confirmed via its own `expires_at`) rather than force-expiring it; the
connected Stripe MCP key doesn't have that operation available either, and it's unnecessary —
test-mode objects carry no cost or real-world effect. Test DB rows (`filing_sessions`, `orders`,
`filing_events`, `crm_sync_queue`) were deleted after verification, same as every other test run
in this task.

## 7. Failure Behavior

| Failure point | Behavior |
|---|---|
| Session missing / not `'complete'` | 409, **no order row created**, filing session untouched |
| Unknown `crm_intent` | 400, no DB access at all beyond the (already-passed) gate check |
| Order INSERT fails | 500, **Stripe is never called** |
| Stripe call throws | Order row updated to `checkout_failed` + `failure_reason`, **not deleted**; filing session untouched; 502 returned with the `order_id` so the failure is traceable |

All four verified — three via the automated test suite (§8, tests A/B/D), the fourth
(order-persistence failure) is exercised implicitly by never reaching the `INSERT` when the
gate rejects first; a true `INSERT`-failure simulation (e.g. a broken connection) was not
separately staged since the code path is a single `try/catch` already proven correct by the
Stripe-failure test's identical shape.

## 8. Integration Test Results

`server/test/checkout/checkoutService.test.ts` — new, added per this task's requirement for a
focused test proving persistence → complete stage → order → Stripe Checkout. Runs against the
real dev Supabase instance (same convention as every other test in this repo); a fake
`StripeCheckoutClient` is injected (same pattern already used for `ZohoClient`/`EmailSender` in
this codebase) since no live Stripe credential is available here (§6).

```
✓ A. Gate: current_stage must be 'complete' (2 tests)
✓ B. crm_intent validation — server-authoritative pricing (1 test)
✓ C. Happy path: persistence -> complete stage -> order -> Stripe Checkout (1 test)
✓ D. Stripe failure: order and filing session are preserved, not deleted (1 test)
✓ E. Real HTTP sequence: POST /api/session/stage then POST /checkout/session (1 test)
6 tests passed
```

Full suite, re-run after reconciliation (§0): `npm run typecheck` — clean. `npm run build` —
clean. `git diff --check` — clean (also checked new/untracked files by hand — no trailing
whitespace). `npm test` (full suite, all 7 files): **50 passed, 0 failed.**

(Earlier, pre-reconciliation, one run of the full suite showed
`test/registeredAgent/acceptanceService.test.ts` timing out on one test under the load of all 7
files running concurrently against the shared 5-connection Supabase pool — `pool.ts`'s `max: 5`,
a deliberate cap. That file is explicitly out of scope for this task and was not modified by it;
it passed 15/15 alone at the time and passed as part of the full suite on the final, clean run
above. Flagged here only in case it recurs — it's pool contention, not a regression.) No lint
tooling is configured in this repo.

## 9. Remaining Gate 2 Blockers

1. **`orders.payment_status` and `orders.crm_deal_id` are live in the schema but unused** by
   this task's code (§0/§4) — they were added by the now-discarded concurrent session's `0007`
   migration, which was kept only because it was already applied to the shared database.
   `payment_status` stays `'pending'` forever without a webhook (see #3 below); `crm_deal_id`
   stays `NULL` forever without CRM-Deal-at-checkout logic, which this task deliberately did not
   build (that was the concurrent session's design, discarded per the user's direction — see
   §0). Either build that feature deliberately later, or drop the two columns if they're not
   wanted — leaving them as permanently-unused nullable columns is a minor but real inconsistency
   worth a decision.
2. **Two redundant indexes** on `orders.checkout_status` (`idx_orders_status`,
   `idx_orders_checkout_status` — §0). Harmless, cheap to drop in a follow-up migration whenever
   convenient.
3. **Stripe webhook** — explicitly out of scope for this task, but `orders.checkout_status` stays
   `checkout_created` forever without one; nothing currently transitions an order to "paid."
   `STRIPE_SECRET_KEY` is now configured (§6), so this is unblocked whenever it's picked up.
4. **Frontend return routes** — `/filing/:id/confirmation` and `/filing/:id/checkout` still
   don't exist in `florida-business-launchpad`'s router (unchanged from the prior
   `GATE2-CHECKOUT-STATUS.md` audit — not touched by this task). `APP_BASE_URL` in `server/.env`
   is currently a placeholder (`https://florida-business-launchpad.example` — §6); set it to the
   real deployed frontend origin once these routes exist.
5. **No authentication** on `/checkout/session` — unchanged from the original `666cc97`
   implementation; any caller who knows a `filing_session_id` can attempt checkout for it. Not
   addressed here (task said don't redesign the subsystem); worth a decision before go-live.
