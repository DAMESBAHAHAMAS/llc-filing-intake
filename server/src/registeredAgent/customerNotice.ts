import type { Pool } from "pg";
import { describeError } from "../db/describeError.js";
import { needsSunbizFiling } from "../offers/sunbizFiling.js";
import { sendOpsAlert } from "../ops/alerts.js";
import { queueOrderEmail } from "../orderEmails/worker.js";
import type { AgentProblem } from "../orderEmails/templates.js";

export const AGENT_RESPONSE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface OpenFilingOrder {
  order_id: string;
  filing_session_id: string;
  payment_status: string;
  authorized_at: Date | string | null;
  paid_at: Date | string | null;
  line_items: Array<{ offer_code?: string }> | null;
}

/** Orders still waiting to be filed. A released hold stays open: the card
 *  saved at checkout covers it, unless the order was cancelled. */
export async function openFilingOrders(pool: Pool, filingSessionId: string): Promise<OpenFilingOrder[]> {
  const { rows } = await pool.query<OpenFilingOrder>(
    `SELECT order_id, filing_session_id, payment_status, authorized_at, paid_at, line_items FROM orders
     WHERE filing_session_id = $1 AND payment_status IN ('authorized', 'released', 'paid')
       AND cancelled_at IS NULL AND proof_of_filing_at IS NULL`,
    [filingSessionId]
  );
  return rows.filter((order) => needsSunbizFiling(order.line_items ?? []));
}

const OPS_LINE: Record<AgentProblem, string> = {
  declined: "The registered agent declined.",
  not_accepted: "The registered agent did not accept within 7 days.",
};

/**
 * Tells the customer and ops, once per agent asked. The order is not
 * touched: it stays open for the customer to name another agent or cancel.
 */
export async function notifyAgentProblem(pool: Pool, order: Pick<OpenFilingOrder, "order_id" | "filing_session_id">, acceptanceId: string, problem: AgentProblem): Promise<boolean> {
  const { isNew } = await queueOrderEmail(pool, {
    orderId: order.order_id,
    filingSessionId: order.filing_session_id,
    emailTypes: ["agent_action_needed"],
    paymentMode: "hold",
    dedupeKey: `agent-${acceptanceId}`,
    details: { agent_problem: problem },
  });
  if (isNew) {
    await sendOpsAlert("Registered agent needs replacing", `Order ${order.order_id}: ${OPS_LINE[problem]} The customer has been asked to name another agent or cancel. Filing is on hold, and the order stays open.`);
  }
  return isNew;
}

/**
 * One pass over orders blocked on the customer's own agent. Catches the
 * agents who never answered, which nothing else would notice, and is the
 * backstop for a decline whose notice failed.
 */
export async function runAgentAcceptanceSweepOnce(pool: Pool, now: Date = new Date()): Promise<{ notified: number }> {
  const { rows } = await pool.query<OpenFilingOrder>(
    `SELECT o.order_id, o.filing_session_id, o.payment_status, o.authorized_at, o.paid_at, o.line_items
     FROM orders o JOIN filing_sessions fs ON fs.filing_session_id = o.filing_session_id
     WHERE o.payment_status IN ('authorized', 'released', 'paid') AND o.cancelled_at IS NULL AND o.proof_of_filing_at IS NULL
       AND fs.filing_data->>'registered_agent_path' = 'customer'
       AND fs.registered_agent_status IS DISTINCT FROM 'accepted'`
  );

  let notified = 0;
  for (const order of rows.filter((o) => needsSunbizFiling(o.line_items ?? []))) {
    try {
      const latest = await pool.query<{ id: string | number; status: string; requested_at: Date | string | null }>(
        `SELECT id, status, requested_at FROM registered_agent_acceptances
         WHERE filing_session_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
        [order.filing_session_id]
      );
      const acceptance = latest.rows[0];
      const key = String(acceptance?.id ?? "none");
      if (acceptance?.status === "declined") {
        if (await notifyAgentProblem(pool, order, key, "declined")) notified++;
        continue;
      }
      const askedAt = acceptance?.requested_at ?? order.authorized_at ?? order.paid_at;
      if (!askedAt || now.getTime() - new Date(askedAt).getTime() < AGENT_RESPONSE_WINDOW_MS) continue;

      if (acceptance?.status === "acceptance_requested") {
        await pool.query(`UPDATE registered_agent_acceptances SET status = 'expired' WHERE id = $1 AND status = 'acceptance_requested'`, [acceptance.id]);
      }
      await pool.query(
        `UPDATE filing_sessions SET registered_agent_status = 'expired' WHERE filing_session_id = $1 AND registered_agent_status IS DISTINCT FROM 'accepted'`,
        [order.filing_session_id]
      );
      if (await notifyAgentProblem(pool, order, key, "not_accepted")) notified++;
    } catch (err) {
      console.error(`[agent sweep] order ${order.order_id}:`, describeError(err));
    }
  }
  return { notified };
}
