# Gate 2 — Deploy Runbook

Deploys the checkout → payment → webhook → order → PDF chain, plus the
storefront that lets a customer actually start it.

**Branches this deploys**

| Repo | Branch |
|---|---|
| `llc-filing-intake` | `feat/gate2-backend-rebased` |
| `florida-business-launchpad` | `feat/checkout-initiation-catalog-tiers` |

**Stripe mode: TEST.** The Offer Master is seeded with test-mode Price
IDs (`acct_1ChHmZDo01bXdbWS`). Live-mode promotion is separate work — do
not treat a successful run of this runbook as "ready to take real money."

**Evidence standard.** Primary evidence is tiers 1–4 (durable DB record →
Stripe event/session ID → durable order/document/CRM record →
customer-visible artifact). Logs are tier 7: they corroborate a
transaction, they never prove it. Every verification below is written to
produce tier 1–4 evidence.

---

## 0. Preconditions — human-only steps

These require credentials or dashboard access and cannot be automated
from the coding session.

- [ ] Stripe test-mode secret key available (`sk_test_…`)
- [ ] Render dashboard access for `llc-data-spine` (`srv-d9u1ihh42hec739av8og`)
- [ ] Lovable publish access for the frontend
- [ ] Stripe Dashboard access to create a webhook endpoint

**Already done — do not redo:** all 14 migrations (`0001`–`0014`) are
applied to the production database. `offers` exists and is seeded.
Verify with the query in §6.1 if you want to confirm before starting.

---

## 1. Set Render environment variables (BEFORE deploying)

Render auto-deploys on push to `main`. Set these **first**, or the first
deploy will serve 500s on checkout.

Service: `llc-data-spine` → Environment.

| Variable | Value | Consequence if unset |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_…` | `POST /api/checkout/create` fails per call |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` from §2 | Webhook returns 500 on every event |
| `FRONTEND_BASE_URL` | `https://damianknowles.com` | Checkout returns 500 (`server misconfigured`) |
| `PDF_SERVICE_URL` | `https://llc-pdf-generator.onrender.com` | Fulfillment can't render; order parks at `requires_review` |
| `PDF_SERVICE_API_KEY` | (PDF service key) | Same as above |
| `SUNBIZ_PROXY_URL` | `https://sunbiz-proxy.onrender.com/api/sunbiz/check` | Server-side name check unavailable |

Leave `SYNC_POLLER_INTERVAL_MS` and `FULFILLMENT_POLLER_INTERVAL_MS`
unset — both default to 30s. `EIN_EXPRESS_DAILY_CAPACITY` is not needed:
`EIN_FILING_EXPRESS` is seeded `draft`, so it is neither renderable nor
sellable.

`FRONTEND_BASE_URL` must be exactly `https://damianknowles.com` — no
trailing slash, no `www.`. It is concatenated directly into Stripe's
`success_url` / `cancel_url`.

---

## 2. Register the Stripe webhook

Stripe Dashboard → **Test mode** → Developers → Webhooks → Add endpoint.

- **URL:** `https://llc-data-spine.onrender.com/api/webhooks/stripe`
- **Events:** `checkout.session.completed` (minimum). Add
  `checkout.session.expired` if you want abandoned-checkout handling.
- Copy the signing secret (`whsec_…`) into `STRIPE_WEBHOOK_SECRET` from §1.

The path must be `/api/webhooks/stripe` exactly. The handler verifies the
raw body signature and enforces a replay-tolerance window, so a
mismatched secret fails closed rather than silently accepting events.

---

## 3. Deploy the backend

```bash
cd ~/Developer/llc-filing-intake
git checkout main && git pull origin main
git merge feat/gate2-backend-rebased --ff-only
git push origin main
```

Render auto-deploys on push. Watch for `status: live`.

**Merge guard — do not skip.** `main` contains the CORS fix (`fee74e2`).
The branch was rebased onto it and `corsMiddleware` must remain the
**first** `app.use()` in `server/src/index.ts`, ahead of the raw-body
webhook mount. If a conflict ever appears here and gets resolved by
taking the branch side, every browser call from the live site breaks
again at preflight. Confirm after merge:

```bash
grep -n "app.use(" server/src/index.ts | head -3
# expect: app.use(corsMiddleware)  ← first
```

---

## 4. Verify the backend before touching the frontend

```bash
# Route surface — 400 means "present and validating", 404 means "not deployed"
for r in /api/offers /api/checkout/create /api/webhooks/stripe; do
  echo -n "$r -> "; curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST "https://llc-data-spine.onrender.com$r" \
    -H "Content-Type: application/json" -d '{}'
done
# /api/offers is GET-only, so POST 404 there is expected — check it directly:
curl -s https://llc-data-spine.onrender.com/api/offers | head -c 200

# CORS still intact from the live origin
curl -s -D - -o /dev/null -X OPTIONS \
  "https://llc-data-spine.onrender.com/api/session/stage" \
  -H "Origin: https://damianknowles.com" \
  -H "Access-Control-Request-Method: POST" | grep -i "access-control-allow-origin"
# expect: Access-Control-Allow-Origin: https://damianknowles.com
```

Webhook secret sanity — an unsigned POST must be **rejected**, not accepted:

```bash
curl -s -X POST "https://llc-data-spine.onrender.com/api/webhooks/stripe" \
  -H "Content-Type: application/json" -d '{"id":"evt_x"}'
# expect: {"error":"signature verification failed", ...}
# a 500 mentioning STRIPE_WEBHOOK_SECRET means §1 is incomplete
```

Stop here and fix if any of the above is wrong. Do not deploy the
frontend against a broken backend.

---

## 5. Deploy the frontend

```bash
cd ~/florida-business-launchpad
git checkout main && git pull origin main
git merge feat/checkout-initiation-catalog-tiers --ff-only
git push origin main
```

**Then click Publish in Lovable.** Pushing to GitHub does not deploy the
site — this has caught us repeatedly. Confirm the deploy actually
changed:

```bash
curl -sI https://damianknowles.com/ | grep -i x-deployment-id
```

Compare before and after; a changed ID means the publish landed.

---

## 6. The continuous transaction test

One customer, one session, start to finish. Do not skip to the middle.

1. Open `https://damianknowles.com/file-florida-llc` in a clean browser
   profile (no prior `localStorage`).
2. Complete the filing interview end to end. Use an obviously-test name
   (existing convention: `… VERIFICATION …`) and an address you can
   select from the Google Places suggestions — free-typed addresses are
   correctly rejected.
3. Submit. You should land on `/llc-formation-packages`.
4. Confirm prices render: **DIY $134 / FastTrack $499 / Premium $999**.
   If you see "couldn't load current pricing", `/api/offers` isn't
   reachable — go back to §4.
5. Select a tier, optionally an add-on, and confirm the total matches the
   sum shown.
6. Click **Continue to payment**. You should land on Stripe Checkout with
   **the same total**, itemised.
7. Pay with test card `4242 4242 4242 4242`, any future expiry, any CVC.
8. You should return to `/checkout/success?...&order_id=…`, which polls
   until the webhook confirms and then shows "Payment confirmed".

### 6.1 Verification queries (tiers 1–3)

Replace `<SESSION>` with the `filing_session_id` (visible in the return
URL).

```sql
-- Tier 1: the filing session, with the name check actually persisted
select filing_session_id, current_stage, entity_name_primary,
       name_check_results is not null as name_check_persisted,
       email, created_at
from filing_sessions where filing_session_id = '<SESSION>';

-- Tier 3: exactly ONE order, priced by the server
select order_id, product, crm_intent, total_cents, checkout_status,
       payment_status, paid_at, fulfillment_status, line_items
from orders where filing_session_id = '<SESSION>';

-- Tier 2: the Stripe event, recorded and processed exactly once
select id, type, processing_result, order_id, processed_at
from stripe_webhook_events order by processed_at desc limit 5;

-- Tier 3: CRM sync
select id, sync_type, status, attempts, last_error, order_id
from crm_sync_queue where filing_session_id = '<SESSION>';

-- Tier 3/4: the generated document
select document_id, order_id, byte_size, sha256, created_at
from filing_documents where order_id = '<ORDER>';
```

**Pass conditions**

- `orders`: exactly one row; `payment_status = 'paid'`; `paid_at` set;
  `total_cents` equals what Stripe charged **and** what the page showed
- `stripe_webhook_events`: one row for the event, `processed_at` set
- `line_items`: contains `offer_code`, `offer_version`, `stripe_price_id`
  per line — the price snapshot at sale time
- `filing_sessions.name_check_persisted` = `true`

### 6.2 Idempotency (CP12)

In Stripe Dashboard → the event → **Resend**. Then re-run the
`stripe_webhook_events` and `orders` queries.

**Pass:** still exactly one order, `stripe_webhook_events` still one row
for that event id, no second CRM job, no second document. The endpoint
should answer `{"received":true,"duplicate":true}`. Idempotency is
enforced by the event id being the table's primary key, so a duplicate
cannot create duplicate work even under a race.

### 6.3 International customer (Gate 2 P0)

Repeat §6 with a **non-US billing address** and a non-US test card from
Stripe's testing docs. Nothing in the rate limiting or bot protection is
geo-aware, so this should behave identically — confirm it does rather
than assuming.

---

## 7. Rollback

Backend — redeploy the previous commit from the Render dashboard, or:

```bash
cd ~/Developer/llc-filing-intake
git revert --no-edit <merge-commit>
git push origin main
```

`fee74e2` (CORS) is the last known-good backend commit. **Never roll back
past it** — that reintroduces the P0 that broke every submission.

Frontend — revert the merge on `main` and Publish again in Lovable.

Data written during a failed run is additive (`orders`,
`stripe_webhook_events`, `filing_documents`). Nothing needs unwinding to
roll back; delete test rows afterwards for hygiene.

---

## 8. What still will not work after this deploy

State these plainly rather than discovering them mid-test:

- **No email (CP11).** No transactional email provider is wired in any
  deployed code. The customer receives no confirmation email, and the
  registered-agent acceptance flow issues a token and URL that nothing
  delivers. Blocked on provisioning a provider — an infrastructure
  decision, not a coding task.
- **No customer document retrieval (CP10 tier-4).** The PDF is generated
  and stored in `filing_documents`, but no route serves it to the
  customer. Tier 1–3 evidence is available; tier 4 is not.
- **Fulfillment stops at `requires_review`.** The worker generates and
  persists the PDF, then deliberately parks the order rather than
  reporting a fax transmission that didn't happen. This is intentional
  and correct — do not read it as a failure.
- **Live-mode Stripe.** Catalog is test-mode only.
- **À-la-carte add-ons** (Operating Agreement, BOI, Banking) are gone
  from the storefront because no approved offer exists for them. That was
  a deliberate commercial decision, not an omission.

---

## 9. Known live issue unrelated to this deploy

`filing_sessions.payment_status` was removed from the client-settable
whitelist on this branch (Gate 2 P0 security fix), and `syncSession` no
longer creates Deals. Before this deploy, the live endpoint accepted
`payment_status` from any caller and the sync worker would create a real
"paid" Zoho Deal from it. **Deploying this branch closes that hole** —
which is one more reason not to roll back past it once shipped.
