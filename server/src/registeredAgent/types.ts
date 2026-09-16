/**
 * The six authoritative values from the locked Gate 2 registered-agent
 * acceptance schema. Do not add, rename, or remove a value here without
 * that schema being re-approved — the filing gate, the acceptance
 * service, and the database CHECK constraint (migration 0005) all assume
 * exactly this set.
 */
export type RegisteredAgentStatus =
  | "pending"
  | "acceptance_requested"
  | "accepted"
  | "declined"
  | "expired"
  | "email_failed";

/** The only status that satisfies the filing gate (§6 of the schema). */
export const ACCEPTED: RegisteredAgentStatus = "accepted";

export interface RegisteredAgentInfo {
  name: string;
  email: string;
  street: string;
  unit?: string;
  city: string;
  state: string;
  zip: string;
}

/** A row of registered_agent_acceptances, exactly the 8 locked fields
 *  plus the housekeeping columns every table in this project has. */
export interface RegisteredAgentAcceptanceRow {
  id: number;
  filing_session_id: string;
  status: RegisteredAgentStatus;
  requested_at: Date | null;
  accepted_at: Date | null;
  registered_agent_name: string;
  registered_agent_email: string;
  accepted_ip: string | null;
  acceptance_token_id: string;
  acceptance_version: string;
  created_at: Date;
  updated_at: Date;
}

/** How long an issued acceptance link remains valid. Not a stored column
 *  (the locked schema has no expires_at field) — computed from
 *  requested_at at read/verify time. See acceptanceService.ts. */
export const ACCEPTANCE_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Bump this when the acceptance language/document changes. Recorded on
 *  every acceptance record so it's always knowable which version of the
 *  designation language a given registered agent actually saw. */
export const CURRENT_ACCEPTANCE_VERSION = "2026-08-v1";
