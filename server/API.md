# llc-data-spine API

Living document — updated in the same commit as any endpoint change.
This is the frontend's (`florida-business-launchpad`) contract against
this service. All request/response bodies are JSON except the Stripe
webhook route. No endpoint here requires end-user auth (this is a public
funnel) unless noted.

Base URL: the deployed `llc-data-spine` Render service
(`https://llc-data-spine.onrender.com` in production).

---

## Session

### `POST /api/session/stage` (Gate 1, unchanged contract — see below for a Gate 2 security fix)

Mints/updates the durable `filing_sessions` row. See
`server/src/routes/session.ts` for the full field whitelist.

**Gate 2 change:** `payment_status`, `crm_lead_id`, `crm_deal_id`,
`crm_sync_status`, `crm_last_synced_at`, `pdf_generated_at`, and
`pdf_storage_ref` are **no longer accepted** from the client (they were
previously in the whitelist — a P0 security gap, see `DECISIONS.md`).
Sending them is silently ignored (not an error) — same as any other
unrecognized field. If the frontend was relying on setting any of these
directly, it needs to stop; they are now exclusively server/worker-owned.

Request: `{ filing_session_id?: string, stage: string, ...whitelisted fields }`
Response: `{ filing_session_id, current_stage, stage_changed, event_id, queued_sync_id }`

---

## Name check

### `POST /api/name-check`

Hard pre-payment gate via the real `sunbiz-proxy` service (proxied
through this service, not called directly from the browser — see
`DECISIONS.md` for why, and for a logged limitation: this session could
not independently re-verify `sunbiz-proxy`'s exact contract due to this
sandbox's network policy, so `SUNBIZ_PROXY_URL` needs to be confirmed
against `llc-worker.js`'s existing `RENDER_PROXY_URL` before relying on
this in production).

Request:
```json
{ "name": "Acme Ventures LLC", "filing_session_id": "optional-uuid" }
```

Response:
```json
{
  "searched_name": "Acme Ventures LLC",
  "distinguishable": true,
  "verdict": "approved",
  "reason": "No conflicts found.",
  "similar_count": 0,
  "similar_entities": [],
  "restricted_word_hits": [],
  "restricted_word_warning": null
}
```

- `verdict: "rejected"` (with `distinguishable: false`) is the ONLY hard
  block — an active Florida entity with the same name (ignoring
  LLC/L.L.C. suffix) already exists.
- `restricted_word_hits`/`restricted_word_warning` are ALWAYS informational
  — never a reason to block checkout by themselves.
- If `filing_session_id` is supplied, the verdict is persisted onto
  `filing_sessions.name_check_results` (best-effort — the verdict is
  still returned even if that write fails).

---

## Checkout (Stripe)

### `POST /api/checkout/create`

The browser sends **offer identifiers only** — never an amount, price,
discount, or total. Every `offer_code` is resolved server-side against
the Offer Master (`offers` table); see `server/migrations/0012_offer_master.sql`
for the current catalog and `DECISIONS.md` for how it was populated (real,
pre-existing Stripe test-mode objects, discovered not invented).

Request:
```json
{
  "filing_session_id": "uuid — must already exist via POST /api/session/stage",
  "line_items": [
    { "offer_code": "DIY_STATE_FEE", "quantity": 1 },
    { "offer_code": "DIY_SERVICE_FEE", "quantity": 1 },
    { "offer_code": "DIY_CERT_OF_STATUS", "quantity": 1 }
  ]
}
```

**Current sellable `offer_code` values** (status='active' in the Offer
Master — anything else, including a typo or `EIN_FILING_EXPRESS`, which
is intentionally `status='draft'` pending a real price confirmation, is
rejected with 422):

| offer_code | Price | Notes |
|---|---|---|
| `DIY_STATE_FEE` | $125.00 | Florida state filing fee |
| `DIY_SERVICE_FEE` | $4.00 | Flat processing fee — NOT a computed surcharge, see decision boundary #2 |
| `DIY_CERT_OF_STATUS` | $5.00 | Included/standard for DIY |
| `DIY_CERTIFIED_COPY_ADDON` | $30.00 | Optional add-on |
| `FASTTRACK` | $499.00 | Single bundled price |
| `PREMIUM` | $999.00 | Single bundled price |
| `EIN_FILING` | $299.00 | Standard EIN filing |
| `EIN_FILING_EXPRESS` | ~$449.00 | **NOT SELLABLE YET** — draft |
| `REGISTERED_AGENT_3YR` | $100.00 | Path A / house RA service |
| `CREDENTIALS_KIT` | $89.00 | Company Credentials Kit |

DIY is always the 3-item combination above (state fee + service fee +
cert of status = $134 total) — whether Certificate of Status is
separately itemized or bundled for FastTrack/Premium is decision
boundary #5, still open.

Response (200):
```json
{ "order_id": "uuid", "checkout_url": "https://checkout.stripe.com/...", "stripe_checkout_session_id": "cs_...", "total_cents": 13400 }
```

Errors:
- `404` — unknown `filing_session_id` (call `POST /api/session/stage` first)
- `422` — one or more `offer_code` values don't resolve (`unknown_offer_codes` array in the body)
- `409` — `EIN_FILING_EXPRESS` requested and today's same-day capacity is full
- `502` — Stripe API call failed; the `order` row still exists with
  `checkout_status: 'checkout_failed'` (never deleted) — `order_id` is
  still returned so the failure is traceable

**Redirect behavior:** the browser's Stripe success/cancel redirect
NEVER establishes payment truth by itself (frozen rule) — the frontend
should treat landing on the success URL as "go poll
`GET /api/checkout/order/:orderId` (or `/api/session/stage`'s
`current_stage`) until `payment_status` reads `paid`," not as "payment
succeeded."

### `GET /api/checkout/order/:orderId`

Polling endpoint for the frontend's payment-succeeded UI state.

Response:
```json
{
  "order_id": "uuid",
  "filing_session_id": "uuid",
  "checkout_status": "checkout_created",
  "payment_status": "pending",
  "failure_reason": null,
  "fulfillment_status": "not_ready",
  "total_cents": 13400,
  "currency": "usd"
}
```

### `POST /api/webhooks/stripe`

Stripe-only (not called by the frontend). Verified via
`Stripe-Signature`; idempotent on `stripe_webhook_events.id`. Handles
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `checkout.session.expired`. On
a paid order that includes an actual Sunbiz filing (`FASTTRACK`,
`PREMIUM`, or `DIY_STATE_FEE`), sets `orders.fulfillment_status='ready'`
so the fulfillment worker picks it up; always enqueues exactly one
`order_deal` (paid) or `abandoned_cart` (failed) CRM job.

**Configure in the Stripe Dashboard:** endpoint URL
`https://llc-data-spine.onrender.com/api/webhooks/stripe`, events listed
above.

---

## Customer order emails

Queued in `crm_sync_queue`, in the same transaction as the state they
announce, and sent by `orderEmails/worker.ts` within about 30 seconds.

| Email | Sent when | Queued by |
|---|---|---|
| Welcome, order confirmation, intake summary | Checkout completes, as a hold or a payment | `POST /api/webhooks/stripe` |
| Filing confirmation | Proof of filing is recorded on a held, released or paid order | `POST /api/orders/:orderId/proof-of-filing` |

Each email is queued at most once per order, and the Resend idempotency key
is `order-email/<order_id>/<type>`. A failed send retries on the CRM backoff
schedule, alerts on the first failure and when it gives up, and never affects
payment or fulfilment.

### `GET /api/orders/:orderId/emails`

Operator only (`x-operator-key`). Shows what the customer was sent.

```json
{
  "order_id": "uuid",
  "emails": [
    { "email_type": "welcome", "status": "sent", "attempts": 0, "last_error": null, "provider_message_id": "re_...", "sent_at": "2026-11-04T15:00:00.000Z" }
  ]
}
```

`status` is `pending` (queued or waiting to retry), `processing`, `sent` or
`dead_letter` (gave up; the customer did not get it).

## EIN Filing Express capacity

### `GET /api/ein-express/availability`

```json
{ "capacity": 20, "usedToday": 3, "remaining": 17, "available": true }
```

Count-based, not a clock cutoff (frozen rule) — call this before
offering the option, but `POST /api/checkout/create` independently
re-checks it, so don't rely on a client-side cache of this response
during the actual checkout call. Currently moot for real sales since
`EIN_FILING_EXPRESS` is `status='draft'` in the Offer Master (unconfirmed
price) — checkout rejects it regardless of capacity.

---

## Post-filing roadmap (Thank You page, A6Y2-T144 Dispatch 13)

The three "Prepare your next steps" toggles on `/checkout/success`. Both calls need the
filing session **and** one of its held or paid orders (the pair in the Stripe success
URL); anything else is `404 { "error": "not_found" }`. `400 invalid_request` for a bad
body, `503 not_open` when `POST_FILING_INTERESTS_ENABLED=false`, `429` past
`RATE_LIMIT_POST_FILING_PER_10MIN` (default 30 per IP). The website shows the toggles
only after a `200` from the GET.

### `GET /api/post-filing-interests?filing_session_id=…&order_id=…`
→ `{ "status": "open", "interests": { "bank_account": false, "licenses_permits": true, "tax_compliance": false }, "license_note": "Food truck, Miami" | null }`

### `POST /api/post-filing-interests`
`{ "filing_session_id", "order_id", "interest": "bank_account" | "licenses_permits" | "tax_compliance", "selected": true | false, "note"?: string }`
→ `{ "status": "saved", "interests": {…}, "license_note": … }`. `note` is kept only for
`licenses_permits` (control characters removed, at most 500 characters).

Saved in `post_filing_interests` (migration 0032; until it is applied both calls answer
`503 not_open`). A background job (every 60 s, `POST_FILING_SYNC_INTERVAL_MS`) writes the
customer's current choices to the Deal in one v8 update: the multi-select
`Post_Filing_Interests` (id 2654294000040656012; "Bank Account Setup", "Licenses and
Permits", "Tax and Compliance") and the long text `Post_Filing_License_Note`
(id 2654294000040639002; emptied when the licence check is off). Override the names with
`POST_FILING_INTERESTS_FIELD` / `POST_FILING_NOTE_FIELD`. The Deal is never taken from the
request: it is the Deal of the session's earliest held or paid order whose Deal id passed
a sync job (the EIN portal's `VERIFIED_DEAL_JOIN`). Retries for about 3 days, then an ops
alert (one per cause per 6 hours).

## SS-4 Third-Party Designee e-signature (ST17)

**Off by default.** Both calls answer `503 { "error": "not_open" }` until
`EIN_DESIGNEE_ESIGN_ENABLED=true` (Damian's switch) and migration 0040 is applied. The
customer types their full legal name under Damian's approved wording (version
`ss4-designee-2026-11-26`, `src/ein/designee.ts`; do not edit it, add a new version).
Both calls need the filing session **and** one of its held or paid orders (the pair in the
Stripe success URL), and the session's held or paid orders must include the EIN (a
Bank-Ready or Premium bundle, or an EIN add-on); anything else is `404 not_found`. `400
invalid_request` for malformed ids, `429` past `RATE_LIMIT_EIN_DESIGNEE_PER_10MIN`
(default 30 per IP).

### `GET /api/ein/designee-authorization?filing_session_id=…&order_id=…`
→ `{ "status": "open", "entity_name": "SUNSHINE WIDGETS LLC" | null, "statement": { "version", "title", "intro", "clauses": [3], "text", "sha256" }, "signature": {…} | null }`

Show `entity_name` above the statement ("the entity listed above"); while it is null the
POST answers `409 entity_name_missing`.

### `POST /api/ein/designee-authorization`
`{ "filing_session_id", "order_id", "entity_name": "<as the GET returned it>", "statement_version": "ss4-designee-2026-11-26", "signer_name": "Ada Lovelace", "signer_title"?: "Managing Member", "consent": true }`
→ `201 { "status": "signed", "already_signed": false, "signature": { "statement_version", "signer_name", "signer_title", "entity_name", "signed_at", "authority_expires_at" } }`,
or `200` with `"already_signed": true` and the **first** signature unchanged if the session
already signed this version (tell the customer it was signed before; nothing new was stored).
`400 consent_required | signer_name_required | invalid_signer_title | entity_name_required | statement_version_required`;
`409 entity_name_changed` (with the current `entity_name`) when the LLC name changed since
the page showed it; `409 statement_changed` (with the current `statement`) when the page
showed an older wording.

Stored in `ein_designee_authorizations` (one row per session and version): the typed name
and title, the LLC name shown, the version, the full statement text and its SHA-256, the
server's signing time, `authority_expires_at` (one year later, clause 1; the EIN
assignment end is not tracked here), the client IP (`True-Client-IP`, kept only if it is a
valid IP address; no fallback to the proxy's address), the raw `X-Forwarded-For` chain and
the user agent. A signature does not prove payment: a held card can later be released, so
the SS-4 step must check the order again. Not printed on the SS-4 and not copied to Zoho.
Still open with Damian: the designee's phone and fax for the SS-4, and whether a Form 2848
is needed instead (O22).

## Registered agent (Path B — customer's own RA)

Path A (house RA) needs **none of these endpoints** — the server always
stamps the fixed house RA identity into the PDF regardless of what (if
anything) the client sends for RA fields.

### `POST /api/registered-agent/request-acceptance`

```json
{ "filing_session_id": "uuid", "registered_agent_name": "Jane Doe", "registered_agent_email": "jane@example.com" }
```
→ `{ "acceptance_token_id": "...", "acceptance_url": "https://<frontend>/registered-agent/accept?token=...", "email_sent": false, "note": "..." }`

**`email_sent` is always `false` right now** — this environment has no
email-provider credentials configured, so no email is actually sent (see
`DECISIONS.md`). The frontend/ops needs its own way to deliver
`acceptance_url` until that's built.

### `POST /api/registered-agent/accept` — `{ "token": "..." }` → `{ "status": "accepted" }`
### `POST /api/registered-agent/decline` — `{ "token": "..." }` → `{ "status": "declined" }`
### `GET /api/registered-agent/status/:filingSessionId` → `{ "registered_agent_status": "accepted" | "pending" | ... | null }`

Tokens expire 7 days after being requested (`status` flips to `expired`
lazily, on the next accept/decline attempt against that token).

---

## Zoho Sign (authorized signer + registered agent signature)

**NOT BUILT.** Decision boundary #4 from the Gate 2 brief. No Zoho Sign
MCP tool and no Zoho Sign API credentials exist in this environment, so
no envelope-creation/callback code was written rather than shipping
something untested. See `DECISIONS.md` for the full status.

---

## PDF / fulfillment (internal — not called by the frontend directly)

Not currently exposed as a frontend-facing HTTP endpoint. The
fulfillment worker (`server/src/fulfillment/fulfillmentWorker.ts`) polls
`orders.fulfillment_status='ready'`, builds and validates the PDF
context (`server/src/pdf/context.ts` — a missing/incomplete field stops
here as `fulfillment_status='requires_review'` with the missing fields
recorded in `fulfillment_last_error`, never a fabricated value), calls
the now-hardened `llc-pdf-generator` service, and persists the result to
`filing_documents`. It stops at `fulfillment_status='requires_review'`
after a successful render — actual fax transmission to the state/IRS
(`fulfillment_transmissions`, Telnyx) is not implemented (would be a new
third-party dependency with no credentials available here — see
`DECISIONS.md`).

If the frontend needs a "is my document ready" signal, the closest
available today is polling `GET /api/checkout/order/:orderId`'s
`fulfillment_status` field — a document-download endpoint (signed,
expiring URL per decision boundary #1) is not yet built.

## Registered agent acceptance signature (T144 Dispatch 12)

- `POST /api/registered-agent/acceptance/details` `{ token }` → `{ actionable, status, llc_name, registered_agent_name, registered_agent_florida_address, statement, statement_version, signature_required, expires_at }`. Records nothing; 404 for an unknown token. `registered_agent_name` is the agent the request was sent to.
- `POST /api/registered-agent/accept` also takes `{ signature_name, consent: true }`. Optional until `RA_ACCEPT_REQUIRE_SIGNATURE=true` (set it once the new acceptance page is published). The name must be the named agent's (case, accents, punctuation, spacing and a middle name ignored; a person may sign for a business agent), else `400 { code: "signature_mismatch", registered_agent_name }`. One transaction uses the token, stores the signature on the `registered_agent_acceptances` row (migration 0033: name, consent, user agent, statement version, the agent name/address/LLC accepted; IP from True-Client-IP) and opens the filing gate. Nothing is stored in `filing_data`. Answer: `{ status: "accepted", signed }`. With `RA_ACCEPT_REQUIRE_SIGNATURE=true` and 0033 not applied: `503 not_ready`.
- Articles Article III prints the agent's `/s/` line only from that row, and only while the filing still names the accepted agent and address.
- `POST /api/ops/registered-agent/acceptance-statement/:filingSessionId` (header `x-operator-key`) → the signed Registered Agent Acceptance Statement PDF, from the row. 422 when there is no typed signature.
- Zoho Deal status: written to `RA_Acceptance_Status` (text, created 25 Nov 2026) unless `RA_DEAL_STATUS_FIELD` names another field; `RA_DEAL_STATUS_FIELD=off` switches it off (values: "Awaiting agent acceptance", "Agent Accepted — Ready for Sunbiz", "Agent declined", "Agent acceptance expired", "Agent email failed"; optional DateTime `RA_DEAL_ACCEPTED_AT_FIELD`). Written only to the session's verified Deal (VERIFIED_DEAL_JOIN: a held or paid order whose Deal a sync job confirmed), field-only (Stage untouched). The job carries no status: the worker sends the session's status as it is when the job runs, so an older job cannot overwrite a newer status. One pending job per session.

## Operating Agreement and Banking Resolution (T144 Dispatch 10)

- Background job (every `OPERATING_AGREEMENT_JOB_INTERVAL_MS`, default 10 min; 0 disables):
  - **Register:** every verified Deal of a held or paid order gets a row: "Pending Generation" for Bank-Ready (FASTTRACK) and Finance-Ready (PREMIUM), otherwise "Not Included".
  - **Generate:** after proof of filing, the agreement is generated and stored in `formation_documents`.
  - **Sync:** the current status is written to the Deal field `Operating_Agreement_Stat`. `OA_DEAL_STATUS_FIELD` overrides the field name; `off` disables the write.
- `POST /api/ops/operating-agreement/:orderId` (header `x-operator-key`). Body: `{ inputs?, banking_resolution_inputs?, filing_date?: "YYYY-MM-DD", replace?: boolean }`. Generates and stores the agreement (plus the DRAFT Banking Resolution when `BANKING_RESOLUTION_ENABLED=true`). Responses:
  - `422 { missingFields }` when answers are missing.
  - `409` when the package does not include the agreement, no proof of filing is recorded, or the agreement was already generated (pass `replace: true` to regenerate).
- `GET /api/ops/formation-documents/:orderId/:kind` (`operating_agreement` | `banking_resolution`) returns the stored PDF. Headers: `X-Content-SHA256`, `X-Draft`.
- Migration 0034 (`operating_agreement_status`, `formation_documents`). Until it is applied, the job logs once and stays idle.

### Operating Agreement: before migration 0034 is applied (T144 D10 review, 25 Nov 2026)
- `POST /api/orders/:orderId/proof-of-filing` also takes an optional `filing_date` (YYYY-MM-DD): the date Sunbiz filed the Articles. It is stored in `orders.sunbiz_filing_date` (migration 0036) after the proof is recorded, and never affects collection. The agreement's "Filed" date comes only from this date or from `filing_date` on the ops route, never from when the proof was recorded. "Effective" follows the Articles: the filing date for "Immediate", otherwise the chosen date. Without a filing date the job waits and alerts once.
- The members are never inferred from Article IV. The job generates on its own only when the customer answered member-managed with a single member, and exactly one person is listed. Otherwise the ops route needs `inputs.members`, or `confirm_members: true` when the Article IV people are exactly the members (else `422`).
- Re-posting the ops route for an agreement that is already generated returns `409` unless `replace: true`, so new answers are never dropped.
- The package is decided per Deal across all its held or paid orders. `OA_JOB_START_DATE` applies to the Deal's first order. A Pending Deal whose qualifying order is released or refunded goes back to Not Included.
- Deal-write failures go to `deal_sync_error` (0036), not `last_error`.
- Apply 0034 and 0036 together.
