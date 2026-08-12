# GOVERNANCE — Standing Rules for This Engagement

Twelve standing rules, consolidated here because they'd accumulated across
multiple sessions and were at risk of only living in scrollback. These apply
across both repos (`llc-filing-intake` and `florida-business-launchpad`)
unless a rule says otherwise. Adding a new standing rule is itself a decision
— log it in `DECISIONS.md`, then reflect it here.

1. **Zoho CRM is a downstream sync target, never the system of record.** A
   local durable store is primary — every funnel stage writes there before
   any external call and before any UI advance. A CRM failure must never
   block the user, never lose data, and must be retryable.
2. **Never write a code path that charges a card before the order record is
   durably persisted.**
3. **One correlation ID for the whole journey** (`filing_session_id`) —
   generated before any PII exists, persisted both client- and server-side,
   and used to backfill anonymous activity onto the identified record once
   an email is first captured.
4. **Never claim a feature is "already implemented" based on a filename, a
   route definition, or a component name.** Only based on reading the
   executing code path end to end, including the network call and the
   server handler.
5. **Do not add third-party dependencies without listing them and waiting
   for approval.**
6. **All secrets stay in environment variables.** Never hardcode a key,
   never log a key, never commit a `.env` file. Never ask the user to paste
   a credential in chat — read it from a gitignored local file they create
   themselves.
7. **Work on a branch. Never push directly to main** — the user pushes, not
   the assistant.
8. **No more than 3 unmerged branches per repo at any time.** If a fourth is
   needed, report the current branch backlog before creating it.
9. **Supabase Postgres is accessed server-side only**, via the `pg` driver,
   over the **session pooler** connection string (never direct, never the
   transaction pooler), with the pool capped at `max: 5` on the free tier.
   Never build against Supabase Auth, Storage, Realtime, or Edge Functions.
10. **Before any destructive migration** (drop/alter column, drop table),
    dump schema and data to a local `.sql` file first, and state that in the
    commit message. Do not rewrite git history to scrub already-exposed
    non-secret values without explicit instruction.
11. **`GAPS.md` and `DECISIONS.md` are living registers, not one-time
    artifacts.** Append immediately, in the same response a finding or
    decision is made — never wait for a formal review or session end. Never
    delete, renumber, or rewrite an existing entry. See "Living-register
    discipline" below for the operational specifics.
12. **Finding something broken outside the current task's scope is not
    authorization to fix it.** Log it to the appropriate register, state its
    severity, and continue with the task at hand — unless it's a P0
    security or data-loss issue, in which case stop and report before
    proceeding.

## Living-register discipline

Two registers exist, in different repos on purpose — each stays with what it
tracks:

- **`florida-business-launchpad/GAPS.md`** — funnel defects (gaps, missing
  requirements, inconsistencies, risks) found in that repo's product code.
  Schema: `# | Gap | Stage | Severity | Blocks Core Path? | Est. Effort |
  Fix Summary | Status | Commit SHA | Re-verified`. Severity is P0/P1/P2
  only (defined in that file). Status is OPEN/FIXED/SUPERSEDED/WONTFIX.
  **Immutable:** `#`, `Gap`, `Stage`, `Severity`, `Blocks Core Path?`,
  `Est. Effort`, `Fix Summary`. **Mutable:** `Status`, `Commit SHA`,
  `Re-verified` — updating these records a fix, it isn't overwriting a
  finding. A gap found to be wrong is marked SUPERSEDED with a reason, never
  deleted. New rows are appended at the bottom in discovery order; row
  position stopped implying priority once the register went live — read the
  Severity/Blocks columns for that.
- **`llc-filing-intake/DECISIONS.md`** (this repo) — architecture and
  process decisions for the data-spine build and beyond. Format: one `##
  <date> — <decision>` heading per entry, with **Rationale** and
  **Supersedes** fields underneath. **Immutable:** every entry, once
  published. A reversed or changed decision is a **new, appended** entry
  whose **Supersedes** field names the entry it replaces — the original
  stays exactly as written.

**Re-verification trigger:** in any session where `main` has moved since the
last one, re-verify every OPEN P0/P1 row in `GAPS.md` against the current
tree — actually check the code, don't assume — and update `Re-verified`
regardless of outcome (including "still open, unchanged"), before doing any
build work.
