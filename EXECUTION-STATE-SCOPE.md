# Execution-State Scope & Draft Scheduling Report

**Date:** 2026-09-20 · doc §9, §12
**Status:** DRAFT — written, not yet reviewed/submitted/approved/ratified.

This synthesizes every audit produced 2026-09-20 (`AUDIT-LLC-INTAKE-TECHNOLOGY.md`,
`AUDIT-LLC-DELIVERY-SYSTEM.md`, `AUDIT-LLC-INTAKE-CHECKPOINTS.md`,
`AUDIT-PDF-PRE-PAYMENT-CONTROL.md`, the two lead-magnet audits, and
`AUDIT-FAILURE-POINT-ANALYSIS.md`) into a sequenced capability list.

**What I'm deliberately not doing here:** assigning start/end dates or final
priority ordering. Doc §10 states plainly that Business Operations owns
scheduling — that's a real decision with tradeoffs only you can weigh
(what else is competing for the time, what's actually urgent to the
business right now, what you're willing to defer). I'm providing the
dependency-ordered structure that makes those decisions possible to make
quickly; filling in dates against it is the one part of this document I'm
handing back to you rather than drafting myself.

---

## Capabilities, in dependency order

### Group 1 — No dependencies, independently startable

**1a. Fix false-success confirmation copy (3 instances)**
- Definition: `/resources/florida-llc-formation-guide`, `/certification-checklist`, and the Readiness Assessment's consent text — stop claiming delivery/retention that doesn't happen.
- Why first: highest customer-facing/brand-trust impact of anything found (Pattern B, brand audit), and the fix for the *copy* itself requires no new integration work — can ship independent of deciding whether/how to build real submission.
- Definition of done: no UI state anywhere in the funnel asserts an outcome the code hasn't actually achieved.
- Evidence of completion: a pass re-reading every confirmation/consent string against its actual code path (the same method these audits used).

**1b. Wire `/us-gateway` to its own existing delivery page**
- Definition: on successful submission, redirect to `FormationGuideThankYou.tsx` (already built, already has the real PDF link).
- Dependency: none — the real download asset and the real page both already exist; this is a connection, not new construction.
- Definition of done: a form submission on `/us-gateway` results in the customer actually seeing/receiving the guide.
- Evidence: a live test submission, verified by screenshot/network trace, same standard as this session's PDF acceptance test.

**1c. Verify `llc-pdf-generator`'s `/generate-pdf` under the shared-secret key**
- Definition: confirm whether `PDF_SERVICE_API_KEY` is *supposed* to be set now that its absence has been surfaced (currently unauthenticated by deliberate, logged decision — worth a explicit go/no-go rather than leaving it open indefinitely by default).
- Dependency: none technically; a decision dependency on you.

### Group 2 — Depends on a decision, not on other engineering work

**2a. Decide the fate of `/resources/florida-llc-formation-guide` and `/certification-checklist`**
- Options: wire real Zoho submission (lowest-new-risk path: mirror the hero form's now-proven Web-to-Lead iframe pattern), or remove/relabel as not-yet-available.
- This has to be decided before engineering time is spent, since "build real submission" and "remove the broken form" are very different amounts of work.

**2b. Decide whether the Readiness Assessment gets real submission**
- The scoring engine already works client-side — the remaining work is transmission, not logic. Same Zoho-pattern option as 2a applies.

### Group 3 — Depends on Track A (OAuth/WorkDrive), currently blocked externally

**3a. Zoho WorkDrive OAuth credentials for the backend** — blocked on `damianmaknowles-site`#1 (IONOS DNS), tracked there, reviewed each pass per your standing instruction not to stall on it.

**3b. SA4-T464 — automated pre-payment PDF delivery to WorkDrive** — depends entirely on 3a. Code design already scoped (this session); not yet written, since it would be untestable without real credentials.

**3c. Internal-reviewer delivery** (the other, still-unbuilt half of the original PDF pre-payment requirement) — could piggyback on 3b's infrastructure once it exists, or be built independently and sooner if internal visibility matters more than the WorkDrive archival specifically. Worth deciding which one you actually need first.

### Group 4 — Larger, structural, no hard blocker but real scope

**4a. Frontend/backend contract check for `filing_data`**
- The single highest-severity finding in the whole program (Pattern D). A shared type definition or a lightweight contract test would prevent this exact class of bug from recurring silently.
- Dependency: none, but touches both repos.

**4b. Some minimal administrative visibility**
- Currently zero — every check on this entire system, by anyone, has always been a direct SQL query. Doesn't need to be elaborate to be a real improvement over nothing.

**4c. Direct Sunbiz submission (Telnyx fax integration)**
- The largest single piece of genuinely new engineering in this list — `fulfillment_transmissions` schema exists, the code calling Telnyx does not. Every order today stops at `requires_review` regardless of anything else on this list.
- Worth an explicit decision: is manual review-and-file an acceptable permanent operating model, or is this automation actually required? That's a business decision this audit surfaces but doesn't answer.

**4d. Unauthenticated-identifier hardening** (`crm_deal_id` capture, and the broader pattern across every route)
- Scoped in the Failure-Point Analysis as its own workstream, not bundled with the others — real, but architecturally bigger than a quick fix.

---

## Suggested review/approval flow (per doc §20)

For each capability above, before implementation begins:
1. **Review** — does the definition above hold up, are there dependencies I missed, does anything contradict another item on this list.
2. **Second review** — implementation readiness: does it need a decision from you first (Group 2), is it blocked (Group 3), or is it startable now (Group 1, most of Group 4).
3. **Your approval** — which items, in what order, by when.
4. **Ratified** — I update this document to reflect the approved sequence and dates, and it becomes the actual schedule I execute against and report progress on.

## What I need from you to turn this into the actual Scheduling Report

Per doc §12's own required fields, the piece only you can supply is: start
date, end date, and priority ordering across the groups above (everything
else — dependencies, sequence within a decision, definition of done,
evidence required — is already in this document). Tell me the ordering and
dates you want, or tell me to propose dates myself if you'd rather I take
a first pass at that too — I held back from inventing them unprompted
rather than assume which you'd prefer.
