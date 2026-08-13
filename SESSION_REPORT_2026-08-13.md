# Session Report — 2026-08-13

Autonomous session, Gate 1 ("finish the data spine"). Branch:
`feat/data-spine-schema`, off `main`. **Not merged. Not pushed.**
Reporting per the task's explicit instruction before any merge.

## What shipped

5 commits on `feat/data-spine-schema`:

```
3bc2297 Gate 1: failure tests 3/4/5 against real Supabase
fee23c5 Gate 1: CRM sync worker (Zoho client, backoff, poller)
504387b Gate 1 schema: POST /api/session/stage
39393dd Gate 1 schema: filing_sessions, filing_events, crm_sync_queue
d2ed834 DECISIONS.md: log live connectivity verification + node-pg-migrate substitution
```

11 files changed, 972 insertions, 0 deletions:

```
DECISIONS.md                               |  33 ++++
server/.env.example                        |  12 ++
server/migrations/0001_filing_sessions.sql |  57 +++++++
server/migrations/0002_filing_events.sql   |  15 ++
server/migrations/0003_crm_sync_queue.sql  |  43 +++++
server/src/index.ts                        |  24 +++
server/src/routes/session.ts               | 182 +++++++++++++++++++++
server/src/sync/backoff.ts                 |  35 ++++
server/src/sync/worker.ts                  | 165 +++++++++++++++++++
server/src/zoho/client.ts                  | 155 ++++++++++++++++++
server/test/syncWorker.integration.test.ts | 251 +++++++++++++++++++++++++++++
```

### 1. Schema (3 migrations, applied live against Supabase project `rtivwkqsuuvbkvdudgnd`)

`filing_sessions`, `filing_events` (append-only), `crm_sync_queue` —
exact column sets and indexes per spec. `npm run migrate` output:
`Applied: 0001_filing_sessions, 0002_filing_events, 0003_crm_sync_queue`.
Column structure independently verified against `information_schema.columns`.

**Deviation, documented in `DECISIONS.md`:** used the repo's existing
custom migration runner instead of `node-pg-migrate`. That package
isn't an installed dependency, and both the standing rule ("no new
dependency without approval") and this session's own stop-condition
("stop for: a new dependency") apply. The already-approved, already-in-use
runner does the same job, so I substituted rather than pausing the
whole session over it.

### 2. `POST /api/session/stage`

Mints `filing_session_id` server-side, upserts `filing_sessions`,
idempotent on `(filing_session_id, stage)` — a repeat call with the
same stage re-applies the upsert (harmless) but skips a second
`filing_events` row and a second `crm_sync_queue` enqueue. CRM enqueue
happens only once an email exists (own or already-on-session), in the
*same* transaction as the session write. Live-verified with 3 sequential
curl calls during an earlier turn (new session, idempotent duplicate,
enqueue-on-email); re-verified this session via the automated test.

### 3. CRM sync worker

- `zoho/client.ts` — injectable `ZohoClient` interface + `realZohoClient`
  (token refresh, Lead upsert, conditional Deal creation on paid status,
  401 detection). No Zoho credentials configured in this environment yet
  — jobs against it will fail gracefully (a normal queued failure, not a
  crash) until `ZOHO_CLIENT_ID`/`ZOHO_CLIENT_SECRET`/`ZOHO_REFRESH_TOKEN`
  are set on Render.
- `sync/backoff.ts` — 1m/5m/15m/1h/6h/24h, dead-letter at `attempts >= max_attempts` (6).
- `sync/worker.ts` — `claimNextJob` (`FOR UPDATE SKIP LOCKED`, short
  transaction), `syncWithOneFreeAuthRetry` (a 401 gets one immediate
  retry that doesn't count against `max_attempts`), `recordOutcome`
  (separate short transaction; success updates `crm_sync_queue` and
  `filing_sessions` together).
- `index.ts` — in-process poller, `SYNC_POLLER_INTERVAL_MS` (default
  30s, `0` disables it). Known gap, not addressed this session: the
  poller only runs while the Node process is up — the Render Cron Job
  sweeper backstop from `DEPLOY.md` ("Sync-worker hardening") is the
  independent safety net for gaps in that, and hasn't been built yet.

### 4. Failure tests — real output, against real Supabase (not pg-mem)

`npm run test` (2 files, 5 tests):

```
✓ test/migrationRunner.test.ts (2 tests) 21ms
✓ test/syncWorker.integration.test.ts (3 tests) 9988ms
  ✓ Test 3: Zoho 401 -> failed + preserved, then retry succeeds after refresh  3501ms
  ✓ Test 4: Zoho timeout -> failed + preserved, then retry succeeds            3496ms
  ✓ Test 5: abandonment leaves all prior data queryable                       2694ms

Test Files  2 passed (2)
     Tests  5 passed (5)
```

- **Test 3 (401):** fake client fails both the initial call and the
  free retry with `httpStatus:401` → job stays `pending` (not
  dead-lettered), `attempts=1` (the free retry did not count as a 2nd
  attempt), `last_error` captured, `payload_snapshot` unchanged,
  `filing_sessions.crm_sync_status='failed'`. Backoff then forced
  eligible immediately (no real 1-minute wait) and reprocessed with a
  client that now succeeds → `synced`, `crm_lead_id` set,
  `crm_last_synced_at` set.
- **Test 4 (timeout):** same shape, but a network-style error (no
  `httpStatus`) — confirms the free-retry rule is 401-specific, i.e.
  `syncWithOneFreeAuthRetry` does *not* retry a timeout inline.
- **Test 5 (abandonment):** hit `POST /api/session/stage` for real over
  HTTP (an in-process Express server on an ephemeral port) across 3
  stages, stopped short of "complete." Verified all 3 `filing_events`
  rows and the `filing_sessions` row (with its accumulated fields)
  remained queryable, and exactly one `crm_sync_queue` job existed
  (enqueued on the stage where email first appeared) — nothing gets
  rolled back or cleaned up just because the funnel wasn't finished.

Every row these tests create is deleted in `afterAll`; confirmed
post-run row counts on `crm_sync_queue`/`filing_sessions`/`filing_events`
were all `0`.

## An incidental fix, disclosed

The first test run failed — not because the worker was wrong, but
because `claimNextJob` (correctly) claims the *oldest* eligible pending
row in the whole table, and a leftover `crm_sync_queue` row
(`test@example.com`, stage `intake_start`) from an earlier session's
manual curl-testing of `POST /api/session/stage` was still sitting
`pending` in the real table. It got claimed ahead of my freshly-inserted
test rows, so the first run's assertions were checking the wrong job.
I deleted that leftover synthetic row (it was my own earlier test
artifact, not user data — confirmed via its `test@example.com`
email and generic stage names before deleting) and added a
`beforeEach` backlog-drain to the test file so it's self-defending
against this class of interference in the future. Real Supabase state
after cleanup: 0 rows across all three new tables.

## Not done this session (logged, not fixed — out of Gate 1's explicit scope)

- Render Cron Job sweeper backstop for the poller (`DEPLOY.md`,
  "Sync-worker hardening").
- Zoho OAuth credentials for this service are not yet set on Render —
  sync jobs will fail (gracefully, queued for retry) against production
  until they are.
- `feat/data-spine` branch cleanup in this repo is still pending your
  decision (git refused a safe `-d` delete since it's tracked against
  an unpushed `origin/feat/data-spine`) — unrelated to this session's
  work, flagged in an earlier turn, still open.

## Next

This branch is ready for your review. Per your instruction, I have not
merged and have not pushed. Let me know if you want the diff against
`main` shown in full before you decide, or want any of the "not done"
items above picked up next.
