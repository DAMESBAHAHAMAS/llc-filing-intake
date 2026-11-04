import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { describeError } from "../db/describeError.js";
import { sendOpsAlert } from "../ops/alerts.js";
import { backoffForAttempt, isDeadLetter } from "../sync/backoff.js";
import type { OrderEmailSender } from "./sender.js";
import { buildOrderEmail, type AgentProblem, type OrderEmailRow, type OrderEmailType, type PaymentMode, type RenderedEmail } from "./templates.js";
import { blockedByTestMode, TEST_MODE_NOT_SENT } from "./testAddress.js";

/**
 * Customer order emails run through crm_sync_queue rather than a new
 * table: enqueued in the same transaction as the payment or filing state
 * they announce, and sent by this worker, never inline (frozen rule, see
 * routes/webhooksStripe.ts). They reuse the queue's backoff and dead
 * letter states, under their own sync_type, so sync/worker.ts leaves them
 * alone and a mail failure never touches crm_sync_status.
 *
 * A row is the record of one email: status 'synced' means sent, 'skipped'
 * means the order moved on so it was not sent, last_error holds the latest
 * failure or the reason for a skip, and GET /api/orders/:orderId/emails
 * shows them. The filing confirmation is not here: it gates collection, so
 * routes/orders.ts sends it through proofDelivery/deliverProof.ts.
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
  /** Set for an email that can recur on one order (one per agent asked,
   *  for example). Without it, each type is sent once per order. */
  dedupeKey?: string;
  /** Extra fields the template needs, kept on the job. */
  details?: { amount_cents?: number; agent_problem?: AgentProblem; charge_kind?: "fallback" | "deferred"; rejection_reason?: string };
}

type QueryClient = { query: (text: string, params?: unknown[]) => Promise<unknown> };

async function insertEmailJobs(client: QueryClient, input: EnqueueInput): Promise<number> {
  const dedupeKey = input.dedupeKey ?? "";
  let inserted = 0;
  for (const emailType of input.emailTypes) {
    const payload = { payment_mode: input.paymentMode, ...(dedupeKey ? { dedupe_key: dedupeKey } : {}), ...input.details };
    const result = (await client.query(
      `INSERT INTO crm_sync_queue (filing_session_id, order_id, sync_type, payload_snapshot)
       SELECT $1::uuid, $2::uuid, $3::text, $4::jsonb
       WHERE NOT EXISTS (
         SELECT 1 FROM crm_sync_queue
         WHERE order_id = $2::uuid AND sync_type = $3::text AND COALESCE(payload_snapshot->>'dedupe_key', '') = $5::text
       )`,
      [input.filingSessionId, input.orderId, syncTypeFor(emailType), JSON.stringify(payload), dedupeKey]
    )) as { rowCount?: number | null } | undefined;
    inserted += result?.rowCount ?? 0;
  }
  return inserted;
}

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
    await insertEmailJobs(client, input);
    await client.query("RELEASE SAVEPOINT customer_emails");
    return true;
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT customer_emails");
    console.error(`[order emails] could not queue ${input.emailTypes.join(", ")} for order ${input.orderId}:`, describeError(err));
    return false;
  }
}

/**
 * For callers outside a payment transaction. Takes the order row lock
 * enqueueCustomerEmails needs, and reports whether a new job went in, so a
 * caller alerts ops only the first time. Never throws.
 */
export async function queueOrderEmail(pool: Pool, input: EnqueueInput): Promise<{ queued: boolean; isNew: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT order_id FROM orders WHERE order_id = $1 FOR UPDATE`, [input.orderId]);
    const inserted = await insertEmailJobs(client, input);
    await client.query("COMMIT");
    return { queued: true, isNew: inserted > 0 };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(`[order emails] could not queue ${input.emailTypes.join(", ")} for order ${input.orderId}:`, describeError(err));
    await alertEmailsNotQueued(input.orderId, input.emailTypes.join(", "));
    return { queued: false, isNew: false };
  } finally {
    client.release();
  }
}

export async function alertEmailsNotQueued(orderId: string, what: string): Promise<void> {
  await sendOpsAlert("Customer emails not queued", `Order ${orderId}: ${what} could not be queued, so the customer will not get them. The order itself is safe.`);
}

export interface ClaimedEmailJob {
  id: number;
  order_id: string;
  sync_type: string;
  payload_snapshot: {
    payment_mode?: PaymentMode;
    dedupe_key?: string;
    resend_count?: number;
    amount_cents?: number;
    agent_problem?: AgentProblem;
    charge_kind?: "fallback" | "deferred";
    rejection_reason?: string;
  } & Record<string, unknown>;
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

export interface OrderEmailState extends OrderEmailRow {
  payment_status: string;
  authorized_at: Date | string | null;
  cancelled_at: Date | string | null;
  deferred_charged_at: Date | string | null;
  stripe_livemode: boolean | null;
  fulfillment_status?: string | null;
}

export const ORDER_EMAIL_COLUMNS = `o.order_id, o.line_items, o.total_cents, o.deferred_cents, o.proof_of_filing_ref,
            o.payment_status, o.authorized_at, o.cancelled_at, o.deferred_charged_at, o.stripe_livemode, o.fulfillment_status,
            fs.email, fs.full_name, fs.phone, fs.country, fs.entity_name_primary, fs.entity_name_backup,
            fs.filing_data, fs.registered_agent_status`;

async function loadOrderRow(pool: Pool, orderId: string): Promise<OrderEmailState | null> {
  const { rows } = await pool.query<OrderEmailState>(
    `SELECT ${ORDER_EMAIL_COLUMNS}
     FROM orders o JOIN filing_sessions fs ON fs.filing_session_id = o.filing_session_id
     WHERE o.order_id = $1`,
    [orderId]
  );
  return rows[0] ?? null;
}

/** The order's payment as it stands now. Null when no payment is in place,
 *  so nothing may describe one. */
export function currentPaymentMode(row: Pick<OrderEmailState, "payment_status" | "authorized_at">): PaymentMode | null {
  if (row.payment_status === "authorized") return "hold";
  if (row.payment_status === "paid") return row.authorized_at ? "collected" : "paid";
  return null;
}

type SendDecision = { send: true; mode: PaymentMode } | { send: false; reason: string };

/**
 * Decided from the order as it stands at send time, not when the email was
 * queued: a retry can run hours later, and the wording must fit by then.
 * An order that is released, refunded or failed gets no hold wording,
 * because nothing it says would still be true.
 */
export function decideSend(type: OrderEmailType, row: OrderEmailState, job: Pick<ClaimedEmailJob, "payload_snapshot">): SendDecision {
  const mode = currentPaymentMode(row);
  const skip = (reason: string): SendDecision => ({ send: false, reason });
  const orderIs = `order is ${row.cancelled_at ? "cancelled" : row.payment_status}`;

  if (type === "order_cancelled") {
    return row.cancelled_at ? { send: true, mode: mode ?? "hold" } : skip("order is not cancelled");
  }
  if (row.cancelled_at) return skip(orderIs);

  if (type === "payment_problem") {
    if (job.payload_snapshot.charge_kind === "deferred") {
      return row.deferred_charged_at ? skip("the service charge has since gone through") : { send: true, mode: mode ?? "hold" };
    }
    if (row.payment_status !== "released" && row.payment_status !== "authorized") return skip(orderIs);
    return { send: true, mode: "hold" };
  }

  if (type === "agent_action_needed") {
    if (row.registered_agent_status === "accepted") return skip("the registered agent has since accepted");
    if (row.payment_status === "released") return { send: true, mode: "hold" };
    return mode ? { send: true, mode } : skip(orderIs);
  }

  if (type === "filing_rejected") {
    if (row.fulfillment_status !== "rejected") return skip("the filing is no longer rejected");
    if (row.payment_status === "released") return { send: true, mode: "hold" };
    return mode ? { send: true, mode } : skip(orderIs);
  }

  return mode ? { send: true, mode } : skip(orderIs);
}

interface SendOutcome {
  ok: boolean;
  error?: string;
  /** No retry can fix this, so the job stops now instead of backing off. */
  permanent?: boolean;
  /** Deliberately not sent; the reason goes in last_error. */
  skipped?: boolean;
  providerMessageId?: string;
}

/**
 * Resend replays a key for identical content, which covers a retry after a
 * lost response. The same key with different content is refused (409), and
 * every email here is re-rendered per attempt, so a retry after the order
 * changed would fail until the job gave up, and report a failure for an
 * email the customer may already have. The content hash keeps those apart.
 * An operator resend is a deliberate new send, so it gets its own key.
 */
export function idempotencyKeyFor(job: Pick<ClaimedEmailJob, "order_id" | "payload_snapshot">, type: OrderEmailType, to: string, email: RenderedEmail): string {
  const hash = createHash("sha256").update(JSON.stringify([to, email.subject, email.text, email.html])).digest("hex").slice(0, 16);
  const { dedupe_key: dedupeKey, resend_count: resendCount } = job.payload_snapshot;
  return [`order-email/${job.order_id}/${type}`, dedupeKey, resendCount ? `resend-${resendCount}` : null, hash].filter(Boolean).join("/");
}

async function sendJob(pool: Pool, sender: OrderEmailSender, job: ClaimedEmailJob): Promise<SendOutcome> {
  const type = typeFromSyncType(job.sync_type);
  const row = await loadOrderRow(pool, job.order_id);
  if (!row) return { ok: false, permanent: true, error: "order not found" };
  if (!row.email) return { ok: false, permanent: true, error: "no customer email on the filing session" };
  if (blockedByTestMode(row.stripe_livemode, row.email)) return { ok: false, skipped: true, error: TEST_MODE_NOT_SENT };

  const decision = decideSend(type, row, job);
  if (!decision.send) return { ok: false, skipped: true, error: decision.reason };

  const email = buildOrderEmail(type, row, decision.mode, {
    amountCents: job.payload_snapshot.amount_cents,
    agentProblem: job.payload_snapshot.agent_problem,
    rejectionReason: job.payload_snapshot.rejection_reason,
  });
  const result = await sender.send({ to: row.email, ...email, idempotencyKey: idempotencyKeyFor(job, type, row.email, email) });
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

  if (outcome.skipped) {
    await pool.query(
      `UPDATE crm_sync_queue SET status = 'skipped', locked_at = NULL, locked_by = NULL, last_error = $2 WHERE id = $1`,
      [job.id, outcome.error ?? null]
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

/** Per-order send record for the operator endpoint. The filing confirmation
 *  lives on the order, because it gates collection. */
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
  const emails: OrderEmailStatus[] = rows.map((row) => ({
    email_type: typeFromSyncType(row.sync_type),
    status: row.status === "synced" ? "sent" : row.status,
    attempts: row.attempts,
    last_error: row.last_error,
    provider_message_id: row.payload_snapshot?.provider_message_id ?? null,
    sent_at: row.payload_snapshot?.sent_at ?? null,
  }));

  const proof = await pool.query<{
    proof_of_filing_at: Date | string | null;
    proof_delivered_at: Date | string | null;
    proof_delivery_message_id: string | null;
    proof_delivery_error: string | null;
  }>(`SELECT proof_of_filing_at, proof_delivered_at, proof_delivery_message_id, proof_delivery_error FROM orders WHERE order_id = $1`, [orderId]);
  const order = proof.rows[0];
  if (order?.proof_of_filing_at) {
    emails.push({
      email_type: "filing_confirmation",
      status: order.proof_delivered_at ? "sent" : "failed",
      attempts: order.proof_delivered_at || order.proof_delivery_error ? 1 : 0,
      last_error: order.proof_delivery_error,
      provider_message_id: order.proof_delivery_message_id,
      sent_at: order.proof_delivered_at ? new Date(order.proof_delivered_at).toISOString() : null,
    });
  }
  return emails;
}

const RESENDABLE_TYPES: OrderEmailType[] = ["welcome", "order_confirmation", "intake_summary", "payment_problem", "agent_action_needed", "filing_rejected", "order_cancelled"];

export function isResendableEmailType(type: string): type is OrderEmailType {
  return (RESENDABLE_TYPES as string[]).includes(type);
}

/**
 * Puts a dead-lettered email back in the queue with a fresh set of
 * attempts. The worker then decides again from the order as it stands, so
 * a resend can never carry wording the order has outgrown.
 */
export async function requeueDeadLetteredEmail(pool: Pool, orderId: string, type: OrderEmailType): Promise<number> {
  const { rows } = await pool.query<{ id: number; payload_snapshot: ClaimedEmailJob["payload_snapshot"] }>(
    `SELECT id, payload_snapshot FROM crm_sync_queue WHERE order_id = $1 AND sync_type = $2 AND status = 'dead_letter'`,
    [orderId, syncTypeFor(type)]
  );
  for (const row of rows) {
    const payload = { ...row.payload_snapshot, resend_count: (row.payload_snapshot.resend_count ?? 0) + 1 };
    await pool.query(
      `UPDATE crm_sync_queue
       SET status = 'pending', attempts = 0, run_after = now(), locked_at = NULL, locked_by = NULL, last_error = NULL, payload_snapshot = $2
       WHERE id = $1`,
      [row.id, JSON.stringify(payload)]
    );
  }
  return rows.length;
}
