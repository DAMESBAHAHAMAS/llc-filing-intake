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
