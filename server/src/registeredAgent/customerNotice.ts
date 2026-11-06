import type { Pool } from "pg";
import { describeError } from "../db/describeError.js";
import { hasDiyPackage } from "../offers/diyPackage.js";
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
  stripe_livemode?: boolean | null;
}

/** Orders still waiting to be filed. A released hold stays open: the card
 *  saved at checkout covers it, unless the order was cancelled. */
export async function openFilingOrders(pool: Pool, filingSessionId: string): Promise<OpenFilingOrder[]> {
  const { rows } = await pool.query<OpenFilingOrder>(
    `SELECT order_id, filing_session_id, payment_status, authorized_at, paid_at, line_items, stripe_livemode FROM orders
     WHERE filing_session_id = $1 AND payment_status IN ('authorized', 'released', 'paid')
       AND cancelled_at IS NULL AND proof_of_filing_at IS NULL`,
    [filingSessionId]
  );
  return rows.filter((order) => needsSunbizFiling(order.line_items ?? []));
}

/**
 * Starts filing on any order that was waiting for its registered agent,
 * after registered_agent_status changes to 'accepted' — the other half of
 * the gate routes/webhooksStripe.ts applies at payment time (see that
 * file's own registered-agent-gate comment). Most orders are held, not
 * paid, by this point: the card is charged only after Florida confirms.
 *
 * An order can also be waiting in review with no Articles: the worker reached
 * it while the agent was pending, and its details were locked, so nothing else
 * would bring it back.
 *
 * A released hold still files on other packages. The agent can take the full
 * 7 days a hold lasts, and the customer authorized the saved card for exactly
 * that case; it is charged after Florida confirms (routes/orders.ts). Ops hears
 * about it, because Damian is paying Sunbiz with no hold behind the order. A
 * $139 order can't file on a released hold: approve-filing refuses it until a
 * new hold is placed. A cancelled order never files, and neither does a Stripe
 * test-mode order: the same rule the webhook applied when it was paid.
 */
export async function reevaluateFulfillmentAfterAcceptance(pool: Pool, filingSessionId: string): Promise<void> {
  for (const order of await openFilingOrders(pool, filingSessionId)) {
    if (order.stripe_livemode === false && process.env.TEST_MODE_ORDERS_FILE !== "true") continue;
    const articles = await pool.query(`SELECT 1 FROM filing_documents WHERE order_id = $1 LIMIT 1`, [order.order_id]);
    const started = await pool.query(
      `UPDATE orders SET fulfillment_status = 'ready', fulfillment_ready_at = now(), fulfillment_last_error = NULL
       WHERE order_id = $1 AND cancelled_at IS NULL
         AND (fulfillment_status = 'not_ready' OR (fulfillment_status = 'requires_review' AND approved_unrecorded_at IS NULL AND $2::boolean))`,
      [order.order_id, !articles.rowCount]
    );
    if (!started.rowCount || order.payment_status !== "released") continue;
    if (hasDiyPackage(order.line_items ?? [])) {
      await sendOpsAlert(
        "Agent accepted on an order with no hold",
        `Order ${order.order_id}: the registered agent accepted after the card hold ended, so this order can't file yet. If the customer agrees to a new hold, use replace-authorization with customer_agreed. Otherwise use /cancel. Do not pay Florida until approve-filing succeeds.`
      );
    } else {
      await sendOpsAlert(
        "Filing started with no hold in place",
        `Order ${order.order_id}: the registered agent accepted after the card hold ended. Filing is starting. The saved card is charged after Florida confirms, and it can still decline.`
      );
    }
  }
}

/**
 * The Articles name the registered agent, so a new agent means new Articles.
 * The order waits for the agent, then goes through the worker again. Only for
 * an order no filing has left: the select route refuses one that has, except a
 * rejected filing, which gets corrected Articles when it is resubmitted.
 */
export async function articlesMustBeRedone(pool: Pool, filingSessionId: string): Promise<void> {
  for (const order of await openFilingOrders(pool, filingSessionId)) {
    await pool.query(
      `UPDATE orders SET fulfillment_status = 'not_ready', fulfillment_last_error = NULL
       WHERE order_id = $1 AND fulfillment_status IN ('ready', 'in_progress', 'requires_review') AND approved_unrecorded_at IS NULL`,
      [order.order_id]
    );
  }
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
  // An agent accepted, but the order did not move: the step after the accept
  // is best-effort, and a deploy or a database error can stop it. A released
  // hold is left out: a lapse stopped that filing on purpose, and a renewal restarts it.
  const accepted = await pool.query<{ filing_session_id: string }>(
    `SELECT DISTINCT o.filing_session_id
     FROM orders o JOIN filing_sessions fs ON fs.filing_session_id = o.filing_session_id
     WHERE o.payment_status IN ('authorized', 'paid') AND o.cancelled_at IS NULL AND o.proof_of_filing_at IS NULL
       AND o.fulfillment_status IN ('not_ready', 'requires_review')
       AND fs.filing_data->>'registered_agent_path' = 'customer' AND fs.registered_agent_status = 'accepted'`
  );
  for (const { filing_session_id } of accepted.rows) {
    await reevaluateFulfillmentAfterAcceptance(pool, filing_session_id).catch((err) => console.error(`[agent sweep] session ${filing_session_id}:`, describeError(err)));
  }

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
