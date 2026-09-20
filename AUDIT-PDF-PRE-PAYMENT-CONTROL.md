# PDF Rendering and Pre-Payment Control — Review

**Date:** 2026-09-20
**Scope:** doc §6. Answers each named question directly, from evidence
already produced this session (live acceptance testing, Gate 2 runbook §6.4)
plus the checkpoint audit (CP9, CP14).

---

**How is the PDF generated?**
`filing_data` (already validated complete by `buildPdfContext()`) is mapped
onto a Jinja2 template (`templates/articles_of_organization.html.j2`) and
rendered to PDF bytes by WeasyPrint, running as a separate Flask service
(`llc-pdf-generator`). The backend calls it over HTTP with a shared-secret
header that exists in code but is not currently enforced live (see
delivery-system audit, Security).

**What information does it contain?**
Articles I–VI of a Florida Articles of Organization: LLC name; principal
and mailing address; registered agent identity and address; authorized
persons (name, address, Article IV title); effective date; other
provisions. Verified directly this session by parsing a real generated PDF
and checking every field against what was actually submitted through the
live form — not assumed from the template source alone.

**How is rendering validated?**
Two independent layers, by design: `buildPdfContext()` refuses to call the
PDF service at all if any required field is missing (returns the missing
field list instead); the template itself uses Jinja2 `StrictUndefined`, so
even if the first layer had a gap, a missing variable raises loudly at
render time rather than rendering blank. Both layers were real, not
theoretical, during this session — CP5's bug was caught by the first
layer working correctly (reporting "incomplete" honestly); the `pydyf`
crash was a rendering-engine failure the second layer doesn't cover
(neither layer validates the rendering *library's own* correctness).

**How is successful rendering confirmed?**
The response's PDF bytes are hashed (SHA-256) and persisted alongside the
document in `filing_documents`. This session independently recomputed the
hash of the downloaded bytes and confirmed it matched the stored value
exactly — that's the actual confirmation mechanism, not merely "a 200
response came back."

**How is an independent snapshot of the customer's completed report
created?**
`filing_documents` — a dedicated table storing the PDF bytes, hash, and
size, separate from `filing_data` itself. The pre-payment row
(`order_id IS NULL`) is exactly one per session, enforced by a partial
unique index, so it cannot silently accumulate duplicates on retry.

**How is the snapshot associated with the correct customer and order?**
By `filing_session_id` foreign key (always) and `order_id` foreign key
(post-payment rows only — the pre-payment row has no order yet by
definition, since it's generated before checkout). There is currently no
independent human-readable customer identifier attached at this layer —
association is entirely by database ID, consistent with the delivery
audit's authentication/authorization finding (every identifier is an
unauthenticated bearer token, including this one).

**How does Administrator or Order Management receive the successful-render
signal?**
**It doesn't. Nothing does.** Per the delivery-system audit, no
administrative system exists. A successful pre-payment render is visible
only to: the customer's own browser (which downloads it), and anyone who
runs a direct SQL query against `filing_documents`. There is no
notification, no dashboard flag, no internal-reviewer delivery — the
original requirement this pre-payment PDF work was built against
explicitly calls for delivering a copy to "a designated internal
reviewer," and that half of the requirement is not built. Worth stating
precisely: the *generation and retention* half of Requirement 1 is done
and evidenced; the *internal visibility* half is not.

**What happens when rendering fails?**
The endpoint returns a structured error — 422 (with the missing field
list) for a data-completeness gap, or 502 (with the upstream error
detail) for a rendering-engine failure. The frontend logs it via
`console.error` and does not block the customer from continuing to
checkout, by explicit design (this is a visibility/evidence control, not
an approval gate). No `filing_documents` row is written on failure — the
partial unique index means a *subsequent* successful attempt for the same
session still succeeds cleanly.

**What happens when the PDF succeeds but the snapshot fails?**
This cannot currently happen as two separate steps — the same database
write that persists the PDF bytes *is* the snapshot; there is no
intermediate "PDF rendered but not yet saved" state that could fail
independently. If the question is really "what if the PDF bytes come back
but the INSERT fails" — that would surface as a 500 from the endpoint
(caught by the route's own try/catch), and no row would exist, so a retry
would simply regenerate rather than silently believing a snapshot exists
that doesn't. Not independently tested this session; reasoned from the
code path, not observed under failure.

**What happens when payment succeeds but document processing fails?**
This is CP14/CP13's territory. `orders.fulfillment_status` records
exactly what happened: `requires_review` for a data-completeness gap
(not retried on a timer — it needs new information, not time),
`ready` with backoff/retry for a transient PDF-service failure, and
gated at `blockedOnRegisteredAgent` before fulfillment is even attempted
if a third-party agent hasn't accepted yet. Payment itself is never
undone or contingent on this — `orders.payment_status='paid'` and
`fulfillment_status` are tracked independently, which is the correct
separation of concerns (a customer who paid stays paid regardless of a
downstream document-processing problem).

---

## Net assessment

The *generation → validation → confirmation → snapshot* chain is solid and
has real runtime evidence behind every link, for the pre-payment path
specifically (CP9). The chain breaks entirely at the point doc §6 calls
"how Administrator or Order Management receives the successful-render
signal" — because that role doesn't exist yet in this system at all (see
delivery-system audit). Closing that gap isn't a document-generation fix;
it's either building the internal-reviewer delivery the original
requirement asked for (WorkDrive automation, currently blocked on OAuth
credentials — Track A) or standing up some minimal administrative
visibility, which doesn't exist in any form today.
