import type { Pool } from "pg";
import { backoffForAttempt, isDeadLetter } from "../sync/backoff.js";
import { buildPdfContext } from "../pdf/context.js";
import type { FilingSessionRecord } from "../pdf/types.js";
import { generateArticlesOfOrganizationPdf } from "../pdf/serviceClient.js";

const MAX_FULFILLMENT_ATTEMPTS = 6;

export interface ClaimedOrder {
  order_id: string;
  filing_session_id: string;
  fulfillment_attempts: number;
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
       RETURNING order_id, filing_session_id, fulfillment_attempts`,
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
