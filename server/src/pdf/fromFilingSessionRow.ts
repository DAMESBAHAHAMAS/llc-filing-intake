import type { FilingSessionRecord } from "./types.js";

export interface FilingSessionRow {
  filing_session_id: string;
  filing_data: unknown;
}

const REQUIRED_TOP_LEVEL_KEYS: (keyof FilingSessionRecord)[] = [
  "llc_name",
  "principal_street",
  "principal_city",
  "principal_state",
  "principal_zip",
  "mailing_same",
  "agent_choice",
  "agent_name",
  "agent_street",
  "agent_city",
  "agent_state",
  "agent_zip",
  "management_structure",
  "members",
  "managers",
  "additional_authorized_persons",
  "effective_date_option",
];

/**
 * Adapts a persisted filing_sessions row's `filing_data` jsonb column
 * (migration 0004) into composeArticlesOfOrganizationContext's input.
 * This is the ONLY place a raw database row becomes a FilingSessionRecord
 * — the composer itself never touches the database or knows this type
 * exists; it stays a pure function over FilingSessionRecord.
 *
 * Deliberately a thin structural check, not full schema validation (no
 * new validation-library dependency added for that) — it exists so an
 * incomplete row fails here with a specific, row-identified error,
 * before it ever reaches the composer's own per-field checks.
 */
export function filingSessionRecordFromRow(row: FilingSessionRow): FilingSessionRecord {
  if (!row.filing_data || typeof row.filing_data !== "object") {
    throw new Error(
      `filing_sessions row ${row.filing_session_id} has no filing_data — cannot build a PDF context from it`
    );
  }
  const data = row.filing_data as Record<string, unknown>;
  const missing = REQUIRED_TOP_LEVEL_KEYS.filter((key) => data[key] === undefined || data[key] === null);
  if (missing.length) {
    throw new Error(
      `filing_sessions row ${row.filing_session_id}'s filing_data is missing: ${missing.join(", ")}`
    );
  }
  return data as unknown as FilingSessionRecord;
}
