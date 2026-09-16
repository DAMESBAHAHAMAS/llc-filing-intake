# Gate 2 — Zoho CRM Connectivity Re-Validation Status

Pure connectivity/permissions verification, run in the exact order specified. **No application
code was modified** — no file in this repo or the frontend repo was touched. Nothing committed,
pushed, or deployed. All operations performed directly against the live Zoho CRM API via the
connected Zoho MCP tools (not through the application's own `zoho/client.ts`, which this task
was explicitly told not to touch).

## Result: All 10 steps passed. No STOP condition was hit.

## 1. Organization Test — `getOrganization`

**Passed.**

| Field | Value |
|---|---|
| Company | Damian Knowles |
| Org ID | `2654294000000020005` |
| Primary email | `damian@damianknowles.com` |
| Subscription paid | `true` |
| Plan | `zohooneenterprise` |
| Paid expiry | `2026-09-27T20:00:00-04:00` |
| Users licensed | 2 |

Confirms the exact claim this task set out to verify: **Zoho One subscription is active**, not
expired — a live, current, paid Enterprise license, ~1 month from its next renewal date.

## 2. Modules Test — `getModules`, `getFields`

**Passed.**

`getModules` returned 117 modules. `Deals` module confirmed: `api_supported: true`,
`creatable: true`, `editable: true`, `deletable: true`, `viewable: true`.

`getFields` for `Deals` returned 42 fields, including the standard fields the application's
Deal-creation code path (`zoho/client.ts`, currently dormant — see §8) would need:
`Deal_Name` (text), `Stage` (picklist), `Amount` (currency), `Closing_Date` (date), `Pipeline`
(picklist, mandatory — see §8 for why this mattered). Also present: a custom field
`filing_session_id` already exists on the Deals module (currently unused by any live code path,
but confirms the module has already been prepared for this application's data model).

One tool-schema note, not a connectivity problem: `getModules`' exposed `status` filter
documented `active`/`inactive`/`all`, but Zoho's live API only accepts
`visible`/`user_hidden`/`system_hidden`/`scheduled_for_deletion` — a mismatch in the MCP tool's
own parameter description, not an authentication or permission issue (the call succeeded
immediately once corrected to `visible`).

## 3. Deals Read Test — `getRecords`, `getRecord`

**Passed.**

`getRecords` on `Deals` (3-record sample, sorted by `Created_Time` desc) returned successfully:
1 existing Deal in the entire org (`TEST — DELETE 3.9.4 LLC — Standard — LLC Filing + EIN +
Operating Agreement ($349)`, created 2026-07-12 — an earlier, unrelated test record, read but not
modified or touched by this task). `getRecord` on that same id returned full field detail
successfully.

## 4. Deals Create Test — `createRecords`

**Passed, after resolving a real Stage/Pipeline mapping constraint (documented, not a
connectivity failure — see §8).**

Created exactly one record, clearly labeled:

```
Deal_Name:    GATE2 CRM CONNECTIVITY TEST — SAFE TO DELETE — 2026-08-28
Stage:        Closed Lost
Pipeline:     Standard (Standard)
Amount:       1
Closing_Date: 2026-09-04
id:           2654294000038557001
```

No production or customer Deal was created — this record's name, and the deliberately-chosen
`Closed Lost` stage, made it unambiguous as a disposable test record and minimized any chance of
triggering revenue-reporting or fulfillment-oriented automation while it briefly existed.

## 5. Deals Update Test — `updateRecord`

**Passed.** Updated `Amount: 1 → 2` and set a `Description` explaining the record's purpose.
Read back (`getRecord`) confirmed both changes applied, `Modified_Time` advanced.

## 6. Cleanup Result — `deleteRecord`

**Passed.** Deleted `2654294000038557001`. Verified with a follow-up `getRecord` on the same id,
which returned an empty result — the test Deal no longer exists. **No trace of this task's test
record remains in the CRM.**

## 7. OAuth/Permission Result

**Sufficient for read and write on Deals**, confirmed by direct exercise of every operation:
organization-level read, module/field metadata read, record list read, record detail read,
record create, record update, record delete — every one succeeded end to end. No `401`, no
`INVALID_TOKEN`, no permission-denied response was encountered at any point in this sequence.

## 8. Findings Worth Flagging (discovered, not fixed — no application code was touched)

1. **A real Stage/Pipeline data-integrity issue, directly relevant to the application's dormant
   Deal-creation code.** Zoho enforces that a Deal's `Stage` value must belong to whichever
   `Pipeline` is set — most combinations tried failed with `MAPPING_MISMATCH` ("Pipeline doesn't
   contain the Stage"), including combinations built from values that appear valid in the
   module's own field/layout metadata (e.g. `Pipeline: "LLC Formation"` + `Stage: "Offer Referral
   Opportunity"`, both individually present in the `Deals` layout's picklists, were rejected
   together). Only `Pipeline: "Standard (Standard)"` + `Stage: "Closed Lost"` succeeded in
   testing.
   **Concretely actionable:** `zoho/client.ts`'s Deal-creation code (currently unreachable —
   `isVerifiedPaidSnapshot` requires a `verified_paid` flag no live caller sets, per
   `GATE2-PAYMENT-AUTHORITY-STATUS.md`) hardcodes `Stage: "Payment Received"`. **That exact string
   does not exist anywhere in this org's live `Stage` picklist** (confirmed by searching the full
   42-field metadata dump) — the closest real values are `"Payment Details"`,
   `"PAYMENT CONFIRMATION"`, and `"PAYMENT EXECUTED"`. If that dormant code path is ever
   reactivated as-is, it will fail against the real Zoho org with the same `MAPPING_MISMATCH` (or
   an invalid-picklist-value error) encountered repeatedly during this test — not because of a
   permissions problem, but because the hardcoded stage name doesn't match this org's actual
   configuration. This is a data/config finding, reported per this task's instructions, not
   corrected — application CRM code was explicitly off-limits this task.
2. **Zoho's Deal-Pipeline/Stage mapping is not fully exposed through the metadata APIs used
   here** (`getFields`, `getLayouts`, `getLayoutById`) — the returned picklists look like a
   superset across all pipelines rather than a per-pipeline filtered list, so the only reliable
   way to confirm a valid combination was live trial. Worth keeping in mind for whoever next
   builds real Deal-creation logic: verify the exact intended `(Pipeline, Stage)` pair against a
   live create call before shipping, rather than trusting the metadata read alone.
3. Everything else about the org (organization status, module/field access, Leads-adjacent
   permissions implied by the same OAuth scope that made Deals fully readable/writable) checks
   out cleanly — no other irregularities encountered.

## Remaining Blockers

1. **§8.1 above** — `zoho/client.ts`'s hardcoded `Stage: "Payment Received"` will not work
   against the live org as written, whenever that dormant Deal-creation path is eventually
   reactivated. Needs a real Stage/Pipeline decision from whoever owns the CRM configuration
   before that code path is turned on — not something to guess at without touching application
   code (explicitly out of scope this task).
2. **Leads module was not directly exercised in this task** (only `Deals`, per this task's exact
   10-step spec) — the OAuth connection and CRM API reachability proven here apply broadly (same
   token, same API), but Leads-specific field/permission specifics weren't individually
   re-verified. Low risk given everything else passed cleanly, but noted for completeness rather
   than assumed.
3. Unrelated, unchanged from prior reports: CRM Deal-at-checkout is still not built; `orders.crm_deal_id`
   stays `NULL`; no code change was made or needed in this task to any of that.
