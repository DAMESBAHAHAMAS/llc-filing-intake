# Deploying llc-data-spine

Gate 1 scope: connectivity skeleton only — Express, a `pg` pool (max 5), and
`GET /health`. No business schema yet (see `migrations/.gitkeep`). This
doc covers deploying exactly that. It will grow as later phases land.

## 1. Get the Supabase connection string

Supabase dashboard → your project (`cedwebrzbpjwusbshdiu`) → **Project
Settings → Database → Connection string**. Use the **direct connection**
(port 5432), not the pooled/PgBouncer URI (port 6543) — this service
manages its own small pool (`max: 5`) and direct is the right mode for
that at this scale. It looks like:

```
postgres://postgres:[YOUR-PASSWORD]@db.cedwebrzbpjwusbshdiu.supabase.co:5432/postgres
```

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
| Plan | Free (see §5 before this goes live with real customers) |

## 4. Set environment variables on the Render service

| Key | Value |
|---|---|
| `DATABASE_URL` | The connection string from step 1 (same one, direct/5432) |
| `PORT` | Leave unset — Render injects this automatically |
| `PGSSL_DISABLE` | Leave unset |

Do **not** set `DATABASE_URL` from any file that gets committed. Paste it
directly into the Render dashboard's environment variable UI.

## 5. Verify

Once deployed, `curl -s https://<your-service>.onrender.com/health`
should return the same `db: "connected"` shape as step 2. If it instead
shows `db: "error"`, check (in order): Supabase project not paused →
`DATABASE_URL` set correctly on the Render service → Supabase's own
dashboard for any active incident.

---

## Before Stripe goes live — do not skip this

The free Render plan spins the service down after inactivity. The
in-process poller that will retry queued CRM syncs (added in a later
phase) stops running while the service is asleep, so a failed sync can
sit queued until the next inbound request wakes the service back up.
That's acceptable during development with no real customers. It is
**not** acceptable once Stripe payments are live — a stuck sync at that
point means a paying customer's CRM record silently lags.

Before accepting real payments:
1. Upgrade this Render service to a paid, always-on instance plan.
2. Add a Render **Cron Job** (separate from this web service) that hits
   an endpoint to sweep and retry any `crm_sync_queue` rows stuck beyond
   a threshold — a backstop independent of the in-process poller, for
   the case where the always-on instance still restarts/redeploys mid-cycle.
3. Confirm the poller interval env var (added when the sync worker
   ships) is tuned appropriately for production, not left at a
   development-friendly default.
