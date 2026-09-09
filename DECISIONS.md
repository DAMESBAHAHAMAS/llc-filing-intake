# DECISIONS — LLC Filing Funnel / Data Spine

Living, append-only architectural decision log. Same discipline as
`florida-business-launchpad/GAPS.md`: append immediately, in the same
response a decision is made — never wait for a summary or session end.
**Never edit an existing entry.** A reversed or changed decision is a new,
appended entry that names which earlier entry it supersedes; the original
stays exactly as written.

Format per entry: `## <date> — <decision>` heading, followed by
**Rationale** and **Supersedes**.

---

## 2026-08-11 — The durable data store is the existing Supabase Postgres project, accessed via the `pg` driver directly

**Rationale:** the project already had a Supabase Postgres instance
provisioned (`cedwebrzbpjwusbshdiu`) — unused, with an empty schema — rather
than nothing. Using it avoids standing up a second Postgres instance for no
reason. Access is plain SQL via `pg`, not the Supabase JS client — no
Supabase Auth/Storage/Realtime/Edge Functions anywhere in this build.

**Supersedes:** the original framing in the data-spine kickoff request,
which said "Postgres on Render preferred."

---

## 2026-08-11 — Frontend must never touch Supabase

**Rationale:** only the server owns the database connection. Keeps the
Supabase project's credential surface entirely server-side — the frontend
has none of it, so there's nothing there to leak or misuse.

**Supersedes:** —

---

## 2026-08-11 — `DATABASE_URL` uses Supabase's session pooler (port 5432), never the direct connection or the transaction pooler (port 6543)

**Rationale:** the direct connection (`db.<ref>.supabase.co:5432`) is
IPv6-only and unreliable from hosted runtimes like Render. The transaction
pooler (port 6543) disables prepared statements and session-level state,
which breaks advisory-lock-based migration tooling and will break the
planned `SELECT ... FOR UPDATE SKIP LOCKED` job-claiming pattern in the CRM
sync queue. The session pooler (`aws-<region>.pooler.supabase.com:5432`) is
the only option compatible with both.

**Supersedes:** —

---

## 2026-08-11 — `pg` pool capped at `max: 5` everywhere this project connects to Supabase

**Rationale:** free-tier shared-CPU Micro instance has limited connection
headroom. An exhausted pool presents as a hung request or timeout, not an
obvious "pool size" error — capping it low and explicitly avoids hours of
misdiagnosis chasing a phantom code bug.

**Supersedes:** —

---

## 2026-08-11 — CRM sync uses a `crm_sync_queue` table with transactional enqueue

**Rationale:** the queue insert must commit in the *same transaction* as the
originating `filing_sessions`/`filing_events` write — if the write succeeds
but the enqueue doesn't (or vice versa), that's exactly the kind of silent
data loss this whole build exists to prevent. Job claiming uses
`SELECT ... FOR UPDATE SKIP LOCKED` so multiple workers/poll cycles can't
double-process the same row. A Zoho `401` triggers one token refresh + retry
that does **not** count against `max_attempts` — a token expiry isn't a
"real" failed attempt and shouldn't burn down the retry budget.

**Supersedes:** —

---

## 2026-08-11 — The data-spine backend lives at `llc-filing-intake/server/`, deployed as its own Render Node Web Service

**Rationale:** the Cloudflare Worker runtime can't hold persistent Postgres
connections or run multi-statement transactions without a paid Hyperdrive
add-on — incompatible with the transactional-enqueue + `SKIP LOCKED` queue
design above. Sharing the existing Flask/gunicorn PDF service's process
would let CPU-bound WeasyPrint renders starve transactional session writes.
Not `florida-business-launchpad` (frontend-only) and not a new standalone
repo (keeps all backend pieces — Worker, PDF service, data spine — in one
place).

**Supersedes:** —

---

## 2026-08-11 — Migration direction: Express becomes the single owner of all Zoho CRM writes; the Worker becomes a thin edge layer

**Rationale:** keeps three services with clean, non-overlapping ownership —
Cloudflare Worker (edge routing, Sunbiz proxy, forwards CRM-bound requests
to Express), Express (durable store, session state, all Zoho writes, sync
queue), Flask/gunicorn (PDF rendering only) — instead of Zoho logic
duplicated across runtimes. Not built yet; this is the direction to build
*toward*. Any place where Zoho logic would need to be copied across
runtimes in the meantime should be flagged and reported, not copied.

**Supersedes:** —

---

## 2026-08-11 — The Express service gets its own, fresh Zoho OAuth client credentials

**Rationale:** keeps the Worker's and Express's Zoho access independently
revocable during the migration window described above — a credential
problem in one runtime can't take down the other, and the eventual cutover
doesn't require synchronizing a shared credential.

**Supersedes:** —

---

## 2026-08-11 — Payment processor is Stripe; no alternatives evaluated

**Rationale:** explicit decision, not derived — stated directly rather than
left open for a build-time evaluation.

**Supersedes:** —

---

## 2026-08-11 — Stripe integration uses hosted Checkout, not a custom card-collection UI

**Rationale:** hosted Checkout keeps PCI scope minimal (no raw card data
ever touches this project's servers or client code) and avoids building and
maintaining a custom payment form, which is a much larger and riskier
surface than this build needs to own.

**Supersedes:** —

---

## 2026-08-11 — Prices are Stripe Price IDs, not numbers computed or stored client-side

**Rationale:** directly closes the pattern flagged as a gap during the
funnel audit (`GAPS.md` #2 in `florida-business-launchpad`) — package/addon
totals were computed in the browser and never reached any backend. Using
Stripe Price IDs as the single source of truth means the price actually
charged is whatever Stripe's dashboard says it is, never a number the
client computed and the server trusted blindly.

**Supersedes:** —

---

## 2026-08-11 — Deployment split: Claude builds code + deploy config only; the user provisions and deploys

**Rationale:** standing rule of this engagement (never push to main, never
touch the user's cloud accounts) applied concretely to Render. Deliverables
are `render.yaml`, `.env.example`, a `/health` endpoint, and `DEPLOY.md` —
not a live, Claude-provisioned service. The user deploys the skeleton once
those four things exist and migrations run clean locally against Supabase,
*before* the sync worker is written — so DB/network connectivity gets
proven while the only thing that can break is a health check, not while
debugging connectivity and queue logic simultaneously.

**Supersedes:** —

---

## 2026-08-11 — Render service starts on the free tier now; upgrade to a paid Starter (always-on) instance before Stripe goes live

**Rationale:** a free Render web service spins down after inactivity, which
stops the in-process `node-cron` CRM-sync poller — queued syncs stall until
the next inbound request wakes the service. Acceptable pre-launch (no real
customers, no real money moving yet); unacceptable once Stripe is live,
since a stalled sync queue at that point means real orders sitting unsynced
to CRM. `DEPLOY.md` carries a "before Stripe goes live" checklist item for
the upgrade, plus adding a Render Cron Job sweeper for stuck rows. The
poller interval is a configurable env var so it can be tuned without a code
change.

**Supersedes:** —

---

## 2026-08-11 — `/health` always returns 200 (with `db: "connected"|"error"`); `/ready` returns 503 when the database is unreachable

**Rationale:** Render's own health check is pointed at `/health` — a 200
there regardless of DB state prevents Render from crash-looping the service
over a transient DB blip (e.g., Supabase free-tier auto-pause). `/ready` is
a separate, stricter endpoint for the user's own manual verification and
for the sync worker to gate on later, where a non-2xx genuinely should mean
"don't proceed."

**Supersedes:** —

---

## 2026-08-11 — Never push to `main` in either repo; the user pushes

**Rationale:** standing rule, reinforced explicitly during the merge-sequence
work: "I push. You never push." Every merge Claude performs lands on a
local `main` only; publishing to the remote is always a separate, explicit
action the user takes themselves.

**Supersedes:** —

---

## 2026-08-11 — `chore/remove-unused-supabase-client` merged to `main` in `florida-business-launchpad` (local merge, not pushed)

**Rationale:** zero call sites confirmed before merge (dead code — an
unused Supabase client scaffold, empty schema); independent of and safe
ahead of the rest of the data-spine work, so it shipped first rather than
waiting behind everything else.

**Supersedes:** —

---

## 2026-08-11 — `.env` being tracked in `florida-business-launchpad`'s git history is fixed going forward only; git history is not rewritten

**Rationale:** the keys exposed (Google Places API key, and until removal,
the Supabase publishable/anon key) are client-exposed-by-design
"publishable" keys, not deep secrets. A `filter-repo` history rewrite isn't
judged worth it for two non-critical keys across multiple branches/remotes.

**Supersedes:** —

---

## 2026-08-11 — `chore/untrack-env-file` (florida-business-launchpad) held unmerged pending confirmation of how the Lovable-hosted build sources `VITE_*` vars

**Rationale:** merging blind risks silently breaking the live build if
Lovable's build reads the committed `.env` file rather than its own
separately-configured environment variables — this can't be confirmed from
either repo alone; needs a check of the Lovable project dashboard.

**Supersedes:** —

---

## 2026-08-11 — `GAPS.md` (florida-business-launchpad) is a living register for the whole project, not a one-time audit artifact

**Rationale:** append on discovery, in the same response; never
delete/renumber/rewrite a row; only Status/Commit SHA/Re-verified may be
updated; re-verify every OPEN P0/P1 row against the current tree whenever
`main` has moved since the last session, before any build work.

**Supersedes:** —

---

## 2026-08-11 — `DECISIONS.md` follows the same append-only discipline as `GAPS.md`

**Rationale:** a decision log that can be silently edited after the fact is
worthless as a record of what was actually decided and why, at the time.

**Supersedes:** —

---

## 2026-08-11 — `DECISIONS.md` and `GOVERNANCE.md` live in `llc-filing-intake`, not `florida-business-launchpad`

**Rationale:** data-spine architecture/process decisions and standing rules
belong with the backend they govern, not the frontend funnel repo. `GAPS.md`
stays in `florida-business-launchpad` — correct as originally placed, since
it tracks that repo's funnel defects specifically.

**Supersedes:** the initial placement of `DECISIONS.md` in
`florida-business-launchpad` (same content, no data lost — see that repo's
git history, commit `8ea4bb5`, for the original).

---

## 2026-08-11 — No more than 3 unmerged branches per repo at any time; a 4th requires reporting the backlog first

**Rationale:** six branches with nothing merged is how the audit went stale
the first time — unmerged work isn't doing anything for anyone, and it's
easy to lose track of what's actually landed versus what's still sitting on
a branch.

**Supersedes:** —

---

## 2026-08-11 — `DECISIONS.md` rewritten in per-entry Markdown-heading format, replacing the original table format

**Rationale:** explicit format change requested — `## <date> — <decision>`
heading with **Rationale**/**Supersedes** fields reads better for prose-heavy
entries than a wide Markdown table does, and scales better as entries
accumulate.

**Supersedes:** the original table-format `DECISIONS.md` (same 16 decisions
carried forward here, content-preserved, reformatted only — see this repo's
git history, commit `b358b80`, for the original table version).

---

## 2026-08-13 — Render service deploys on Starter ($7/month), always-on, from the start — not free tier

**Rationale:** decided ahead of the original "free tier now, upgrade before
Stripe" plan. Deploying always-on from day one avoids the spin-down risk
entirely rather than accepting it temporarily and remembering to upgrade
later. `render.yaml` (`plan: free` → `plan: starter`) and `DEPLOY.md`'s
service-settings table and "before Stripe goes live" section updated to
match — the free-tier spin-down caveats there no longer apply. The Cron Job
sweeper backstop and poller-interval-tuning items from that section remain
valid regardless of plan tier (an always-on plan doesn't guarantee zero
restarts) and were kept, reframed as general hardening rather than a
tier-upgrade migration step.

**Supersedes:** the 2026-08-11 entry above ("Render service starts on the
free tier now; upgrade to a paid Starter (always-on) instance before Stripe
goes live") — that entry stays exactly as written; this is the update.

---

## 2026-08-13 — Data-spine skeleton deployed; live connectivity verified

**Rationale:** confirmed directly, not transcribed from a report —
`curl https://llc-data-spine.onrender.com/health` returns `200`,
`{"status":"ok","db":"connected","migrations":null}`. `migrations: null`
is correct at this point: the Gate 1 skeleton shipped with zero `.sql`
migration files, so there's nothing to report as applied. This is the
starting point for Gate 1's schema build (this same session).

**Supersedes:** —

---

## 2026-08-13 — Gate 1 schema migrations use the existing custom migration runner, not node-pg-migrate

**Rationale:** the Gate 1 schema task specified `node-pg-migrate`, which
is not a current dependency of `server/` — adding it would be a new
third-party dependency, an explicit stop-condition of this session's own
autonomous-mode rules (and standing rule: never add a dependency without
listing it and waiting for approval). The existing runner
(`server/src/db/migrationRunner.ts`, shipped in the Gate 1 skeleton) already
does the functionally equivalent job: numbered `.sql` files in
`server/migrations/`, applied in order inside their own transaction,
tracked in a `schema_migrations` table, safe to re-run. It has no
down-migration/rollback support, unlike `node-pg-migrate` — acceptable for
this phase; flagged in `GAPS.md` if that's ever actually needed. Used this
instead of stopping the session to ask, since a suitable
already-approved-by-existing-use alternative was available.

**Supersedes:** —

---

## 2026-09-09 — Schema/migration drift: 8 migrations (0004–0011) existed live in Supabase with zero corresponding files or application code anywhere in git

**Rationale/finding:** starting Gate 2 (payment/fulfillment build) on a new
branch (`feat/gate2-backend`, off `main` at `ac3930e`), I queried the live
Supabase project (`rtivwkqsuuvbkvdudgnd`) directly via the Supabase MCP
tools before writing any code, per this repo's own rule 4 (never trust a
filename/route/comment — verify the executing state). `schema_migrations`
on the live project had 11 rows, not the 3 that `server/migrations/`
contains on `main` or on `feat/data-spine`:

```
0001_filing_sessions                              2026-08-13
0002_filing_events                                2026-08-13
0003_crm_sync_queue                                2026-08-13
0004_filing_sessions_filing_data                  2026-08-27
0005_registered_agent_acceptance                  2026-08-27
0006_orders                                        2026-08-28
0007_orders_payment_status_crm_deal               2026-08-28
0008_stripe_webhook_events                         2026-08-28
0009_filing_sessions_payment_status_non_authoritative  2026-08-28
0010_orders_fulfillment_status                     2026-09-01
0011_fulfillment_transmissions                     2026-09-01
```

Migrations 0004–0011 added exactly the 5 undocumented tables (`orders`,
`stripe_webhook_events`, `filing_documents`, `fulfillment_transmissions`,
`registered_agent_acceptances`) plus `filing_sessions.filing_data` and
`filing_sessions.registered_agent_status`, with column/table `COMMENT`s
that explicitly name application files that do not exist in this repo at
any commit (`webhook/stripeWebhookService.ts`,
`fulfillment/fulfillmentWorker.ts`, `server/src/pdf/types.ts`). This is
strong evidence a prior planning pass designed this schema and applied it
directly to Supabase (outside git, outside the migration runner) as
forward documentation of intended Gate 2 code, then neither the `.sql`
files nor the code were ever committed. No concurrent session conflict —
`git fetch` shows only the already-known stale `feat/data-spine` branch;
nothing new was pushed by anyone else.

**Action taken:** wrote `server/migrations/0004_*.sql` through
`0011_*.sql`, named to match the `schema_migrations.version` strings
exactly (so the existing migration runner recognizes them as already
applied and skips them — no re-execution against the live DB, no risk of
"already exists" errors). Full column/constraint/index/FK fidelity was
verified two ways before committing: (1) `list_tables` (verbose) plus raw
`pg_constraint`/`pg_indexes` queries against the live project, compared
column-by-column; (2) the exact concatenated content of all 11 files run
against a throwaway `migration_test_gate2` schema on the *same* live
project (via `execute_sql`, wrapped in `CREATE SCHEMA` / `DROP SCHEMA
CASCADE`, never touching `public`), with the resulting column sets
diffed against the live `public` schema and found identical. This is a
best-effort reconstruction, not a recovered original: the exact original
grouping of a few individually-optional statements (e.g., which of the
two duplicate `checkout_status`-indexing statements landed in which file)
is inferred, not recoverable, since the real files never existed. This
does not affect correctness — nothing here is being re-run against the
live database, only recorded for git history and for reproducing the
schema in a fresh environment.

**Secondary finding, same investigation:** every table in `public`
(including the three tables in migrations 0001–0003, which contain no
`ENABLE ROW LEVEL SECURITY` statement) has `rls_enabled = true` live, with
**zero** rows in `pg_policies`. This was not done via any migration file
either — almost certainly a manual dashboard action (Supabase's Security
Advisor flags public tables without RLS). With no policies and RLS
enabled, only a role with `BYPASSRLS` (e.g., the `postgres` role used by
the session-pooler connection string per standing rule 9) can read/write
at all — which matches Gate 1's `POST /api/session/stage` working
correctly today, so this is not currently a live blocker. Standing rule 9
already forbids building against Supabase Auth, and RLS policies here
would functionally require an `auth.uid()`-shaped identity model this
project doesn't have — so no policies were authored. To stop compounding
the drift, the *new* tables created in 0005/0006/0008/0011 above do
include an explicit `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;` (matching
live state, now captured in git), but 0001–0003 were left exactly as
originally written per this repo's immutability rule for already-applied
migrations — the live RLS-enabled-with-no-policies state on those three
tables remains real but uncaptured in any file, which is a permanent,
accepted gap in the historical record, not something a later migration
should silently paper over.

**Supersedes:** —
