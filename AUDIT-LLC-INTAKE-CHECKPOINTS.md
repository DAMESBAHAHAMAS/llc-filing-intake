# LLC Intake — Checkpoint and Failure Audit

**Date:** 2026-09-20
**Scope:** doc §5. Establishes the authoritative checkpoint structure for
the current intake workflow and documents each checkpoint's failure modes.

**On the "12 vs 15 checkpoints" question:** I do not have access to
whatever prior document(s) identified 12 or 15 — they aren't in either
repo. Rather than guess which count was "right," this audit derives its
own checkpoint structure directly from the current, actual, deployed
workflow (verified this session end-to-end via a live production test).
It lands on **15**, which may or may not match either prior figure
coincidentally — treat this as independently derived, not a reconciliation
of the earlier counts.

Each checkpoint uses the 8-field structure the source document specifies.

---

## CP1 — Hero lead capture

1. **Required outcome:** name/email/phone captured, delivered to Zoho as a Lead, and carried forward into the filing form's local state.
2. **Potential failure points:** Zoho rejects the submission (invalid org/form config, required field missing); the hidden-iframe POST never completes (network failure); the browser's own carry-forward (`localStorage`) fails or is cleared.
3. **Indication of failure:** none visible to the customer by design — the form always advances regardless of Zoho's outcome. This is deliberate, not an oversight.
4. **Method for verifying failure:** the iframe's post-load same-origin readability against `returnURL` (fixed 2026-09-18 to compare against `returnURL`'s own origin, not the page's) is the only signal; a `console.warn`/`console.error` is the only durable trace, and only if a dev tool is watching in that exact session.
5. **Resolution procedure:** none automated. A dropped Lead today is simply lost — there is no retry queue reachable from the browser.
6. **Recommended redundancy/fallback:** none exists. A server-side capture path (the customer's data is already durably persisted at CP6 regardless) would make this checkpoint's failure inconsequential rather than silent.
7. **Owner:** Frontend (`florida-business-launchpad`, `HeroFormCard`).

## CP2 — Name availability check (Sunbiz)

1. **Required outcome:** the proposed name is checked against Sunbiz's live registry; the customer sees an availability signal (likely available / similar names found).
2. **Potential failure points:** `sunbiz-proxy` (a separate Render service) is down or slow; the underlying Sunbiz source itself is unreachable.
3. **Indication of failure:** the UI has an explicit `checking`/`error` state (`NameSearchErrorCard`) with retry — this checkpoint fails loudly to the customer, unlike CP1.
4. **Method for verifying failure:** direct HTTP check against `sunbiz-proxy`'s own health/behavior; this session's earlier audits could not independently re-verify this specific service due to sandbox network policy (noted in `DECISIONS.md`, 2026-09-09).
5. **Resolution procedure:** customer-initiated retry via the UI's own retry affordance.
6. **Recommended redundancy/fallback:** the "Request Manual Review From Damian" path (confirmed live this session) already functions as a fallback when automated name-checking can't resolve — this is a real, working redundancy, not a gap.
7. **Owner:** Backend (`routes/nameCheck.ts`) + external (`sunbiz-proxy`).

## CP3 — Address verification (Google Places)

1. **Required outcome:** principal (and, if different, mailing) address selected from a real Google Places suggestion, not free-typed.
2. **Potential failure points:** Google Places API quota/outage; a real address Google doesn't resolve well (rare edge case, not tested).
3. **Indication of failure:** the UI blocks progression with an explicit warning ("select a verified address") — confirmed directly this session.
4. **Method for verifying failure:** UI state is directly observable; no server-side record of *why* a customer abandoned here if they did.
5. **Resolution procedure:** customer must select a suggestion; no bypass exists.
6. **Recommended redundancy/fallback:** none if Google Places itself is down — the form would hard-block every customer simultaneously with no fallback path. Worth flagging as a single-point-of-failure risk, not yet mitigated.
7. **Owner:** Frontend (`LLCFilingIntake.tsx`, Article II step).

## CP4 — Registered agent selection

1. **Required outcome:** house (server-stamped identity) or third-party agent recorded; for third-party, full contact/address captured.
2. **Potential failure points:** none client-side beyond standard field validation; the real risk is downstream (CP7/CP13), not here.
3. **Indication of failure:** N/A — this step is low-risk by design.
4. **Method for verifying failure:** N/A.
5. **Resolution procedure:** N/A.
6. **Recommended redundancy/fallback:** N/A.
7. **Owner:** Frontend.

## CP5 — Authorized persons / management structure

1. **Required outcome:** at least one authorized person captured with name, address, and Article IV title (AMBR/MGR), correctly selected from `members` or `managers` based on management structure.
2. **Potential failure points:** **this exact mapping was broken until 2026-09-18** — `canonicalFilingData.ts` never combined these fields into the shape the backend actually required, so every filing looked incomplete regardless of input. This is the single highest-impact failure found in this entire audit process, and it was silent (no error surfaced to the customer or to any log until PDF generation was actually attempted).
3. **Indication of failure:** before the fix, none visible at this checkpoint at all — the failure only surfaced three checkpoints later, at PDF generation (CP9/CP14), as a 422 "filing data incomplete."
4. **Method for verifying failure:** direct inspection of `filing_sessions.filing_data` against `FilingSessionRecord`'s required shape — this is how the bug was actually found, not by testing this checkpoint in isolation.
5. **Resolution procedure:** fixed (`DECISIONS.md`, 2026-09-18). No monitoring exists to catch a regression of the same class other than another manual end-to-end test.
6. **Recommended redundancy/fallback:** a contract test asserting `buildCanonicalFilingData()`'s output shape against `buildPdfContext()`'s required fields would have caught this before it ever reached production. None exists today.
7. **Owner:** Frontend (`canonicalFilingData.ts`) writes it; Backend (`pdf/context.ts`) is the only thing that would ever have detected it, and only at CP9/CP14, not at capture time.

## CP6 — Filing interview completion → durable persistence

1. **Required outcome:** `POST /api/session/stage` (stage=complete) succeeds; `filing_data` is durably written to Postgres.
2. **Potential failure points:** network failure; backend down; a rejected write (though the whitelist model means a malformed field is silently dropped, not rejected — see CP5).
3. **Indication of failure:** explicit — the UI shows `setSubmitErr` and does not advance, does not clear local state, and does not touch CRM, on failure.
4. **Method for verifying failure:** `filing_sessions` row existence/`current_stage` value is directly queryable.
5. **Resolution procedure:** customer-initiated retry (their data is still in `IntakeContext`, nothing is lost client-side).
6. **Recommended redundancy/fallback:** already reasonably robust — persistence is required (not best-effort) before anything else proceeds, which is the correct design.
7. **Owner:** Backend (`routes/session.ts`).

## CP7 — Registered agent durable selection

1. **Required outcome:** `POST /registered-agent/select` succeeds; for third-party agents, the acceptance workflow is initiated.
2. **Potential failure points:** validation errors surfaced by the backend; network failure.
3. **Indication of failure:** explicit, blocking — this call is required, not best-effort, and checkout cannot proceed without it succeeding.
4. **Method for verifying failure:** `registered_agent_acceptances`/`filing_sessions.registered_agent_status` directly queryable.
5. **Resolution procedure:** customer-initiated retry.
6. **Recommended redundancy/fallback:** none needed beyond what exists — this is a correctly hard-gated checkpoint.
7. **Owner:** Backend (`routes/registeredAgent.ts`).

## CP8 — Name Review resolution

1. **Required outcome:** any Sunbiz similar-name conflict is either resolved (alternate name chosen, checked clean) or explicitly routed to manual review before the customer can continue.
2. **Potential failure points:** the customer could theoretically get stuck if neither an alternate name nor "Request Manual Review" is used — confirmed live this session that the UI explicitly blocks continuation until one path is taken ("Please confirm the name you would like to file before continuing").
3. **Indication of failure:** explicit, blocking.
4. **Method for verifying failure:** `filing_sessions.name_check_results`/`nameCheckStatus` directly queryable.
5. **Resolution procedure:** built-in — customer picks an alternate or requests manual review.
6. **Recommended redundancy/fallback:** already has one (manual review) — functioning correctly.
7. **Owner:** Frontend + Backend jointly.

## CP9 — Pre-payment PDF generation

1. **Required outcome:** `POST /api/filing-session/:id/pdf` returns a valid PDF matching the submitted data, stored as `filing_documents` (`order_id IS NULL`).
2. **Potential failure points, all previously encountered and fixed this session:** (a) filing_data shape mismatch (CP5) → 422; (b) `PDF_SERVICE_URL` unset on the caller → 502; (c) `pydyf` version incompatibility crashing WeasyPrint on real (non-empty) data → 502. All three were hit, in sequence, during this system's actual first real end-to-end exercise of this path.
3. **Indication of failure:** explicit — the endpoint returns a structured error (422 with missing fields, or 502 with the upstream detail); the frontend logs it via `console.error` and does not block checkout (by design, per the requirement this was built against).
4. **Method for verifying failure:** direct HTTP testing against the live endpoint; Render's own service logs for the 502 cases (this is how the `pydyf` root cause was actually found — reading the real traceback, not guessing).
5. **Resolution procedure:** all three known failure modes are now fixed and verified with runtime evidence (Gate 2 runbook §6.4).
6. **Recommended redundancy/fallback:** none exists if `llc-pdf-generator` itself is down — no queue/retry, just a logged failure. Given this is best-effort by design (never blocks checkout), that's a defensible tradeoff, not necessarily a gap to close.
7. **Owner:** Backend (`routes/filingDocument.ts`) + external (`llc-pdf-generator`).

## CP10 — CRM sync (Lead/Deal)

1. **Required outcome:** the Cloudflare Worker creates a Zoho Deal at intake completion; `crm_deal_id` is captured onto the session.
2. **Potential failure points:** Worker unreachable; Zoho API failure; the `crm_deal_id` capture itself is unauthenticated (any client-supplied string is accepted once) — a real, previously-logged trust gap, not new here.
3. **Indication of failure:** best-effort, logged via `console.error`, never blocks the customer.
4. **Method for verifying failure:** `crm_sync_queue` status/`last_error` directly queryable (for backend-side sync); the Worker's own behavior is not independently auditable from either repo (source unavailable).
5. **Resolution procedure:** `crm_sync_queue`'s own backoff/dead-letter for backend-originated syncs; nothing automated for the Worker's own call.
6. **Recommended redundancy/fallback:** already has one for the backend-side path (the queue); the Worker-side call has none.
7. **Owner:** External (Cloudflare Worker, unaudited) + Backend (`sync/worker.ts`) for downstream syncs.

## CP11 — Package/add-on selection & checkout initiation

1. **Required outcome:** customer selects a package (DIY/FastTrack/Premium) + optional add-ons; server-defined pricing (`GET /api/offers`) is what's actually charged, never client-supplied.
2. **Potential failure points:** `/api/offers` unreachable → "couldn't load current pricing" (per the deploy runbook's own stated failure mode).
3. **Indication of failure:** explicit to the customer.
4. **Method for verifying failure:** direct HTTP check against the endpoint.
5. **Resolution procedure:** none beyond the backend recovering; no client-side retry/backoff observed.
6. **Recommended redundancy/fallback:** none needed beyond backend uptime — the design (server-priced, not client-priced) is already the correct control here.
7. **Owner:** Backend (`routes/offers.ts`) + Frontend.

## CP12 — Payment (Stripe Checkout + webhook confirmation)

1. **Required outcome:** Stripe Checkout completes; the webhook is received, signature-verified, and the order is durably marked paid exactly once.
2. **Potential failure points:** `STRIPE_WEBHOOK_SECRET` misconfiguration (confirmed unset/misconfigured in production during earlier live testing this session — a currently open, human-controlled configuration item, not a code defect); webhook redelivery.
3. **Indication of failure:** a misconfigured secret produces a clear 500 naming the exact problem (`server misconfigured: STRIPE_WEBHOOK_SECRET not set`) rather than a silent failure — this was how the gap was originally found.
4. **Method for verifying failure:** direct unsigned-webhook HTTP test against the live endpoint (already performed, documented in this repo's history).
5. **Resolution procedure:** configuration action on Render — outside engineering's ability to self-resolve.
6. **Recommended redundancy/fallback:** `stripe_webhook_events`'s event-ID-as-primary-key design already makes redelivery safe (idempotent) — that part is solid. The open item is purely the missing secret, not the mechanism.
7. **Owner:** Backend (`routes/webhooksStripe.ts`) + Damian (Render env var configuration).

## CP13 — Fulfillment gate (registered-agent acceptance requirement)

1. **Required outcome:** for a third-party registered agent, `fulfillment_status` cannot reach `ready` until that agent has actually accepted — confirmed via `registered_agent_status`.
2. **Potential failure points:** the acceptance email itself depends on `RESEND_API_KEY`/`RESEND_FROM_EMAIL` (confirmed unset/unconfirmed in production as of the last live check) — without it, a third-party agent is never notified and can never accept, so the order is durably stuck, correctly, rather than incorrectly proceeding.
3. **Indication of failure:** `registered_agent_status` records `email_failed` rather than pretending success — an honest failure state, not a silent one.
4. **Method for verifying failure:** direct query of `registered_agent_status`/`registered_agent_acceptances`.
5. **Resolution procedure:** configuration action (Resend account/domain provisioning) — outside engineering's ability to self-resolve.
6. **Recommended redundancy/fallback:** none needed — the gate correctly fails closed (blocks fulfillment) rather than failing open (proceeding without real acceptance).
7. **Owner:** Backend (`routes/webhooksStripe.ts`, `registeredAgent/acceptanceEmail.ts`) + Damian (Resend configuration).

## CP14 — Post-payment PDF generation & persistence

1. **Required outcome:** `fulfillmentWorker.ts` generates the final PDF and persists it (`filing_documents`, `order_id NOT NULL`).
2. **Potential failure points:** identical class of failure as CP9 (same `buildPdfContext`/`generateArticlesOfOrganizationPdf` machinery) — now fixed for the same underlying reasons, though this specific post-payment path was not independently re-tested end-to-end this session (only the pre-payment path was live-tested with a real Stripe-free run; a real paid order was not run through fulfillment as part of this audit).
3. **Indication of failure:** `fulfillment_status = 'requires_review'` with `fulfillment_last_error` populated — a completeness gap is deliberately *not* retried on a timer (it needs new data, not time).
4. **Method for verifying failure:** `orders.fulfillment_status`/`fulfillment_last_error` directly queryable.
5. **Resolution procedure:** none automated for a data-completeness gap; a transient PDF-service failure does retry on backoff.
6. **Recommended redundancy/fallback:** given CP9 and CP14 share the same underlying bug classes and CP9 has now been proven live, a real paid-order test through fulfillment would close the remaining gap in confidence here — recommended as a near-term follow-up, not yet performed.
7. **Owner:** Backend (`fulfillment/fulfillmentWorker.ts`).

## CP15 — State submission (Sunbiz) — **not built**

1. **Required outcome (intended, not current):** the completed, reviewed Articles of Organization is actually transmitted to the Florida Division of Corporations.
2. **Potential failure points:** N/A — there is no code path to fail. `fulfillment_transmissions` (fax via Telnyx) exists as a table schema only; nothing ever writes to it.
3. **Indication of failure:** every order, without exception, stops at `requires_review` — this is not a failure state, it's the system's actual current ceiling.
4. **Method for verifying failure:** confirmed by reading `fulfillmentWorker.ts` directly — it returns after persisting the document, never calling any transmission provider.
5. **Resolution procedure:** N/A — requires new engineering work (Telnyx integration) plus a real operational decision about who reviews `requires_review` orders today and how.
6. **Recommended redundancy/fallback:** N/A until the primary path exists.
7. **Owner:** Unbuilt — no current owner.

---

## Summary

Of 15 checkpoints, **one (CP15) has no implementation at all**, and the
customer-facing steps before it are, as of this session's own work, in
their best-evidenced state to date — CP5 and CP9 were both real, silent,
previously-undetected failures affecting *every* filing, found and fixed
in the same session that also produced the first genuine end-to-end proof
this pipeline can work. CP14 shares CP9's exact bug history but has not
yet had the same live re-verification — that's the most concrete,
narrowly-scoped next technical step this audit surfaces, separate from
the larger CP15 gap.
