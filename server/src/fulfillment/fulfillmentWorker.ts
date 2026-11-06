import type { Pool } from "pg";
import { backoffForAttempt, isDeadLetter } from "../sync/backoff.js";
import { buildPdfContext } from "../pdf/context.js";
import type { FilingSessionRecord } from "../pdf/types.js";
import { generateArticlesOfOrganizationPdf } from "../pdf/serviceClient.js";
import { sendOpsAlert } from "../ops/alerts.js";
import { hasDiyPackage } from "../offers/diyPackage.js";

const MAX_FULFILLMENT_ATTEMPTS = 6;

/** Far longer than one PDF render, so an order this old has no worker left. */
export const STALLED_AFTER_MS = 15 * 60 * 1000;

export interface ClaimedOrder {
  order_id: string;
  filing_session_id: string;
  fulfillment_attempts: number;
  payment_status?: string;
  line_items?: Array<{ offer_code?: string }> | null;
}

/**
 * Claims exactly one order whose fulfillment_status='ready' and whose
 * backoff window has elapsed, using the same FOR UPDATE SKIP LOCKED
 * pattern as sync/worker.ts's claimNextJob (Gate 1) — see DECISIONS.md
 * ("fulfillment uses orders' own state machine, not a queue table").
 */
export async function claimNextReadyOrder(pool: Pool, lockedBy: string): Promise<ClaimedOrder | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const picked = await client.query<{ order_id: string }>(
      `SELECT order_id FROM orders
       WHERE fulfillment_status = 'ready'
         AND NOT (line_items @> '[{"offer_code":"LIVE_TEST_NO_FILING"}]'::jsonb)
         AND (payment_status IN ('authorized', 'paid') OR (payment_status = 'released' AND cancelled_at IS NULL))
         AND (fulfillment_run_after IS NULL OR fulfillment_run_after <= now())
       ORDER BY fulfillment_ready_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`
    );

    if (picked.rowCount === 0) {
      await client.query("COMMIT");
      return null;
    }

    const updated = await client.query<ClaimedOrder>(
      `UPDATE orders
       SET fulfillment_status = 'in_progress', fulfillment_started_at = now()
       WHERE order_id = $1
       RETURNING order_id, filing_session_id, fulfillment_attempts, payment_status, line_items`,
      [picked.rows[0].order_id]
    );

    await client.query("COMMIT");
    return updated.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Processes exactly one claimed order through PDF generation and
 * persistence. Stops at fulfillment_status='requires_review' after a
 * successful PDF render — actual fax transmission to the state/IRS
 * (fulfillment_transmissions, Telnyx) is NOT implemented in this pass:
 * it needs Telnyx credentials this environment doesn't have and would be
 * a new third-party dependency (standing rule 5) — logged as an
 * explicit gap in DECISIONS.md rather than stubbed with a fabricated
 * "success." 'requires_review' is an honest use of the schema's own
 * existing vocabulary for "a human needs to look at this next," not a
 * failure state.
 *
 * A data-completeness gap (buildPdfContext returning ok:false) also
 * lands in 'requires_review', with the missing fields recorded in
 * fulfillment_last_error — this is not a transient failure to retry on
 * a timer, it needs the customer/ops to actually supply the missing
 * data, so it is deliberately NOT re-queued via backoff.
 */
export async function processClaimedOrder(pool: Pool, order: ClaimedOrder): Promise<void> {
  const sessionRes = await pool.query<{ filing_data: Partial<FilingSessionRecord> | null; registered_agent_status: string | null }>(
    `SELECT filing_data, registered_agent_status FROM filing_sessions WHERE filing_session_id = $1`,
    [order.filing_session_id]
  );

  const filingData = sessionRes.rows[0]?.filing_data ?? {};
  const registeredAgentStatus = sessionRes.rows[0]?.registered_agent_status ?? null;

  const contextResult = buildPdfContext(filingData, registeredAgentStatus);
  if (!contextResult.ok) {
    await pool.query(
      `UPDATE orders
       SET fulfillment_status = 'requires_review',
           fulfillment_last_error = $2
       WHERE order_id = $1`,
      [order.order_id, `Filing data incomplete: ${contextResult.missingFields.join(", ")}`]
    );
    await sendOpsAlert("Filing needs review: details missing", `Order ${order.order_id} cannot be filed. Missing: ${contextResult.missingFields.join(", ")}.`);
    return;
  }

  const pdfResult = await generateArticlesOfOrganizationPdf(contextResult.context);

  if (!pdfResult.ok) {
    const newAttempts = order.fulfillment_attempts + 1;
    if (isDeadLetter(newAttempts, MAX_FULFILLMENT_ATTEMPTS)) {
      await pool.query(
        `UPDATE orders SET fulfillment_status = 'failed', fulfillment_attempts = $2, fulfillment_last_error = $3 WHERE order_id = $1`,
        [order.order_id, newAttempts, pdfResult.error]
      );
      await sendOpsAlert("Articles could not be generated", `Order ${order.order_id}: PDF generation gave up after ${newAttempts} attempts. ${pdfResult.error}`);
    } else {
      const waitMs = backoffForAttempt(newAttempts);
      await pool.query(
        `UPDATE orders
         SET fulfillment_status = 'ready',
             fulfillment_attempts = $2,
             fulfillment_run_after = now() + ($3 || ' milliseconds')::interval,
             fulfillment_last_error = $4
         WHERE order_id = $1`,
        [order.order_id, newAttempts, String(waitMs), pdfResult.error]
      );
    }
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO filing_documents (filing_session_id, order_id, byte_size, sha256, pdf_bytes)
       VALUES ($1, $2, $3, $4, $5)`,
      [order.filing_session_id, order.order_id, pdfResult.pdfBytes.length, pdfResult.sha256, pdfResult.pdfBytes]
    );
    await client.query(
      `UPDATE orders
       SET fulfillment_status = 'requires_review', fulfillment_last_error = NULL
       WHERE order_id = $1`,
      [order.order_id]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  await sendOpsAlert("Filing ready for review", readyForReview(order));
}

function readyForReview(order: ClaimedOrder): string {
  const generated = `Order ${order.order_id}: the Articles are generated.`;
  if (!hasDiyPackage(order.line_items ?? [])) return `${generated} Review them, file at Sunbiz, then record the submission.`;
  if (order.payment_status === "released") {
    return `${generated} Its card hold has ended, so it can't file. If the customer agrees to a new hold, use replace-authorization with customer_agreed. Otherwise use /cancel. Do not pay Florida until approve-filing succeeds.`;
  }
  return `${generated} Review them, then call approve-filing, the last check before Florida is paid. If it refuses, do not file. If it approves, file at Sunbiz at once, then record the submission.`;
}

/**
 * Puts orders back whose worker died mid-render, which only a deploy or a
 * thrown database error can do. They count as a failed attempt, so an order
 * that kills its worker every time stops at 'failed' instead of looping.
 */
export async function reapStalledOrders(pool: Pool, now: Date): Promise<number> {
  const { rows } = await pool.query<{ order_id: string; fulfillment_attempts: number }>(
    `SELECT order_id, fulfillment_attempts FROM orders WHERE fulfillment_status = 'in_progress' AND fulfillment_started_at < $1`,
    [new Date(now.getTime() - STALLED_AFTER_MS)]
  );
  for (const row of rows) {
    const attempts = row.fulfillment_attempts + 1;
    const gaveUp = isDeadLetter(attempts, MAX_FULFILLMENT_ATTEMPTS);
    const { rowCount } = await pool.query(
      `UPDATE orders SET fulfillment_status = $2, fulfillment_attempts = $3, fulfillment_last_error = 'the worker stopped before finishing this order'
        WHERE order_id = $1 AND fulfillment_status = 'in_progress'`,
      [row.order_id, gaveUp ? "failed" : "ready", attempts]
    );
    if (rowCount) {
      await sendOpsAlert(
        gaveUp ? "Articles could not be generated" : "A stalled filing was restarted",
        `Order ${row.order_id}: the worker stopped while generating its Articles, attempt ${attempts}. ${gaveUp ? "It will not retry by itself. Fix the cause, then use retry-articles, or /cancel it." : "It has gone back in the queue."}`
      );
    }
  }
  return rows.length;
}

export async function processOne(pool: Pool, lockedBy: string): Promise<boolean> {
  const order = await claimNextReadyOrder(pool, lockedBy);
  if (!order) return false;
  await processClaimedOrder(pool, order);
  return true;
}

export async function runOnce(pool: Pool, lockedBy = "fulfillment-worker"): Promise<number> {
  let processed = 0;
  // eslint-disable-next-line no-constant-condition
  while (await processOne(pool, lockedBy)) {
    processed++;
  }
  return processed;
}
