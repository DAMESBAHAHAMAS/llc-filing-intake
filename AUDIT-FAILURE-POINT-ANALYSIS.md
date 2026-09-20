# Failure-Point Analysis

**Date:** 2026-09-20
**Scope:** doc §14–§19. Purpose per the source document: identify where the
system fails, whether it recurs, and what control makes it harder to break
— not to assign blame.
**Sources:** this session's own direct work (2026-09-17 through 2026-09-20,
across both repos), plus each repo's own `DECISIONS.md`/commit history where
it documents a failure independently of this session.

---

## List 1 — Observed failures

Plain statements of what happened. No cause assumed, no blame assigned, no
prediction of recurrence — that's List 2's job.

1. Two consecutive Render backend deploys build-failed (`5da5162`, `dd54cfc`) because `@types/node` was too old for `vitest`'s peer requirement.
2. Local verification of that same build passed, using `npm audit fix --force` against an already-resolved `node_modules` that silently tolerated the same conflict Render's clean install hit directly.
3. `STRIPE_WEBHOOK_SECRET` was unset/misconfigured in the production backend, discovered only by directly testing the live webhook endpoint.
4. `RESEND_API_KEY`/`RESEND_FROM_EMAIL` were unset in production, discovered the same way.
5. `PDF_SERVICE_URL` was unset in production, discovered only once the pre-payment PDF endpoint was actually exercised with real data for the first time.
6. `PDF_SERVICE_API_KEY` exists in code on both the calling and receiving services but is not enforced on the live receiving service — confirmed by direct unauthenticated request, not configuration review.
7. `llc-pdf-generator`'s `requirements.txt` pinned `weasyprint` but not `pydyf`; production resolved an incompatible `pydyf` version that crashed every real (non-empty-context) PDF render. This had never been triggered before because nothing had exercised this code path with real data until this session.
8. `canonicalFilingData.ts` (frontend) never produced the field shape `buildPdfContext()` (backend) actually required — every filing's completeness check would have failed regardless of what a customer entered, for as long as this mapping existed, undetected until this session.
9. No test or check anywhere asserted that the frontend's output shape matched the backend's required input shape for filing data.
10. The homepage hero form's original Zoho lead-capture design reported success to the customer regardless of whether Zoho actually accepted the submission.
11. A first attempted fix to (10) introduced a second bug — comparing against the page's own origin rather than the fixed `returnURL`'s origin — which would have made the fix report false failures (and retry, risking duplicate leads) on every non-production origin. Caught before shipping.
12. A second, independent fix to the same lead-capture flow (made by Lovable, concurrently) corrected a case where the first fix's retry logic could itself create duplicate leads on an inconclusive (not confirmed-failed) read.
13. `/resources/florida-llc-formation-guide` (linked from the sitewide footer) shows "Check your inbox" to every user; `handleSubmit` never sends anything anywhere.
14. `/certification-checklist` shows "A copy has been sent to {email}" to every user; the integration point is a commented-out TODO.
15. `/us-gateway`'s two lead forms have real submission code and a real download asset exists, plus a dedicated delivery page exists, but nothing in the code connects form submission to that delivery page.
16. The Readiness Assessment (`/readiness-assessment`) computes a real score client-side and then discards it entirely on tab close — no transmission, no storage, anywhere.
17. The Readiness Assessment's own on-screen consent copy states user data is retained for follow-up; the code retains none of it.
18. The frontend repository (`florida-business-launchpad`) received unplanned, concurrent commits from Lovable's auto-publish mechanism on at least five separate occasions across this session's work, each requiring a fetch/merge/re-verify cycle before this session's own work could be pushed.
19. `crm_deal_id` capture (`POST /api/session/stage`) accepts any client-supplied string, once, with no verification the caller actually owns that Deal.
20. Direct submission to Sunbiz (the stated end goal of the intake workflow) has no implementation — `fulfillment_transmissions`/Telnyx exists as a database schema only; the code that would populate it was never written. Every order, without exception, stops at a `requires_review` state.
21. No administrative or reporting interface exists anywhere in either repository — every verification performed by this session, and (per `DECISIONS.md`) every prior acceptance-testing pass, was a direct production SQL query.
22. Three separate Zoho CRM MCP tools (`getFields`, `getRecords`, `searchRecords`) rejected every attempted parameter shape this session tried against them, with an error indicating a missing path variable regardless of how the parameter was supplied.
23. The Render MCP's `select_workspace` tool required a parameter named `ownerID`, not the `workspaceId` its own surrounding tool family otherwise uses — discovered by trial and error.
24. A Cloudflare `wrangler` OAuth token that had just been used successfully (to create a Pages project) was rejected as unauthenticated on the very next command attempted seconds later.
25. Mid-session, a fresh `wrangler login` was completed against the wrong Cloudflare account, requiring a second login and a re-verification of account identity before any further Cloudflare action could safely proceed.
26. A WorkDrive file-upload MCP tool, given a local file path, wrote the literal path string as the file's content (23 bytes) rather than reading and uploading the file at that path — caught by checking the returned file size, not assumed successful.

---

## List 2 — Quantified failure patterns

| Pattern | Occurrences (from List 1) | Affected capability/workflow | Common condition | Operational consequence | Possible control |
|---|---|---|---|---|---|
| **A — Local/dev verification did not match production reality** | 5 (#1, #3, #4, #5, #7) | Backend deploys; Stripe webhook; email; PDF generation (twice) | In every case, the failure was invisible until the exact production code path was exercised for the first time — none were caught by local testing, code review, or a successful build alone. | Repeated deploy cycles discovered as broken only after the fact; at least two cases (#3, #4) mean real customer-facing capability (payment confirmation, email) was silently non-functional for an unknown prior period. | A deploy-verification step that exercises the *actual* production dependency graph (clean install, no `--force`) and a smoke test hitting each critical external integration post-deploy, before declaring a deploy "done." |
| **B — Silent or false success shown to the customer** | 6 (#10, #13, #14, #15, #16 combined with #17, and #6 as a security-relevant variant) | Hero lead capture (fixed), 3 of 4 audited lead-magnet form instances, the Readiness Assessment | Each instance independently arrived at the same shape: the UI's success/confirmation state is not actually contingent on the underlying operation succeeding. | This is the single most consequential pattern in the entire audit program — it means the count of "leads captured" a human could reasonably believe from using this site is materially higher than the count actually reaching Zoho. | Structural: any UI success state should be driven by a confirmed backend/CRM outcome, not by "the client-side function returned without throwing." Given how often this exact shape recurs across independently-written components, a shared, reusable lead-capture hook with confirmed-outcome semantics (the pattern now built for the hero form) is a stronger control than fixing each instance ad hoc. |
| **C — Unpinned or unverified dependency drift** | 2 (#1/#2, #7) | Backend build; PDF rendering | Neither `package.json`/`requirements.txt` pinned the specific transitive dependency that broke; both were "known good" until an upstream release changed behavior. | Two separate multi-day windows where a core capability was broken in production without detection. | Pin transitive dependencies known to be load-bearing (this session already did this for `pydyf`); a scheduled dependency-audit pass rather than discovering breakage via a live failure. |
| **D — No contract verification between frontend and backend data shapes** | 1 root cause, but the single highest-impact item in this entire analysis (#8, #9) | The entire filing-data pipeline, both pre- and post-payment | The two repos evolved independently with no shared type or test asserting one side's output matches the other's required input. | Every filing, for the entire time this mapping existed, would have silently failed data-completeness validation. This is the most severe single finding across every audit produced this session. | A shared type definition or a contract test run in CI on both repos (or at minimum, one repo importing the other's shape definition) would have caught this at write time rather than requiring a live end-to-end test to surface it. |
| **E — Concurrent, uncoordinated edits to the same repository** | 5+ distinct merge events (#18) | Frontend (`florida-business-launchpad`) exclusively | Lovable's auto-publish commits directly to `main` with no coordination signal to any other concurrent editor. | Repeated but so far non-destructive — each merge was clean and independently re-verified. The risk is latent, not yet realized as data loss. | A designated "hold" window during active engineering sessions, or moving engineering work to a branch merged deliberately rather than working directly on `main` alongside an automated publisher — a real process change, not a code fix. |
| **F — MCP/tooling integration friction** | 5 (#22, #23, #24, #25, #26) | Session tooling only — Zoho CRM MCP, Render MCP, Cloudflare auth, WorkDrive MCP | Each is a distinct, unrelated tool defect or naming inconsistency in third-party/session tooling, not in either application repository. | Time cost and required workarounds within sessions; no customer-facing impact. | Document each as a known tooling gotcha (this document now does); for the WorkDrive upload issue specifically, verify file size/content after every automated upload rather than trusting a success response — already adopted as practice this session. |
| **G — Standing unauthenticated identifiers** | 2 (#19, and the delivery audit's broader finding that every ID in every route is effectively a bearer token) | CRM Deal-stage updates; every route in the backend | Not a discrete "event" like the others — a standing architectural condition rather than a failure that occurred at a point in time. | Currently mitigated in one specific case (Deal-stage updates now verify Contact-email ownership) but open everywhere else. | Listed here for completeness since it's a real, evidenced condition, but it's a security-architecture item, not a "failure recurrence" in the same sense as A–F — treat it as its own workstream rather than folding it into this pattern table's remediation sequencing. |

---

## Known example — GitHub account confusion (doc §18)

I could not independently find or quantify specific instances of this in
either repository's history — a duplicate-account mixup doesn't
necessarily leave a code trace, and I don't have access to whatever
history (if any) would show it directly. I can report what I verified
directly this session: `gh auth status` resolves to a single account
(`DAMESBAHAHAMAS`), which is also the account both existing repos
(`llc-filing-intake`, `florida-business-launchpad`) already live under,
and which you confirmed as authoritative when I flagged the *separate*
Cloudflare-account risk before creating `damianmaknowles-site` this
session. I did not find a second GitHub account referenced anywhere in
either codebase's configuration, CI, or deploy tooling.

**Given I can't independently verify occurrences, I'm not going to
speculate at counts or impact.** If this condition has caused real,
specific incidents you can recall (a wrong-account push, a repo created
in the wrong place, permissions granted to the wrong identity), those
specifics would need to come from you — I can then fold them into this
analysis with the same rigor as everything above. What I can state as a
control regardless of history: `DAMESBAHAHAMAS` is now the one
consistently-verified account across all three repositories this program
touches (including the new `damianmaknowles-site`), which is itself a
step toward the consolidation doc §18 asks for.

---

## Failure reduction — controls worth prioritizing, in order

1. **Pattern B (silent/false success)** — highest customer-facing impact, recurs across independently-written code, and has a known, already-proven fix pattern (the hero form's confirmed-outcome redesign) that could be generalized rather than reinvented per instance.
2. **Pattern D (no frontend/backend contract check)** — lower recurrence count but the single most severe individual finding in the whole program; a structural fix (shared type or contract test) would close an entire class of future bugs, not just this one instance.
3. **Pattern A (local verification vs. production reality)** — a process change (verify against the actual clean production dependency graph, smoke-test post-deploy) rather than a code change, addressable without new engineering scope.
4. **Pattern C (dependency pinning)** — narrow, already half-addressed (this session's own `pydyf` fix); a scheduled audit pass is enough, doesn't need dedicated project time.
5. **Pattern E (concurrent edits)** — a process/workflow decision for Damian, not an engineering fix.
6. **Pattern F (tooling friction)** — already addressed by documenting it; no further action needed unless a specific tool is chosen for repeated future use.
7. **Pattern G (unauthenticated identifiers)** — real, but architecturally larger than a quick control; recommend scoping as its own dedicated security workstream rather than sequencing it against the others above.
