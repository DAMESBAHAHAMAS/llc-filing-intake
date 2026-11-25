/**
 * T144 Dispatch 12: the customer's own registered agent signs the acceptance.
 *
 * The agent types their full name under the statutory statement on the
 * acceptance page. The signature and its audit details (time, the visitor's IP
 * via True-Client-IP, user agent, statement version, and what was accepted:
 * agent name, Florida address, LLC name) are stored on the
 * registered_agent_acceptances row (migration 0033) inside the same
 * transaction that uses the token and opens the filing gate. Nothing here is
 * read from or written to the client-writable filing_sessions.filing_data.
 *
 * Rollout: the published website still sends only { token }. Until the new
 * acceptance page is published, a missing signature is accepted (button-only).
 * Set RA_ACCEPT_REQUIRE_SIGNATURE=true after Damian publishes the page.
 */
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { VERIFIED_DEAL_JOIN } from "../ein/portalJobs.js";
import type { DealStageUpdatePayload } from "../zoho/client.js";

/** The statement the agent signs: the Article III acceptance on the Sunbiz Articles form. */
export const RA_ACCEPTANCE_STATEMENT =
  "Having been named as registered agent and to accept service of process for the above stated limited liability company at the place designated in this certificate, I hereby accept the appointment as registered agent and agree to act in this capacity. I further agree to comply with the provisions of all statutes relating to the proper and complete performance of my duties, and I am familiar with and accept the obligations of my position as registered agent as provided for in Chapter 605, F.S.";
export const RA_ACCEPTANCE_STATEMENT_VERSION = "ra-statement-2026-11-25";
/** Wording by version, so a stored acceptance always prints what was signed. */
export const RA_STATEMENTS: Record<string, string> = { [RA_ACCEPTANCE_STATEMENT_VERSION]: RA_ACCEPTANCE_STATEMENT };

/** Status wording shown to the customer and written to the Zoho Deal (picklist values to create). */
export const RA_STATUS_AWAITING = "Awaiting agent acceptance";
export const RA_STATUS_ACCEPTED = "Agent Accepted — Ready for Sunbiz";
export const RA_STATUS_DECLINED = "Agent declined";
export const RA_STATUS_EXPIRED = "Agent acceptance expired";
export const RA_STATUS_EMAIL_FAILED = "Agent email failed";

export const RA_DEAL_SYNC_TYPE = "ra_status_deal_update";

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

/** Lower case, accents and punctuation removed, single spaces. */
export function normalizeName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Legal-form words only, so a person whose surname is "Agent" or "Service" is still matched by name. */
const ENTITY_WORDS = /\b(llc|l l c|inc|incorporated|corp|corporation|company|ltd|limited|lp|llp|pllc|p a)\b/;

/** True when the named registered agent is a business, which a person signs for. */
export function isEntityName(agentName: string): boolean {
  return ENTITY_WORDS.test(normalizeName(agentName));
}

/**
 * The typed name must be the named agent's: case, accents, punctuation and
 * spacing ignored, and a middle name or initial allowed (the first and last
 * words of the named agent must both appear). A business agent is signed for
 * by a person, so any name is accepted there and printed "for" the business.
 */
export function signatureMatchesAgent(signature: string, agentName: string): boolean {
  if (isEntityName(agentName)) return true;
  const want = normalizeName(agentName).split(" ").filter(Boolean);
  const have = new Set(normalizeName(signature).split(" ").filter(Boolean));
  if (want.length === 0) return false;
  return have.has(want[0]) && have.has(want[want.length - 1]);
}

export type SignatureCheck =
  | { ok: true; signatureName: string | null }
  | { ok: false; status: 400; error: string; code: "signature_required" | "signature_invalid" | "consent_required" };

/** Validates the signature fields of an accept request (the agent-name match is checked against the acceptance row). */
export function checkSignature(body: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): SignatureCheck {
  const provided = body.signature_name !== undefined && body.signature_name !== null && body.signature_name !== "";
  if (!provided) {
    return requireSignature(env)
      ? { ok: false, status: 400, code: "signature_required", error: "signature_name (the agent's full name) is required" }
      : { ok: true, signatureName: null };
  }
  const name = cleanSignatureName(body.signature_name);
  if (!name) return { ok: false, status: 400, code: "signature_invalid", error: "signature_name must be the agent's full name (2-120 characters)" };
  if (body.consent !== true) return { ok: false, status: 400, code: "consent_required", error: "consent must be true to sign the acceptance" };
  return { ok: true, signatureName: name };
}

export function tokenRef(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/** The signed acceptance as stored on the registered_agent_acceptances row. */
export interface StoredAcceptance {
  signature_name: string | null;
  accepted_at: Date | string;
  accepted_ip: string | null;
  accepted_user_agent: string | null;
  statement_version: string | null;
  accepted_agent_name: string | null;
  accepted_agent_address: string | null;
  accepted_llc_name: string | null;
  acceptance_token_id: string;
}

/**
 * The latest accepted row of a session with its signature columns, or null.
 * Before migration 0033 is applied the columns do not exist: that is "no
 * signature on file", not an error.
 */
export async function loadStoredAcceptance(db: Pool | PoolClient, filingSessionId: string): Promise<StoredAcceptance | null> {
  try {
    const { rows } = await db.query<StoredAcceptance>(
      `SELECT signature_name, accepted_at, accepted_ip, accepted_user_agent, statement_version,
              accepted_agent_name, accepted_agent_address, accepted_llc_name, acceptance_token_id
       FROM registered_agent_acceptances
       WHERE filing_session_id = $1 AND status = 'accepted'
       ORDER BY accepted_at DESC NULLS LAST
       LIMIT 1`,
      [filingSessionId]
    );
    return rows[0] ?? null;
  } catch (err) {
    if (isUndefinedColumn(err)) return null; // 0033 not applied yet
    throw err;
  }
}

/** Postgres undefined_column (42703); the message check covers test databases without codes. */
export function isUndefinedColumn(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === "42703" || /column .* does not exist/i.test(e?.message ?? "");
}

/** Status text for the Deal from filing_sessions.registered_agent_status. */
export function raStatusLabel(status: string | null | undefined): string | null {
  switch (status) {
    case "accepted": return RA_STATUS_ACCEPTED;
    case "pending":
    case "acceptance_requested": return RA_STATUS_AWAITING;
    case "declined": return RA_STATUS_DECLINED;
    case "expired": return RA_STATUS_EXPIRED;
    case "email_failed": return RA_STATUS_EMAIL_FAILED;
    default: return null;
  }
}

function validFieldName(v: string | undefined): string {
  return v && /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(v) ? v : "";
}

/** Deals.RA_Acceptance_Status (text, id 2654294000040675015), created by the dispatcher 25 Nov 2026. */
export const DEFAULT_RA_DEAL_STATUS_FIELD = "RA_Acceptance_Status";

/**
 * The Deal field for the agent status: RA_DEAL_STATUS_FIELD when set,
 * otherwise RA_Acceptance_Status. Set RA_DEAL_STATUS_FIELD=off to switch the
 * Deal update off. A malformed name also switches it off.
 */
export function raDealStatusField(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.RA_DEAL_STATUS_FIELD;
  if (v === undefined) return DEFAULT_RA_DEAL_STATUS_FIELD;
  if (v.trim().toLowerCase() === "off") return "";
  return validFieldName(v.trim());
}

export function raDealSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return raDealStatusField(env) !== "";
}

/** The Deal of the session's earliest held or paid order whose Deal id a sync job verified (#26's rule). */
async function verifiedDeal(db: Pool | PoolClient, filingSessionId: string): Promise<{ crm_deal_id: string; order_id: string } | null> {
  const { rows } = await db.query<{ crm_deal_id: string; order_id: string }>(
    `SELECT o.crm_deal_id, o.order_id
     FROM orders o
     ${VERIFIED_DEAL_JOIN}
     WHERE o.filing_session_id = $1
       AND o.payment_status IN ('authorized', 'paid')
       AND o.crm_deal_id IS NOT NULL
     ORDER BY COALESCE(o.authorized_at, o.paid_at) ASC
     LIMIT 1`,
    [filingSessionId]
  );
  return rows[0] ?? null;
}

async function verifiedDealId(db: Pool | PoolClient, filingSessionId: string): Promise<string | null> {
  return (await verifiedDeal(db, filingSessionId))?.crm_deal_id ?? null;
}

/**
 * Queues "write the agent status to the Deal" for a session. The job carries
 * no status: the worker reads the CURRENT status when it sends (raDealPayloadNow),
 * so a retried or older job can never put "Awaiting" back over "Accepted".
 * Nothing is queued while the switch is off or before the session has a
 * verified Deal (a held or paid order). A pending job for the same session is
 * brought forward instead of duplicated.
 */
export async function queueRaDealStatus(
  db: Pool | PoolClient,
  filingSessionId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ queued: boolean; reason?: string }> {
  if (!raDealSyncEnabled(env)) return { queued: false, reason: "RA Deal status switched off (RA_DEAL_STATUS_FIELD=off)" };
  const deal = await verifiedDeal(db, filingSessionId);
  if (!deal) return { queued: false, reason: "no verified Deal (held or paid order) yet" };
  const pending = await db.query(
    `SELECT 1 FROM crm_sync_queue WHERE filing_session_id = $1 AND sync_type = $2 AND status = 'pending' LIMIT 1`,
    [filingSessionId, RA_DEAL_SYNC_TYPE]
  );
  if (pending.rowCount) {
    // It sends the current status anyway; just make it go now rather than after its backoff.
    await db.query(
      `UPDATE crm_sync_queue SET run_after = now() WHERE filing_session_id = $1 AND sync_type = $2 AND status = 'pending'`,
      [filingSessionId, RA_DEAL_SYNC_TYPE]
    );
    return { queued: true, reason: "pending job brought forward" };
  }
  await db.query(
    `INSERT INTO crm_sync_queue (filing_session_id, order_id, sync_type, payload_snapshot) VALUES ($1, $2, $3, $4)`,
    [filingSessionId, deal.order_id, RA_DEAL_SYNC_TYPE, JSON.stringify({ queued_at: new Date().toISOString() })]
  );
  return { queued: true };
}

/**
 * Built by the worker at send time: the verified Deal and the session's
 * current agent status. The Deal is ours by the verified-Deal rule, so the
 * update goes out as server_created (no client-supplied Deal id or email is used).
 */
export async function raDealPayloadNow(
  db: Pool | PoolClient,
  filingSessionId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ ok: true; payload: DealStageUpdatePayload } | { ok: false; reason: string }> {
  const statusField = raDealStatusField(env);
  if (!statusField) return { ok: false, reason: "RA Deal status switched off (RA_DEAL_STATUS_FIELD=off)" };
  const dealId = await verifiedDealId(db, filingSessionId);
  if (!dealId) return { ok: false, reason: "no verified Deal for this filing session" };
  const { rows } = await db.query<{ registered_agent_status: string | null }>(
    `SELECT registered_agent_status FROM filing_sessions WHERE filing_session_id = $1`,
    [filingSessionId]
  );
  const status = rows[0]?.registered_agent_status;
  const label = raStatusLabel(status);
  if (!label) return { ok: false, reason: `no agent status to send (${status ?? "none"})` };
  const extra: Record<string, unknown> = { [statusField]: label };
  const atField = validFieldName(env.RA_DEAL_ACCEPTED_AT_FIELD);
  if (atField && status === "accepted") {
    const acc = await loadStoredAcceptance(db, filingSessionId);
    if (acc?.accepted_at) extra[atField] = new Date(acc.accepted_at).toISOString().replace(/\.\d{3}Z$/, "+00:00");
  }
  return { ok: true, payload: { crm_deal_id: dealId, expected_email: "", server_created: true, extra_fields: extra } };
}
