# Gate 2 — Checkout Implementation Status

Audit of commit `666cc97` (`feat/checkout-session-endpoint`, local only — not pushed to
`origin`). Working tree confirmed clean at time of audit; no code changed as part of this
report. All findings below are grounded in the current file contents, `git show 666cc97`,
live Supabase inspection (project `rtivwkqsuuvbkvdudgnd`, `llc-filing-intake`), and a
fresh grep of `florida-business-launchpad`'s frontend router.

## 1. Checkout Endpoint

**Files changed by `666cc97`:**
- `server/src/routes/checkout.ts` (new, 109 lines)
- `server/src/index.ts` (+2 lines — import + `app.use(checkoutRouter)`)
- `server/package.json` (+1 dependency: `stripe@^22.5.0`)
- `server/package-lock.json` (lockfile update)
- `server/.env.example` (+20 lines — documents `STRIPE_SECRET_KEY`, `APP_BASE_URL`, 5 optional price-override vars)

| Question | Answer | Evidence |
|---|---|---|
| Endpoint/function name | `checkoutRouter`, handler on `POST /checkout/session` | `checkout.ts:51` |
| HTTP method | POST | `checkout.ts:51` |
| Request payload | `{ filing_session_id: string, crm_intent: string }` | `checkout.ts:52-53` |
| Authentication | **None.** No auth middleware in `index.ts`, no per-route check in `checkout.ts`. Any caller who knows a `filing_session_id` can request a checkout URL for it. | `index.ts` (full file, no auth middleware); `checkout.ts` (no auth check) |
| Filing session identification | Exact-match lookup: `SELECT current_stage FROM filing_sessions WHERE filing_session_id = $1` | `checkout.ts:69-71` |
| Line items identified by | Client sends `crm_intent` (a closed vocabulary of 4 strings) — never a Price ID or line item directly | `checkout.ts:59` |
| Pricing source | Hardcoded literal Stripe Price ID strings in a source-code object (`OFFER_PRICE_MAP`), each overridable by an env var | `checkout.ts:21-38` |
| Can client submit an arbitrary amount? | **No.** No amount field is read from the request body anywhere in the handler. | `checkout.ts:52-53` (only `filing_session_id`/`crm_intent` destructured) |
| Does the server calculate the total? | **No arithmetic total is computed anywhere in this code.** The server resolves `crm_intent` to one or two fixed Stripe Price IDs; Stripe itself determines the charged amount from those Price objects. See §2 for whether this satisfies the stated requirement. | `checkout.ts:21-38, 87-96` |
| Order/session persisted before Stripe call? | **No write occurs.** One `SELECT` (read) against the pre-existing `filing_sessions` row; no `INSERT`/`UPDATE` before or after `stripe.checkout.sessions.create()`. See §3. | `checkout.ts:69-84` |
| Stripe Checkout Session fields | `mode: "payment"`, `line_items`, `client_reference_id: filingSessionId`, `success_url`, `cancel_url`, `metadata` | `checkout.ts:87-98` |
| Stripe metadata | `{ filing_session_id, crm_intent }` | `checkout.ts:97-100` |
| Stripe customer information | **None set.** No `customer` or `customer_email` param, even though `filing_sessions.email` exists and is already collected earlier in the funnel — the gate query doesn't even `SELECT` it. | `checkout.ts:69-71, 87-96` (no `customer*` key) |
| Idempotency | **None.** No `idempotencyKey` passed as a request option to `stripe.checkout.sessions.create()`. A double-submit (double-click, client retry after timeout) creates two separate Stripe Checkout Sessions. | `checkout.ts:87-96` (single positional arg, no options object); confirmed via `grep -n idempotenc` → no match |
| Error handling | 400 (missing fields) → 400 (unknown `crm_intent`) → 409 (session not found) → 500 (DB error, `describeError`) → 409 (session not `'complete'`) → 502 (Stripe API error, `describeError`) | `checkout.ts:54-56, 60-63, 72-75, 77-79, 82-84, 104-106` |

**Two operational notes found during validation, not in the diff itself:**
- The local `server/.env` has only `DATABASE_URL` set — no `STRIPE_SECRET_KEY`, no `APP_BASE_URL`. `checkout.ts:5-8` throws at module load if `STRIPE_SECRET_KEY` is unset, and `index.ts` imports it unconditionally — **the server cannot start at all in this environment right now**, not just the checkout route. This endpoint has not been exercised end-to-end, even locally.
- `typecheck`, `build`, and the existing test suite (5/5, real Supabase instance) all pass unchanged (see §7). There are no tests for `checkout.ts` itself — it isn't exercised by anything in `server/test/`.

## 2. Server-Authoritative Pricing

**Claim to verify:** *"The client sends line-item IDs only. The server computes the total from a server-side price table."*

**Code path** (`checkout.ts:51-63`):
```
const crmIntent = typeof body.crm_intent === "string" ? body.crm_intent : "";
...
const lineItems = OFFER_PRICE_MAP[crmIntent];   // OFFER_PRICE_MAP is a hardcoded literal, lines 21-38
if (!lineItems) { return 400; }
```
`OFFER_PRICE_MAP` keys are `LLC_FORMATION_FASTTRACK`, `LLC_FORMATION_PREMIUM`, `EIN_FILING`, `LLC_FORMATION_DIY` — a closed, hardcoded set. Each value is one or two `{ price: <Stripe Price ID>, quantity: 1 }` objects, resolved from an env var or a hardcoded fallback literal. There is no code path in this file that reads a price, quantity, or amount from `req.body` and uses it.

**Verdict: no violation of the security property this requirement is protecting** — the client cannot select a Price ID and cannot submit an amount; `crm_intent` is validated against a fixed, server-owned map and rejected with 400 if unrecognized.

**One literal-wording mismatch, not a violation:** the server does not "compute a total" anywhere — there is no arithmetic. The actual charged amount is whatever Stripe's Price objects say, resolved by Stripe itself when the Checkout Session is created. This is the intended architecture (`DECISIONS.md`, 2026-08-11: *"Prices are Stripe Price IDs, not numbers computed or stored client-side"* — that decision explicitly rules out a locally-computed total in favor of Stripe-owned Price objects). So the requirement's underlying intent (client cannot dictate price) holds; the literal phrase "server computes the total" does not describe what this code does, by design.

## 3. Order Persistence

**Claim to verify:** `order/session record → Stripe Checkout Session` as the actual execution order.

**Exact DB operation and location:**
```ts
// checkout.ts:69-71
const existing = await pool.query<{ current_stage: string | null }>(
  "SELECT current_stage FROM filing_sessions WHERE filing_session_id = $1",
  [filingSessionId]
);
```
This is a **read**, not a write. It is the only database operation in the entire handler — there is no `INSERT` and no `UPDATE` anywhere in `checkout.ts`, before or after the `stripe.checkout.sessions.create()` call at line 87.

**What this means concretely:**
- The `filing_sessions` row must already exist and have `current_stage = 'complete'` — but that row was created and completed by an *earlier, separate* endpoint (`POST /api/session/stage`, `session.ts`), not by this one. So in the narrow sense that *some* order-related record durably exists before Stripe is called, the requirement holds — but only because it was satisfied by a prior request, not by this code.
- **This endpoint itself persists nothing.** No row records that a checkout attempt happened, which `crm_intent`/price map was resolved, or what Stripe Checkout Session ID was returned. If the created `checkout_url` is never opened, or the browser never reaches `success_url`/`cancel_url`, there is currently no database trace that a Checkout Session was ever created for that filing session — the only record of it exists in Stripe's own system, addressable later only via `client_reference_id`/`metadata` once a webhook handler is built (none exists yet — see §6).

**Verdict: the diagram as literally stated is not what this code does.** A pre-existing, already-durable record is *read and gated on* — nothing new is written as part of initiating checkout.

## 4. Frontend Return Flow

| Item | Current state | Evidence |
|---|---|---|
| Stripe `success_url` | `${APP_BASE_URL}/filing/${filingSessionId}/confirmation?session_id={CHECKOUT_SESSION_ID}` | `checkout.ts:94` |
| Stripe `cancel_url` | `${APP_BASE_URL}/filing/${filingSessionId}/checkout` | `checkout.ts:95` |
| Application success route | **Does not exist.** Fresh grep of `florida-business-launchpad/src/App.tsx` and all of `src/` for `filing/.../confirmation`, `checkout_url`, `crm_intent`, `success_url`/`cancel_url` returns zero matches. | `florida-business-launchpad` repo, `git log` unchanged since prior audit (`a28c0f9`) |
| Application cancel/return route | **Does not exist**, same grep, same result. | same |
| Filing session recoverable after cancellation? | **Data survives** (this endpoint never mutates `filing_sessions` — read-only, §3), but **there is no route for the user to land on.** If Stripe redirected a real user to `cancel_url` today, the SPA router has no matching route registered for `/filing/:id/checkout` and would fall through to whatever catch-all/404 behavior `App.tsx` has — the underlying intake data is intact in the database, but the user has no visible way back into it from that URL. | `florida-business-launchpad/src/App.tsx` (no matching `<Route>`) |

**This confirms, unchanged, what the prior handoff reported** — the frontend half of the return flow has not been built since that audit; there is no regression, but also no progress on it.

## 5. Supabase Security

Live inspection of project `rtivwkqsuuvbkvdudgnd` (`llc-filing-intake`), the only project this backend's `pg` pool connects to.

**Tables involved in checkout:**
- `filing_sessions` — read by the checkout gate (§1, §3)
- `filing_events`, `crm_sync_queue` — not touched by `checkout.ts` at all, but share the same RLS posture

| Table | RLS enabled | Policies |
|---|---|---|
| `filing_sessions` | **No** | 0 |
| `filing_events` | **No** | 0 |
| `crm_sync_queue` | **No** | 0 |
| `schema_migrations` | **No** | 0 |

Confirmed via `pg_policies` query against `public` schema: **zero rows** — no policies exist on any table, RLS or not. Supabase's own security advisor flags this as `rls_disabled_in_public`, level **ERROR**, on all four tables.

**Can the browser directly read/write this data?** Only if a caller holds a valid anon or service key for **this specific Supabase project** (`rtivwkqsuuvbkvdudgnd`) and hits its PostgREST endpoint directly. Checked: `florida-business-launchpad`'s frontend `.env` points at a **different** Supabase project (`VITE_SUPABASE_PROJECT_ID` resolves to a different ref entirely — unrelated to `llc-filing-intake`). So **no currently-shipped frontend code holds a key for this project**, and no browser-reachable path to these tables exists today through this codebase.

**Which operations are intentionally server-side:** all of them. `GOVERNANCE.md` rule 9 mandates this project's Postgres is accessed only via the `pg` driver over the session-pooler connection string, from server code — never via Supabase Auth, Storage, Realtime, Edge Functions, or the client SDK. The current implementation follows that rule; `checkout.ts` uses the shared `pool` from `db/pool.ts`, same as every other route.

**Standing risk, unchanged from the prior audit, not created by this commit:** RLS-off + zero policies means if this project's anon/service key were ever pasted into a frontend, a Supabase Edge Function, or any other client-facing surface, every row of `filing_sessions` (PII: name, email, phone, address) and `crm_sync_queue` (raw Zoho payload snapshots) would become fully readable and writable by anyone holding that key. **Per your instruction, RLS has not been enabled or modified — this is reported, not fixed.**

## 6. Gate 2 Gaps

| Requirement | Current State | Evidence | Action Required |
|---|---|---|---|
| Server-authoritative pricing | **Met.** Client cannot select a Price ID or submit an amount; `crm_intent` validated against a closed, hardcoded map. | `checkout.ts:21-38, 51-63` | None functionally; consider whether the hardcoded map should move to a DB-backed table before go-live |
| Order persisted before payment creation | **Partially met.** The filing session must pre-exist and be `'complete'` (checked via read), but this endpoint writes no order/checkout-attempt record of its own. | `checkout.ts:69-84` (SELECT only) | Decide whether to persist a checkout-attempt row (Stripe session ID, resolved `crm_intent`, timestamp) before or immediately after calling Stripe |
| Stripe Checkout | **Implemented.** `mode: 'payment'`, correct line items, `client_reference_id`, `metadata`. | `checkout.ts:87-98` | None |
| Success route | **Not implemented.** URL is generated; no matching frontend route exists. | `florida-business-launchpad/src/App.tsx` | Build the route |
| Cancel route | **Not implemented.** Same gap. | `florida-business-launchpad/src/App.tsx` | Build the route |
| Payment webhook | **Not implemented.** No route file exists; referenced only in a code comment as "a separate task." | `server/src/routes/` contains only `checkout.ts`, `health.ts`, `session.ts` | Build (Gate 2, later task — likely T3) |
| Idempotency | **Not implemented.** No `idempotencyKey` on the Stripe call. | `checkout.ts:87-96` | Add one (e.g. derived from `filing_session_id` + `crm_intent`, or a client-supplied nonce) |
| Filing-session preservation | **Met.** This endpoint is read-only against `filing_sessions` — cancellation or abandonment cannot lose intake data via this code path. | `checkout.ts:69-84` | None |
| Supabase RLS | **Disabled, 0 policies, on all 4 tables.** No browser-reachable path today (different Supabase project keyed in the frontend), but a standing risk if that changes. | `pg_policies` query (empty), Supabase advisor (`rls_disabled_in_public`, ERROR ×4) | User decision — not auto-applied, per instruction |
| Jinja2/WeasyPrint integration | **Not implemented**, and out of scope for this endpoint specifically — no code anywhere (frontend, worker, or this server) calls `/generate-pdf` yet. Confirmed unchanged from the prior funnel-data audit. | repo-wide grep for `generate-pdf`/`articles_of_organization` — no caller found | Build the context-composition layer (separate task; two confirmed data gaps and one string-mismatch bug already logged in that prior audit) |

## 7. Validation Performed

Read-only only — no source, dependency, database, or git-remote changes made.

- `git show --stat 666cc97`, `git show 666cc97 -- server/src server/.env.example server/package.json` — full diff reviewed
- `git status`, `git log`, `git branch -vv`, `git ls-remote --heads origin` — confirmed working tree clean, branch `feat/checkout-session-endpoint` local-only (not on `origin`)
- `npm run typecheck` — clean
- `npm run build` — clean
- `npm test` — 5/5 passing (real Supabase test instance, pre-existing tests; none cover `checkout.ts`)
- Supabase `list_tables` (verbose), `get_advisors` (security), and a direct read-only `SELECT ... FROM pg_policies` against project `rtivwkqsuuvbkvdudgnd` — confirmed RLS state and zero policies
- Fresh grep of `florida-business-launchpad/src` for any checkout/confirmation route wiring — confirmed absent, `git log` unchanged since prior audit

No fixes were implemented. No files were staged or committed. No packages were installed. No database policies were modified.
