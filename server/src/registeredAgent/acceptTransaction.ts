/**
 * T144 D12: one transaction for the agent's acceptance.
 *
 * Using the token, storing the signed acceptance and opening the filing gate
 * (filing_sessions.registered_agent_status = 'accepted') commit together, so a
 * failure part-way can no longer leave a used token with the gate still shut.
 * The row is locked first, so two clicks cannot both accept.
 */
import type { Pool } from "pg";
import { isUndefinedColumn, RA_ACCEPTANCE_STATEMENT_VERSION, signatureMatchesAgent } from "./acceptanceRecord.js";

export type AcceptOutcome =
  | { kind: "accepted"; signed: boolean }
  | { kind: "not_actionable"; status: string }
  | { kind: "signature_mismatch"; agentName: string }
  | { kind: "signature_storage_unavailable" };

/** True once migration 0033 is applied (the signature columns exist). */
export async function signatureColumnsExist(pool: Pool): Promise<boolean> {
  try {
    await pool.query(`SELECT signature_name, accepted_agent_name FROM registered_agent_acceptances LIMIT 0`);
    return true;
  } catch (err) {
    if (isUndefinedColumn(err)) return false;
    throw err;
  }
}

export async function recordAcceptance(
  pool: Pool,
  input: {
    acceptanceId: number;
    filingSessionId: string;
    signatureName: string | null;
    ip: string | null;
    userAgent: string | null | undefined;
    acceptedAt: Date;
    requireSignature: boolean;
  }
): Promise<AcceptOutcome> {
  const canStore = await signatureColumnsExist(pool);
  if (!canStore && input.requireSignature) return { kind: "signature_storage_unavailable" };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ status: string; registered_agent_name: string }>(
      `SELECT status, registered_agent_name FROM registered_agent_acceptances WHERE id = $1 FOR UPDATE`,
      [input.acceptanceId]
    );
    const row = rows[0];
    if (!row || row.status !== "acceptance_requested") {
      await client.query("ROLLBACK");
      return { kind: "not_actionable", status: row?.status ?? "missing" };
    }
    // The agent named in the request (server-written when the email went out), not filing_data.
    if (input.signatureName && !signatureMatchesAgent(input.signatureName, row.registered_agent_name)) {
      await client.query("ROLLBACK");
      return { kind: "signature_mismatch", agentName: row.registered_agent_name };
    }

    await client.query(
      `UPDATE registered_agent_acceptances SET status = 'accepted', accepted_at = $2, accepted_ip = $3 WHERE id = $1`,
      [input.acceptanceId, input.acceptedAt, input.ip]
    );

    if (canStore) {
      // What the agent saw on the page and accepted: the address and LLC as they
      // stand now. The Articles print the signature only while these still match.
      const fd = await client.query<{ filing_data: Record<string, unknown> | null }>(
        `SELECT filing_data FROM filing_sessions WHERE filing_session_id = $1`,
        [input.filingSessionId]
      );
      const data = fd.rows[0]?.filing_data ?? {};
      const str = (k: string) => (typeof data[k] === "string" ? (data[k] as string).trim() : "");
      await client.query(
        `UPDATE registered_agent_acceptances
         SET signature_name = $2, signature_consent = $3, accepted_user_agent = $4, statement_version = $5,
             accepted_agent_name = $6, accepted_agent_address = $7, accepted_llc_name = $8
         WHERE id = $1`,
        [
          input.acceptanceId,
          input.signatureName,
          input.signatureName !== null,
          typeof input.userAgent === "string" ? input.userAgent.slice(0, 300) : null,
          RA_ACCEPTANCE_STATEMENT_VERSION,
          row.registered_agent_name,
          str("registered_agent_florida_address"),
          str("llc_name"),
        ]
      );
    } else if (input.signatureName) {
      console.warn(`[ra accept] migration 0033 not applied: signature for acceptance ${input.acceptanceId} not stored`);
    }

    await client.query(`UPDATE filing_sessions SET registered_agent_status = 'accepted' WHERE filing_session_id = $1`, [
      input.filingSessionId,
    ]);
    await client.query("COMMIT");
    return { kind: "accepted", signed: canStore && input.signatureName !== null };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
