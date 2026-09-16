import { Router } from "express";
import { pool } from "../db/pool.js";
import { describeError } from "../db/describeError.js";
import {
  acceptRegisteredAgent,
  declineRegisteredAgent,
  getAcceptancePageData,
  initiateOwnAgentAcceptance,
  reissueOwnAgentAcceptance,
  setDamianAsRegisteredAgent,
} from "../registeredAgent/acceptanceService.js";
import { realEmailSender } from "../registeredAgent/emailSender.js";
import type { RegisteredAgentInfo } from "../registeredAgent/types.js";

export const registeredAgentRouter = Router();

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function initiateDeps() {
  return { emailSender: realEmailSender, appBaseUrl: process.env.APP_BASE_URL ?? "" };
}

/**
 * POST /registered-agent/select
 *
 * The one entry point for both paths in the locked schema (§5 Damian, §3
 * outside agent). filing_session_id must already exist and already have
 * filing_data.llc_name set (Article I precedes Article III in the actual
 * funnel) — the outside-agent path fails validation otherwise rather
 * than sending an email with no LLC name in it.
 */
registeredAgentRouter.post("/registered-agent/select", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const filingSessionId = typeof body.filing_session_id === "string" ? body.filing_session_id : "";
  const agentChoice = body.agent_choice === "damian" || body.agent_choice === "own" ? body.agent_choice : "";

  if (!filingSessionId || !agentChoice) {
    res.status(400).json({ error: "filing_session_id and agent_choice ('damian' or 'own') are required" });
    return;
  }

  try {
    if (agentChoice === "damian") {
      const result = await setDamianAsRegisteredAgent(pool, filingSessionId);
      res.status(200).json(result);
      return;
    }

    const agent: RegisteredAgentInfo = {
      name: typeof body.name === "string" ? body.name : "",
      email: typeof body.email === "string" ? body.email : "",
      street: typeof body.street === "string" ? body.street : "",
      unit: typeof body.unit === "string" ? body.unit : "",
      city: typeof body.city === "string" ? body.city : "",
      state: typeof body.state === "string" ? body.state : "",
      zip: typeof body.zip === "string" ? body.zip : "",
    };
    const result = await initiateOwnAgentAcceptance(pool, filingSessionId, agent, initiateDeps());
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: "registered agent selection failed", detail: describeError(err) });
  }
});

/** §7: re-attempt after email_failed/expired/declined, same filing session. */
registeredAgentRouter.post("/registered-agent/retry", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const filingSessionId = typeof body.filing_session_id === "string" ? body.filing_session_id : "";
  if (!filingSessionId) {
    res.status(400).json({ error: "filing_session_id is required" });
    return;
  }
  try {
    const result = await reissueOwnAgentAcceptance(pool, filingSessionId, initiateDeps());
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: "registered agent retry failed", detail: describeError(err) });
  }
});

/**
 * GET /registered-agent/acceptance/:token
 *
 * The acceptance page itself (§4). Self-contained HTML, not the React
 * SPA and not the Jinja2/WeasyPrint system — an external party (the
 * registered agent) is following an emailed link, not using the funnel.
 * Shows only what §4 requires: LLC name, agent name, agent Florida
 * address, the designation statement, and the accept/decline actions.
 * The URL carries nothing but the opaque token.
 */
registeredAgentRouter.get("/registered-agent/acceptance/:token", async (req, res) => {
  const { token } = req.params;
  try {
    const data = await getAcceptancePageData(pool, token);
    if (!data) {
      res.status(404).type("html").send(page("This link is not valid.", "<p>We couldn't find a registered agent designation for this link.</p>"));
      return;
    }

    if (data.effectiveStatus === "accepted") {
      res.type("html").send(page("Already accepted", `<p>You have already accepted this designation for <strong>${escapeHtml(data.llcName)}</strong>.</p>`));
      return;
    }
    if (data.effectiveStatus === "declined") {
      res.type("html").send(page("Declined", "<p>This designation was previously declined.</p>"));
      return;
    }
    if (data.effectiveStatus === "expired") {
      res.type("html").send(page("Link expired", "<p>This acceptance link has expired. Please contact the company to request a new one.</p>"));
      return;
    }

    const body = `
      <p>You have been designated as the Registered Agent for:</p>
      <p><strong>${escapeHtml(data.llcName)}</strong></p>
      <p>Registered agent name on file: <strong>${escapeHtml(data.registeredAgentName)}</strong></p>
      <p>Registered agent Florida address on file: <strong>${escapeHtml(data.registeredAgentFloridaAddress)}</strong></p>
      <p>By accepting, you agree to act as registered agent for this Florida LLC and to accept service of process and official state correspondence on its behalf at the address above.</p>
      <form method="POST" action="/registered-agent/acceptance/${encodeURIComponent(token)}/accept" style="display:inline">
        <button type="submit">Accept designation</button>
      </form>
      <form method="POST" action="/registered-agent/acceptance/${encodeURIComponent(token)}/decline" style="display:inline; margin-left: 12px;">
        <button type="submit">Decline</button>
      </form>
    `;
    res.type("html").send(page("Registered Agent Designation", body));
  } catch (err) {
    res.status(500).type("html").send(page("Something went wrong", `<p>${escapeHtml(describeError(err))}</p>`));
  }
});

registeredAgentRouter.post("/registered-agent/acceptance/:token/accept", async (req, res) => {
  const { token } = req.params;
  try {
    const result = await acceptRegisteredAgent(pool, token, req.ip ?? null);
    if (!result.ok && result.reason !== undefined) {
      res.type("html").send(page("Unable to accept", `<p>${escapeHtml(result.reason)}</p>`));
      return;
    }
    res.type("html").send(page("Accepted", "<p>Thank you — the registered agent designation has been accepted.</p>"));
  } catch (err) {
    res.status(500).type("html").send(page("Something went wrong", `<p>${escapeHtml(describeError(err))}</p>`));
  }
});

registeredAgentRouter.post("/registered-agent/acceptance/:token/decline", async (req, res) => {
  const { token } = req.params;
  try {
    const result = await declineRegisteredAgent(pool, token);
    if (!result.ok && result.reason !== undefined) {
      res.type("html").send(page("Unable to decline", `<p>${escapeHtml(result.reason)}</p>`));
      return;
    }
    res.type("html").send(page("Declined", "<p>You have declined this registered agent designation.</p>"));
  } catch (err) {
    res.status(500).type("html").send(page("Something went wrong", `<p>${escapeHtml(describeError(err))}</p>`));
  }
});

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family: sans-serif; max-width: 560px; margin: 40px auto; line-height: 1.6;">
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>`;
}
