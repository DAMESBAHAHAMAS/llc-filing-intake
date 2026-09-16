# Gate 2 — Payment Authority Security Fix Status

Working tree: `feat/pdf-context-composer`. Nothing committed, pushed, or deployed. The Stripe
checkout-creation and webhook-verification flows themselves are unmodified — this task closes a
CRM-side trust gap, not the payment path (proven unchanged in §"Legitimate-Payment Regression
Test"). No Name Reservation work started, no Stripe pricing/Products/Prices touched, no
Jinja2/WeasyPrint/Sunbiz/fax touched.

## Original Vulnerability

`filing_sessions.payment_status` (migration `0001`, Gate 1) was in `routes/session.ts`'s
`SESSION_FIELDS` — the whitelist of columns `POST /api/session/stage` accepts directly from the
request body, with **no verification of any kind**. `zoho/client.ts`'s `realZohoClient.syncSession`
derived `isPaid` straight from that value:

```ts
const isPaid = snapshot.payment_status === "paid" || snapshot.payment_status === "completed";
```

`snapshot` is `SELECT * FROM filing_sessions WHERE filing_session_id = $1` — the *entire raw row*,
queued into `crm_sync_queue.payload_snapshot` and later handed to `syncSession` by the background
worker (`sync/worker.ts`). When `isPaid` was true, `syncSession` created a real Zoho **Deal**,
`Stage: "Payment Received"`, `Amount` taken from the equally client-writable `order_total_cents`
field.

## Attack Path

1. Attacker calls `POST /api/session/stage` with `{ stage: "<anything new>", email: "...",
   payment_status: "paid", order_total_cents: 999999999 }` — no authentication, no Stripe
   involvement at all.
2. `session.ts` writes `filing_sessions.payment_status = 'paid'` (whitelisted, trusted at face
   value).
3. Because the stage changed and an email is present, a `crm_sync_queue` job is enqueued with
   `payload_snapshot` = the full row just written, including the fabricated `payment_status`.
4. The sync worker (already running, polling every 30s in production) claims the job and calls
   `realZohoClient.syncSession(payload_snapshot)`.
5. `isPaid` evaluates `true` → a real Zoho Deal is created, `Stage: "Payment Received"`, with an
   attacker-chosen `Amount` — **with zero Stripe involvement and no real payment ever having
   occurred.**

This was entirely independent of `orders.payment_status` (the column the Stripe webhook writes) —
a completely separate, unauthenticated path to the same real-world consequence (a CRM system
believing a sale was paid).

## Files/Functions Affected

Full audit performed before any edit (per this task's §1), tracing every reference to
`filing_sessions.payment_status`, `orders.payment_status`, `crm_deal_id`, CRM Deal creation/update,
and all three routes named in the task:

| File | Role in the vulnerability | Confirmed via |
|---|---|---|
| `server/src/routes/session.ts` | Sole write path — `payment_status` was in `SESSION_FIELDS`, the *only* place any client input reaches this column | `grep` — one write site in the whole codebase |
| `server/src/zoho/client.ts` | Sole trust boundary — `isPaid` derivation | `grep` for every `payment_status`/`isPaid` reference |
| `server/src/sync/worker.ts` | Delivery mechanism — claims queued jobs, calls `syncSession`, persists `dealId` back onto `filing_sessions.crm_deal_id` | read in full |
| `server/src/routes/checkout.ts` / `checkoutService.ts` | **Confirmed clean** — never reads `payment_status` from the request body at all (only `filing_session_id`, `crm_intent`) | `grep -rn "order_id"` and the request-body destructuring in `checkout.ts` — no `payment_status` key read anywhere |
| `server/src/webhook/stripeWebhookService.ts` | **Confirmed clean** — the *only* place `orders.payment_status = 'paid'` is ever written, gated on signature verification + a live Stripe re-fetch | `grep -rn "SET payment_status"` — exactly one hit, in this file |
| Frontend (`florida-business-launchpad`, `src/`) | **Confirmed the field was never legitimately used** | `grep -rn "payment_status\|order_total_cents\|payment_ref\|crm_deal_id" src` → zero matches |
| PDF composer, registered-agent module | **Confirmed no legitimate reader** | `grep` across `server/src/pdf`, `server/src/registeredAgent` → zero matches |
| Live dev database | **Confirmed no stale exploited data** | `SELECT count(*) FROM filing_sessions WHERE payment_status IS NOT NULL` → `0` |

This audit is the basis for the fix below — not assumed complete from the prior report, re-derived
from scratch per this task's explicit instruction.

## Changes Made

**1. `routes/session.ts` — removed client write authority.** `"payment_status"` deleted from
`SESSION_FIELDS`. A client POSTing `payment_status: "paid"` now has that key silently dropped by
`extractPatch` (the same behavior any non-whitelisted key already had) — the column is simply
never touched by this route again. `order_total_cents` and `payment_ref` were **left in the
whitelist** — deliberate, not an oversight: with `isPaid` no longer derivable from anything on
`filing_sessions` (change 2, below), `order_total_cents` alone is inert for this attack surface,
and narrowing the whitelist further wasn't asked for and would be scope creep beyond the named
vulnerability.

**2. `zoho/client.ts` — removed the trust boundary itself, not just one input to it.** This is the
defense-in-depth half of the fix: even if `payment_status` somehow re-entered `filing_sessions`
later (a future bug, a different route, direct DB access), the CRM logic must not trust it. The
inline `isPaid` expression was replaced with an exported, independently-testable function:

```ts
export function isVerifiedPaidSnapshot(snapshot: Record<string, unknown>): boolean {
  return snapshot.verified_paid === true;
}
```

`verified_paid` is **not a `filing_sessions` column and never will be** — `session.ts`'s snapshot
is `SELECT * FROM filing_sessions`, so it can structurally never contain this key. The only way
this ever evaluates `true` is a caller that deliberately constructs a snapshot object containing
it, in memory, after establishing the payment is genuinely verified. No current code path does
this — `stripeWebhookService.ts` doesn't call `syncSession` at all today (see change 3) — so this
is the extension point for CRM-Deal-at-checkout, not a currently-exercised path.

**3. Migration `0009_filing_sessions_payment_status_non_authoritative.sql`** — `COMMENT ON COLUMN
filing_sessions.payment_status`, marking it `NON-AUTHORITATIVE / legacy` at the schema level.
Applied to the shared dev database. The column is **not dropped or renamed** — per this task's
explicit §8, and because the audit above proves "unused today" but not "provably safe to delete";
a comment is the durable, reversible record of intent without taking an irreversible action the
task didn't ask for.

## New Authority Model

```
Stripe (real payment)
  → POST /api/stripe/webhook  (signature verified, payment re-confirmed live — unchanged, §"CRM Impact")
  → webhook/stripeWebhookService.ts
  → UPDATE orders SET payment_status = 'paid'    ← the ONLY write site for this column, in the whole codebase
```

```
Browser (any client)
  → POST /api/session/stage        → payment_status: silently dropped (not in SESSION_FIELDS)
  → POST /checkout/session          → payment_status/order fields in the body: never read at all
  → (no other route exists that touches payment_status on any table)
```

`orders.payment_status` was already sound before this task (confirmed in the audit and
unchanged by it). What this task fixes is that `filing_sessions.payment_status` — a same-named,
different-table, unrelated-consequence field — could previously simulate a "paid" signal into
the CRM without ever going near `orders` or Stripe at all. That path is now closed at both ends:
input (§Changes 1) and trust (§Changes 2).

## CRM Impact

- **Ordinary funnel-progress Lead sync is unaffected.** `session.ts`'s `session_sync` jobs still
  enqueue and still upsert a Zoho Lead exactly as before — nothing about Lead creation changed.
- **Deal creation from `session_sync` is now permanently unreachable**, by construction —
  `isVerifiedPaidSnapshot` can never return `true` for a `filing_sessions`-derived snapshot.
  Verified directly: `test/security/paymentAuthority.test.ts` §C asserts this for every
  client-reachable shape (`"paid"`, `"completed"`, mixed case, truthy-but-wrong-type values) and
  end-to-end through the real enqueue path.
- **The "previously approved architecture" this task named — "Checkout initiated → Deal may
  exist as an open opportunity; Payment confirmed by Stripe → Order paid → CRM may be updated" —
  is not newly built here** (that would be redesigning the CRM/Stripe flow, out of scope by this
  task's own §18). It remains true that `stripeWebhookService.ts` does not call Zoho at all today
  (documented in `GATE2-STRIPE-WEBHOOK-STATUS.md` §9 and unchanged by this task) — Zoho stays off
  the payment-verification critical path entirely, which is exactly what §"Do not require a live
  Zoho call to prove this security fix" and the Security Acceptance Criteria ask for. `isVerifiedPaidSnapshot`
  is the deliberately-named seam a future Deal-at-checkout feature would use.
- **`ZOHOONE_TRIAL_EXPIRED` was never a dependency of this fix** — every test in
  `test/security/paymentAuthority.test.ts` and the unit assertions on `isVerifiedPaidSnapshot`
  run with zero Zoho credentials configured in this environment, proving the boundary without a
  live Zoho call, exactly as instructed.

## Database Impact

- `filing_sessions.payment_status`: **not dropped, not renamed** — `COMMENT ON COLUMN` added
  (migration `0009`) marking it non-authoritative/legacy. No rows currently have it set (`0`,
  confirmed live before this task began).
- `orders.payment_status`: **unchanged** — remains the sole canonical field, no duplicate column
  introduced anywhere.
- Migration history matches the live database: `schema_migrations` now ends at `0009`, applied
  via `npm run migrate` (`0001`–`0008` reported "already applied," `0009` applied cleanly).

## Attack-Test Results

All from `server/test/security/paymentAuthority.test.ts` (new file), run against the real dev
Supabase instance — real HTTP requests to a real Express app, not mocked:

| Test | Attack | Expected | Result |
|---|---|---|---|
| A | `POST /api/session/stage` with `payment_status: "paid"`, `order_total_cents: 999999999` | No paid Order; column stays unset | ✅ `filing_sessions.payment_status` stays `NULL`; this route never touches `orders` at all (`0` rows) |
| B | `POST /checkout/session` with a fabricated `payment_status: "paid"` (top-level and nested) in the body | Rejected/ignored — no public route can set `orders.payment_status` | ✅ Order created (legitimate), but `payment_status` stays `"pending"` — the field is never read by this route |
| C | Fabricated filing-session payment status attempting to trigger CRM Deal logic | No paid CRM state | ✅ `isVerifiedPaidSnapshot()` unit-tested against every client-reachable shape (all `false`); end-to-end test confirms a real enqueued `crm_sync_queue.payload_snapshot` never carries a trusted paid claim |
| D | Complete a filing with no payment at all | Order remains unpaid/pending | ✅ real persistence + real Order creation, `payment_status` stays `"pending"`, no webhook delivered |
| E | Complete an actual Stripe TEST payment | Verified webhook changes `orders.payment_status` → `paid` | ✅ covered exhaustively by the existing `test/webhook/stripeWebhookService.test.ts` (11 tests, unchanged by this task) **and** reproven live this task — see next section |

5 new tests, `test/security/paymentAuthority.test.ts`, all passing; re-run twice consecutively
with no leftover-row collisions.

## Legitimate-Payment Regression Test

Ran the full real flow live, end to end, a second time (first time was the prior Gate 2 task) —
specifically to prove this security fix doesn't break it:

```
POST /api/session/stage  → filing_session_id d880911f-..., current_stage: "complete"
POST /checkout/session    → order_id cb71177f-..., real Stripe test-mode checkout_url
[real browser payment: Stripe's official test card 4242 4242 4242 4242, real "Pay" click on
 Stripe's own hosted page — including checking Stripe's own "I am an AI agent acting on behalf
 of someone else" disclosure, since that's accurate; a UI automation snag needed a few retries
 (a required phone field on Stripe's own Link section, unrelated to this app or this fix) before
 the real submit went through]
→ verified live via Stripe: status: "complete", payment_status: "paid", amount_total: 12900,
  livemode: false
→ real post-payment session data delivered to POST /api/stripe/webhook with a genuine signature
  (same technique as the prior task's proof — no public URL in this environment, so transport is
  local, but the payment and the delivered data are both 100% real; see GATE2-STRIPE-WEBHOOK-STATUS.md
  §12 for the full explanation of this environment's constraint)
→ 200 { "received": true, "claimed": true, "result": "paid", "orderId": "cb71177f-..." }
```

Order after: `checkout_status: "checkout_created"`, `payment_status: "paid"`, `total_cents: 12900`,
`currency: "usd"` — unchanged shape from the prior task's proof. **Critically for this task:**
`filing_sessions.payment_status` was queried immediately after and is `NULL` — confirming the now
non-writable column played no role whatsoever in the legitimate path either, which is exactly what
the audit predicted (nothing legitimate ever depended on it).

No code in the checkout-creation or webhook-verification path was touched by this task — `git diff`
confirms the only changed files are `session.ts`, `zoho/client.ts`, `index.ts` (import ordering,
pre-existing from the prior task, not touched again here), `package.json`/`package-lock.json`
(pre-existing), and `.env.example` (pre-existing) — `checkout.ts`, `checkoutService.ts`,
`stripeCheckoutClient.ts`, `stripeWebhook.ts`, and `stripeWebhookService.ts` are byte-for-byte
what they were before this task.

## Full Test Results

```
npm run typecheck  — clean
npm run build       — clean
git diff --check   — clean (new files hand-checked for trailing whitespace too)
```

`npx vitest run --no-file-parallelism` (all 10 files, one at a time — the definitive, contention-free
result): **73/73 passing.**

`npm test` (default file-level parallelism): intermittently 71–73/73 passing depending on run —
the 2 possible failures (`handleCompletePersistence.test.ts`'s absolute-row-count assertion,
`syncWorker.integration.test.ts`'s job-claim-count assertion) are both **pre-existing test files
this task never touched**, racing against unrelated concurrent test files' legitimate DB writes
to the same shared tables (`filing_sessions`, `crm_sync_queue`) under vitest's default
per-file parallelism — not a regression. Confirmed twice: both fail files pass 100% run together
in isolation, and the full suite is 100% clean with parallelism disabled. This is the third
instance of the same documented characteristic (see `GATE2-CHECKOUT-INTEGRATION-STATUS.md` and
`GATE2-STRIPE-WEBHOOK-STATUS.md` for the first two) — adding more legitimate concurrent test
activity against shared tables makes it more likely to surface, not less, but it isn't a
correctness defect in this task's code. No lint tooling is configured in this repo.

New test file this task added: `test/security/paymentAuthority.test.ts` — 5/5 passing, re-run
twice with no leftover-row collisions (the exact class of bug found and fixed in the prior
webhook task's test suite — this file was written using unique, request-derived ids throughout
from the start, so it didn't recur here).

## Security Acceptance Criteria — Verified

1. **Client cannot set an Order to paid.** ✅ — `orders.payment_status = 'paid'` has exactly one
   write site in the codebase, gated on Stripe signature verification + live re-confirmation.
2. **Client cannot cause CRM to treat an unpaid filing as paid.** ✅ — `isVerifiedPaidSnapshot`
   is unreachable from any client-controlled input; `filing_sessions.payment_status` is no longer
   client-writable at all.
3. **Stripe webhook remains the authoritative payment source.** ✅ — unchanged from the prior
   task, reproven live this task.
4. **Valid Stripe payment still transitions the Order to paid.** ✅ — proven live, this task
   (§"Legitimate-Payment Regression Test").
5. **Duplicate webhook delivery remains idempotent.** ✅ — unchanged code (`stripe_webhook_events`
   PK-claim mechanism, migration `0008`); `test/webhook/stripeWebhookService.test.ts`'s idempotency
   tests are untouched and still passing.
6. **All attack tests pass.** ✅ — 5/5, §"Attack-Test Results."
7. **Existing legitimate checkout behavior remains intact.** ✅ — full suite passing (contention-
   free run), live regression reproven.

## Remaining Security Concerns

1. **`filing_sessions.payment_status`/`order_total_cents`/`payment_ref` remain unused, legacy
   columns.** Not dropped per this task's explicit instruction (§8) — a future task with a clear
   mandate to drop dead schema could remove them once someone's comfortable there's truly no
   historical/reporting dependency. Not a live risk as things stand (write path closed, trust
   boundary closed).
2. **`filing_sessions.crm_deal_id` is still in `SESSION_FIELDS`** (client-writable) — out of this
   task's named scope (`payment_status` specifically), and lower severity: setting it doesn't by
   itself cause Zoho to believe anything was paid (the current `realZohoClient` has no
   update-by-id capability at all, so a client-supplied `crm_deal_id` is inert today — it would
   only matter once/if Deal-update-by-id gets built). Worth a follow-up audit at that time, flagged
   here rather than silently left.
3. **No authentication on `POST /api/session/stage` or `/checkout/session`** — unchanged,
   previously documented (`GATE2-CHECKOUT-INTEGRATION-STATUS.md` §9), still true, still out of
   this task's scope.
4. **This environment still cannot receive a real Stripe-pushed webhook** (no public URL) — the
   regression proof reuses the same locally-signed-real-data technique as the original build;
   unchanged limitation, not introduced or worsened by this task.
