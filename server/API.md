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

An LLC filing order (`FASTTRACK`, `PREMIUM` or `DIY_STATE_FEE`) answers
**422** with `code: "filing_authorization_required"` unless
`filing_data.filing_authorization.accepted` is exactly `true`. The website
writes that record at intake.

Every session is card only. A held session shows the saved-card
authorization above the pay button, and the order records the text Stripe
reports it showed (`saved_card_authorization_text`) with the moment checkout
completed (`saved_card_authorized_at`).

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
a held or paid order that includes an actual Sunbiz filing (`FASTTRACK`,
`PREMIUM`, or `DIY_STATE_FEE`), sets `orders.fulfillment_status='ready'`
so the fulfillment worker picks it up; enqueues one `order_deal` job
(`held_deal` opens the Deal at SERVICE REQUESTED on a verified hold,
`paid_deal` opens it at Closed Won on a checkout payment) or one
`abandoned_cart` job (failed). A session that already holds a
`crm_deal_id` gets a `deal_stage_update` job instead of a second Deal.
Also handles `payment_intent.succeeded` (order paid, held Deal moves to
Closed Won), `payment_intent.canceled` and `charge.refunded`. See
`DECISIONS.md`, 2026-11-04.

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
| Saved card declined after filing | The saved card refuses a charge | `POST /api/orders/:orderId/proof-of-filing`, `service-complete` |
| Agent declined, or no answer in 7 days | The customer's own agent falls through | `POST /api/registered-agent/decline`, the card-hold poller |
| Order cancelled | The order is cancelled | `POST /api/orders/:orderId/cancel` |

The filing confirmation is not queued. It gates collection, so it is sent
once, inline, by `POST /api/orders/:orderId/proof-of-filing`, and appears in
the list below as `filing_confirmation`.

Each email is queued at most once per order (the agent notice, once per agent
asked). The worker decides at send time, from the order as it stands: a
released, refunded, failed or cancelled order gets no hold wording, and the
email is marked `skipped` with the reason in `last_error`. A test-mode order
emails only reserved test addresses (`example.com`, `.test`, `.invalid` and
similar). The Resend idempotency key is
`order-email/<order_id>/<type>/<content hash>`, so a retry with the same
content cannot send twice and a re-rendered retry is not refused. A failed
send retries on the CRM backoff schedule, alerts on the first failure and when
it gives up, and never affects payment or fulfilment.

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

`status` is `pending` (queued or waiting to retry), `processing`, `sent`,
`skipped` (deliberately not sent; `last_error` says why), `failed` (a filing
confirmation that has not gone yet) or `dead_letter` (gave up; the customer
did not get it, and the resend route below puts it back).

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

## `POST /api/orders/:orderId/proof-of-filing` (operator key)

Body: `{ "document_number": "<Sunbiz document number, or the EIN for an
EIN-only order>" }`. Records the proof, emails it to the customer, then
collects the hold (or charges the saved card if the hold has lapsed).
**Collection happens only after the email provider accepts the proof
email.** If it does not, the route answers 502, nothing is collected, an
ops alert goes out, and `orders.proof_delivery_error` holds the reason.
Calling the route again retries; a proof already delivered is not sent
twice. An EIN-only order gets a completion notice, not the EIN itself.

This email is the filing confirmation, and the only one: the order email
queue does not send it. It is refused for a test-mode order at a real
address, so that order collects nothing.

If the saved card is declined, the route answers 502 with
`status: "saved_card_declined"`, the customer is emailed once to arrange
another way to pay, and ops is alerted. Calling the route again tries the
card again under a new Stripe idempotency key. After an unknown outcome
(network failure, Stripe 5xx) the key stays the same, so a retry cannot
charge twice.

Refused with 409 for a cancelled order and for an order with no filing in
it, before anything is recorded.

Needs `RESEND_API_KEY` and `RESEND_FROM_EMAIL`, and migrations 0021 to 0023
on the database. With either setting missing, nothing is collected.

## `POST /api/orders/:orderId/service-complete` (operator key)

Body: `{ "service_ref": "<the EIN that was issued>" }`. Charges the part of
a formation order that was deferred until the service is complete, to the
saved card, once, and only after the formation part was collected. A decline
is handled as above. `service_ref` is kept on the order and never reaches
Stripe metadata or an ops alert.

## `POST /api/orders/:orderId/cancel` (operator key)

Body: `{ "reason"?: string }`. For a customer who cancels, or a filing that
cannot go ahead. Marks the order cancelled first, stops filing, ends any live
agent link, closes the Deal, releases any hold and emails the customer. A
cancelled order is never filed and its saved card is never charged.
Refused with 409 once the filing is submitted or recorded, and for a paid
order, which is a refund. If the release fails the route answers 502, and
calling it again retries the release alone.

## `POST /api/orders/:orderId/emails/:emailType/resend` (operator key)

Puts a dead-lettered customer email back in the queue with fresh attempts.
The worker decides again from the order as it stands, so a resend cannot
carry stale wording. 409 if nothing of that type is dead-lettered. For the
filing confirmation, call proof of filing again instead.

## Customer's own registered agent

An order that is held or paid, and waiting for the customer's own agent:

- **Accepts:** filing starts, on a held, paid or released order. A released
  hold raises an ops alert, because filing then starts with no hold behind
  it. The saved card is charged after Florida confirms.
- **Declines, or no answer in 7 days:** the customer is emailed, ops is
  alerted and the order stays open. The second case comes from the card-hold
  poller.
- **Customer names another agent:** `POST /registered-agent/select` asks the
  new agent at once and answers `acceptance_email_sent`.
- **Customer switches to Damian:** answers 409 with `required_offer_code`
  unless the 3-year agent service is on a held or paid order.
- **Customer cancels:** see above.

## Saved card

The card-hold poller detaches the saved card once an order closes: paid with
no service charge to come, refunded, or cancelled. Refunds on earlier charges
still work. A failure is retried on the next pass, with one ops alert. The
Stripe key needs write access to PaymentMethods.
