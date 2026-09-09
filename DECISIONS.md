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

---

## 2026-09-09 — Stripe catalog drift: real Products/Prices for this exact business already exist in Stripe test mode, with zero reference anywhere in this repo

**Rationale/finding:** before designing the Offer Master (needed to satisfy
the frozen rule "browser sends line-item identifiers only, server resolves
against an approved commercial catalog"), I checked the connected Stripe
account via the Stripe MCP tools rather than assuming none existed. The
connected account (`acct_1ChHmZDo01bXdbWS`, "Damian Knowles", **test
mode**) already has a full, coherent product catalog for this exact
business, with a consistent `offer_sku`/`offer_version`/`crm_intent`
metadata convention someone clearly designed on purpose: DIY state fee
($125), DIY service/processing fee ($4, flat — not a computed
percentage), DIY Certificate of Status ($5, "standard and included"),
DIY certified-copy add-on ($30, optional), FastTrack ($499, single
bundled Price), Premium ($999, single bundled Price), EIN Filing ($299),
EIN Filing Express/same-day ($449, **flagged in its own Stripe metadata
as `pricing_status: PLACEHOLDER_PENDING_DAMIAN_CONFIRMATION`**),
Registered Agent 3-year service ($100), and a Company Credentials Kit
($89, "launch price, thin margin by design" per an earlier, now-inactive
$147 price on the same product). An earlier, cruder single combined DIY
price ($129) exists but is inactive — superseded by the itemized
125+4+5=$134 breakdown, evidence this catalog was iterated on
deliberately, not thrown together. None of this — no Price ID, no
product ID, no amount — appears anywhere in `llc-filing-intake` or
`florida-business-launchpad` at any commit. This is the same shape of
finding as the Supabase schema drift above: real, thought-through
commercial work done directly against a third-party console, never
captured in this repo. Confirmed test mode (`livemode: false`) before
touching anything — no risk of live financial exposure either way, and
no live Stripe object was created or modified to make this finding.

**Action taken:** `server/migrations/0012_offer_master.sql` creates an
`offers` table (the Offer Master called for in the Gate 2 brief — offer
code + version as a real row, not just a price field; `internal_cost_cents`
apparently unset, was left `NULL` rather than fabricated — an early
Gate 2 build decision boundary, see below) and seeds it with these
**real, discovered** Price/Product IDs — no new Stripe objects were
created to populate it. `EIN_FILING_EXPRESS` is seeded `status='draft'`,
not `'active'` — mechanically un-sellable until a human flips it — because
Stripe's own metadata already flags that exact price as unconfirmed; I
am not the one who gets to confirm it. This also supplies concrete
evidence toward two of the five decision boundaries this task named
(logged as evidence, not resolution — still reporting both as open,
since finding an existing artifact isn't the same as an explicit
confirmation): the DIY processing-fee mechanism (boundary #2) already
exists as a flat $4 line item rather than a computed surcharge; and
boundary #5 (is the $5 Certificate of Status inside or on top of
FastTrack/Premium) is sharper now that FastTrack/Premium are confirmed
single, non-itemized bundled Prices with no separate cert-of-status line
wired to either — so it's genuinely unanswered, not merely undocumented.

**Supersedes:** —

---

## 2026-09-09 — P0 SECURITY FIX: `filing_sessions.payment_status` was client-writable and directly gated real Zoho Deal creation

**Rationale/finding:** migration 0009 (reconstructed earlier this
session) carries a Postgres `COMMENT` claiming
`filing_sessions.payment_status` was already made non-authoritative and
non-client-writable as part of "Gate 2's payment-authority security
fix." Reading the actual executing code (standing rule 4 — never trust a
comment/filename, verify the code), that fix had **not** actually been
applied: `server/src/routes/session.ts`'s `SESSION_FIELDS` whitelist
still included `payment_status` (and `crm_lead_id`, `crm_deal_id`,
`crm_sync_status`, `crm_last_synced_at`, `pdf_generated_at`,
`pdf_storage_ref`), and `server/src/zoho/client.ts`'s
`realZohoClient.syncSession` read exactly that field
(`snapshot.payment_status === "paid" || "completed"`) to decide whether
to create a real Zoho Deal. Concretely: a client could
`POST /api/session/stage { "payment_status": "paid", ... }` with no
Stripe payment ever having happened, and the Gate 1 CRM sync worker
would create a real Deal from it — precisely the failure mode the Gate 2
frozen rule ("CRM Deal only after a verified Stripe webhook, never at
intake") exists to prevent. This is a P0 per Governance rule 12 (stop
and fix immediately, don't just log it) — data integrity of the CRM
pipeline and a forgeable "payment received" business signal.

**Action taken, same commit as this entry:**
1. `server/src/routes/session.ts`: removed `payment_status`,
   `crm_lead_id`, `crm_deal_id`, `crm_sync_status`, `crm_last_synced_at`,
   `pdf_generated_at`, and `pdf_storage_ref` from `SESSION_FIELDS`. All
   seven are exclusively server/worker-written now (the CRM sync worker,
   the Stripe webhook handler, the fulfillment worker) — never through
   this public endpoint. Confirmed via `grep` that `llc-worker.js` (the
   only other caller in this codebase) never calls this endpoint at all,
   so nothing legitimate depended on setting these client-side.
2. `server/src/zoho/client.ts`: removed the Deal-creation branch from
   `realZohoClient.syncSession` entirely — it is now Lead-upsert only.
   Deal creation is exclusively `syncOrderEvent`'s job (new this
   session), triggered only by the verified-webhook `order_deal` queue
   job (see the Offer Master / `crm_sync_queue` extension entries
   above). This closes the loop: there is now no code path anywhere that
   creates a Zoho Deal except the one gated by a real, signature-verified
   Stripe webhook.
3. Updated `server/API.md` to document the contract change for the
   frontend session (these fields are now silently ignored if sent, not
   an error).

No historical exploitation of this is known or was investigated in this
session (out of scope — this is a code-path fix, not a CRM data audit);
if `flag`ging a retroactive CRM data review is wanted, that's a decision
for the user, not something this session decided unilaterally.

**Supersedes:** —

---

## 2026-09-09 — Stripe integration built via direct REST calls + hand-rolled webhook signature verification, not the `stripe` npm SDK

**Rationale:** the Gate 2 brief explicitly flagged that a Stripe SDK for
Node would be a NEW dependency for `server/`, requiring listing and
approval per standing rule 5 — and this is an autonomous session with no
synchronous way to get that approval before writing code. The actual
surface area needed is small: create a Checkout Session, retrieve one,
and verify a webhook signature. All three are implemented directly
against Stripe's documented REST API and signature scheme using only
Node built-ins (`fetch`, `node:crypto`) — see
`server/src/stripe/restClient.ts` and `server/src/stripe/webhookSignature.ts`.
Both are unit-tested for real (not just asserted): 7 passing tests prove
the signature verification matches Stripe's HMAC-SHA256 scheme
(including tamper detection, wrong-secret rejection, replay/timestamp-
tolerance rejection, and multi-signature key-rotation support), and 4
passing tests prove the REST client's request construction (bracket-
notation nested-array encoding for `line_items`, Bearer auth, error
surfacing as a typed `StripeApiError`) matches what Stripe's API expects.
Real Price IDs from the connected test-mode account were independently
confirmed valid via the Stripe MCP's read tools (`GetProducts`/
`GetPrices`); an attempt to create a real live Checkout Session via the
Stripe MCP's write tool to test the full path end-to-end was blocked —
the MCP's own API key lacks `checkout.sessions:write` permission — so
this is NOT verified against a live Stripe network call, only against
unit tests and confirmed-valid Price data. If the `stripe` SDK is
reviewed and preferred instead, swapping it in is a contained change
behind these same two modules' exported functions — nothing else in the
codebase talks to Stripe directly.

**Supersedes:** —

---

## 2026-09-09 — `render_pdf.py` hardened: StrictUndefined + shared-secret auth (not replaced, per the brief's instruction not to replace it)

**Rationale:** two real gaps found reading the actual executing code
(not assumed from the filename): (1) `/generate-pdf` had no
authentication at all — a publicly reachable, CPU-intensive
(WeasyPrint) endpoint, a real abuse/DoS surface; (2) the Jinja2
`Environment` used the default `Undefined` class, meaning a missing
template variable (e.g. a blank `llc_name`) would silently render as an
empty string in a real legal document — the exact failure mode the Gate
2 test matrix explicitly forbids ("missing PDF variable surfaces as a
completeness gap, not a fabricated value or silent failure"). Fixed both
without changing the template, the render pipeline, or the
WeasyPrint/Jinja2 dependency versions: `undefined=StrictUndefined` makes
a missing variable raise `UndefinedError`, caught and returned as a 422
naming the field; a shared-secret `X-PDF-Service-Key` header (checked
via `hmac.compare_digest`, no new dependency — stdlib) is required when
`PDF_SERVICE_API_KEY` is set, with a loud startup warning if it isn't.
**Consequence documented in `server/src/pdf/context.ts`'s own comments:**
every context key the template can reference must now always be present
in the request (using `""`/empty values for genuinely-optional fields,
never simply omitted) — an omitted key is what triggers the 422, by
design. `server/src/pdf/context.ts`'s `buildPdfContext()` is the one
place responsible for guaranteeing that invariant before this service is
ever called, and is itself unit-tested (7 passing tests) proving exactly
this completeness-gap behavior, including that Path A's house
registered-agent identity is stamped server-side even when `filing_data`
carries different (client-supplied) RA fields.

**Supersedes:** —

---

## 2026-09-09 — Name-check: sunbiz-proxy contract could not be independently re-verified in this session (network policy), and the restricted-word list is a starting point, not a verified legal list

**Rationale/finding:** `POST /api/name-check` (new) proxies to the
already-deployed `sunbiz-proxy` service rather than duplicating it,
mirroring the request/response shape (`POST { name } -> { entities,
total_results }`) that `llc-worker.js`'s existing, live, working
integration already uses (`RENDER_PROXY_URL`). A direct `curl` to
`https://sunbiz-proxy.onrender.com/health` from this session was
rejected by this sandbox's own egress proxy (`CONNECT tunnel failed,
403` — confirmed organizational network policy, not a bug in the target
service), so the exact path could not be empirically re-confirmed from
here the way the Supabase/Stripe findings above were. `SUNBIZ_PROXY_URL`
is left as a required, unset env var with an explicit comment to confirm
it matches `llc-worker.js`'s value before deploying, rather than guessing
a path and presenting it as verified.

Separately: Florida distinguishability (hard rejection on an active
exact-name conflict, mirroring `llc-worker.js`'s existing fallback logic)
is implemented and is the only hard block. Restricted-word detection
(`server/src/nameCheck/restrictedWords.ts`) is new — `llc-worker.js` had
none at all — and is explicitly commented as a reasonable starting list,
not independently verified against the current text of Fla. Stat. 605 or
the FL Division of Corporations' actual restricted-word guidance. It is
wired as a warning only, never a rejection, per the frozen rule, so the
risk of an incomplete list is under- rather than over-blocking.

**Supersedes:** —

---

## 2026-09-09 — Registered-agent acceptance: token issuance/acceptance/decline mechanics are built; automated email delivery is NOT

**Rationale/finding:** `POST /api/registered-agent/request-acceptance`
generates a real, single-use, 7-day-expiring token and persists a
`registered_agent_acceptances` row exactly as that table's own schema
anticipated (migration 0005). It does not send an email — there is no
email-provider credential of any kind configured in this environment
(Zoho Mail's API needs its own separate OAuth setup from Zoho CRM's,
which also isn't configured), and this session judged standing up and
verifying a new email integration blind, with no way to confirm a real
message actually delivers, worse than shipping the token mechanics alone
and flagging the gap plainly (`email_sent: false` in every response,
documented in `server/API.md`). This is a real functional gap against
the brief's "an emailed link + token" description, not a silent one.

**Supersedes:** —

---

## 2026-09-09 — Fulfillment worker stops at `requires_review` after PDF generation; fax transmission to the state/IRS (Telnyx) is not built

**Rationale:** `server/src/fulfillment/fulfillmentWorker.ts` claims
`orders.fulfillment_status='ready'` rows, validates filing-data
completeness (`pdf/context.ts`), generates the PDF via the now-hardened
`llc-pdf-generator`, and persists it to `filing_documents` — all real,
unit-tested-where-testable-without-a-DB code. It deliberately stops
there, setting `fulfillment_status='requires_review'` (an honest use of
that status's existing, schema-defined meaning — "needs a human," not a
failure) rather than fabricating a fax-transmission success against
`fulfillment_transmissions` (whose own schema comment already names
`provider: 'telnyx'` as the intended integration). No Telnyx credentials
exist in this environment, and adding a Telnyx SDK (or hand-rolling
against their REST API, as this session did for Stripe) would need
either a new dependency decision or, at minimum, real credentials to
verify against — neither was available. Building untested fax-submission
code that could look done without ever having been exercised was judged
worse than stopping cleanly at a real, inspectable artifact (an actual
generated PDF, stored, hashed, retrievable) and naming the gap.

**Supersedes:** —

---

## 2026-09-09 — Zoho Sign (decision boundary #4) not implemented — no way to test it in this environment

**Rationale:** the Gate 2 brief's own instruction for this boundary was
explicit: "report exactly what you find/verify, don't assume it works."
This session has no Zoho Sign MCP tool (the available Zoho MCP surface
covers CRM, Mail, Projects, Sheet, WorkDrive, Notebook, Learn — not
Sign) and no Zoho Sign API credentials in the environment. Writing
envelope-creation/recipient-tag-mapping/completion-callback code with no
way to create a real envelope, drive it through a real signature, and
observe a real completion callback would produce exactly the kind of
"claims a feature works based on a filename" artifact standing rule 4
forbids. Nothing was built for this boundary. The template's anchor tags
(`zs_agent_signature`, `zs_agent_printed_name`, `zs_authorized_signature`,
`zs_authorized_printed_name`, `zs_date_signed`) are already correctly
present in `templates/articles_of_organization.html.j2` (verified by
reading the file directly) as literal, non-Jinja-rendered text — that
much is confirmed ready for whenever Zoho Sign integration is built.

**Supersedes:** —

---

## 2026-09-09 — The five Gate 2 decision boundaries: recorded as open, not decided

Per the brief's explicit instruction, these are NOT decided by this
session — recorded here and reported to the user directly. Evidence
found in this session (Stripe catalog drift entry above) sharpens two of
them but does not answer them.

1. **PDF durable storage/serving target.** `pdf_bytes bytea` in Postgres
   is what the already-existing schema does (migration 0011,
   reconstructed) and is what this session built against, purely because
   it's what's already live — not a recommendation. No signed/expiring
   download endpoint was built (no storage target decided means no
   serving mechanism to build against). Cloudflare R2 (there's already a
   `wrangler.toml`/Worker in this repo) remains a live alternative,
   unevaluated this session.
2. **Exact DIY processing-fee surcharge mechanism.** Evidence found (not
   decided): the connected Stripe account already has a flat $4 Price
   object for this (`DIY_SERVICE_FEE`), not a computed percentage — see
   the Stripe catalog drift entry. Still reporting this as open pending
   explicit confirmation that this existing object is the intended final
   mechanism.
3. **Is Article IV/member-manager info mandatory for this service.**
   `server/src/pdf/context.ts` currently treats `authorized_persons` as
   hard-required (at least one) for PDF generation regardless of this
   boundary's answer, on the reasoning that a Florida LLC needs at least
   one named authorized person/manager to be validly organized — see
   that file's comments. This boundary, as posed, is about intake-flow
   sequencing/optionality, which this session did not touch.
4. **Zoho Sign envelope/callback — not built, not testable here.** See
   dedicated entry above.
5. **Whether the $5 Certificate of Status is inside or on top of
   FastTrack/Premium's total.** Sharpened, not answered: FastTrack and
   Premium are each confirmed single, non-itemized Stripe Prices
   ($499.00 / $999.00 flat) with no separate Certificate-of-Status line
   item wired to either, per the Stripe catalog drift entry.

**Supersedes:** —

---

## 2026-09-09 — `crm_sync_queue` extended (not duplicated) for order→Deal jobs; fulfillment (PDF+fax) uses `orders`' own state machine, not a queue table

**Rationale:** the Gate 2 brief explicitly left "reuse the existing
`crm_sync_queue` pattern or extend it for PDF+fulfillment jobs, your
call, log the choice" open. Decision: `crm_sync_queue` gets one new
nullable `order_id` column (`server/migrations/0013_...sql`) and one new
`sync_type` (`'order_deal'`) — the existing claim query
(`FOR UPDATE SKIP LOCKED`), backoff schedule, and dead-letter handling
(all already built and tested in Gate 1) are reused as-is; the worker's
`ZohoClient` interface and `recordOutcome` gain an order-keyed path
alongside the existing session-keyed one, rather than standing up a
second, parallel queue implementation for what is functionally the same
"retry an external call with backoff" problem. Fulfillment (PDF
generation + fax transmission) is different in kind — it's not a single
external call to retry, it's a multi-step pipeline (render PDF, persist
`filing_documents`, transmit fax, poll delivery) — and the schema already
anticipated this: `orders.fulfillment_status`/`fulfillment_run_after`/
`fulfillment_attempts` (migration 0010, reconstructed above) are a
purpose-built claim/backoff state machine on the `orders` row itself, so
`fulfillment/fulfillmentWorker.ts` claims directly off `orders` rather
than through any queue table.

**Supersedes:** —
