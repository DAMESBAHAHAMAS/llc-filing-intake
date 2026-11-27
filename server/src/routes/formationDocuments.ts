import { Router, type Request } from "express";
import { timingSafeEqual } from "node:crypto";
import { pool } from "../db/pool.js";
import { describeError } from "../db/describeError.js";
import { defaultOaDeps, generateForOrder, isMissingTable } from "../formation/operatingAgreementJob.js";

/**
 * Operator routes for the Operating Agreement (T144 Dispatch 10). Header
 * x-operator-key = OPERATOR_API_KEY; with the key unset every request is
 * refused. Nothing here sends a document to a customer.
 */
export const formationDocumentsRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function operatorAuthorized(req: Request): boolean {
  const expected = process.env.OPERATOR_API_KEY;
  const given = req.header("x-operator-key");
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * POST /api/ops/operating-agreement/:orderId
 * Body (all optional): { inputs: OperatingAgreementInputs, banking_resolution_inputs,
 * filing_date: "YYYY-MM-DD", replace: boolean }. Generates and stores the agreement
 * (and the Banking Resolution when BANKING_RESOLUTION_ENABLED=true) for a
 * Bank-Ready or Finance-Ready order with proof of filing. 422 lists missing answers.
 */
formationDocumentsRouter.post("/api/ops/operating-agreement/:orderId", async (req, res) => {
  if (!operatorAuthorized(req)) {
    res.status(401).json({ error: "operator key required" });
    return;
  }
  if (!UUID_RE.test(req.params.orderId)) {
    res.status(400).json({ error: "orderId must be a UUID" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const filingDate = typeof body.filing_date === "string" ? body.filing_date.trim() : undefined;
  if (filingDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(filingDate)) {
    res.status(400).json({ error: "filing_date must be YYYY-MM-DD" });
    return;
  }
  try {
    const r = await generateForOrder(await defaultOaDeps(pool), req.params.orderId, {
      inputs: (body.inputs ?? undefined) as never,
      bankingInputs: (body.banking_resolution_inputs ?? undefined) as never,
      filingDate,
      replace: body.replace === true,
      confirmMembers: body.confirm_members === true,
    });
    if (!r.ok) {
      res.status(r.status).json({ error: r.error, ...(r.missingFields ? { missingFields: r.missingFields } : {}) });
      return;
    }
    res.status(200).json(r);
  } catch (err) {
    if (isMissingTable(err)) {
      res.status(503).json({ error: "migration 0034 not applied yet" });
      return;
    }
    res.status(500).json({ error: "generation failed", detail: describeError(err) });
  }
});

/** GET /api/ops/formation-documents/:orderId/:kind (operating_agreement | banking_resolution) → the stored PDF. */
formationDocumentsRouter.get("/api/ops/formation-documents/:orderId/:kind", async (req, res) => {
  if (!operatorAuthorized(req)) {
    res.status(401).json({ error: "operator key required" });
    return;
  }
  if (!UUID_RE.test(req.params.orderId)) {
    res.status(400).json({ error: "orderId must be a UUID" });
    return;
  }
  if (!["operating_agreement", "banking_resolution"].includes(req.params.kind)) {
    res.status(400).json({ error: "kind must be operating_agreement or banking_resolution" });
    return;
  }
  try {
    const { rows } = await pool.query<{ pdf_bytes: Buffer; sha256: string; draft: boolean }>(
      `SELECT pdf_bytes, sha256, draft FROM formation_documents WHERE order_id = $1 AND kind = $2`,
      [req.params.orderId, req.params.kind]
    );
    if (!rows.length) {
      res.status(404).json({ error: "not generated" });
      return;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-SHA256", rows[0].sha256);
    res.setHeader("X-Draft", String(rows[0].draft));
    res.status(200).send(rows[0].pdf_bytes);
  } catch (err) {
    res.status(isMissingTable(err) ? 503 : 500).json({ error: "lookup failed", detail: describeError(err) });
  }
});
