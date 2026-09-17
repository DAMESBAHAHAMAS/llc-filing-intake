import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { realEmailSender } from "./emailSender.js";

/** Same values as routes/registeredAgent.ts's existing token/TTL
 *  constants — kept here too since this module is the other caller of
 *  the same token scheme (the post-payment deferred send), and neither
 *  file imports the other (avoids a route<->route circular import; see
 *  this module's own header). */
const ACCEPTANCE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ACCEPTANCE_VERSION = "v1";

export interface DispatchAcceptanceEmailResult {
  ok: boolean;
  reason?: string;
}

/**
 * Sends (or re-sends) the registered-agent acceptance email for a
 * "customer" (third-party) RA and records the outcome. Shared by both
 * routes/registeredAgent.ts (POST /api/registered-agent/request-acceptance,
 * which already has name/email/address in its own request body) and
 * routes/webhooksStripe.ts (the deferred, post-payment first send for
 * POST /registered-agent/select's persist-only selection, which has
 * neither — this function pulls them back out of filing_data and the
 * most recent registered_agent_acceptances row instead). Lives in its
 * own module, not in either route file, specifically so neither route
 * file has to import the other.
 *
 * Uses main's existing token scheme exactly as
 * routes/registeredAgent.ts's own request-acceptance endpoint already
 * does — an unhashed random token stored directly as acceptance_token_id
 * — rather than introducing a different (e.g. hashed) scheme for just
 * this caller. Left as a known, pre-existing property of this codebase's
 * design, not something this port changes.
 */
export async function dispatchAcceptanceEmail(pool: Pool, filingSessionId: string): Promise<DispatchAcceptanceEmailResult> {
  const frontendBaseUrl = process.env.FRONTEND_BASE_URL;
  if (!frontendBaseUrl) {
    return { ok: false, reason: "server misconfigured: FRONTEND_BASE_URL not set" };
  }

  const sessionRow = await pool.query<{ filing_data: Record<string, unknown> | null }>(
    `SELECT filing_data FROM filing_sessions WHERE filing_session_id = $1`,
    [filingSessionId]
  );
  const filingData = sessionRow.rows[0]?.filing_data ?? {};
  const llcName = typeof filingData.llc_name === "string" ? filingData.llc_name : "";
  const registeredAgentName = typeof filingData.registered_agent_name === "string" ? filingData.registered_agent_name : "";
  const registeredAgentAddress =
    typeof filingData.registered_agent_florida_address === "string" ? filingData.registered_agent_florida_address : "";
  // Bridging field only — see routes/registeredAgent.ts's POST
  // /registered-agent/select comment on why email lives here pre-send
  // (pdf/types.ts's FilingSessionRecord has no email field; it's not PDF
  // content). Once a registered_agent_acceptances row exists, that row's
  // own email is authoritative instead (a reissue must keep using the
  // email it already sent to/heard back from, even if filing_data were
  // ever edited afterward).
  const bridgedEmail = typeof filingData.registered_agent_email === "string" ? filingData.registered_agent_email : "";

  const lastAcceptance = await pool.query<{ registered_agent_email: string }>(
    `SELECT registered_agent_email FROM registered_agent_acceptances
     WHERE filing_session_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [filingSessionId]
  );
  const registeredAgentEmail = lastAcceptance.rows[0]?.registered_agent_email || bridgedEmail;

  if (!llcName || !registeredAgentName || !registeredAgentAddress || !registeredAgentEmail) {
    return { ok: false, reason: "incomplete registered-agent data on filing_session — nothing to send" };
  }

  // At most one live ("acceptance_requested") token per session — an
  // old link must not remain capable of flipping status back to
  // "accepted" after a reissue.
  await pool.query(
    `UPDATE registered_agent_acceptances SET status = 'expired' WHERE filing_session_id = $1 AND status = 'acceptance_requested'`,
    [filingSessionId]
  );

  const token = randomBytes(24).toString("base64url");
  const requestedAt = new Date();
  const expiresAt = new Date(requestedAt.getTime() + ACCEPTANCE_TOKEN_TTL_MS);
  const acceptanceUrl = `${frontendBaseUrl}/registered-agent/accept?token=${encodeURIComponent(token)}`;

  const emailResult = await realEmailSender.sendRegisteredAgentAcceptanceEmail({
    toEmail: registeredAgentEmail,
    toName: registeredAgentName,
    llcName,
    registeredAgentFloridaAddress: registeredAgentAddress,
    acceptanceUrl,
    expiresAt,
  });

  if (!emailResult.ok) {
    await pool.query(
      `INSERT INTO registered_agent_acceptances
         (filing_session_id, status, registered_agent_name, registered_agent_email, acceptance_token_id, acceptance_version)
       VALUES ($1, 'email_failed', $2, $3, $4, $5)`,
      [filingSessionId, registeredAgentName, registeredAgentEmail, token, ACCEPTANCE_VERSION]
    );
    await pool.query(`UPDATE filing_sessions SET registered_agent_status = 'email_failed' WHERE filing_session_id = $1`, [
      filingSessionId,
    ]);
    return { ok: false, reason: emailResult.error };
  }

  await pool.query(
    `INSERT INTO registered_agent_acceptances
       (filing_session_id, status, requested_at, registered_agent_name, registered_agent_email, acceptance_token_id, acceptance_version)
     VALUES ($1, 'acceptance_requested', $2, $3, $4, $5, $6)`,
    [filingSessionId, requestedAt, registeredAgentName, registeredAgentEmail, token, ACCEPTANCE_VERSION]
  );
  await pool.query(
    `UPDATE filing_sessions SET registered_agent_status = 'acceptance_requested' WHERE filing_session_id = $1`,
    [filingSessionId]
  );

  return { ok: true };
}
