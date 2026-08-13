# Deploying llc-data-spine

Gate 1 scope: connectivity skeleton only — Express, a `pg` pool (max 5), and
`GET /health`. No business schema yet (see `migrations/.gitkeep`). This
doc covers deploying exactly that. It will grow as later phases land.

## 1. Get the Supabase connection string — SESSION POOLER, not direct, not transaction

Supabase dashboard → your project → **Project Settings → Database →
Connection string**. Supabase offers three modes; this service requires
the **session pooler**, specifically:

```
postgres://postgres.<project-ref>:[YOUR-PASSWORD]@aws-<region>.pooler.supabase.com:5432/postgres
```

| Mode | Host / port | Use it? |
|---|---|---|
| **Session pooler** | `aws-<region>.pooler.supabase.com:5432` | ✅ **Use this one** |
| Direct connection | `db.<project-ref>.supabase.co:5432` | ❌ No — IPv6-only, unreliable from hosted runtimes like Render |
| Transaction pooler | `aws-<region>.pooler.supabase.com:6543` | ❌ No — disables prepared statements and session state, which will break `SELECT ... FOR UPDATE SKIP LOCKED` job-claiming in the sync worker (added in a later phase) and this project's own migration-locking |

Get the port and host right — 5432 on the *pooler* hostname, not 5432 on
the *direct* hostname and not 6543 on the pooler hostname. All three are
easy to mix up because two of them share a port number and two of them
share a hostname.

If the project shows as **paused** in the dashboard, click **Resume**
before doing anything below — a paused project fails connections with a
generic error, not a clear "paused" message.

## 2. Run the migration locally first

This proves the connection string works before anything touches Render.

```bash
cd server
npm install
cp .env.example .env
# edit .env — set DATABASE_URL to the string from step 1
npm run migrate
```

Expected output with zero migration files present (current state):
`No pending migrations.` — this is correct, not a failure; it means the
bootstrap `schema_migrations` tracking table was created (or already
existed) and there's nothing queued yet.

Then sanity-check locally:

```bash
npm run dev
# in another terminal:
curl -s localhost:3000/health | jq
```

Expect `{"status":"ok","db":"connected","migrations":null}`. `migrations`
is `null` because no migration files have shipped yet — that's the
correct value for this phase, not a bug.

## 3. Create the Render Web Service

**Option A — Blueprint** (try this first): Render dashboard → **New →
Blueprint** → point at this repo. It should pick up `render.yaml` at the
repo root and create a service named `llc-data-spine` with root directory
`server`.

**Option B — manual dashboard settings**, if the Blueprint doesn't fit:
| Setting | Value |
|---|---|
| Type | Web Service |
| Runtime | Node |
| Root Directory | `server` |
| Build Command | `npm install && npm run build` |
| Start Command | `npm start` |
| Health Check Path | `/health` |
| Plan | Starter ($7/month), always-on — not Free. Decided 2026-08-12, see DECISIONS.md. |

## 4. Set environment variables on the Render service

| Key | Value |
|---|---|
| `DATABASE_URL` | The connection string from step 1 (session pooler, port 5432 on the pooler host) |
| `PORT` | Leave unset — Render injects this automatically |
| `PGSSL_DISABLE` | Leave unset |

Do **not** set `DATABASE_URL` from any file that gets committed. Paste it
directly into the Render dashboard's environment variable UI.

## 5. Verify

Once deployed, `curl -s https://<your-service>.onrender.com/health`
should return the same `db: "connected"` shape as step 2. If it instead
shows `db: "error"`, check (in order): Supabase project not paused →
`DATABASE_URL` set correctly on the Render service, **using the session
pooler host/port from step 1** (a direct or transaction-pooler string
pasted in here will misbehave in ways that look like a code bug) →
Supabase's own dashboard for any active incident.

`GET /ready` returns the same DB check but as a real HTTP status (503
when `db: "error"`, 200 when connected) — `/health` deliberately always
returns 200 so Render's health check doesn't restart the service over a
transient DB blip. Use `/ready` for your own manual verification and for
anything (like the future sync worker) that needs to gate on the DB
actually being reachable.

---

## Sync-worker hardening — before Stripe goes live

This service deploys on Render's **Starter plan (always-on, no
spin-down)** from the start — decided 2026-08-12, see DECISIONS.md. The
free-tier spin-down risk this section originally warned about (the
in-process poller that will retry queued CRM syncs going to sleep with
the service, letting a failed sync sit stuck until the next inbound
request) does not apply here.

Two items remain worth doing before accepting real payments, regardless
of plan tier — an always-on plan doesn't guarantee zero restarts, and
a stuck sync once Stripe is live means a paying customer's CRM record
silently lags:
1. Add a Render **Cron Job** (separate from this web service) that hits
   an endpoint to sweep and retry any `crm_sync_queue` rows stuck beyond
   a threshold — a backstop independent of the in-process poller, for
   the case where the service still restarts or redeploys mid-cycle.
2. Confirm the poller interval env var (added when the sync worker
   ships) is tuned appropriately for production, not left at a
   development-friendly default.
