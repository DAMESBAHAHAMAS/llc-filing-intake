/**
 * T144 Dispatch 12: the customer's own registered agent signs the acceptance.
 *
 * Before this, POST /api/registered-agent/accept recorded only a button press
 * (accepted_at and Render's proxy IP). Florida's Articles carry the agent's
 * signed acceptance (Article III), so the agent now types their full name
 * under the statutory statement, and the data spine keeps an audit record:
 * the typed name, time, the visitor's IP (True-Client-IP), user agent, the
 * statement wording and its version, and a short reference to the token.
 *
 * The record lives in filing_sessions.filing_data.registered_agent_acceptance
 * (jsonb), so no migration is needed. registered_agent_acceptances keeps its
 * own accepted_at / accepted_ip as before.
 *
 * Rollout: the published website still sends only { token }. Until the new
 * acceptance page is published, a missing signature is accepted and recorded
 * as method "button_only". Set RA_ACCEPT_REQUIRE_SIGNATURE=true after Damian
 * publishes the page to require the typed signature.
 */
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

/** The statement the agent signs: the Article III acceptance on the Sunbiz Articles form. */
export const RA_ACCEPTANCE_STATEMENT =
  "Having been named as registered agent and to accept service of process for the above stated limited liability company at the place designated in this certificate, I hereby accept the appointment as registered agent and agree to act in this capacity. I further agree to comply with the provisions of all statutes relating to the proper and complete performance of my duties, and I am familiar with and accept the obligations of my position as registered agent as provided for in Chapter 605, F.S.";
export const RA_ACCEPTANCE_STATEMENT_VERSION = "ra-statement-2026-11-25";

/** Status wording shown to the customer and written to the Zoho Deal. */
export const RA_STATUS_AWAITING = "Awaiting agent acceptance";
export const RA_STATUS_ACCEPTED = "Agent Accepted — Ready for Sunbiz";

export interface RegisteredAgentAcceptanceRecord {
  method: "typed_signature" | "button_only";
  signature_name: string | null;
  registered_agent_name: string;
  registered_agent_florida_address: string;
  llc_name: string;
  accepted_at: string;
  ip: string | null;
  user_agent: string | null;
  statement_version: string;
  statement_text: string;
  /** First 16 hex characters of SHA-256(token): ties the record to the email link without storing the token again. */
  token_ref: string;
}

export function requireSignature(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RA_ACCEPT_REQUIRE_SIGNATURE === "true";
}

/** A typed full name: 2-120 characters with at least one letter, control characters removed. */
export function cleanSignatureName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 120 || !/\p{L}/u.test(name)) return null;
  return name;
}

export type SignatureCheck =
  | { ok: true; signatureName: string | null }
  | { ok: false; status: 400; error: string };

/** Validates the signature part of an accept request. */
export function checkSignature(body: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): SignatureCheck {
  const provided = body.signature_name !== undefined && body.signature_name !== null && body.signature_name !== "";
  if (!provided) {
    return requireSignature(env)
      ? { ok: false, status: 400, error: "signature_name (the agent's full name) is required" }
      : { ok: true, signatureName: null };
  }
  const name = cleanSignatureName(body.signature_name);
  if (!name) return { ok: false, status: 400, error: "signature_name must be the agent's full name (2-120 characters)" };
  if (body.consent !== true) return { ok: false, status: 400, error: "consent must be true to sign the acceptance" };
  return { ok: true, signatureName: name };
}

export function tokenRef(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export function buildAcceptanceRecord(input: {
  signatureName: string | null;
  filingData: Record<string, unknown>;
  acceptedAt: Date;
  ip: string | null;
  userAgent: string | null | undefined;
  token: string;
}): RegisteredAgentAcceptanceRecord {
  const s = (k: string) => (typeof input.filingData[k] === "string" ? (input.filingData[k] as string) : "");
  const ua = typeof input.userAgent === "string" ? input.userAgent.slice(0, 300) : null;
  return {
    method: input.signatureName ? "typed_signature" : "button_only",
    signature_name: input.signatureName,
    registered_agent_name: s("registered_agent_name"),
    registered_agent_florida_address: s("registered_agent_florida_address"),
    llc_name: s("llc_name"),
    accepted_at: input.acceptedAt.toISOString(),
    ip: input.ip,
    user_agent: ua || null,
    statement_version: RA_ACCEPTANCE_STATEMENT_VERSION,
    statement_text: RA_ACCEPTANCE_STATEMENT,
    token_ref: tokenRef(input.token),
  };
}

/**
 * Zoho Deal fields for the agent's status. Off unless RA_DEAL_STATUS_FIELD
 * names a Deal field (none exists yet: an admin creates it, e.g. a picklist
 * "Registered Agent Status"). RA_DEAL_ACCEPTED_AT_FIELD (DateTime) is optional.
 */
export function raDealFields(
  status: string,
  acceptedAt: Date | null,
  env: NodeJS.ProcessEnv = process.env
): Record<string, unknown> | null {
  const valid = (v: string | undefined) => (v && /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(v) ? v : "");
  const statusField = valid(env.RA_DEAL_STATUS_FIELD);
  if (!statusField) return null;
  const atField = valid(env.RA_DEAL_ACCEPTED_AT_FIELD);
  return {
    [statusField]: status,
    ...(atField && acceptedAt ? { [atField]: acceptedAt.toISOString().replace(/\.\d{3}Z$/, "+00:00") } : {}),
  };
}

/**
 * Queues a Deal update with the agent's status on the session's Deal. Uses the
 * existing deal_stage_update path without a Stage, so the Deal's ownership is
 * verified (its Contact's email must match the session's) before anything is
 * written. Skipped, with the reason returned, when the switch is off or the
 * session has no Deal or email yet.
 */
export async function queueRaDealStatus(
  db: Pool | PoolClient,
  filingSessionId: string,
  status: string,
  acceptedAt: Date | null,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ queued: boolean; reason?: string }> {
  const fields = raDealFields(status, acceptedAt, env);
  if (!fields) return { queued: false, reason: "RA_DEAL_STATUS_FIELD not set" };
  const { rows } = await db.query<{ email: string | null; crm_deal_id: string | null }>(
    `SELECT email, crm_deal_id FROM filing_sessions WHERE filing_session_id = $1`,
    [filingSessionId]
  );
  const email = rows[0]?.email?.trim();
  const dealId = rows[0]?.crm_deal_id?.trim();
  if (!dealId) return { queued: false, reason: "no Deal on this filing session yet" };
  if (!email) return { queued: false, reason: "no email on this filing session" };
  await db.query(
    `INSERT INTO crm_sync_queue (filing_session_id, sync_type, payload_snapshot) VALUES ($1, $2, $3)`,
    [filingSessionId, RA_DEAL_SYNC_TYPE, JSON.stringify({ crm_deal_id: dealId, expected_email: email, extra_fields: fields })]
  );
  return { queued: true };
}

export const RA_DEAL_SYNC_TYPE = "ra_status_deal_update";
