# Gate 2 — Registered Agent Acceptance Workflow

Implements the locked schema exactly as approved — no field renamed, added, or removed from
`registered_agent_status` or `registered_agent_acceptance`. Nothing committed, pushed, or
deployed. Stripe, PDF generation, Jinja2, WeasyPrint, Sunbiz fax, Zoho Sign, and Google Maps
are untouched — confirmed via `git status` on `florida-business-launchpad` (unchanged from
the prior session) and by not importing/editing any of those modules in `llc-filing-intake`.

## 1. Existing Architecture Discovered

Audited before writing anything, per §12:

- **Database schema**: `filing_sessions` (migrations 0001–0004) has one existing status-style
  column pattern (`payment_status`, `crm_sync_status` — plain nullable `text`, no CHECK
  constraint) and one existing jsonb pattern (`filing_data`, added last session — exactly the
  PDF composer's `FilingSessionRecord` shape). `filing_events` (migration 0002) is an
  existing append-only audit table (`event_type` + `payload jsonb` + `created_at`) — already
  exactly what an audit trail needs.
- **Filing-session model**: `filing_data.agent_*` fields (`agent_choice`, `agent_name`,
  `agent_street`, `agent_unit`, `agent_city`, `agent_state`, `agent_zip`) already exist from
  the PDF-context work — this workflow writes to those same fields, not a parallel copy.
  Notably, `FilingSessionRecord` has **no `agent_email`** field — correct, since the PDF
  template never prints the registered agent's email. The registered agent's email belongs
  solely to the acceptance record (`registered_agent_email`, one of the locked fields), never
  duplicated into `filing_data`.
- **Email infrastructure**: **none exists anywhere in either repo.** Grepped both for
  nodemailer/SMTP/SendGrid/Resend/Mailgun/SES/Postmark — no matches. `llc-worker.js`'s
  `email` references are all Zoho CRM *field values* being stored, not messages the system
  sends. This is reported honestly in §5 below, not glossed over.
- **Auth/token utilities**: none exist beyond `randomUUID` (session.ts, for minting
  non-secret row ids). No hashing, no signing, no existing "secure link" pattern anywhere.
  Built entirely on Node's built-in `crypto` module — no new dependency.

**Smallest schema change determined**: one new nullable column (`registered_agent_status`)
on the existing `filing_sessions` table, plus one new table for the durable per-request
history a fast, safe, unauthenticated token lookup needs (a jsonb field can't be indexed for
that the way a real column can, and the locked schema needs multiple historical rows per
filing session — see §7's reissuance requirement). No other table or column was touched.

## 2. Schema Changes

`server/migrations/0005_registered_agent_acceptance.sql` — **applied** to the real dev
Supabase instance via `npm run migrate` (the project's own established, non-destructive
workflow, same as migration 0004 last session). Purely additive:

```sql
CREATE TABLE registered_agent_acceptances (
  id, filing_session_id (FK), status, requested_at, accepted_at,
  registered_agent_name, registered_agent_email, accepted_ip,
  acceptance_token_id (UNIQUE), acceptance_version,
  created_at, updated_at
);
ALTER TABLE filing_sessions ADD COLUMN registered_agent_status text CHECK (...six values or NULL...);
```

No existing column, table, row, or constraint touched. Reversible with a plain
`DROP TABLE` / `DROP COLUMN`.

## 3. Registered-Agent State Model

`registered_agent_status` lives on `filing_sessions` itself — the single, fast,
authoritative field the filing gate reads (§6 needs one lookup, not a join). `NULL` is the
implicit seventh state ("no registered agent chosen yet"), distinct from all six locked
values, which all describe an actual designation having been made.

`registered_agent_acceptances` holds the full history — every request attempt, not just the
current one. `filing_sessions.registered_agent_status` is always the current truth; the
table is where §9 (auditability) and §7 (reissuance) get satisfied.

**One interpretation decision, stated plainly rather than silently made**: the locked
`registered_agent_acceptance` field list has no `expires_at` column. §4 requires the token be
"time-limited" and §1 requires an `expired` status, so expiry has to be derived, not stored.
It's computed as `requested_at + 7 days` (`ACCEPTANCE_LINK_TTL_MS`, `types.ts`) at
verify-time, never as a stored field — this uses only the locked fields, it doesn't add one.

**Second interpretation decision**: "Do not store a raw reusable token if the security
architecture supports hashed token storage" is satisfied by making `acceptance_token_id`
store `sha256(raw secret)`, hex-encoded — a genuine identifier derived from the token, never
the secret itself, and usable directly as an indexed lookup key (`UNIQUE`). The raw secret
exists only in the emailed link and in memory for the instant a request is verified; it is
never written to the database.

## 4. Acceptance Workflow

`server/src/registeredAgent/acceptanceService.ts`:

- **`setDamianAsRegisteredAgent`** (§5): populates `filing_data.agent_*` from one canonical
  `DAMIAN_REGISTERED_AGENT` constant (the single source now — nothing else in the server
  hardcodes this address a second time), sets `registered_agent_status = 'accepted'`
  directly, sends no email, and — the §13.K requirement — supersedes any still-open prior
  outside-agent request first, so an old emailed link can never later flip status away from
  Damian's already-accepted designation.
- **`initiateOwnAgentAcceptance`** (§3): matches the locked schema's own stated order
  exactly — persists the agent info and sets `pending` **first**, validates **second**, and
  only on valid input attempts the send. An invalid submission leaves status `pending`, not
  `email_failed` (no send was ever attempted). On send success: `acceptance_requested` +
  a new acceptance row. On send failure: `email_failed` + a new acceptance row (for audit —
  see §7).
- **`reissueOwnAgentAcceptance`** (§7): pulls the agent's last-known name/email/address back
  out of `filing_data`/the last acceptance row and re-runs the same initiation — no filing
  session is ever duplicated, and a `registered_agent.retry` audit event is logged.
- **`acceptRegisteredAgent`** / **`declineRegisteredAgent`** (§4/§6/§8): `FOR UPDATE` row-lock
  the acceptance record by token hash before checking state, so two concurrent requests for
  the same token can't both succeed (classic double-submit protection, same posture as
  `session.ts`'s own upsert). Idempotent: re-presenting an already-`accepted` token returns
  success without touching `accepted_at`/`accepted_ip`/logging again; presenting it against
  any other terminal state (declined/expired/email_failed) is rejected outright.
- **`isFilingSessionRegisteredAgentAccepted`** (§6): the actual gate function, reading real
  database state. `isRegisteredAgentAccepted(status) === (status === "accepted")` — never
  inferred from email-sent/opened/clicked/confirmed, exactly as required.

## 5. Email Workflow

**No real transactional email provider is wired up** — none existed before this task (§1),
and provisioning one (Resend/SES/Postmark/credentials) is an infrastructure decision outside
this task's scope. `server/src/registeredAgent/emailSender.ts` defines the `EmailSender`
interface (mirroring `zoho/client.ts`'s existing pattern exactly — interface + result object
+ an injectable fake for tests) and `realEmailSender`, which fails clearly
(`ok: false, error: "No email provider configured..."`) rather than pretending to send,
matching this codebase's existing convention of failing loudly on missing configuration
(`pool.ts`, `zoho/client.ts`). Dropping in a real provider means implementing one `fetch`
call inside `realEmailSender` — nothing else in the workflow changes.

`buildRegisteredAgentAcceptanceEmail` is the dedicated template (§10): LLC name, registered
agent name, registered agent Florida address, a plain-language explanation, the secure link,
and expiration date. Deliberately excludes the filing session, any other address, and every
member/manager name — only what a registered agent needs to decide.

## 6. Token/Security Implementation

`server/src/registeredAgent/token.ts` — Node's built-in `crypto` only:
- `generateAcceptanceToken()`: 32 random bytes (`randomBytes`), base64url-encoded — the raw
  secret that goes in the email link.
- `hashToken(raw)`: `sha256(raw)`, hex — what's actually stored as `acceptance_token_id`.
- `tokenIdsEqual`: constant-time comparison helper (defined for any future manual-compare
  path; the current lookup uses an indexed equality match, which is already safe against
  timing attacks the way any indexed DB lookup is).

Properties delivered, matching §4 exactly: time-limited (7-day TTL, computed), single-use
(status flips out of `acceptance_requested` on first successful accept/decline/expiry —
never reusable after), tied to one filing session (FK), invalid after success (status check
rejects re-processing a non-`acceptance_requested` row), invalid after expiration (verified
at read-and-accept time). The URL (`/registered-agent/acceptance/:token`) carries only the
opaque token — no filing_session_id, no email, no name.

## 7. Filing Gate Behavior

`isFilingSessionRegisteredAgentAccepted(pool, filingSessionId)` is the gate. **Not wired to a
caller yet** — there is no "submit filing"/Sunbiz-transmission code path anywhere in this
codebase for it to gate (confirmed by audit; the closest existing thing, `checkout.ts`, gates
on `current_stage`, and modifying it was explicitly out of scope for this task). The function
exists, is tested directly (test scenario J, both branches), and is ready for whatever
submission step is built next to call.

## 8. Tests Performed

`server/test/registeredAgent/acceptanceService.test.ts` — all against the real Supabase dev
instance (same convention as every other integration test in this repo), with a fake
`EmailSender` injected per test (no real provider exists to test against — see §5). Every
row created is deleted in `afterAll`; confirmed zero orphaned rows in the database after the
run.

| Scenario | Covered |
|---|---|
| A. Damian → accepted, no email | ✓ |
| B. Outside agent → pending (even on invalid input, before validation fails it forward) | ✓ |
| C. Send succeeds → acceptance_requested + durable record | ✓ |
| D. Agent accepts → accepted, accepted_at/accepted_ip recorded | ✓ |
| E. Agent declines → declined, filing session preserved | ✓ |
| F. Token expires → rejected, status → expired | ✓ |
| G. Email transmission fails → email_failed, session preserved, audit row still recorded | ✓ |
| H. Used token cannot be reused | ✓ (two cases: re-accept is a no-op; decline-after-accept is rejected) |
| I. Duplicate processing creates no duplicate acceptance row or duplicate accepted event | ✓ |
| J. Filing gate rejects everything except accepted | ✓ (both branches) |
| K. Outside agent → Damian: old token invalidated, no stale requirement | ✓ |
| L. Damian → outside agent: resets to pending, initiates workflow | ✓ |
| Bonus: reissuance after email_failed doesn't duplicate the filing session | ✓ |

## 9. Exact Test Results

```
 ✓ test/pdf/composeArticlesOfOrganizationContext.test.ts (19 tests)
 ✓ test/migrationRunner.test.ts (2 tests)
 ✓ test/pdf/realSession.integration.test.ts (2 tests)
 ✓ test/syncWorker.integration.test.ts (3 tests)
 ✓ test/registeredAgent/acceptanceService.test.ts (15 tests)

 Test Files  5 passed (5)
      Tests  41 passed (41)
```

`npm run typecheck`: clean. `npm run build`: clean. `git diff --check`: clean (0 whitespace
errors). Lint: **no lint script/config exists in this repo**, unchanged from prior reports —
not something this task added or skipped.

`florida-business-launchpad` was not touched by this task — `git status` there is identical
to the end of the prior session (only the two files changed in earlier sessions remain
modified). No frontend build/lint run was needed since nothing there changed.

## 10. Remaining Issues

- **No real email provider.** `realEmailSender` fails clearly rather than sending anything —
  this is the single largest gap between "the workflow is correct" and "a registered agent
  actually receives an email." Needs a provider decision + credentials, outside this task.
- **The acceptance page is server-rendered HTML from the Express app**, not part of the React
  SPA or the Jinja2/WeasyPrint system. This was a deliberate scope decision: an external
  party (the registered agent) is following an emailed link, not using the funnel, and §12's
  implementation requirements were entirely backend-shaped (schema, filing-session model,
  email infra, token utilities) with no mention of frontend work. If a branded, SPA-hosted
  acceptance page is wanted instead, that's a separate, explicit frontend task.
- **No caller wires the filing gate into anything yet** (§7 above) — the function is real and
  tested; nothing in this codebase currently needs to call it, since no filing-submission
  step exists yet.
- **`Express.trust proxy` is not configured** — `req.ip` in the accept endpoint reflects
  whatever Express resolves it to under the app's current proxy settings; on Render (behind a
  load balancer), `app.set('trust proxy', ...)` may need setting for `accepted_ip` to be the
  real client IP rather than the proxy's. Not touched here — it's an app-wide Express setting
  with implications beyond this one route, not something to change as a side effect of this
  task.
- **No frontend wiring** — `LLCFilingIntake.tsx`'s registered-agent step still doesn't call
  `POST /registered-agent/select`; it still only writes to local `IntakeData` and the
  eventual funnel-submission payload. Wiring the actual UI to this workflow is a frontend
  task, not attempted here to keep this session's change strictly backend, per §12's own
  framing.
- **Automatic scheduled retries are not built.** §7 says "allow the system to retry," which
  this satisfies via an idempotent, safely-repeatable `reissueOwnAgentAcceptance` call — but
  nothing calls it automatically on a timer. Building a full poller (mirroring
  `sync/worker.ts`) was judged out of scope: §14 and "do not create a duplicate registered-
  agent acceptance mechanism" both argue against building a second background-worker
  subsystem alongside the existing CRM sync one without being asked to.

Stopping here as instructed — not proceeding to another Gate 2 subsystem.
