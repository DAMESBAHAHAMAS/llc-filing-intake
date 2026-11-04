import type { Pool } from "pg";

export type FilingBlockerCode = "registered_agent_not_accepted" | "articles_pdf_missing";

export interface FilingBlocker {
  code: FilingBlockerCode;
  error: string;
}

/**
 * What must be true before an order can be filed, and again before its proof
 * of filing is accepted: "must accept before we can file", and Articles that
 * exist for this order. The fulfillment worker stores the PDF under the order
 * id, so a pre-payment copy (order_id NULL) does not count: it may predate a
 * correction.
 */
export async function findFilingBlocker(pool: Pick<Pool, "query">, order: { order_id: string; filing_session_id: string }): Promise<FilingBlocker | null> {
  const session = await pool.query<{ filing_data: { registered_agent_path?: string } | null; registered_agent_status: string | null }>(
    `SELECT filing_data, registered_agent_status FROM filing_sessions WHERE filing_session_id = $1`,
    [order.filing_session_id]
  );
  const agent = session.rows[0];
  if (agent?.filing_data?.registered_agent_path === "customer" && agent.registered_agent_status !== "accepted") {
    return { code: "registered_agent_not_accepted", error: "the customer's registered agent has not accepted" };
  }
  const pdf = await pool.query(`SELECT 1 FROM filing_documents WHERE order_id = $1 LIMIT 1`, [order.order_id]);
  if (!pdf.rowCount) {
    return { code: "articles_pdf_missing", error: "the Articles of Organization PDF for this order does not exist yet" };
  }
  return null;
}
