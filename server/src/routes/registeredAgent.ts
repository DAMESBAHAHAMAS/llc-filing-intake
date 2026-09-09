import { randomBytes } from "node:crypto";
import { Router } from "express";
import { pool } from "../db/pool.js";
import { describeError } from "../db/describeError.js";

export const registeredAgentRouter = Router();

const ACCEPTANCE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ACCEPTANCE_VERSION = "v1";

/**
 * POST /api/registered-agent/request-acceptance
 *
 * Path B only (customer's own registered agent) — Path A (house RA)
 * never touches this table at all; the server always stamps
 * HOUSE_REGISTERED_AGENT into the PDF regardless (pdf/types.ts).
 *
 * KNOWN GAP, logged in DECISIONS.md: this does not send an email. There
 * is no email-provider credential configured anywhere in this
 * environment (Zoho Mail's API needs its own OAuth setup, separate from
 * Zoho CRM's), and standing up one would be a new integration this
 * session cannot verify end-to-end without credentials. It returns the
 * acceptance_url so the caller (frontend, or a manual/ops process) can
 * deliver it by whatever channel is actually wired up today, but the
 * "email link" half of "an emailed link + token" from the Gate 2 brief
 * is NOT built — only the token issuance/acceptance/decline mechanics
 * are.
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

  const frontendBaseUrl = process.env.FRONTEND_BASE_URL;
  if (!frontendBaseUrl) {
    res.status(500).json({ error: "server misconfigured: FRONTEND_BASE_URL not set" });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const sessionExists = await client.query("SELECT 1 FROM filing_sessions WHERE filing_session_id = $1", [filingSessionId]);
    if (sessionExists.rowCount === 0) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "unknown filing_session_id" });
      return;
    }

    const acceptanceTokenId = randomBytes(24).toString("base64url");

    await client.query(
      `INSERT INTO registered_agent_acceptances
         (filing_session_id, status, requested_at, registered_agent_name, registered_agent_email, acceptance_token_id, acceptance_version)
       VALUES ($1, 'acceptance_requested', now(), $2, $3, $4, $5)`,
      [filingSessionId, registeredAgentName, registeredAgentEmail, acceptanceTokenId, ACCEPTANCE_VERSION]
    );

    await client.query(`UPDATE filing_sessions SET registered_agent_status = 'acceptance_requested' WHERE filing_session_id = $1`, [
      filingSessionId,
    ]);

    await client.query("COMMIT");

    res.status(200).json({
      acceptance_token_id: acceptanceTokenId,
      acceptance_url: `${frontendBaseUrl}/registered-agent/accept?token=${encodeURIComponent(acceptanceTokenId)}`,
      email_sent: false,
      note: "Email delivery is not implemented — see server/API.md and DECISIONS.md. Deliver acceptance_url by whatever channel is actually wired up today.",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "request-acceptance failed", detail: describeError(err) });
  } finally {
    client.release();
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
