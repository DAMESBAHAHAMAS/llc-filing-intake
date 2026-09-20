# LLC Intake — Technology Audit

**Date:** 2026-09-20
**Scope:** doc §3, "LLC INTAKE — TECHNOLOGY AUDIT" — every system, service, API,
integration, platform, database, automation, or third-party dependency
required to execute the intake, from a customer landing on the site through
(intended) direct submission to Sunbiz.

**Method:** produced by reading the actual, currently-deployed code and
configuration across both repos and querying live production state (Render,
Supabase) directly — not from memory or design intent. Every row below is
traceable to a specific file or a command run against the live system.
Anything I could not directly verify (because its source isn't in either
repo I have access to) is marked as such rather than assumed.

**Headline finding, stated up front because it changes how the rest of this
table should be read:** the workflow as built does **not** reach "direct
submission to Sunbiz." It reaches PDF generation and a human review
checkpoint. The schema for the actual transmission step exists
(`fulfillment_transmissions`, fax via Telnyx) but the code that would call
Telnyx was never written — `fulfillmentWorker.ts` deliberately stops at
`fulfillment_status = 'requires_review'` after generating the PDF. This is
documented in the repo's own `API.md` and `DECISIONS.md` as a known,
intentional gap (a fabricated "sent" status was explicitly rejected in favor
of an honest stop), not something newly discovered here — but it means any
scheduling or scoping built on top of this audit needs to treat "submit to
Sunbiz" as unbuilt, not as an existing capability with unknown reliability.

---

## 1. Customer-facing frontend

| Tool / Service | Function / Purpose |
|---|---|
| `florida-business-launchpad` (React 18 + TypeScript + Vite) | The intake UI itself — hero lead form, name-check flow, the multi-step filing interview (`LLCFilingIntake.tsx`), package selection, checkout handoff. |
| Lovable (lovable.dev) | Hosts and auto-deploys the frontend. Pushing to GitHub does **not** publish the live site — Lovable requires a separate manual "Publish" step. Lovable also auto-commits its own edits directly to `main` (observed repeatedly this session as concurrent "Changes" commits) — a real, ongoing concurrent-edit risk against any other work on this repo. |
| React Router | Client-side routing across the multi-page site, including the filing interview's step sequence. |
| `IntakeContext` (`src/context/IntakeContext.tsx`) | Client-side state for the entire intake — persisted to `localStorage` under `llc-intake-shared-v1`. This is the **only** place hero-captured data (name/email/phone) and filing-interview data live before `POST /api/session/stage` durably persists them server-side. If a customer closes the tab before that call succeeds, the data exists only in that browser's `localStorage`. |
| Google Places Autocomplete API | Address verification for principal/mailing address in the filing interview. The UI hard-requires a selected Places suggestion (free-typed addresses are rejected) before allowing continuation — confirmed directly by testing the live form. |
| Zoho Web-to-Lead (hidden iframe POST) | Hero form lead capture (`ZohoLeadGateForm.tsx`). Cross-origin by design — the app cannot read Zoho's response directly. Outcome (accepted/rejected) is inferred from whether the iframe navigates to a fixed `returnURL`, which only resolves as same-origin-readable when the site itself is running on the production domain — verified and fixed for a false-negative bug this session (2026-09-17/18 work). |
| Cloudflare Worker — `llc-worker.damian-793.workers.dev` | Called at full filing-interview completion (`handleComplete` → `POST {WORKER}/intake`). Creates the Zoho Deal at intake time and returns `deal_id`. **Source not available to me** — this repo only has the frontend's call site, not the Worker's own code, so I cannot audit its internals; it is an external dependency I can name and describe by observed contract only. |
| `canonicalFilingData.ts` | Maps `IntakeData` into the canonical `filing_data` shape the backend's PDF composer requires. This mapping was silently broken until this session's 2026-09-18 fix (see that repo's `DECISIONS.md`) — every filing was reported "incomplete" regardless of input, for as long as this had existed. |
| `sunbiz-proxy` (separate Render service, `srv-d8qahedckfvc73e1keug`) | Proxied via the backend's `POST /api/name-check`, mirroring the same contract `llc-worker.js` already used directly (`RENDER_PROXY_URL`). Performs the actual Florida Sunbiz business-name-availability lookup. |
| Stripe Checkout (redirect) | Payment collection — customer is redirected to Stripe-hosted Checkout, not an embedded form. |

---

## 2. Backend — `llc-data-spine` (Render service `srv-d9u1ihh42hec739av8og`)

| Tool / Service | Function / Purpose |
|---|---|
| Express (Node.js/TypeScript) | The backend's HTTP framework — all routes in `server/src/routes/`. |
| `pg` (node-postgres) | Direct SQL driver to Postgres — no ORM. |
| Supabase Postgres (project `rtivwkqsuuvbkvdudgnd`) | The system of record for filing data. Tables directly involved in intake: `filing_sessions` (the session + `filing_data` JSON, the canonical record `pdf/context.ts` reads), `filing_events` (append-only stage-change log), `orders`, `stripe_webhook_events`, `crm_sync_queue`, `registered_agent_acceptances`, `filing_documents`, `fulfillment_transmissions`, `offers`/`offer_add_ons` (Offer Master), `schema_migrations`. |
| `POST /api/session/stage` (`routes/session.ts`) | The one write path for intake data. Whitelists exactly which columns a client can set (`SESSION_FIELDS`) — a P0 security fix from 2026-09-09 removed `payment_status`/CRM fields from client control after a real forgery path was found. Mints `filing_session_id` server-side on first call; idempotent per (session, stage). |
| `POST /registered-agent/select` (`routes/registeredAgent.ts`) | Durable, required (not best-effort) persistence of the registered-agent choice — house (server-stamped identity, non-negotiable) or third-party (requires a separate acceptance flow before fulfillment can proceed). |
| `POST /api/name-check` (`routes/nameCheck.ts`) | Backend-side proxy to `sunbiz-proxy`, mirroring the Worker's own contract. |
| `GET /api/offers` (`routes/offers.ts`) | Serves the Offer Master (package/add-on catalog) — package pricing shown at checkout is server-defined, not client-supplied. |
| `stripe/restClient.ts` | Hand-rolled REST client directly against Stripe's HTTP API — **not** the `stripe` npm SDK, per this repo's own governance rule against unapproved new dependencies. Used for Checkout session creation. |
| `POST /api/webhooks/stripe` (`routes/webhooksStripe.ts`) | Stripe webhook receiver. Verifies signature (`STRIPE_WEBHOOK_SECRET` — currently unconfirmed/unset in production as of the last live test this session), marks the order paid, gates fulfillment-readiness on registered-agent acceptance status, enqueues CRM sync and the acceptance email. |
| `POST /api/filing-session/:id/pdf` (`routes/filingDocument.ts`, added 2026-09-18) | Pre-payment PDF generation, independent of order/payment state. The only customer-facing PDF retrieval path that currently exists (see §4). |
| `fulfillment/fulfillmentWorker.ts` | Post-payment worker. Polls `orders.fulfillment_status='ready'`, builds and validates the PDF context, calls the PDF-rendering service, persists the result — then stops at `requires_review`. Does not call Telnyx; no fax is sent. |
| `sync/worker.ts` | CRM sync queue worker — dispatches `crm_sync_queue` jobs (Lead/Deal sync, Deal-stage update on payment) with exponential backoff and dead-lettering. Runs as an in-process poller (every 30s by default) — a known limitation: it stops while the Render instance is asleep/restarting, with no external cron backstop currently built. |
| `zoho/client.ts` | Zoho CRM REST API client — Deal creation/stage updates. Deal-stage updates verify the target Deal's linked Contact email matches the paying session's email before writing (added 2026-09-17) — mitigates but does not resolve the fact that `crm_deal_id` capture itself is still unauthenticated client input. |
| `registeredAgent/emailSender.ts` (Resend SDK) | Registered-agent acceptance emails. A logged, approved exception to the "no new dependency without review" rule. `RESEND_API_KEY`/`RESEND_FROM_EMAIL` were unconfirmed/unset in production as of the last live check. |
| Render Cron/poller pattern | Both the CRM sync and fulfillment pollers run **in-process** (`setInterval` inside the same web service), not as separate scheduled jobs — see `index.ts`. |

---

## 3. PDF generation

| Tool / Service | Function / Purpose |
|---|---|
| `llc-pdf-generator` (separate Render service, `srv-d94edalckfvc739rg9jg`, Flask/gunicorn/Python) | Renders the Articles of Organization PDF. Same git repo as the backend (`llc-filing-intake`) but a distinct Render deployment with its own root directory and dependencies. |
| WeasyPrint 62.3 (pinned) | HTML/CSS → PDF rendering engine. |
| `pydyf` (must stay `<0.11.0`, fixed 2026-09-18) | WeasyPrint's PDF-writing dependency. Was unpinned; resolved to an incompatible 0.11.0+ that broke every real (non-empty-context) render with `AttributeError: 'super' object has no attribute 'transform'` — a known upstream issue (Kozea/WeasyPrint#2620), found via Render's own logs, not assumed. |
| Jinja2 3.1.4, `StrictUndefined` | Templating engine for `templates/articles_of_organization.html.j2`. Hardened (2026-09-09) so a missing template variable raises loudly (422) rather than silently rendering blank — a real gap found and fixed at the time, not a hypothetical. |
| `pdf/context.ts` / `buildPdfContext()` | The single place that validates `filing_data` is complete and maps it onto the template's exact variable names. Both the pre-payment endpoint and the post-payment fulfillment worker call this same function — one validator, two callers. |
| `pdf/serviceClient.ts` | The backend's HTTP client to `llc-pdf-generator`'s `/generate-pdf`. Shared-secret auth (`X-PDF-Service-Key`/`PDF_SERVICE_API_KEY`) exists in code on both sides but is **currently not enforced** — confirmed live: the production `llc-pdf-generator` accepts unauthenticated requests as of this audit. Tracked as an open security item, deliberately deferred per explicit instruction. |
| Zoho Sign (referenced, not built) | The PDF template contains literal, deliberately-escaped text anchors (`{{zs_agent_signature}}` etc.) for a Zoho Sign envelope integration. Confirmed via the template source and `API.md`: **not built** — no Zoho Sign credentials or integration code exist anywhere in this system. |

---

## 4. Document delivery / evidence

| Tool / Service | Function / Purpose |
|---|---|
| `filing_documents` table | Stores the actual generated PDF bytes (Postgres `bytea`), sha256, byte size. `order_id IS NULL` rows are the pre-payment evidence copy (one per session, enforced by a partial unique index); `order_id NOT NULL` rows are post-payment fulfillment attempts (one per attempt, never mutated). |
| `POST /api/filing-session/:id/pdf` | The only route that serves a PDF back to anything (a browser, in this case) — idempotent, reuses an already-generated artifact rather than regenerating. There is **no equivalent route for the post-payment fulfillment PDF** — that one is generated and stored but nothing serves it to the customer (a distinct, still-open gap from the pre-payment path). |
| Zoho WorkDrive (SA4-T464, in progress) | Intended frozen-record archival destination for the pre-payment PDF (`04_LEGAL/01_LLC-FORMATION/PRE-PAYMENT-EVIDENCE/`). Destination verified against the real production WorkDrive team folder via its API this session. Automated backend delivery is **not yet built** — blocked on Zoho WorkDrive OAuth credentials for the backend, which is the subject of the separate, currently-in-progress OAuth/Cloudflare track. |

---

## 5. Payments

| Tool / Service | Function / Purpose |
|---|---|
| Stripe (test mode only, confirmed) | Checkout Session creation and webhook-driven payment confirmation. The Offer Master's Price IDs are seeded against a **test-mode** Stripe account — this system has never been promoted to live-mode payments. |
| `stripe_webhook_events` table | Durable, idempotent record of every processed webhook event — event ID is the primary key, so redelivery cannot double-process. |

---

## 6. CRM

| Tool / Service | Function / Purpose |
|---|---|
| Zoho CRM (Leads + Deals modules) | Lead capture at the hero step; Deal creation at full-intake completion (via the Cloudflare Worker); Deal-stage update on confirmed payment (via the backend, ownership-checked). |
| `crm_sync_queue` table | Durable job queue for all CRM writes — decouples CRM availability from the customer-facing flow (CRM failure never blocks fulfillment, per this repo's own governance rule #1). |

---

## 7. Infrastructure / hosting / accounts

| Tool / Service | Function / Purpose |
|---|---|
| Render (4 separate services: `llc-data-spine`, `llc-pdf-generator`, `sunbiz-proxy`, plus others unrelated to this funnel) | Compute hosting for every backend/service component. |
| Supabase | Managed Postgres hosting for the system of record. |
| GitHub (`DAMESBAHAHAMAS` account) | Source control for both `llc-filing-intake` and `florida-business-launchpad`. |
| Lovable | Frontend hosting/publish pipeline (distinct from GitHub — see §1). |
| Cloudflare Workers | Hosts `llc-worker.js` (intake-time Deal creation) — source not in either audited repo. |

---

## What this audit deliberately does not cover

- **Lead magnet Type 1 and Type 2** (doc §7, §8) are separate audit scopes, not covered here.
- **Full delivery-system dependency audit** (doc §4, broader than intake — CRM/email/SMS/admin/reporting as a whole) is a distinct, wider task, next in sequence.
- I did not attempt to audit `llc-worker.js` or Lovable's own internals beyond their observed external contract, since neither's source is available to me. If a full audit of either is required, that needs either their source added to an accessible location, or a different reviewer with that access.
