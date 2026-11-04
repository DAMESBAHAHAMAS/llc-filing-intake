# ADR-244 checkout review, 4 Nov 2026

**Status:** fixes on draft branch `claude/checkout-consistency`. Not merged and not deployed.

**Damian's direction (4 Nov):** preserve the four commits, fix the two checkout inconsistencies, test the full payment process, document the results. No retroactive ratification. This document ratifies nothing, and acceptance of the branch is still open.

## Result

- The four commits are preserved. This branch builds on `616468c` and reverts none of them.
- Both inconsistencies are fixed on the branch, with tests.
- The payment process passed end to end in Stripe test mode on an isolated local database. Real email, Zoho, the PDF service and Sunbiz were stand-ins; see "What was not tested".
- **Live checkout is not ready.** Section "Other findings" lists two website defects, and one of them may be affecting customers now.

## The two inconsistencies

**Source:** the record names them, so they were not chosen from the code. They are in the ADR-244 register page, "Addendum: checkout consistency review, November 4, 2026", from bus correlation `cgpt-bfb8c50096035fd127b9`.

### 1. `c54f608`: the Deal documentation did not match the Deal lifecycle

| | |
|---|---|
| **What the record says** | A Deal opens on a verified card hold and closes won after capture, but the comments say "only after verified payment", and the decision text still describes a Deal created at intake. |
| **Confirmed in the code** | Yes. The webhook opens the Deal on the hold, before any money is collected. `DECISIONS.md` 2026-09-17 item 4 still says the Worker creates it at intake. |
| **Effect** | Documentation only. Behaviour was already correct, so no behaviour changed. |
| **Fix** | Corrected the comments in `llc-worker.js`, `zoho/client.ts`, `checkout.ts` and `webhooksStripe.ts`, plus `server/API.md` and the runbook. Appended a superseding `DECISIONS.md` entry; the old entry stays as written (GOVERNANCE rule 11). |
| **Test** | New `server/test/dealLifecycle.test.ts`, and the real sequence below. |

### 2. `db5a162`: no proof reached the customer before capture

| | |
|---|---|
| **What the record says** | The PDF route stores rather than returns a document, and its comments imply a customer link after payment. Under pay-after-acceptance, the customer needs evidence before final capture, and the stated link is not built. |
| **Confirmed in the code** | Yes. `POST /api/orders/:orderId/proof-of-filing` recorded the proof and captured in one request. Nothing told the customer, so the code broke Damian's 29 Sep rule: funds are collected only after proof of filing is delivered. |
| **Effect** | Functional. A customer could be charged with no proof sent to them. |
| **Fix** | The route now emails the Sunbiz document number first, and collects only after Resend accepts it. If that fails, nothing is collected, the route answers 502, an ops alert goes out, and the reason is stored. A repeat call retries and does not send twice. The gate covers the hold capture and the saved-card charge. Adds migration 0021 (numbered 0020 when this review ran). |
| **Not built** | A customer link to the Articles PDF. Its storage and serving target is the open boundary 1 in `DECISIONS.md` (2026-09-09), so the comment now says so instead of implying a link. The proof sent is the Sunbiz document number, which is how the 2026-09-30 decision defines proof. |

**Please check this reading.** The record's wording is "customer-facing acceptance evidence", and the document number by email meets that. If the filed PDF is required as well, boundary 1 must be decided first.

## The commits on real data

The record found no conflict in `436d0bc` or `616468c`, but asked for acceptance evidence. All three checks ran against the real backend and database.

| Commit | Result |
|---|---|
| `436d0bc` agent fee gate | Damian-as-agent without the 3-year service: 422 naming `REGISTERED_AGENT_3YR`. With it: 200, hold, $597. Own agent without it: 200. |
| `616468c` clears own-agent details | After switching own to Damian, the three own-agent fields were absent from the stored record, with path `house` and status `accepted`. |
| `db5a162` PDF route | Returns JSON, never PDF bytes. A repeat call returns `already_generated`. |

## Test results

### Repository suite

| Check | Result |
|---|---|
| `vitest run`, local database | 19 files, 130 tests passed |
| `vitest run`, no database | 17 files loaded, 124 tests passed; the same 2 files cannot load without `DATABASE_URL`, as before this branch |
| Baseline before this branch, no database | 15 files loaded, 101 tests passed |
| `typecheck`, `build` | Pass |
| `npm run verify:prices` (Stripe test) | Pass |
| `llc-worker.js` syntax | Pass |

### Full payment process

**Setup:** this branch running on localhost, in-memory PGlite with migrations 0001 to 0020, Stripe test account `acct_1ChHmZDo01bXdbWS` (`livemode: false`), hosted Checkout with Stripe's test card. Stripe's real test events were relayed to the local webhook with a one-time signing secret, deleted afterwards. No deployed database and no live key were used. No secret is recorded here.

| Scenario | Order | Stripe | Result |
|---|---|---|---|
| Clean sequence | `fcec2f28-8c5c-4392-9741-102641e0319a` | `pi_3UY6ooDo01bXdbWS3OieAMZu` | authorized → filing work on the hold (`requires_review`, order-bound document stored) → proof delivered → captured → paid → refunded Pass |
| Provider down, then retry | `2695f58d-aa6b-4c68-ad90-98bc88a500c2` | `pi_3UY6lBDo01bXdbWS0SeA6dkZ`, `re_3UY6lBDo01bXdbWS0EqZhBEq` | 502 with `requires_capture`, $597.00 still capturable, $0 received, no email. Retry: captured, one email. Paid, then refunded Pass |
| Hold released, then saved card | `aaa528fb-935f-4c09-a9b6-87bc43b377c3` | `pi_3UY6lCDo01bXdbWS1Fqcr6B0` (released), `pi_3UY6oCDo01bXdbWS4iCgoDRX` (fallback, $237.00) | released → with provider down, 502 and no charge → with provider up, saved card charged → paid Pass |
| Abandoned checkout | `0107b445-0caa-4223-84c9-d457c2a63780` | session expired | failed Pass |

**Order of events, clean sequence (UTC):** authorized 16:14:41.0, proof delivered 16:14:43.2, Stripe capture event 16:14:44, paid 16:14:46.1.

**Deal sequence (recording fake using the real worker and `buildDealRecord`):** SERVICE REQUESTED / Hold Placed → Closed Won / Payment Collected → Closed Lost / Refunded. Released hold: stayed SERVICE REQUESTED / Hold Released, then Closed Won after the saved-card charge. Closed Won never preceded collection.

**Controls:** duplicate event `duplicate: true`, no change. Forged signature 400. Stale signature 400. Operator routes without the key 401. Repeat proof before and after payment: no second email.

### What was not tested

| Not tested | Why |
|---|---|
| A real email through Resend | No Resend key locally. A local stub stood in, so the wording and sending path ran but no email was delivered. **"Delivered" in this document means accepted by the stub.** |
| Real Zoho CRM writes | A recording fake stood in. The picklist and field writes were not exercised. |
| The real PDF service | A stub returned placeholder bytes. |
| A real Sunbiz filing | Document numbers were invented test values (`L26000244001`, `L26000244002`, `L26000244004`). |
| A hold that truly expired | A released hold exercised the same saved-card branch. Stripe's own expiry code path was not. |
| An EIN-only order, 3D Secure, a declined or failed saved card | Covered in part by unit tests, not run on Stripe here. |
| Cash App Pay and Klarna | Both appear on the Checkout page. Their hold behaviour is untested. |
| The website pages | The API was driven by script, so the customer's browser journey on the site was not run. |
| The deployed Worker and live database | Out of bounds for this test. Migration 0021 has not been run on the live database. |
| Concurrency | PGlite serialises connections. |

### Side effect to note

Stripe also delivered these test events to the enabled test endpoint on the deployed service (`pending_webhooks: 0`). Those orders do not exist there, so by the code path each event ends as `order_not_found` and is recorded in its events table. No order, payment or Deal changes. That outcome comes from reading the code; the deployed database and logs were not inspected. The 26 Oct run had the same property.

## Other findings

Found during this review and **not changed here**: they are outside the two named items (GOVERNANCE rule 12), and the first three are in the website repository.

| # | Severity | Finding | Evidence | Owner action |
|---|---|---|---|---|
| 1 | **High, may affect customers now** | After `db5a162`, the website still treats the PDF response as a file. It saves the JSON reply as `articles-of-organization-<id>.pdf`, so a customer who completes the interview gets a broken file. | `src/pages/LLCFilingIntake.tsx:1146-1159` on `origin/main`. From reading both sides of the code; not reproduced in a browser, and the published site was not checked against `origin/main`. Depends on PDF generation succeeding in production. | Website: remove the download block. Needs a publish. |
| 2 | **High before live checkout** | The packages page lists the 3-year agent as "Optional" and never reads the agent choice. When online checkout returns, a Damian-as-agent customer who leaves the box unticked gets a 422 the page does not handle. | `src/pages/LLCFormationPackages.tsx`, `src/lib/offerTiers.ts`. Latent today: the page takes no payment. | Website: require and pre-select the line when the agent is Damian. |
| 3 | **Medium** | Assisted drafts use `agentChoice: "us"`, but the intake and backend only accept `"damian"` or `"own"`. A draft that picks Damian maps to `customer`, and `/registered-agent/select` refuses it with 400 unless the customer re-picks the agent on the page. | `src/lib/filing-draft.ts:42`, `src/pages/filing-continue.tsx:29`, `src/lib/canonicalFilingData.ts:55`. From reading the code. | Website: map `us` to `damian` in `draftToIntakePatch`. |
| 4 | Low | The agent check ignores an earlier Premium order, so a later add-on would be refused although Premium includes the agent service. | `server/src/routes/checkout.ts`. Latent: Premium is closed. | Backend. |
| 5 | Low | If a hold is collected before the `held_deal` job has synced, `orders.crm_deal_id` is empty and the Closed Won update is skipped. | `enqueueDealUpdate` in `webhooksStripe.ts`. The poller runs every 30 seconds and filing takes far longer, so this needs an unusually long CRM outage. | Backend. |

## Before this can merge

1. **Merge order with draft PR #7** (`claude/customer-order-emails`). Both change `routes/orders.ts`, and both send a filing email, so merging both unchanged sends the customer two. PR #7's is queued and does not gate collection. The rebase should keep this gate and drop PR #7's `filing_confirmation` send, or make this gate wait on it. The wording here matches PR #7's so that either can stand. `claude/charge-ein-when-issued` touches the same files.
2. **Apply migration 0021 to the live database before deploying.** Render does not run migrations.
3. **Confirm `RESEND_API_KEY` and `RESEND_FROM_EMAIL`** on the service, plus `ORDER_EMAIL_REPLY_TO` unless the From address is a monitored mailbox. Without them nothing can be collected, which is the safe failure.
4. **One real email** to a test address, before the live acceptance run.

## Rollback

Revert this branch's commits, then apply `server/migrations-rollback/0021_orders_proof_delivery.rollback.sql`. The code must go first, because the gate reads those columns. Reverting removes the gate, and capture returns to the previous behaviour.
