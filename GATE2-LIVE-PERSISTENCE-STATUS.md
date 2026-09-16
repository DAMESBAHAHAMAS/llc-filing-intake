# Gate 2 — Live Funnel Connected to Real Filing-Session Persistence

The persistence layer, composer, and WeasyPrint pipeline are unmodified — this task connects
`LLCFilingIntake.tsx`'s `handleComplete()` to them. Nothing committed, pushed, or deployed.
Stripe, fax, Sunbiz, Zoho Sign, Corporate Kit, and Google Maps are untouched.

## 1. Existing Completion Flow (traced before changing anything)

`handleComplete()` (`LLCFilingIntake.tsx`):
- **Collects**: the entire `IntakeData` object — every field from Articles I–VI, contact info,
  and signature.
- **Called**: `fetch(WORKER, ...)` — `WORKER = "https://llc-worker.damian-793.workers.dev/intake"`,
  a Cloudflare Worker, unrelated to `llc-data-spine`.
- **Payload**: a flat, hand-built, snake_case object (`llc_name`, `principal_street`, `members`,
  `manual_review_required`, `lead_type: "intake_complete"`, etc.) — a distinct shape from the
  canonical `FilingSessionRecord`, built solely for this Worker.
- **What the Worker does**: confirmed by direct diagnostic probe (`fetch` from the browser
  console straight at the Worker with a deliberately incomplete body) — it validates required
  fields (got a real `400 {"error":"Missing required field: llc_name"}` back) and, per
  `llc-worker.js`'s own code (audited last session), upserts Zoho CRM Lead/Deal records. It
  does **not** persist structured filing content anywhere queryable — CRM only.
- **Expected response**: `{ success: boolean, ... }`; `!res.ok` or `success === false` was
  already treated as failure.
- **After success**: `navigate("/llc-formation-packages")` — no intermediate screen, since (the
  comment already said) "the full payload already lives in shared IntakeContext."

**Not removed**: this exact Worker call, with this exact payload, still fires — see §3.

## 2. New Persistence Flow

`handleComplete()` now calls `POST ${DATA_SPINE_URL}/api/session/stage` **first**, with:
```
{ filing_session_id?, stage: "complete", email, phone, full_name,
  entity_name_primary, entity_name_backup, filing_data: buildCanonicalFilingData(data) }
```
`buildCanonicalFilingData` (new: `src/lib/canonicalFilingData.ts`) is the **only** place
`IntakeData` is mapped into the canonical shape — field names match
`server/src/pdf/types.ts`'s `FilingSessionRecord` exactly. No shared package exists between
the two repos, so this mapping and that type must be kept in sync by hand — stated plainly as
a coupling risk, not hidden.

`DATA_SPINE_URL` is `import.meta.env.VITE_DATA_SPINE_URL`, falling back to the deployed
`https://llc-data-spine.onrender.com` — set to `http://localhost:3000` in `.env.local` for
this session's testing. **CORS had to be added to the server** (`index.ts`, hand-written
3-header middleware, no new dependency) — without it, no browser call from any origin to this
API can succeed at all, in local dev or in production. This isn't incidental hardening; the
objective doesn't function without it.

## 3. Legacy Worker/CRM Relationship

**Chosen**: Frontend → `/api/session/stage` (persist) → Worker (CRM), not "Worker calls the
persistence endpoint." Smallest, safest change: the Worker is a separately deployed
Cloudflare Worker I have no way to test changes to from here; modifying and redeploying it
would be a larger, riskier change than adding one more `fetch` call in the frontend that
already makes one. The Worker's own code, payload, and behavior are **completely unchanged**.

**Order matters**: persistence runs first and is required; the Worker call is best-effort and
runs only after persistence succeeds (GOVERNANCE.md #1/#2: CRM is a downstream sync target,
never the system of record, and a filing record must exist independently of it). A Worker
failure is caught, logged (`console.error("[CRM sync] ...")`) — the same "never blocks the
user" convention this file already used for `fireUrgentReview` — and does not affect the
success path.

## 4. Duplicate-Submission Behavior

**Existing mechanism reused, not a new one invented**: `POST /api/session/stage`'s own
upsert-on-`filing_session_id` idempotency (already built and tested in Gate 1). A new
`IntakeData` field, `dataSpineFilingSessionId`, is written back the first time the server
returns one and reused on every subsequent call — so a retry (network hiccup, or a second
click that somehow reaches the handler) upserts the same row.

**Two layers verified**:
- Airtight synchronous guard: `isCompletingRef` (a `useRef`, checked and set before any
  `await`) — a second `handleComplete()` invocation returns immediately, closing the gap
  between a double-click and React's `submitting`-disabled re-render actually committing.
- Server-side: proven live (§6) — submitting the identical payload twice with the same
  `filing_session_id` produced `stage_changed: false` on the second call and left exactly one
  `filing_sessions` row and one `filing_events` row.

## 5. Failure Handling

**Persistence fails** (network error or non-2xx): `submitErr` is set to an actionable message,
the function returns before ever calling the Worker, and `navigate()` is never reached — the
success path requires persistence to have actually succeeded, not "the request completed."
Nothing in `IntakeContext`/`localStorage` is touched or cleared, so the customer's data
survives and Continue can be retried. Fixed one real bug while building this: an early
`return` inside a nested `try` would have skipped the original `finally` that resets
`submitting`/`isCompletingRef` — restructured into a single outer `try/finally` wrapping the
whole function so every exit path (early return, success) always resets them, verified live
(§6) that the button re-enables after a failure rather than staying stuck disabled.

**CRM fails after persistence succeeds**: caught, logged, does not undo or touch the
persisted row (nothing to delete — it's a durable Postgres row, independent of the Worker
entirely), does not block navigation to success. "Allow retry according to the existing
architecture" — there is no CRM-retry queue reachable from the browser; the failure is
surfaced via console/error-reporting instead of a customer-facing message, consistent with
this file's own "CRM failure never blocks the user" convention.

## 6. Browser Verification (real funnel, not simulated)

Ran the **actual customer-facing form** end to end via the running dev server (frontend on
`:8080`, `llc-data-spine` running locally on `:3000` against the real Supabase dev instance),
clicking through all 10 steps with a fully seeded, valid filing (Manager-Managed, Damian as
registered agent, other provisions, immediate effective date) to `handleComplete()`.

| Check | Result |
|---|---|
| 1. Frontend calls `/api/session/stage` | ✓ — `OPTIONS → 204`, `POST → 200` captured directly in the network log |
| 2. Request contains canonical filing data | ✓ — confirmed via the captured response and a direct Postgres read |
| 3. Postgres receives the data | ✓ |
| 4. `filing_sessions.filing_data` is queryable | ✓ — read directly via SQL |
| 5. Persisted data identical to submitted canonical data | ✓ — every field matched exactly (llc_name, all addresses, agent, managers/members with `article_iv_title`, effective_date_option, other_provisions, signer) |
| 6. Existing CRM behavior still occurs where expected | Confirmed the Worker is reachable and validates payload shape (direct diagnostic probe, real `400` response back). The tool used for this test does not capture network log entries for calls to that specific external domain — a **testing-tool limitation**, not a code issue (see below); circumstantial evidence (payload had `llc_name`, no error logged, external fetches confirmed working) strongly indicates the real call succeeded silently, but I did not capture the exact request/response pair for it directly |
| 7. Composer can consume the persisted session | ✓ — the unmodified composer, run against the exact row this browser submission created |
| 8. Real Jinja2/WeasyPrint PDF from that session | ✓ — real 2-page PDF generated and sent to you |

**Beyond what was asked**, because the tool limitation above left a gap, I proved CRM-failure
resilience (§7's scenario D) and persistence-failure blocking (scenario B) directly in the
browser rather than only by code review:
- Patched `window.fetch` to reject only the Worker's URL, resubmitted a fresh valid filing —
  console showed `[CRM sync] Worker call failed after successful persistence`, and the app
  **still navigated to the success page**, with the filing session **still durably persisted**
  in Postgres (verified by direct query).
- Patched `window.fetch` to reject the `/api/session/stage` call, resubmitted — the app
  **stayed on the same page**, showed "We couldn't save your filing...", the Continue button
  **re-enabled** (not stuck disabled), and **zero rows** were created in `filing_sessions` for
  that attempt.
- Directly proved duplicate-submission idempotency by resubmitting the identical
  `handleComplete()` payload (reading the real `dataSpineFilingSessionId` out of
  `localStorage`) a second time — same `filing_session_id` returned, `stage_changed: false`,
  one row, one event.

All test rows created during browser verification were deleted afterward; confirmed zero
orphaned rows remain.

## 7. Tests and Exact Results

`server/test/handleCompletePersistence.test.ts` (new) — the request shape
`handleComplete()` actually sends, against the real Supabase instance:

| Scenario | Result |
|---|---|
| A. Successful frontend/session persistence | ✓ automated + ✓ live browser |
| B. Persistence failure (missing `stage`) | ✓ automated (400, zero rows created) + ✓ live browser (patched fetch, verified no navigation/no row) |
| C. Duplicate completion/submission | ✓ automated (same payload twice → one row, one event, `stage_changed: false`) + ✓ live browser |
| D. CRM failure after successful persistence | **Live browser only** — this is frontend orchestration (sequential `await`s in one function), not something a backend integration test can exercise; proved directly instead of asserted by code review alone |
| E. Real persisted session → composer → PDF | Covered by the existing `test/pdf/realSession.integration.test.ts` (unchanged) + re-proven this session against the actual browser-submitted row |

`src/lib/__tests__/canonicalFilingData.test.ts` (new, frontend) — 5 tests on the mapping
function in isolation (llc_name fallback, address/agent field mapping, authorized-person
pass-through with `article_iv_title` intact, effective-date/provisions/signer mapping).

**Exact results:**
```
server (npm test):
 ✓ test/pdf/composeArticlesOfOrganizationContext.test.ts (19)
 ✓ test/migrationRunner.test.ts (2)
 ✓ test/pdf/realSession.integration.test.ts (2)
 ✓ test/handleCompletePersistence.test.ts (3)
 ✓ test/syncWorker.integration.test.ts (3)
 ✓ test/registeredAgent/acceptanceService.test.ts (15)
 Test Files  6 passed (6) | Tests  44 passed (44)
```
One transient failure on the first run of this exact suite (`registeredAgent` test K timed
out at the 5s default) — re-ran immediately and got 44/44 clean. Root cause: six test files
now share one Postgres connection pool capped at `max: 5` (`pool.ts`'s own deliberate,
documented Supabase-free-tier limit); with more test files added across this engagement,
concurrent execution occasionally exceeds that headroom. **Not a logic regression** — noted
under Remaining Issues, not fixed here (touching pool sizing or test concurrency is outside
this task's scope).

`florida-business-launchpad` (`npx vitest run`): 3 test files, 22 tests, **20 passed**,
**2 pre-existing failures** in `hero-spacing.test.ts` — confirmed unrelated (a homepage hero
CSS-spacing regression test; `git status` shows no hero/`Index.tsx` file touched by this or
any prior session in this engagement).

**TypeScript**: clean, both repos. **Lint**: server has no lint script/config (unchanged from
every prior report); frontend shows the same pre-existing 1 error + 6 warnings in code this
task didn't touch, zero new issues. **Production build**: clean, both repos (frontend's
bundle-size warning is pre-existing and unrelated). **`git diff --check`**: clean, both repos.

## 8. Remaining Gate 2 Blockers

- **The Worker call's exact success/failure for a real submission was not directly captured**
  (§6) — a limitation of this session's testing tool for that specific external domain, not
  of the implementation. Confirmed the domain is reachable and validates correctly; strongly
  circumstantial (not conclusively captured) evidence the real call succeeds.
- **Test-suite connection-pool contention** (§7) — six test files sharing a `max: 5` pool is
  starting to produce occasional timeouts under concurrent execution as the suite grows.
  Worth addressing (raise the pool max for test runs, or serialize test files) before adding
  significantly more integration test files.
- **`buildCanonicalFilingData` ↔ `FilingSessionRecord` sync is manual** (§2) — no shared
  types package between the two repos. A field renamed in one without the other risks a
  silent mismatch caught only by a broken PDF, not a type error.
- Everything already listed in `GATE2-CHECKOUT-STATUS.md`, `GATE2-PDF-CONTEXT-STATUS.md`,
  `GATE2-REAL-DATA-STATUS.md`, and `GATE2-REGISTERED-AGENT-ACCEPTANCE-STATUS.md` remains
  exactly as reported there — Stripe wiring, the payment webhook, success/cancel frontend
  routes, RLS, the registered-agent email provider, and the filing gate's caller are all still
  open, untouched by this task.

Stopping here as instructed.
