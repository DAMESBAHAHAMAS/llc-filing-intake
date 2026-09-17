import type { Pool } from "pg";
import type { DealStageUpdatePayload, OrderSyncPayload, ZohoClient, ZohoSyncResult } from "../zoho/client.js";
import { backoffForAttempt, isDeadLetter } from "./backoff.js";

export interface ClaimedJob {
  id: number;
  filing_session_id: string;
  order_id: string | null;
  sync_type: string;
  payload_snapshot: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

/**
 * Claims exactly one eligible job (status='pending', run_after <= now())
 * using SELECT ... FOR UPDATE SKIP LOCKED so concurrent workers never
 * double-claim the same row, then marks it 'processing' — all inside one
 * short transaction that commits immediately. The row lock is NOT held
 * during the external Zoho call that follows; 'processing' status alone
 * keeps other workers off this row until the outcome is recorded.
 */
export async function claimNextJob(pool: Pool, lockedBy: string): Promise<ClaimedJob | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const picked = await client.query<{ id: number }>(
      `SELECT id FROM crm_sync_queue
       WHERE status = 'pending' AND run_after <= now()
       ORDER BY run_after ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`
    );

    if (picked.rowCount === 0) {
      await client.query("COMMIT");
      return null;
    }

    const jobId = picked.rows[0].id;
    const updated = await client.query<ClaimedJob & { payload_snapshot: unknown }>(
      `UPDATE crm_sync_queue
       SET status = 'processing', locked_at = now(), locked_by = $2
       WHERE id = $1
       RETURNING id, filing_session_id, order_id, sync_type, payload_snapshot, attempts, max_attempts`
    , [jobId, lockedBy]);

    await client.query("COMMIT");
    const row = updated.rows[0];
    return { ...row, payload_snapshot: row.payload_snapshot as Record<string, unknown> };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs the Zoho sync for one claimed job, applying the 401-retry rule:
 * a 401 triggers exactly one immediate retry that is NOT counted against
 * max_attempts (only the final outcome, after that retry, is recorded as
 * "the attempt"). Any other failure (including a second 401) is recorded
 * as a normal failed attempt.
 */
function dispatchSync(client: ZohoClient, job: ClaimedJob): Promise<ZohoSyncResult> {
  if (job.sync_type === "order_deal" || job.sync_type === "abandoned_cart") {
    return client.syncOrderEvent(job.payload_snapshot as unknown as OrderSyncPayload);
  }
  if (job.sync_type === "deal_stage_update") {
    return client.updateDealStage(job.payload_snapshot as unknown as DealStageUpdatePayload);
  }
  return client.syncSession(job.payload_snapshot);
}

async function syncWithOneFreeAuthRetry(client: ZohoClient, job: ClaimedJob): Promise<ZohoSyncResult> {
  const first = await dispatchSync(client, job);
  if (first.ok || first.httpStatus !== 401) {
    return first;
  }
  // Free retry — a fresh token is pulled inside the client method itself
  // on every call (see zoho/client.ts), so simply calling again is the
  // "immediate token refresh + retry."
  return dispatchSync(client, job);
}

/**
 * Records the outcome of a processed job — success or failure — inside
 * its own short transaction. On success, also updates the owning
 * filing_sessions row (crm_lead_id/crm_deal_id/crm_sync_status/
 * crm_last_synced_at) in the SAME transaction as marking the queue row
 * synced, so the two can't disagree.
 */
async function recordOutcome(pool: Pool, job: ClaimedJob, result: ZohoSyncResult): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (result.ok) {
      await client.query(
        `UPDATE crm_sync_queue
         SET status = 'synced', locked_at = NULL, locked_by = NULL, last_error = NULL
         WHERE id = $1`,
        [job.id]
      );
      if (job.order_id && result.dealId) {
        // Order-scoped job (paid_deal): the Deal belongs to the order,
        // not the session — orders.crm_deal_id is the one place a Deal
        // ID for THIS order is recorded, satisfying "exactly one Deal
        // per paid filing session" without overloading
        // filing_sessions.crm_deal_id (which Gate 1 already uses for a
        // different, session-level purpose).
        await client.query(`UPDATE orders SET crm_deal_id = $2 WHERE order_id = $1`, [job.order_id, result.dealId]);
      }
      await client.query(
        `UPDATE filing_sessions
         SET crm_lead_id = COALESCE($2, crm_lead_id),
             crm_deal_id = COALESCE($3, crm_deal_id),
             crm_sync_status = 'synced',
             crm_last_synced_at = now()
         WHERE filing_session_id = $1`,
        [job.filing_session_id, result.leadId ?? null, job.order_id ? null : result.dealId ?? null]
      );
    } else {
      const newAttempts = job.attempts + 1;
      if (isDeadLetter(newAttempts, job.max_attempts)) {
        await client.query(
          `UPDATE crm_sync_queue
           SET status = 'dead_letter', attempts = $2, locked_at = NULL, locked_by = NULL, last_error = $3
           WHERE id = $1`,
          [job.id, newAttempts, result.error ?? "unknown error"]
        );
        await client.query(
          `UPDATE filing_sessions SET crm_sync_status = 'dead_letter' WHERE filing_session_id = $1`,
          [job.filing_session_id]
        );
      } else {
        const waitMs = backoffForAttempt(newAttempts);
        await client.query(
          `UPDATE crm_sync_queue
           SET status = 'pending', attempts = $2, run_after = now() + ($3 || ' milliseconds')::interval,
               locked_at = NULL, locked_by = NULL, last_error = $4
           WHERE id = $1`,
          [job.id, newAttempts, String(waitMs), result.error ?? "unknown error"]
        );
        await client.query(
          `UPDATE filing_sessions SET crm_sync_status = 'failed' WHERE filing_session_id = $1`,
          [job.filing_session_id]
        );
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Claims and processes exactly one job, if one is eligible. Returns
 *  false when there was nothing to claim (caller can stop polling). */
export async function processOne(pool: Pool, zohoClient: ZohoClient, lockedBy: string): Promise<boolean> {
  const job = await claimNextJob(pool, lockedBy);
  if (!job) return false;

  const result = await syncWithOneFreeAuthRetry(zohoClient, job);
  await recordOutcome(pool, job, result);
  return true;
}

/** Drains every currently-eligible job (used by tests and by the
 *  production poller's tick). */
export async function runOnce(pool: Pool, zohoClient: ZohoClient, lockedBy = "worker"): Promise<number> {
  let processed = 0;
  // eslint-disable-next-line no-constant-condition
  while (await processOne(pool, zohoClient, lockedBy)) {
    processed++;
  }
  return processed;
}
