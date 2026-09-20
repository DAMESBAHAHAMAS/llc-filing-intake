# LLC Delivery System — Complete Dependency Audit

**Date:** 2026-09-20
**Scope:** doc §4 — every system touching the complete customer delivery
experience, organized against the categories the source document names
explicitly. Builds on `AUDIT-LLC-INTAKE-TECHNOLOGY.md` (the intake-specific
detail lives there; this document covers what that one didn't, and states
plainly where a named category has no corresponding system at all —
verified by search, not assumed absent).

---

## Category-by-category

**Website / Hosting / Lovable / CRM / Payment processing / Document
generation / PDF rendering / Databases / APIs** — fully covered in
`AUDIT-LLC-INTAKE-TECHNOLOGY.md` §1–§6. Not repeated here.

**File storage**
- Postgres `bytea` columns (`filing_documents.pdf_bytes`) are the only
  durable file storage in the system today — PDFs are stored as database
  rows, not in object storage (S3/GCS/etc.). Flagged in this repo's own
  `DECISIONS.md` as an open tradeoff, not a settled architecture.
- Zoho WorkDrive is the intended long-term storage for frozen pre-payment
  evidence copies (SA4-T464) — folder structure exists in production
  WorkDrive, automated delivery is not yet built (Track A, blocked).

**Email**
- Resend (`registeredAgent/emailSender.ts`) — the only outbound customer
  email in the system: registered-agent acceptance confirmation. No
  order-confirmation email, no receipt email, no "your filing is being
  processed" email, no marketing/nurture email exists in this codebase.
- Zoho Mail — the business's own inbound mail (MX records at
  `damianmaknowles.com`), unrelated to any automated customer
  communication.

**SMS**
- **Does not exist.** Searched both repos for Twilio/SMS integration —
  the only hits are a roadmap/planning data file (`roadmapEcosystem.ts`,
  aspirational, not implemented) and an unrelated demo page. No SMS
  sending capability exists anywhere in the delivery path.

**Automation**
- `crm_sync_queue` worker (CRM sync, retried with backoff/dead-letter)
- `fulfillment` worker (PDF generation, stops at human review)
- Both run as in-process pollers on the same Render web service, not as
  separate scheduled jobs — see intake audit §2 for the stated
  reliability limitation (stops during instance sleep/restart, no cron
  backstop).

**Customer communications**
- Limited to: the hero-form Zoho Lead capture (one-way, into CRM only,
  not a communication *to* the customer), and the single RA-acceptance
  email above. There is no post-purchase communication sequence.

**Order management**
- `orders` table + Stripe Checkout/webhooks (see intake audit §5). No
  separate order-management UI or tool exists — the only way to inspect
  an order today is a direct SQL query against production Postgres.

**Administrative systems**
- **Does not exist.** No admin dashboard, no internal tool for viewing
  filings/orders/documents, no way for a non-engineer to check a
  customer's status. Every "admin" reference found in the codebase is a
  code comment describing a hypothetical future flow, not a built one.
  Every verification performed by this audit and by prior sessions'
  acceptance testing was done via direct SQL against production —
  that is currently the *only* administrative interface this system has.

**Reporting**
- **Does not exist.** No analytics, no dashboard, no scheduled report.
  Searched both repos directly — zero hits for any reporting/analytics
  system.

**Security**
- Stripe webhook signature verification (`stripe/webhookSignature.ts`).
- PDF service shared-secret auth exists in code on both sides but is
  **not currently enforced live** (confirmed by direct testing 2026-09-18)
  — an open item, deliberately deferred, not forgotten.
- CRM Deal-stage-update ownership check (Deal→Contact→email match) — a
  mitigation, explicitly logged as not a full fix (the capture path
  itself, `crm_deal_id` on session-stage, is still unauthenticated
  client input).
- Postgres Row Level Security is enabled on the relevant tables
  (`filing_documents`, `fulfillment_transmissions`, confirmed in
  migration source), though the backend connects with a
  service-role-equivalent connection that this audit did not verify the
  exact RLS policy set for — worth a dedicated pass if RLS is meant to be
  a real defense layer rather than a formality.

**Authentication**
- **No authentication or authorization layer exists anywhere in this
  system** — not for customers, not for staff. `middleware/` contains
  only CORS handling. Every route is either fully public (by design, for
  the customer-facing intake) or protected only by obscurity (a
  filing_session_id or order_id acting as a bearer token, which is the
  same class of gap already logged for `crm_deal_id`). There is no login,
  no session, no role concept anywhere in the backend.

**Third-party services** — the full list, consolidated from both audits:
Stripe, Zoho (CRM, Mail, WorkDrive, and referenced-but-unbuilt Sign),
Resend, Google (Places Autocomplete), Render, Supabase, GitHub, Lovable,
Cloudflare (Workers today; Pages, as of this session, for the separate
OAuth-callback site).

**Internal tools**
- None beyond direct database access (Supabase MCP/SQL), the Render
  dashboard/API, and this git history. No internal ops tooling has been
  built.

**Supporting infrastructure**
- Four Render services in total touch this funnel: `llc-data-spine`
  (main backend), `llc-pdf-generator` (PDF rendering), `sunbiz-proxy`
  (name search), plus Render's own cron/health-check surface (health
  check path `/health` on the data-spine service). No CDN, load
  balancer, or queue service beyond Render's own infrastructure and the
  Postgres-table-backed queues already described.

---

## Headline gaps this audit surfaces, stated plainly

1. **No administrative interface of any kind.** Every operational check on
   this system — today, and in every prior acceptance-testing session —
   has been a direct production SQL query. There is no way for anyone
   without direct database/Render access to see a customer's order
   status.
2. **No authentication anywhere.** Every identifier in every URL/body
   (`filing_session_id`, `order_id`, `crm_deal_id`) is effectively a
   bearer token with no issuer-side verification. This is a broader
   framing of a gap already logged narrowly (the CRM Deal-ownership
   issue) — it is a systemic pattern, not an isolated one.
3. **No customer communication beyond one conditional email.** A paying
   customer today receives no order confirmation, no receipt, and no
   status update unless they chose a third-party registered agent.
4. **File storage is rows in Postgres, not object storage** — noted as an
   open tradeoff in this repo's own decision log, not new here, but worth
   carrying into the Execution-State Scope explicitly since it affects
   both cost and the WorkDrive delivery work in flight.
