import type { Pool } from "pg";
import { describeError } from "../db/describeError.js";
import { sendOpsAlert } from "../ops/alerts.js";
import { backoffForAttempt, isDeadLetter } from "../sync/backoff.js";
import type { OrderEmailSender } from "./sender.js";
import { buildOrderEmail, type OrderEmailRow, type OrderEmailType, type PaymentMode } from "./templates.js";

/**
 * Customer order emails run through crm_sync_queue rather than a new
 * table: enqueued in the same transaction as the payment or filing state
 * they announce, and sent by this worker, never inline (frozen rule, see
 * routes/webhooksStripe.ts). They reuse the queue's backoff and dead
 * letter states, under their own sync_type, so sync/worker.ts leaves them
 * alone and a mail failure never touches crm_sync_status.
 *
 * A row is the record of one email: status 'synced' means sent, last_error
 * holds the latest failure, and GET /api/orders/:orderId/emails shows both.
 */
export const CUSTOMER_EMAIL_SYNC_TYPE_PATTERN = "customer_email_%";
const syncTypeFor = (type: OrderEmailType) => `customer_email_${type}`;
const typeFromSyncType = (syncType: string) => syncType.replace("customer_email_", "") as OrderEmailType;

/** A worker that died mid-send leaves its row 'processing'. Resend's
 *  idempotency key makes reclaiming it safe. */
const STALE_CLAIM_MINUTES = 10;

export const CHECKOUT_EMAIL_TYPES: OrderEmailType[] = ["welcome", "order_confirmation", "intake_summary"];

interface EnqueueInput {
  orderId: string;
  filingSessionId: string;
  emailTypes: OrderEmailType[];
  paymentMode: PaymentMode;
}

type QueryClient = { query: (text: string, params?: unknown[]) => Promise<unknown> };

/**
 * Queues each email at most once per order, which is what stops a repeated
 * webhook or a repeated proof-of-filing call from sending twice. The caller
 * must be inside a transaction holding the order row's lock (FOR UPDATE, or
 * an UPDATE of that row): that lock is what makes NOT EXISTS safe here
 * without a unique index.
 *
 * A savepoint keeps a failure here from aborting the payment transaction
 * around it. Returns false in that case so the caller can alert.
 */
export async function enqueueCustomerEmails(client: QueryClient, input: EnqueueInput): Promise<boolean> {
  try {
    await client.query("SAVEPOINT customer_emails");
    for (const emailType of input.emailTypes) {
      await client.query(
        `INSERT INTO crm_sync_queue (filing_session_id, order_id, sync_type, payload_snapshot)
         SELECT $1::uuid, $2::uuid, $3::text, $4::jsonb
         WHERE NOT EXISTS (SELECT 1 FROM crm_sync_queue WHERE order_id = $2::uuid AND sync_type = $3::text)`,
        [input.filingSessionId, input.orderId, syncTypeFor(emailType), JSON.stringify({ payment_mode: input.paymentMode })]
      );
    }
    await client.query("RELEASE SAVEPOINT customer_emails");
    return true;
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT customer_emails");
    console.error(`[order emails] could not queue ${input.emailTypes.join(", ")} for order ${input.orderId}:`, describeError(err));
    return false;
  }
}

export async function alertEmailsNotQueued(orderId: string, what: string): Promise<void> {
  await sendOpsAlert("Customer emails not queued", `Order ${orderId}: ${what} could not be queued, so the customer will not get them. The order itself is safe.`);
}

export interface ClaimedEmailJob {
  id: number;
  order_id: string;
  sync_type: string;
  payload_snapshot: { payment_mode?: PaymentMode } & Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

/** Same FOR UPDATE SKIP LOCKED claim as sync/worker.ts's claimNextJob. */
export async function claimNextEmailJob(pool: Pool, lockedBy: string): Promise<ClaimedEmailJob | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const picked = await client.query<{ id: number }>(
      `SELECT id FROM crm_sync_queue
       WHERE sync_type LIKE $1
         AND ((status = 'pending' AND run_after <= now())
           OR (status = 'processing' AND locked_at < now() - ($2 || ' minutes')::interval))
       ORDER BY run_after ASC, id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [CUSTOMER_EMAIL_SYNC_TYPE_PATTERN, String(STALE_CLAIM_MINUTES)]
    );

    if (picked.rowCount === 0) {
      await client.query("COMMIT");
      return null;
    }

    const updated = await client.query<ClaimedEmailJob>(
      `UPDATE crm_sync_queue
       SET status = 'processing', locked_at = now(), locked_by = $2
       WHERE id = $1
       RETURNING id, order_id, sync_type, payload_snapshot, attempts, max_attempts`,
      [picked.rows[0].id, lockedBy]
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

async function loadOrderRow(pool: Pool, orderId: string): Promise<OrderEmailRow | null> {
  const { rows } = await pool.query<OrderEmailRow>(
    `SELECT o.order_id, o.line_items, o.total_cents, o.proof_of_filing_ref,
            fs.email, fs.full_name, fs.phone, fs.country, fs.entity_name_primary, fs.entity_name_backup,
            fs.filing_data, fs.registered_agent_status
     FROM orders o JOIN filing_sessions fs ON fs.filing_session_id = o.filing_session_id
     WHERE o.order_id = $1`,
    [orderId]
  );
  return rows[0] ?? null;
}

interface SendOutcome {
  ok: boolean;
  error?: string;
  /** No retry can fix this, so the job stops now instead of backing off. */
  permanent?: boolean;
  providerMessageId?: string;
}

async function sendJob(pool: Pool, sender: OrderEmailSender, job: ClaimedEmailJob): Promise<SendOutcome> {
  const type = typeFromSyncType(job.sync_type);
  const row = await loadOrderRow(pool, job.order_id);
  if (!row) return { ok: false, permanent: true, error: "order not found" };
  if (!row.email) return { ok: false, permanent: true, error: "no customer email on the filing session" };

  const email = buildOrderEmail(type, row, job.payload_snapshot.payment_mode ?? "hold");
  const result = await sender.send({ to: row.email, ...email, idempotencyKey: `order-email/${job.order_id}/${type}` });
  return { ok: result.ok, error: result.error, providerMessageId: result.providerMessageId };
}

async function recordOutcome(pool: Pool, job: ClaimedEmailJob, outcome: SendOutcome): Promise<void> {
  if (outcome.ok) {
    const sent = { ...job.payload_snapshot, provider_message_id: outcome.providerMessageId ?? null, sent_at: new Date().toISOString() };
    await pool.query(
      `UPDATE crm_sync_queue
       SET status = 'synced', locked_at = NULL, locked_by = NULL, last_error = NULL, payload_snapshot = $2
       WHERE id = $1`,
      [job.id, JSON.stringify(sent)]
    );
    return;
  }

  const attempts = job.attempts + 1;
  const error = outcome.error ?? "unknown error";
  const label = `${typeFromSyncType(job.sync_type)} for order ${job.order_id}`;
  console.error(`[order emails] ${label} failed (attempt ${attempts}): ${error}`);

  if (outcome.permanent || isDeadLetter(attempts, job.max_attempts)) {
    await pool.query(
      `UPDATE crm_sync_queue
       SET status = 'dead_letter', attempts = $2, locked_at = NULL, locked_by = NULL, last_error = $3
       WHERE id = $1`,
      [job.id, attempts, error]
    );
    await sendOpsAlert("Customer email gave up", `${label} will not be retried: ${error}. The customer has not received it.`);
    return;
  }

  await pool.query(
    `UPDATE crm_sync_queue
     SET status = 'pending', attempts = $2, run_after = now() + ($3 || ' milliseconds')::interval,
         locked_at = NULL, locked_by = NULL, last_error = $4
     WHERE id = $1`,
    [job.id, attempts, String(backoffForAttempt(attempts)), error]
  );
  if (attempts === 1) {
    await sendOpsAlert("Customer email failed", `${label}: ${error}. It will retry automatically.`);
  }
}

/** Claims and sends one email. Returns false when nothing is due. */
export async function processOne(pool: Pool, sender: OrderEmailSender, lockedBy: string): Promise<boolean> {
  const job = await claimNextEmailJob(pool, lockedBy);
  if (!job) return false;
  let outcome: SendOutcome;
  try {
    outcome = await sendJob(pool, sender, job);
  } catch (err) {
    outcome = { ok: false, error: describeError(err) };
  }
  await recordOutcome(pool, job, outcome);
  return true;
}

export async function runOnce(pool: Pool, sender: OrderEmailSender, lockedBy = "order-email-worker"): Promise<number> {
  let processed = 0;
  // eslint-disable-next-line no-constant-condition
  while (await processOne(pool, sender, lockedBy)) {
    processed++;
  }
  return processed;
}

export interface OrderEmailStatus {
  email_type: OrderEmailType;
  status: string;
  attempts: number;
  last_error: string | null;
  provider_message_id: string | null;
  sent_at: string | null;
}

/** Per-order send record for the operator endpoint. */
export async function listOrderEmails(pool: Pool, orderId: string): Promise<OrderEmailStatus[]> {
  const { rows } = await pool.query<{
    sync_type: string;
    status: string;
    attempts: number;
    last_error: string | null;
    payload_snapshot: { provider_message_id?: string | null; sent_at?: string | null };
  }>(
    `SELECT sync_type, status, attempts, last_error, payload_snapshot
     FROM crm_sync_queue WHERE order_id = $1 AND sync_type LIKE $2 ORDER BY id ASC`,
    [orderId, CUSTOMER_EMAIL_SYNC_TYPE_PATTERN]
  );
  return rows.map((row) => ({
    email_type: typeFromSyncType(row.sync_type),
    status: row.status === "synced" ? "sent" : row.status,
    attempts: row.attempts,
    last_error: row.last_error,
    provider_message_id: row.payload_snapshot?.provider_message_id ?? null,
    sent_at: row.payload_snapshot?.sent_at ?? null,
  }));
}
