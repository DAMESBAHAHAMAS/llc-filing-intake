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

## 2026-09-01 — Sunbiz-fulfillment bridge: trigger lives inside the Stripe webhook transaction, on `orders.fulfillment_status`, transmission not yet connected

**Rationale:** GATE2-STRIPE-WEBHOOK-STATUS.md §17 named this the explicit
handoff point ("`orders.payment_status = 'paid'` is currently a terminal
state with no further automation... the natural next Gate 2 task is exactly
what this one calls out as its own handoff point"). The requirement: create
a reliable, idempotent, server-side signal that a paid order is ready for
Sunbiz fulfillment, without transmitting anything to Sunbiz yet and without
the frontend or any client-supplied value ever influencing it.

Design chosen: six new columns on `orders` (migration `0010`) —
`fulfillment_status` (`not_ready` | `ready` | `in_progress` | `transmitted`
| `failed` | `requires_review`, default `not_ready`) plus
`fulfillment_ready_at`/`_started_at`/`_completed_at`/`_attempts`/`_last_error`
— rather than a new queue table (the `crm_sync_queue` pattern). A paid order
has exactly one fulfillment job, unlike CRM syncs (many per filing_session
over its lifetime) or registered-agent acceptances (reissuable); a status
column co-located with `payment_status` matches the existing
`registered_agent_status` precedent (migration 0005) instead.

The trigger itself is written **only** by `webhook/stripeWebhookService.ts`,
inside the **same database transaction** that sets `payment_status = 'paid'`
— the sole existing payment authority, unchanged. That "mark paid" step was
previously two independent `pool.query` calls (payment_status update, then
a `filing_events` audit insert); wrapping the whole outcome (payment,
fulfillment decision, both audit events, and the `stripe_webhook_events`
idempotency ledger's completion) in one transaction closes a real
crash-recovery gap: without it, a crash between those two writes, followed
by Stripe's routine redelivery of the same `event.id`, would hit the
existing `already_paid_noop` guard on retry and permanently skip whatever
came after the first write. Fulfillment readiness re-reads `filing_data`
fresh inside that transaction, with `FOR UPDATE`, rather than trusting
anything read earlier — a customer can take arbitrarily long between
Checkout Session creation (gated on `current_stage = 'complete'` at that
earlier moment) and actually paying.

A schema-level `CHECK (fulfillment_status = 'not_ready' OR payment_status =
'paid')` constraint on `orders` makes it structurally impossible — not just
application-logic-impossible — for fulfillment to ever advance on an unpaid
order, regardless of future application bugs, manual `UPDATE`s, or a worker
written without reading this decision.

`in_progress`/`transmitted`/`failed` are defined in the CHECK constraint for
forward compatibility but are **not driven by any code yet** — no worker
claims `ready` rows, and no Sunbiz client exists. That is the next task,
requires explicit approval per this task's own instruction, and was not
started here.

**Files:** `server/migrations/0010_orders_fulfillment_status.sql` (new);
`server/src/webhook/stripeWebhookService.ts` (paid-path rewritten as one
transaction; new `FulfillmentStatus` type; new
`isFilingDataFulfillmentReady` check); `server/test/webhook/stripeWebhookService.test.ts`
(4 existing assertions updated for the new `fulfillmentStatus` return field;
new "J. Fulfillment bridge" describe block: missing filing_data ->
`requires_review`, incomplete filing_data -> `requires_review`, duplicate
delivery doesn't double-write the `fulfillment_ready` audit event, and a
direct proof of the schema-level CHECK constraint). Frontend
(`florida-business-launchpad`) untouched — the trigger is fully
server-side, and the customer-facing success page still reads only
`payment_status`, unchanged.

**Supersedes:** —

---

## 2026-09-01 — Sunbiz-fulfillment transmission layer: fax adapter (Telnyx), PDF retention, idempotent transmission ledger

**Rationale:** the prior session's fulfillment bridge (immediately above) left
`orders.fulfillment_status = 'ready'` as a terminal signal with nothing
consuming it. This task builds the actual transmission engine: generate the
filing package, retain the PDF, transmit it by fax, record the result — with
the destination fully configurable (a free Phase-1 test number today, the
real Sunbiz fax number later, same code either way) and Sunbiz never
hardcoded anywhere in the fulfillment engine itself.

**Provider:** Telnyx Fax API — chosen explicitly over Sinch/Phaxio (direct
multipart upload, no public URL needed) because the user already has reasons
to prefer Telnyx. The trade-off this decision accepts: Telnyx sends by
`media_url` (a URL it fetches), so this service needed a new public,
token-gated route (`GET /api/fax-media/:token`, routes/faxMedia.ts) for
Telnyx to pull the generated PDF from — unauthenticated by necessity (Telnyx
carries no credentials of ours) but access-controlled by an unguessable,
sha256-hashed, expiring, single-document capability token, the same posture
already established for registered-agent acceptance links (migration 0005).
`registeredAgent/token.ts`'s existing `hashToken`/token-hash discipline is
reused directly, not duplicated.

**Schema (migration 0011):** two new tables, one new column, no existing
row/column touched.
- `filing_documents` — the authoritative retained PDF artifact (bytea in
  Postgres, not an external store — GOVERNANCE.md rule 9 explicitly rules out
  Supabase Storage, and volume is small enough that a new storage dependency
  isn't justified). One row per fulfillment attempt, never mutated.
- `fulfillment_transmissions` — one row per EXPLICIT transmission attempt,
  mirroring `registered_agent_acceptances`' "single status column on the
  parent + full append-only history table" pattern (migration 0005) rather
  than a new queue table: a paid order has exactly one fulfillment job, so
  there's nothing to enqueue more than once per order, unlike
  `crm_sync_queue`. `UNIQUE(order_id, attempt_number)` is the idempotency
  backstop at the database level. `document_id` is nullable (an attempt can
  fail during PDF generation, before any document exists) but a CHECK
  constraint makes it structurally impossible for a row to claim
  `submitted`/`delivered` without one.
- `orders.fulfillment_run_after` — backoff gate, reusing `crm_sync_queue`'s
  exact naming convention and `sync/backoff.ts`'s exact schedule (not a new
  schedule).

**Worker design (server/src/fulfillment/fulfillmentWorker.ts):** deliberately
modeled on `sync/worker.ts` + `sync/backoff.ts` — `SELECT ... FOR UPDATE SKIP
LOCKED` to claim, process outside the lock, record the outcome in its own
transaction, the identical backoff/dead-letter schedule — reused, not
reinvented. Two additions beyond the CRM worker's shape:
1. **The registered-agent gate is now wired in.** `acceptanceService.ts`'s
   own comment named `isFilingSessionRegisteredAgentAccepted` as "the
   function any future filing-submission path... should call before
   proceeding. Not wired to a caller yet." The fulfillment claim query now
   requires `filing_sessions.registered_agent_status = 'accepted'` — an order
   that's paid and fulfillment-ready but whose agent hasn't accepted yet is
   simply not selected (not a failure, not a counted attempt); it's picked
   up automatically the moment that status flips, with no new wiring needed
   anywhere else.
2. **Stale in_progress reclaim.** A worker crash between claiming an order
   and finishing its attempt would otherwise strand that order at
   `in_progress` forever (it's no longer `'ready'`, so it would never be
   re-claimed). The claim query also matches an `in_progress` order whose
   `fulfillment_started_at` is older than a timeout (default 10 minutes),
   treating it as eligible for a new, explicit attempt.

**Idempotency, end to end:** the SKIP LOCKED claim means no two ticks can
ever process the same order at once; `UNIQUE(order_id, attempt_number)` means
a duplicate row for the same attempt is a constraint violation, not a
possibility; and `orders.fulfillment_attempts` is bumped atomically with the
transmission-row reservation (in the same transaction), not re-derived later
from a possibly-stale snapshot — an earlier draft of this worker double-
counted attempts by recomputing `attempts + 1` in two different places from
two different snapshots of the same order; fixed by threading the
authoritative `attemptNumber` explicitly through both call sites instead of
letting either recompute it.

**Verified with a real, non-fake PDF:** `render_pdf.py`'s dependencies were
installed locally (a throwaway venv, discarded afterward) and the full
pipeline was run against it with a fake fax provider standing in for Telnyx
(no Telnyx account exists in this environment) — a genuine 89,771-byte
WeasyPrint PDF (verified `%PDF` magic bytes) was generated from
`composeArticlesOfOrganizationContext`, retained with its sha256, and the
order reconciled through to `fulfillment_status = 'transmitted'`. Test rows
were cleaned up afterward; the local PDF service and its venv were torn down.

**Gap found, logged, not fixed (out of this task's scope per GOVERNANCE.md
rule 12 — not P0):** `render_pdf.py`'s pinned `weasyprint==62.3` crashes
(`AttributeError: 'super' object has no attribute 'transform'`) against a
freshly-`pip install`ed `pydyf` (0.12.1) — a known class of tight coupling
between WeasyPrint point releases and pydyf. Downgrading to `pydyf==0.11.0`
in the local venv fixed it. **Not changed in `requirements.txt`** — this is
the separately-managed, already-deployed Render dashboard service (per
`render.yaml`'s own comment), untouched by this task, and its deployed
environment's actual resolved `pydyf` version was not checked. Whoever next
touches `render_pdf.py`'s dependencies should pin `pydyf` explicitly rather
than leaving it to float.

**Files:** `server/migrations/0011_fulfillment_transmissions.sql` (new);
`server/src/fulfillment/faxProvider.ts` (new — `FaxProvider` interface +
`telnyxFaxProvider`); `server/src/fulfillment/documentStore.ts` (new);
`server/src/fulfillment/fulfillmentWorker.ts` (new); `server/src/routes/faxMedia.ts`
(new); `server/src/index.ts` (mounts the new route, starts the fulfillment
poller — refuses to start without `FULFILLMENT_FAX_DESTINATION_NUMBER` and
`FULFILLMENT_MEDIA_BASE_URL` set); `server/.env.example` (new variables
documented); `server/test/fulfillment/fulfillmentWorker.test.ts` (new, 15
tests); `server/test/fulfillment/faxMediaRoute.test.ts` (new, 3 tests).
Frontend (`florida-business-launchpad`) untouched — nothing about fulfillment
is triggered from, or observable by, the client.

**Not built (explicit stop point per this task's own instruction):** nothing
was connected to a REAL Telnyx account — `TELNYX_API_KEY`/
`TELNYX_FAX_CONNECTION_ID`/`TELNYX_FAX_FROM_NUMBER` are documented in
`.env.example` but unset in this environment, and no real fax has been sent.
`in_progress`→`transmitted`/`failed` reconciliation code exists and is
tested against a fake provider, but has never observed a real Telnyx
response.

**Supersedes:** —

---

## 2026-09-01 — Database ambiguity resolved: one authoritative Postgres instance, proven live; production Render URL confirmed

**Rationale:** a WBS audit flagged uncertainty about which Postgres instance
is authoritative for `filing_sessions`/`orders`/`filing_documents`/
`fulfillment_transmissions` before any further fulfillment work proceeds.
Investigated read-only (Render MCP + Supabase MCP, both now authorized for
this account; no application code changed). Two facts proven with live
evidence, not inference from config files alone:

**Fact 1 — Authoritative database.** Exactly one Postgres instance is in
play: Supabase project **`llc-filing-intake`** (ref `rtivwkqsuuvbkvdudgnd`,
`us-west-2`, status `ACTIVE_HEALTHY`, Postgres 17.6.1.155). Proof chain:
1. Local `server/.env`'s `DATABASE_URL` username embeds project ref
   `rtivwkqsuuvbkvdudgnd` — directly identifies this project (host
   `aws-0-us-west-2.pooler.supabase.com`, the session pooler per
   GOVERNANCE.md rule 9).
2. Queried that project directly via Supabase MCP (`execute_sql`):
   `schema_migrations` shows `0011_fulfillment_transmissions` applied at
   `2026-09-01 07:16:48 UTC` — the exact migration this session applied via
   that same local `DATABASE_URL` minutes earlier.
3. The **deployed** Render service's own `/health` endpoint
   (`routes/health.ts`'s `getLatestAppliedVersion(pool)`, queried live
   against whatever `DATABASE_URL` Render has configured — not inferred, not
   read from a dashboard) returns
   `{"status":"ok","db":"connected","migrations":"0011_fulfillment_transmissions"}`
   at the time of this check. `"0011_fulfillment_transmissions"` is a
   filename this session invented; the only process that could ever have
   applied it anywhere is this session's own `npm run migrate` run against
   local `DATABASE_URL`. The deployed service reporting it as ITS OWN
   latest-applied version is therefore not merely strong evidence but a
   logical proof that Render's configured `DATABASE_URL` resolves to the
   same physical database as local dev's.
4. Attempted an additional live cross-check (insert a uniquely-tagged marker
   order via direct SQL, read it back through the deployed service's public
   `GET /checkout/session-status`) — this 404'd, but for an unrelated,
   fully-explained reason: see Fact 2's deploy-lag finding below, not a
   different-database explanation. The marker row was inserted and deleted
   directly against the `llc-filing-intake` project only; nothing left
   behind.

**Conclusion:** local dev and the deployed Render service share ONE
Supabase Postgres instance — there is no second, forked, or stale database
in play for these four tables. `omnichannel-voice-intake`
(`usdqzhkilpmylenxfhdc`, status `INACTIVE`) is a different, unrelated
Supabase project belonging to a different Render service of the same name;
it plays no role here and was checked only to positively rule it out.

**Fact 2 — Production Render URL, and a deploy-lag finding.** The `llc-data-spine`
web service (`srv-d9u1ihh42hec739av8og`, workspace `tea-d6iool450q8c73ba8rag`)
is confirmed live at **`https://llc-data-spine.onrender.com`** (repo
`DAMESBAHAHAMAS/llc-filing-intake`, branch `main`, root dir `server`).
Its currently-live deploy (`dep-da609t8u01pc738oivc0`, status `live`) is
built from commit `ac3930e` — the exact tip of local `git log` on `main`.
**This means the deployed service is running code from BEFORE `checkout.ts`,
`stripeWebhook.ts`, and every fulfillment file this and the prior session
wrote — none of that work has been committed/pushed yet (by design; every
session in this engagement has been explicitly instructed not to commit or
push).** This is why `GET /checkout/session-status` 404'd on the deployed
service during the cross-check above: the route's source file doesn't exist
in commit `ac3930e`, not because of a database mismatch. The database is
shared and current (migration 0011 applied); the deployed application code
is several commits behind local. Also confirmed in the same account:
`llc-pdf-generator` (`srv-d94edalckfvc739rg9jg`,
`https://llc-pdf-generator.onrender.com`) is the deployed name for
`render_pdf.py` — referred to only as "the PDF service" or by
`PDF_SERVICE_URL` in prior session notes, its actual Render service name
had not previously been confirmed in this repo's own docs.

**No application code changed by this investigation** — read-only Render/
Supabase MCP calls, one inserted-then-deleted marker row, this documentation
entry. `GOVERNANCE.md`/`DEPLOY.md` should be updated to name the Supabase
project (`llc-filing-intake`, ref `rtivwkqsuuvbkvdudgnd`) and the Render
service ids explicitly the next time either is touched, so future sessions
don't have to re-derive this from scratch.

**Supersedes:** —

## 2026-09-16 — Registered-agent acceptance email provider is Resend, via its SDK — an explicit exception to the "plain fetch, no SDK" default

**Rationale:** GOVERNANCE.md rule 5 requires listing a new third-party
dependency and waiting for approval before adding it; every other outbound
integration in this codebase (Zoho, Telnyx) deliberately uses plain `fetch`
instead of a vendor SDK for exactly this reason. Resend is the one
exception, added on direct instruction naming both the provider and the
SDK explicitly — not a new default for future integrations. `emailSender.ts`
now requires `RESEND_API_KEY` and `RESEND_FROM_EMAIL`; `realEmailSender`
still fails clearly (never throws past its own boundary) when either is
unset, same posture as every other "fails clearly until configured"
integration here. `buildRegisteredAgentAcceptanceEmail` now returns `html`
alongside the existing `subject`/`text` — same content, styled rendering.

**Files:** `server/src/registeredAgent/emailSender.ts`, `server/.env.example`,
`server/package.json` (new dependency: `resend`).

**Supersedes:** —

## 2026-09-16 — crm_deal_id linkage: Stripe metadata carries it from checkout creation to the payment webhook, which updates orders.crm_deal_id and enqueues an async Deal-stage update

**Rationale:** `orders.crm_deal_id` (migration 0007) has been unused since
it was added — "a CRM Deal sync was drafted concurrently ... and was not
adopted" (that migration's own comment). This gives it a real, working path
without inlining a Zoho call in the payment-confirmation transaction
(GOVERNANCE.md #1: every Zoho write is queued and processed asynchronously,
never inline with the request that triggered it):

1. `checkoutService.ts` now reads `filing_sessions.crm_deal_id` (a
   pre-existing column, migration 0001, currently always NULL — nothing
   populates it yet, see below) when creating a Checkout Session, and
   `stripeCheckoutClient.ts` carries it as Stripe metadata
   (`metadata.crm_deal_id`), alongside the existing `filing_session_id` /
   `crm_intent` / `order_id` metadata fields.
2. `stripeWebhookService.ts`, inside the existing payment-confirmation
   transaction, reads `metadata.crm_deal_id` back from the live-re-fetched
   Stripe session (never trusts the webhook event body for this any more
   than it does for payment status) and, when present, writes it onto
   `orders.crm_deal_id` and enqueues a `crm_sync_queue` job
   (`sync_type = 'deal_stage_update'`).
3. `zoho/client.ts`'s `syncSession` — called generically by `sync/worker.ts`
   for every job regardless of `sync_type`, which the worker never passes
   through — recognizes this job by a `job_type: "deal_stage_update"`
   marker in its own payload and issues a `PUT` against the *existing*
   Deal id, never the Lead-upsert/Deal-create path `session_sync` jobs use.
   This is what makes the enqueue actually functional rather than a queue
   row the worker would silently mishandle.

**Two gaps this does NOT close, both flagged rather than guessed at:**
- **Nothing populates `filing_sessions.crm_deal_id` yet.** The Cloudflare
  Worker (`llc-worker.js`) still creates the Deal at intake time and
  returns `deal_id` to the frontend, which discards it today. Until the
  frontend captures that id and sends it to `POST /api/session/stage`
  (already in `SESSION_FIELDS`'s whitelist — no backend change needed for
  that part), every real order's `metadata.crm_deal_id` will be absent and
  this whole path is a no-op (`crm_result: "no_crm_deal_yet"` in
  `filing_events`) — plumbing proven correct, not yet exercised in
  production.
- **No confirmed "this means paid" Zoho Stage value exists.**
  `GATE2-ZOHO-CONNECTIVITY-STATUS.md`'s `MAPPING_MISMATCH` finding is still
  unresolved — only `Stage: "Closed Lost"` is confirmed live for this org's
  pipeline, and it doesn't mean paid. `ZOHO_DEAL_STAGE_ON_PAYMENT` is left
  unset in `.env.example` deliberately: until it's set to a value confirmed
  against the live picklist, a known `crm_deal_id` is still written onto
  the order, but no stage-update job is queued
  (`crm_result: "crm_deal_id_set_but_target_stage_unconfigured"`) — a
  guessed value would only enqueue a job that dead-letters against Zoho's
  own `INVALID_DATA` error after burning its retry budget.

**Files:** `server/src/checkout/checkoutService.ts`,
`server/src/checkout/stripeCheckoutClient.ts`,
`server/src/webhook/stripeWebhookService.ts`, `server/src/zoho/client.ts`,
`server/.env.example`. No migration — reuses `filing_sessions.crm_deal_id`
(0001), `orders.crm_deal_id` (0007), and `crm_sync_queue` (0003) as they
already exist.

**Supersedes:** —
