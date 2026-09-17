import { Router } from "express";
import { pool } from "../db/pool.js";
import { describeError } from "../db/describeError.js";
import { needsSunbizFiling } from "../offers/sunbizFiling.js";
import { dispatchAcceptanceEmail } from "../registeredAgent/acceptanceEmail.js";

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
      await mergeIntoFilingData(filingSessionId, { registered_agent_path: "house" });
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

    const result = await dispatchAcceptanceEmail(pool, filingSessionId);
    if (!result.ok) {
      res.status(502).json({ error: "request-acceptance email failed to send", detail: result.reason });
      return;
    }

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

    const clientIp = req.ip ?? req.socket.remoteAddress ?? null;
    await pool.query(
      `UPDATE registered_agent_acceptances SET status = 'accepted', accepted_at = now(), accepted_ip = $2 WHERE id = $1`,
      [resolved.row.id, clientIp]
    );
    await pool.query(`UPDATE filing_sessions SET registered_agent_status = 'accepted' WHERE filing_session_id = $1`, [
      resolved.row.filing_session_id,
    ]);

    // Best-effort, post-commit-equivalent: the acceptance itself is
    // already durable regardless of what happens here. A failure just
    // means an already-paid order stays not_ready a little longer than
    // it should — nothing is lost.
    try {
      await reevaluateFulfillmentAfterAcceptance(resolved.row.filing_session_id);
    } catch (err) {
      console.error(`Fulfillment re-evaluation failed for filing_session_id=${resolved.row.filing_session_id}:`, err);
    }

    res.status(200).json({ status: "accepted" });
  } catch (err) {
    res.status(500).json({ error: "accept failed", detail: describeError(err) });
  }
});

/** POST /api/registered-agent/decline — { token } */
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

    res.status(200).json({ status: "declined" });
  } catch (err) {
    res.status(500).json({ error: "decline failed", detail: describeError(err) });
  }
});

/** GET /api/registered-agent/status/:filingSessionId — polling endpoint. */
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
