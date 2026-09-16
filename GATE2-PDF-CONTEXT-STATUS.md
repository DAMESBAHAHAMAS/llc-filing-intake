# Gate 2 — PDF Context Pipeline Status

Scope: `filing session data → canonical PDF context → /generate-pdf → render_pdf.py →
articles_of_organization.html.j2 → WeasyPrint → PDF`. No Stripe, webhook, fax, or Zoho
Sign code touched. Nothing committed, pushed, or deployed — this is a working-tree-only
change, on two new local branches (see "Branches" below).

## 1. Template Variable Contract (§5)

Extracted directly from `templates/articles_of_organization.html.j2` — every `{{ }}` and
loop variable in the file, no guessing:

| Variable | Required? | Source |
|---|---|---|
| `llc_name` | Required | Direct mapping from `llc_name` |
| `principal_address` | Required | Composed from `principal_street/city/state/zip/country` |
| `mailing_address` | Required | Composed — see §4 mailing-address rule below |
| `registered_agent_name` | Required | Direct mapping from `agent_name` |
| `registered_agent_florida_address` | Required | Composed from `agent_street/unit/city/state/zip` |
| `authorized_persons` (list) | Required, ≥1 entry | Composed — see Article IV below |
| `authorized_persons[].article_iv_title` | Required per person | Direct mapping — must already be `"AMBR"`/`"MGR"` on the record |
| `authorized_persons[].name` | Required per person | Direct mapping |
| `authorized_persons[].address` | Required per person | Composed from that person's street/city/state/zip |
| `effective_date_option` | Required | Mapped from the funnel's value — see §3 |
| `effective_date` | Required only when `effective_date_option != "Immediate"` | Direct mapping |
| `annual_report_due_date` | Required only when `effective_date_option != "Immediate"` | **Calculated**, never customer-entered — see §4 |
| `other_provisions` | **Optional** — template's own `{% if %}` falls back to "No other provisions." | Direct mapping, empty string is valid |

**Not a template variable at all**, despite appearing in the file as `{{zs_agent_signature}}` etc.:
`zs_agent_signature`, `zs_agent_printed_name`, `zs_authorized_signature`,
`zs_authorized_printed_name`, `zs_date_signed`. These are Jinja **string literals**
(`{{ '{{zs_agent_signature}}' }}`) that print themselves verbatim for Zoho Sign's text-tag
scanner to find later — Jinja never substitutes them. The composer must never provide
values for these and does not.

**Discrepancy found and not fabricated around:** the task's own outline (§4) lists "filing
signer information" as a direct mapping this composer should handle. There is no
`signer_name`/`signer_title`/equivalent variable anywhere in the template — the signature
section is filled entirely by the Zoho Sign anchors above, post-render. `FilingSessionRecord`
carries `signer_name`/`representative_role` for shape-completeness with the funnel's actual
payload, but the composer intentionally does not read or emit them — there is nothing in
the template contract for them to satisfy.

**No required value can be silently stubbed**: `render_pdf.py`'s Jinja2 `Environment` is
built without `StrictUndefined`, so a missing key renders as a blank space, not an error.
The composer (`required()`, `composeAuthorizedPersons`) is the only backstop against that —
it throws on any missing required field instead of letting Jinja swallow it.

## 2. Frontend Fixes (florida-business-launchpad, working tree, uncommitted)

**Article IV role loss** — [IntakeContext.tsx](../florida-business-launchpad/src/context/IntakeContext.tsx):
added `article_iv_title: "AMBR" | "MGR"` to `PersonCard`. [LLCFilingIntake.tsx](../florida-business-launchpad/src/pages/LLCFilingIntake.tsx):
`addMember()`/`addManager()` now tag every person with the correct title **at creation**,
whether they land on the main form or overflow into `additionalAuthorizedPersons` — the
title is a property of the person record now, never inferred from which array it sits in.
`updateMember`/`updateManager`/`fillFromApplicant`/etc. already spread-merge, so the tag
survives every subsequent edit untouched.

**Damian registered-agent data** — the "damian" option's `onClick` now `setFields()`s the
full identity (`agentName`, `agentStreet`, `agentUnit`, `agentCity`, `agentState`,
`agentZip`) instead of only `agentChoice: "damian"`; switching to "own" clears those fields
so stale Damian data can't leak under a different `agent_choice`. The display block now
reads from `data.*`, not the `DAMIAN_RA_ADDRESS` constant, so there's one source of truth.
Two new `IntakeData` fields added: `agentUnit`, `agentState` (defaults to `"Florida"` —
matches the already-fixed, disabled "Florida" field the "own" path has always shown).
Submission payload gets `agent_unit`/`agent_state` added for parity with the other `agent_*`
fields.

**Not changed, deliberately:** the "own" agent path's UI still has no dedicated Unit input
(there wasn't one before). `agentUnit` stays empty for that path unless folded into the
street field by the customer, same as today. Adding that input would be a UI change beyond
"fix the data model," so it was left alone.

**Article V value mismatch** — **not fixed in the frontend.** The UI's `effectiveDateOption`
state values (`"Immediately"`, `"Future Date"`) and every place in `LLCFilingIntake.tsx`
that branches on them are untouched — changing them would mean touching ~6 conditional
checks across a 2000-line component for no benefit, and the task explicitly says not to
change customer-visible wording unless necessary. The fix lives in exactly one place: the
composer (§3 below), per the task's own instruction not to let the template silently accept
aliases either.

## 3. Composer (llc-filing-intake, `server/src/pdf/`, working tree, uncommitted)

- `types.ts` — `FilingSessionRecord`, `AuthorizedPersonInput` (the canonical input shape)
- `formatAddress.ts` — the one place address components become one line (plain text only —
  `autoescape=True` means embedded HTML like `<br>` would render as literal escaped text)
- `effectiveDate.ts` — `mapEffectiveDateOption` (the Article V fix — `{"Immediately":
  "Immediate", "Future Date": "Future"}`, with canonical values passed through unchanged)
  and `computeAnnualReportDueDate` (Florida's public rule: May 1 of the year after the
  effective year — **not documented anywhere in this project's own docs**; grepped
  `DECISIONS.md`, `GOVERNANCE.md`, and `florida-business-launchpad`'s docs for "annual
  report," no match. This is Florida's statutory rule reproduced because nothing internal
  states it — confirm with the client/an accountant before relying on it for a real filing)
- `composeArticlesOfOrganizationContext.ts` — the one place filing data becomes template
  field names; validates every required field and throws rather than stubbing
- `generatePdf.ts` — calls the **existing** `/generate-pdf` (no new endpoint created)

**Deliberately not built:** a new Express route wiring a real `filing_sessions` row through
this composer. The live Postgres table (migration 0001) has no columns for `llc_name`,
addresses, agent, or authorized persons — only funnel-tracking metadata. Adding a route
against columns that don't exist would either break or require inventing a shape nobody's
decided on. `FilingSessionRecord` defines what a complete record should look like; the
composer is proven against it via fixtures. Wiring it to real storage is a schema decision,
out of scope here.

## 4. Test Fixtures & Results

`server/test/pdf/fixtures.ts` — one base fixture (Sunrise Ventures LLC; principal ≠
mailing address; Damian as agent; Manager-Managed with 2 primary managers + 3 overflow
persons **mixing MGR and AMBR** — Erin Overflow is AMBR despite being 5th in a
Manager-Managed filing, which is the actual proof case) plus five variants (A–F from the
task): `ownAgentFixture`, `mailingSameFixture`, `immediateEffectiveFixture`,
`futureEffectiveFixture`, `memberManagedFixture`.

`server/test/pdf/composeArticlesOfOrganizationContext.test.ts` — 19 tests, all passing:
address formatting, the effective-date mapping (including the "Backdated" passthrough — see
below), the annual-report calculation, both registered-agent paths, both mailing-address
paths, both effective-date paths, and — the core proof — that all 5 authorized persons,
**including the continuation-page entry**, carry the correct `article_iv_title`.

**Backdated:** tested at the mapping-function level only (`mapEffectiveDateOption("Backdated")
→ "Backdated"`). The current intake UI offers exactly two options — "File as soon as
possible" and "Choose a future start date" — there is no third button and no code path that
produces "Backdated." It is not reachable end-to-end today; only forward-compatibility with
the template's own vocabulary is verified.

**End-to-end proof, through the real template and the real WeasyPrint engine** (not a mock):
composer output for all 6 scenarios was rendered via the exact `jinja2.Environment`
configuration `render_pdf.py` uses (`autoescape=True`, same `FileSystemLoader`), then
converted to actual PDF bytes with WeasyPrint 62.3 (the version pinned in
`requirements.txt`). Two sample PDFs were sent to you directly. Verified in the rendered
HTML/PDF for every scenario:

- Principal/mailing addresses render correctly, and `mailingSameFixture` produces a
  `mailing_address` **identical** to `principal_address` (fallback proven, not asserted)
- Registered agent renders correctly for both Damian and the customer-provided path
- **Article IV**: main table shows the first 4 persons with correct titles; the
  continuation page (`Article IV — Continued (Attachment)`) shows person 5 as `AMBR` —
  correct despite the filing being Manager-Managed overall, proving the title comes from
  the record, not from array position or `management_structure`
- **Article V**: the immediate-date fixture renders "shall be effective upon the date of
  filing" and nothing else; every future-dated fixture renders "Effective date: 2026-09-15"
  and "Your first Annual Report will be due by May 1, 2027" — this is the direct proof the
  value-mismatch fix works; before this composer existed, neither branch matched and
  Article V would have rendered blank (see `GATE2-CHECKOUT-STATUS.md` §4)
- Zoho Sign anchors (`{{zs_authorized_signature}}` etc.) remain literal, unresolved text in
  the output, exactly as intended
- `other_provisions` renders the provided text; a separate unit test confirms the
  "No other provisions." fallback for an empty value
- No blank required fields in any generated PDF; no fabricated values — every value traces
  to either a fixture input or a documented calculation

## 5. Validation (§8)

| Check | Result |
|---|---|
| TypeScript (`server`, `npm run typecheck`) | Clean |
| TypeScript (`florida-business-launchpad`, `tsc --noEmit`) | Clean, except one pre-existing, unrelated error: `@supabase/supabase-js` module not found — that package is in `package.json` but missing from `node_modules` (a stale install, not caused by this work). No other errors. |
| Lint (`server`) | **No lint script/config exists in this repo** — not something this task added or skipped; there was never one to run |
| Lint (`florida-business-launchpad`, `eslint`) | Ran on both changed files. 1 pre-existing error + 3 pre-existing warnings, all in code untouched by this work (a `Window.google?: any` declaration, two unrelated `useEffect` dependency warnings). Zero new issues from these changes |
| Existing tests (`server`, `npm test`) | 24/24 passing — 5 pre-existing (real Supabase integration tests, untouched) + 19 new composer tests |
| PDF generation test | 6/6 scenarios rendered through the real template; 3 converted to real PDFs via WeasyPrint 62.3 and inspected page-by-page (see §4) |
| `git diff --check` (llc-filing-intake) | Clean, no whitespace errors |

**Environment note, not a code issue:** getting WeasyPrint to actually run locally required
`brew install pango gdk-pixbuf` (native libs it needs — not pip-installable) and pinning
`pydyf<0.12` in an isolated venv, because plain `pip install weasyprint==62.3` resolves the
latest `pydyf` (0.12.1), which is **binary-incompatible** with WeasyPrint 62.3 and crashes
PDF generation with `AttributeError: 'super' object has no attribute 'transform'`.
`requirements.txt` pins `weasyprint==62.3` but not `pydyf` — if the deployed service's
build ever reinstalls from a bare `pip install -r requirements.txt` without a lockfile, it
can hit this exact failure. Worth pinning `pydyf==0.11.0` (or whatever WeasyPrint 62.3
actually ships against) in `requirements.txt` — flagged, not changed, since it's outside
this task's scope.

## 6. Findings Outside Scope (logged, not fixed — per your instruction not to fix yet)

- **Switching `management_structure` mid-form doesn't clear `additionalAuthorizedPersons`.**
  If a client picks Member-Managed, adds 5 members (tagging one overflow entry `AMBR`),
  then switches to Manager-Managed and adds managers, the stale `AMBR` overflow entry is
  still sitting in `additionalAuthorizedPersons` and would be included alongside the new
  `MGR` entries. The composer handles this correctly *as data* (it has no way to know it's
  stale) — the actual bug, if it matters, is in the intake form not clearing overflow state
  on a structure switch. This is exactly the scenario the base test fixture models, which is
  why it was chosen rather than a cleaner all-one-role fixture.
- **`filing_sessions` has no columns for any of this content** (§3) — the composer is fully
  built and tested, but nothing today writes a real, complete filing session record
  anywhere queryable. That's a schema/ingestion decision for a separate task.
- **`pydyf` version pinning** in `requirements.txt` (§5, environment note).

## Branches (uncommitted, nothing pushed)

- `feat/checkout-session-endpoint` (from the prior session) — unaffected by this work
- `feat/pdf-context-composer` (new, off `main`) — carries the composer, fixtures, and tests
  in this repo
- `florida-business-launchpad` — no branch created; changes sit directly in the working
  tree on `main`, uncommitted, alongside the pre-existing unrelated Google-Places-debug diff
  already there
