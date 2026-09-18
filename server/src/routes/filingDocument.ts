import { Router } from "express";
import { pool } from "../db/pool.js";
import { describeError } from "../db/describeError.js";
import { buildPdfContext } from "../pdf/context.js";
import { generateArticlesOfOrganizationPdf } from "../pdf/serviceClient.js";
import type { FilingSessionRecord } from "../pdf/types.js";

export const filingDocumentRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/filing-session/:filingSessionId/pdf
 *
 * Requirement 1 (pre-payment PDF visibility, 2026-09-18 requirement
 * handoff): generates the customer-facing Articles of Organization PDF
 * from the session's already-persisted filing_data, BEFORE any payment.
 * This is a visibility/evidence control, not a payment-approval gate —
 * it never blocks progress to checkout, and a completeness gap here
 * surfaces as an honest 422 the same way it already does for the
 * post-payment fulfillment worker (buildPdfContext is the single shared
 * validator for both paths).
 *
 * Idempotent per session: a pre-payment document already on record
 * (filing_documents.order_id IS NULL) is returned as-is rather than
 * regenerated — a retry or duplicate click does not re-call the external
 * PDF service or accumulate duplicate rows (enforced by the partial
 * unique index added in migration 0015).
 */
filingDocumentRouter.post("/api/filing-session/:filingSessionId/pdf", async (req, res) => {
  const { filingSessionId } = req.params;
  if (!UUID_RE.test(filingSessionId)) {
    res.status(400).json({ error: "filingSessionId must be a UUID" });
    return;
  }

  try {
    const existing = await pool.query<{ pdf_bytes: Buffer }>(
      `SELECT pdf_bytes FROM filing_documents WHERE filing_session_id = $1 AND order_id IS NULL`,
      [filingSessionId]
    );
    if (existing.rowCount) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="articles-of-organization-${filingSessionId}.pdf"`);
      res.status(200).send(existing.rows[0].pdf_bytes);
      return;
    }

    const sessionRes = await pool.query<{
      filing_data: Partial<FilingSessionRecord> | null;
      registered_agent_status: string | null;
    }>(
      `SELECT filing_data, registered_agent_status FROM filing_sessions WHERE filing_session_id = $1`,
      [filingSessionId]
    );
    if (sessionRes.rowCount === 0) {
      res.status(404).json({ error: "filing session not found" });
      return;
    }

    const filingData = sessionRes.rows[0].filing_data ?? {};
    const registeredAgentStatus = sessionRes.rows[0].registered_agent_status;

    const contextResult = buildPdfContext(filingData, registeredAgentStatus);
    if (!contextResult.ok) {
      res.status(422).json({ error: "filing data incomplete", missingFields: contextResult.missingFields });
      return;
    }

    const pdfResult = await generateArticlesOfOrganizationPdf(contextResult.context);
    if (!pdfResult.ok) {
      res.status(502).json({ error: "PDF generation failed", detail: pdfResult.error });
      return;
    }

    await pool.query(
      `INSERT INTO filing_documents (filing_session_id, order_id, byte_size, sha256, pdf_bytes)
       VALUES ($1, NULL, $2, $3, $4)
       ON CONFLICT (filing_session_id) WHERE order_id IS NULL DO NOTHING`,
      [filingSessionId, pdfResult.pdfBytes.length, pdfResult.sha256, pdfResult.pdfBytes]
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="articles-of-organization-${filingSessionId}.pdf"`);
    res.status(200).send(pdfResult.pdfBytes);
  } catch (err) {
    res.status(500).json({ error: "pdf generation failed", detail: describeError(err) });
  }
});
