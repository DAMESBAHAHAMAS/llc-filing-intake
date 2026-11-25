import { Router } from "express";
import { pool } from "../db/pool.js";
import { describeError } from "../db/describeError.js";
import { needsSunbizFiling } from "../offers/sunbizFiling.js";
import { dispatchAcceptanceEmail } from "../registeredAgent/acceptanceEmail.js";
import { isDuplicateAcceptanceRequest, type LatestAcceptanceRow } from "../registeredAgent/acceptancePolicy.js";
import {
  checkSignature,
  loadStoredAcceptance,
  queueRaDealStatus,
  RA_ACCEPTANCE_STATEMENT,
  RA_ACCEPTANCE_STATEMENT_VERSION,
  requireSignature,
} from "../registeredAgent/acceptanceRecord.js";
import { recordAcceptance } from "../registeredAgent/acceptTransaction.js";
import { clientKey } from "../middleware/rateLimit.js";
import { buildAcceptanceStatementContext } from "../registeredAgent/acceptanceStatement.js";
import { renderTemplatePdf } from "../pdf/serviceClient.js";
import { operatorAuthorized } from "./orders.js";

/** The visitor's IP behind Render's proxies (True-Client-IP), or null. */
function visitorIp(req: import("express").Request): string | null {
  const ip = clientKey(req);
  return ip === "unknown" ? null : ip;
}

/**
 * Logs and swallows: a Zoho status update must never fail the agent's answer.
 * The job sends the session's status as it is when the job runs (see
 * acceptanceRecord.ts raDealPayloadNow), so the order of jobs does not matter.
 */
async function queueRaStatusQuietly(filingSessionId: string): Promise<void> {
  try {
    const r = await queueRaDealStatus(pool, filingSessionId);
    if (!r.queued) console.log(`[ra status] Deal not updated for ${filingSessionId}: ${r.reason}`);
  } catch (err) {
    console.error(`[ra status] queueing failed for ${filingSessionId}:`, err);
  }
}

export const registeredAgentRouter = Router();

const ACCEPTANCE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function formatFloridaAddress(parts: { street: string; unit?: string; city: string; state: string; zip: string }): string {
  const line1 = parts.unit ? `${parts.street}, ${parts.unit}` : parts.street;
  return `${line1}, ${parts.city}, ${parts.state} ${parts.zip}`;
}

/** Read-modify-write of filing_sessions.filing_data — merges the given
 *  keys into whatever's already there rather than replacing the whole
 *  object, the same pattern routes/session.ts's own generic patch
 *  mechanism follows for scalar columns. FOR UPDATE first so a
 *  concurrent write can't clobber the rest of filing_data with a stale
 *  read. */
async function mergeIntoFilingData(filingSessionId: string, patch: Record<string, unknown>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ filing_data: Record<string, unknown> | null }>(
      "SELECT filing_data FROM filing_sessions WHERE filing_session_id = $1 FOR UPDATE",
      [filingSessionId]
    );
    const current = rows[0]?.filing_data ?? {};
    const merged = { ...current, ...patch };
    await client.query(`UPDATE filing_sessions SET filing_data = $2 WHERE filing_session_id = $1`, [
      filingSessionId,
      JSON.stringify(merged),
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Re-evaluates a single already-paid order's fulfillment_status after
 * registered_agent_status changes to 'accepted' — the other half of the
 * gate routes/webhooksStripe.ts applies at payment time (see that
 * file's own registered-agent-gate comment). A no-op for an unpaid order
 * (nothing to unblock yet) or one that doesn't actually need Sunbiz
 * filing at all.
 */
async function reevaluateFulfillmentAfterAcceptance(filingSessionId: string): Promise<void> {
  const { rows } = await pool.query<{
    order_id: string;
    payment_status: string;
    fulfillment_status: string;
    line_items: Array<{ offer_code?: string }>;
  }>(
    `SELECT order_id, payment_status, fulfillment_status, line_items
     FROM orders WHERE filing_session_id = $1`,
    [filingSessionId]
  );
  for (const order of rows) {
    if (order.payment_status !== "paid" || order.fulfillment_status !== "not_ready") continue;
    if (!needsSunbizFiling(order.line_items ?? [])) continue;
    await pool.query(
      `UPDATE orders SET fulfillment_status = 'ready', fulfillment_ready_at = now() WHERE order_id = $1`,
      [order.order_id]
    );
  }
}

/**
 * POST /registered-agent/select
 *
 * Persists the Article III registered-agent choice — house ("damian") or
 * customer ("own") — BEFORE checkout, matching the already-shipped
 * florida-business-launchpad frontend's contract exactly (body shape,
 * field names, this path). Persistence + validation only: for the
 * customer path, NO acceptance email is sent here. It sends once payment
 * is confirmed (routes/webhooksStripe.ts calls dispatchAcceptanceEmail),
 * so a customer who never completes checkout never causes a third party
 * to be emailed. Does not replace POST /api/registered-agent/request-
 * acceptance below, which still sends immediately — that endpoint is for
 * a caller that already knows it wants to notify the agent right now.
 */
registeredAgentRouter.post("/registered-agent/select", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const filingSessionId = typeof body.filing_session_id === "string" ? body.filing_session_id.trim() : "";
  const agentChoice = body.agent_choice === "damian" || body.agent_choice === "own" ? body.agent_choice : "";

  if (!filingSessionId || !agentChoice) {
    res.status(400).json({ error: "filing_session_id and agent_choice ('damian' or 'own') are required" });
    return;
  }

  try {
    if (agentChoice === "damian") {
      // Path A (house RA): pdf/context.ts always stamps
      // HOUSE_REGISTERED_AGENT server-side regardless of filing_data, so
      // there's nothing to validate — this just records the choice and
      // marks the (non-existent, no-email) acceptance as satisfied.
      // undefined values are dropped when filing_data is serialised, so
      // switching back from "own" to Damian removes every stored own-agent
      // field instead of leaving stale data for the PDF or CRM.
      await mergeIntoFilingData(filingSessionId, {
        registered_agent_path: "house",
        registered_agent_name: undefined,
        registered_agent_florida_address: undefined,
        registered_agent_email: undefined,
      });
      await pool.query(`UPDATE filing_sessions SET registered_agent_status = 'accepted' WHERE filing_session_id = $1`, [
        filingSessionId,
      ]);
      // Covers switching an already-paid order from "own" to "damian"
      // (e.g. an outside agent declined and the customer switched) —
      // otherwise an order blocked on outside-agent acceptance would
      // stay not_ready forever even though the new choice needs none.
      await reevaluateFulfillmentAfterAcceptance(filingSessionId);
      res.status(200).json({ status: "accepted" });
      return;
    }

    // agentChoice === "own" (Path B: customer's own registered agent)
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const street = typeof body.street === "string" ? body.street.trim() : "";
    const unit = typeof body.unit === "string" ? body.unit.trim() : "";
    const city = typeof body.city === "string" ? body.city.trim() : "";
    const state = typeof body.state === "string" ? body.state.trim() : "";
    const zip = typeof body.zip === "string" ? body.zip.trim() : "";

    const errors: string[] = [];
    if (!name) errors.push("registered agent name is required");
    if (!email) errors.push("registered agent email is required");
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("registered agent email is invalid");
    if (!street) errors.push("registered agent street address is required");
    else if (/p\.?o\.?\s*box/i.test(street)) errors.push("P.O. Boxes are not allowed for the registered agent address");
    if (!city) errors.push("registered agent city is required");
    if (!state) errors.push("registered agent state is required");
    if (!zip) errors.push("registered agent ZIP is required");

    await mergeIntoFilingData(filingSessionId, {
      registered_agent_path: "customer",
      registered_agent_name: name,
      registered_agent_florida_address: formatFloridaAddress({ street, unit, city, state, zip }),
      // Bridging field only — see acceptanceEmail.ts's own comment. Not
      // part of pdf/types.ts's FilingSessionRecord; buildPdfContext()
      // never reads it, it just rides along in the same jsonb column
      // until the deferred send needs it.
      registered_agent_email: email,
    });
    await pool.query(`UPDATE filing_sessions SET registered_agent_status = 'pending' WHERE filing_session_id = $1`, [
      filingSessionId,
    ]);
    // A link already out was sent for the details saved before this call.
    // The website only re-saves an own agent when those details changed
    // (ST06), so that old link must stop working: otherwise the agent could
    // accept an address the customer has since replaced.
    await pool.query(
      `UPDATE registered_agent_acceptances SET status = 'expired'
       WHERE filing_session_id = $1 AND status = 'acceptance_requested'`,
      [filingSessionId]
    );

    const llcNameRow = await pool.query<{ filing_data: { llc_name?: string } | null }>(
      `SELECT filing_data FROM filing_sessions WHERE filing_session_id = $1`,
      [filingSessionId]
    );
    if (!llcNameRow.rows[0]?.filing_data?.llc_name?.trim()) {
      errors.push("llc_name must be set before selecting a registered agent");
    }

    res.status(200).json({ status: "pending", validationErrors: errors.length ? errors : undefined });
  } catch (err) {
    res.status(500).json({ error: "registered agent selection failed", detail: describeError(err) });
  }
});

/**
 * POST /api/registered-agent/request-acceptance
 *
 * Path B only (customer's own registered agent) — Path A (house RA)
 * never touches this table at all; the server always stamps
 * HOUSE_REGISTERED_AGENT into the PDF regardless (pdf/types.ts).
 *
 * Unlike POST /registered-agent/select above, this sends the acceptance
 * email immediately — for a caller (an ops/admin flow, or a future
 * "resend now" UI action) that already wants the agent notified right
 * away rather than deferred to payment confirmation. Persists the same
 * fields into filing_data first (so both entry points converge on one
 * source of truth) and then delegates the actual send to
 * dispatchAcceptanceEmail — the same function routes/webhooksStripe.ts
 * calls post-payment — rather than duplicating the token/send logic.
 */
registeredAgentRouter.post("/api/registered-agent/request-acceptance", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const filingSessionId = typeof body.filing_session_id === "string" ? body.filing_session_id.trim() : "";
  const registeredAgentName = typeof body.registered_agent_name === "string" ? body.registered_agent_name.trim() : "";
  const registeredAgentEmail = typeof body.registered_agent_email === "string" ? body.registered_agent_email.trim() : "";

  if (!filingSessionId || !registeredAgentName || !registeredAgentEmail) {
    res.status(400).json({ error: "filing_session_id, registered_agent_name, and registered_agent_email are required" });
    return;
  }

  try {
    const sessionExists = await pool.query("SELECT 1 FROM filing_sessions WHERE filing_session_id = $1", [filingSessionId]);
    if (sessionExists.rowCount === 0) {
      res.status(404).json({ error: "unknown filing_session_id" });
      return;
    }

    // Idempotent: a live request to this same agent is not sent again (a
    // repeat click, a second device, a retry). Each send expires the last
    // link, so a duplicate would break the one the agent already has.
    // { force: true } resends anyway (an operator "resend now").
    if (body.force !== true) {
      const latest = await pool.query<LatestAcceptanceRow>(
        `SELECT status, registered_agent_email, registered_agent_name, requested_at
         FROM registered_agent_acceptances WHERE filing_session_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [filingSessionId]
      );
      if (isDuplicateAcceptanceRequest(latest.rows[0], registeredAgentName, registeredAgentEmail)) {
        res.status(200).json({ email_sent: false, already_requested: true });
        return;
      }
    }

    // registered_agent_florida_address may already be set (e.g. this
    // session already went through POST /registered-agent/select) — do
    // not clobber a real address with an empty one if this caller only
    // sent name/email.
    const existing = await pool.query<{ filing_data: { registered_agent_florida_address?: string } | null }>(
      `SELECT filing_data FROM filing_sessions WHERE filing_session_id = $1`,
      [filingSessionId]
    );
    const existingAddress = existing.rows[0]?.filing_data?.registered_agent_florida_address ?? "";
    const address =
      typeof body.registered_agent_florida_address === "string" && body.registered_agent_florida_address.trim()
        ? body.registered_agent_florida_address.trim()
        : existingAddress;

    await mergeIntoFilingData(filingSessionId, {
      registered_agent_path: "customer",
      registered_agent_name: registeredAgentName,
      registered_agent_florida_address: address,
      registered_agent_email: registeredAgentEmail,
    });

    const result = await dispatchAcceptanceEmail(pool, filingSessionId, { email: registeredAgentEmail });
    if (!result.ok) {
      res.status(502).json({ error: "request-acceptance email failed to send", detail: result.reason });
      return;
    }

    await queueRaStatusQuietly(filingSessionId);

    const frontendBaseUrl = process.env.FRONTEND_BASE_URL ?? "";
    res.status(200).json({ email_sent: true, note: "Acceptance email sent via Resend." , frontend_base_url: frontendBaseUrl });
  } catch (err) {
    res.status(500).json({ error: "request-acceptance failed", detail: describeError(err) });
  }
});

async function resolveActionableAcceptance(token: string) {
  const { rows } = await pool.query<{
    id: number;
    filing_session_id: string;
    status: string;
    requested_at: string | null;
  }>(
    `SELECT id, filing_session_id, status, requested_at FROM registered_agent_acceptances WHERE acceptance_token_id = $1`,
    [token]
  );
  if (rows.length === 0) return { found: false as const };

  const row = rows[0];
  if (row.status !== "acceptance_requested") {
    return { found: true as const, actionable: false as const, row };
  }
  if (row.requested_at && Date.now() - new Date(row.requested_at).getTime() > ACCEPTANCE_TOKEN_TTL_MS) {
    await pool.query(`UPDATE registered_agent_acceptances SET status = 'expired' WHERE id = $1`, [row.id]);
    await pool.query(`UPDATE filing_sessions SET registered_agent_status = 'expired' WHERE filing_session_id = $1`, [
      row.filing_session_id,
    ]);
    return { found: true as const, actionable: false as const, row: { ...row, status: "expired" } };
  }
  return { found: true as const, actionable: true as const, row };
}

/** POST /api/registered-agent/accept — { token } */
registeredAgentRouter.post("/api/registered-agent/accept", async (req, res) => {
  const body = ((req.body ?? {}) as Record<string, unknown>);
  const token = typeof body.token === "string" ? body.token : "";
  if (!token) {
    res.status(400).json({ error: "token is required" });
    return;
  }
  // T144 D12: the agent's typed full name and consent (required once
  // RA_ACCEPT_REQUIRE_SIGNATURE=true; see registeredAgent/acceptanceRecord.ts).
  const signature = checkSignature(body);
  if (!signature.ok) {
    res.status(signature.status).json({ error: signature.error, code: signature.code });
    return;
  }

  try {
    const resolved = await resolveActionableAcceptance(token);
    if (!resolved.found) {
      res.status(404).json({ error: "unknown or invalid token" });
      return;
    }
    if (!resolved.actionable) {
      res.status(409).json({ error: `token is not actionable (status=${resolved.row.status})` });
      return;
    }

    // One transaction: uses the token, stores the signed acceptance on the
    // acceptance row (never filing_data) and opens the filing gate.
    const outcome = await recordAcceptance(pool, {
      acceptanceId: resolved.row.id,
      filingSessionId: resolved.row.filing_session_id,
      signatureName: signature.signatureName,
      ip: visitorIp(req),
      userAgent: req.get("user-agent"),
      acceptedAt: new Date(),
      requireSignature: requireSignature(),
    });
    if (outcome.kind === "not_actionable") {
      res.status(409).json({ error: `token is not actionable (status=${outcome.status})` });
      return;
    }
    if (outcome.kind === "signature_mismatch") {
      res.status(400).json({
        error: "signature_name must be the name of the registered agent named in this request",
        code: "signature_mismatch",
        registered_agent_name: outcome.agentName,
      });
      return;
    }
    if (outcome.kind === "signature_storage_unavailable") {
      res.status(503).json({ error: "signatures cannot be stored yet (migration 0033 not applied)", code: "not_ready" });
      return;
    }

    // Best-effort, post-commit-equivalent: the acceptance itself is
    // already durable regardless of what happens here. A failure just
    // means an already-paid order stays not_ready a little longer than
    // it should — nothing is lost.
    try {
      await reevaluateFulfillmentAfterAcceptance(resolved.row.filing_session_id);
    } catch (err) {
      console.error(`Fulfillment re-evaluation failed for filing_session_id=${resolved.row.filing_session_id}:`, err);
    }

    await queueRaStatusQuietly(resolved.row.filing_session_id);

    res.status(200).json({ status: "accepted", signed: outcome.signed });
  } catch (err) {
    res.status(500).json({ error: "accept failed", detail: describeError(err) });
  }
});

/** POST /api/registered-agent/decline — { token } */
/**
 * POST /api/registered-agent/acceptance/details { token } (T144 D12)
 *
 * What the acceptance page shows before the agent answers: the LLC, the agent
 * name and Florida address the email already named, and the statement they
 * sign. The token goes in the body, not the URL, so it stays out of access
 * logs. Records nothing. 404 for an unknown token; status tells the page
 * whether the link can still be answered.
 */
registeredAgentRouter.post("/api/registered-agent/acceptance/details", async (req, res) => {
  const token = typeof (req.body as Record<string, unknown>)?.token === "string" ? ((req.body as Record<string, unknown>).token as string) : "";
  if (!token) {
    res.status(400).json({ error: "token is required" });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  try {
    const resolved = await resolveActionableAcceptance(token);
    if (!resolved.found) {
      res.status(404).json({ error: "unknown or invalid token" });
      return;
    }
    const { rows } = await pool.query<{ filing_data: Record<string, unknown> | null }>(
      `SELECT filing_data FROM filing_sessions WHERE filing_session_id = $1`,
      [resolved.row.filing_session_id]
    );
    const fd = rows[0]?.filing_data ?? {};
    const s = (k: string) => (typeof fd[k] === "string" ? (fd[k] as string) : "");
    // The agent name the signature is checked against: the one the request was sent to.
    const named = await pool.query<{ registered_agent_name: string }>(
      `SELECT registered_agent_name FROM registered_agent_acceptances WHERE id = $1`,
      [resolved.row.id]
    );
    const expiresAt = resolved.row.requested_at
      ? new Date(new Date(resolved.row.requested_at).getTime() + ACCEPTANCE_TOKEN_TTL_MS).toISOString()
      : null;
    res.status(200).json({
      actionable: resolved.actionable,
      status: resolved.row.status,
      llc_name: s("llc_name").toUpperCase(),
      registered_agent_name: named.rows[0]?.registered_agent_name ?? s("registered_agent_name"),
      registered_agent_florida_address: s("registered_agent_florida_address"),
      statement: RA_ACCEPTANCE_STATEMENT,
      statement_version: RA_ACCEPTANCE_STATEMENT_VERSION,
      signature_required: requireSignature(),
      expires_at: expiresAt,
    });
  } catch (err) {
    res.status(500).json({ error: "details lookup failed", detail: describeError(err) });
  }
});

registeredAgentRouter.post("/api/registered-agent/decline", async (req, res) => {
  const token = typeof (req.body as Record<string, unknown>)?.token === "string" ? (req.body as Record<string, unknown>).token as string : "";
  if (!token) {
    res.status(400).json({ error: "token is required" });
    return;
  }

  try {
    const resolved = await resolveActionableAcceptance(token);
    if (!resolved.found) {
      res.status(404).json({ error: "unknown or invalid token" });
      return;
    }
    if (!resolved.actionable) {
      res.status(409).json({ error: `token is not actionable (status=${resolved.row.status})` });
      return;
    }

    await pool.query(`UPDATE registered_agent_acceptances SET status = 'declined' WHERE id = $1`, [resolved.row.id]);
    await pool.query(`UPDATE filing_sessions SET registered_agent_status = 'declined' WHERE filing_session_id = $1`, [
      resolved.row.filing_session_id,
    ]);
    await queueRaStatusQuietly(resolved.row.filing_session_id);

    res.status(200).json({ status: "declined" });
  } catch (err) {
    res.status(500).json({ error: "decline failed", detail: describeError(err) });
  }
});

/** GET /api/registered-agent/status/:filingSessionId — polling endpoint. */
/**
 * POST /api/ops/registered-agent/acceptance-statement/:filingSessionId (operator, T144 D12)
 * Renders the signed Registered Agent Acceptance Statement as a PDF. Stores and sends nothing.
 */
registeredAgentRouter.post("/api/ops/registered-agent/acceptance-statement/:filingSessionId", async (req, res) => {
  if (!operatorAuthorized(req)) {
    res.status(401).json({ error: "operator key required" });
    return;
  }
  try {
    const exists = await pool.query(`SELECT 1 FROM filing_sessions WHERE filing_session_id = $1`, [req.params.filingSessionId]);
    if (!exists.rowCount) {
      res.status(404).json({ error: "unknown filing_session_id" });
      return;
    }
    // Server-side acceptance row only (migration 0033), never filing_data.
    const ctx = buildAcceptanceStatementContext(await loadStoredAcceptance(pool, req.params.filingSessionId));
    if (!ctx.ok) {
      res.status(422).json({ error: "no signed acceptance on file", missingFields: ctx.missingFields });
      return;
    }
    const pdf = await renderTemplatePdf("registered_agent_acceptance_statement", ctx.context);
    if (!pdf.ok) {
      res.status(502).json({ error: "PDF generation failed", detail: pdf.error });
      return;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("X-Content-SHA256", pdf.sha256);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(pdf.pdfBytes);
  } catch (err) {
    res.status(500).json({ error: "statement failed", detail: describeError(err) });
  }
});

registeredAgentRouter.get("/api/registered-agent/status/:filingSessionId", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT registered_agent_status FROM filing_sessions WHERE filing_session_id = $1`,
      [req.params.filingSessionId]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "unknown filing_session_id" });
      return;
    }
    res.status(200).json({ registered_agent_status: rows[0].registered_agent_status });
  } catch (err) {
    res.status(500).json({ error: "status lookup failed", detail: describeError(err) });
  }
});
