import type { Pool } from "pg";
import { describeError } from "../db/describeError.js";
import { backoffForAttempt, isDeadLetter } from "../sync/backoff.js";
import { filingSessionRecordFromRow } from "../pdf/fromFilingSessionRow.js";
import { composeArticlesOfOrganizationContext } from "../pdf/composeArticlesOfOrganizationContext.js";
import { generateArticlesOfOrganizationPdf } from "../pdf/generatePdf.js";
import { storeFilingDocument, mintMediaAccessToken } from "./documentStore.js";
import type { FaxProvider } from "./faxProvider.js";

/**
 * The Sunbiz-fulfillment transmission layer. Picks up where
 * webhook/stripeWebhookService.ts leaves off: orders.fulfillment_status
 * = 'ready' (payment verified + filing_data present) is this worker's
 * entire input. Everything below is deliberately modeled on
 * sync/worker.ts + sync/backoff.ts (claim via FOR UPDATE SKIP LOCKED,
 * process outside the lock, record the outcome in its own transaction,
 * the exact same backoff/dead-letter schedule) — reused, not
 * reinvented, per this task's own instruction not to build a parallel
 * system.
 *
 * Destination is never hardcoded: `deps.destinationNumber`/`destinationLabel`
 * come from FULFILLMENT_FAX_DESTINATION_NUMBER/_LABEL (index.ts wires
 * these from env) — this module has no idea whether it's dialing a free
 * Phase-1 test line or the real Sunbiz fax number, and never will.
 */

const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_STALE_CLAIM_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MEDIA_TOKEN_TTL_MS = 60 * 60_000;

export interface FulfillmentDeps {
  faxProvider: FaxProvider;
  /** Base URL this service is reachable at from the public internet —
   *  what the fax provider's media_url is built from. Injectable so
   *  tests never need a real reachable URL. */
  mediaBaseUrl: string;
  destinationNumber: string;
  destinationLabel?: string;
  /** Defaults to generateArticlesOfOrganizationPdf (the real, existing
   *  PDF-service client) — injectable so tests never need a running
   *  PDF_SERVICE_URL. */
  generatePdf?: typeof generateArticlesOfOrganizationPdf;
  maxAttempts?: number;
  staleClaimTimeoutMs?: number;
  mediaTokenTtlMs?: number;
  now?: () => Date;
}

interface ClaimedOrder {
  order_id: string;
  filing_session_id: string;
  fulfillment_attempts: number;
}

/**
 * Claims exactly one eligible order — either a fresh 'ready' order past
 * its backoff window, or an 'in_progress' order stuck long enough to
 * assume its worker crashed mid-attempt — and flips it to 'in_progress'
 * inside one short transaction. Eligibility ALSO requires the filing
 * session's registered agent to be 'accepted': acceptanceService.ts's
 * own comment names this exact function's absence as the gap ("the
 * actual gate... the function any future filing-submission path...
 * should call before proceeding. Not wired to a caller yet"). An order
 * that's paid and has filing_data but whose registered agent hasn't
 * accepted yet is simply not selected — not a failure, not an attempt,
 * just not yet eligible; it's picked up automatically the moment
 * registered_agent_status flips to 'accepted', with no separate wiring
 * needed here.
 */
export async function claimNextFulfillmentJob(
  pool: Pool,
  staleClaimTimeoutMs = DEFAULT_STALE_CLAIM_TIMEOUT_MS
): Promise<ClaimedOrder | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const picked = await client.query<{ order_id: string }>(
      `SELECT o.order_id
       FROM orders o
       JOIN filing_sessions fs ON fs.filing_session_id = o.filing_session_id
       WHERE fs.registered_agent_status = 'accepted'
         AND (
           (o.fulfillment_status = 'ready' AND (o.fulfillment_run_after IS NULL OR o.fulfillment_run_after <= now()))
           OR (o.fulfillment_status = 'in_progress' AND o.fulfillment_started_at < now() - ($1 || ' milliseconds')::interval)
         )
       ORDER BY COALESCE(o.fulfillment_ready_at, o.fulfillment_started_at) ASC
       LIMIT 1
       FOR UPDATE OF o SKIP LOCKED`,
      [String(staleClaimTimeoutMs)]
    );

    if (picked.rowCount === 0) {
      await client.query("COMMIT");
      return null;
    }

    const orderId = picked.rows[0].order_id;
    const updated = await client.query<ClaimedOrder>(
      `UPDATE orders
       SET fulfillment_status = 'in_progress', fulfillment_started_at = now()
       WHERE order_id = $1
       RETURNING order_id, filing_session_id, fulfillment_attempts`,
      [orderId]
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
 * Reserves the next attempt_number for this order with a 'pending' row
 * BEFORE any PDF generation or transmission is attempted — so even a
 * failure during PDF generation itself (before a document exists) is
 * durably recorded with the right attempt_number, destination, and
 * (once it fails) failure_reason. UNIQUE(order_id, attempt_number) means
 * two processes racing to record the same attempt cannot both succeed;
 * the loser's INSERT fails and that process's tick simply errors out
 * (surfacing as a normal retryable error, not a duplicate transmission).
 *
 * orders.fulfillment_attempts is bumped HERE, atomically with the
 * reservation — it counts attempts MADE, not attempts that failed, so it
 * is correct the instant a transmission row exists, before its outcome
 * is known. recordAttemptFailure (below) therefore never re-increments
 * it — it only reads the value this function already wrote.
 */
async function reserveTransmissionAttempt(
  pool: Pool,
  order: ClaimedOrder,
  destinationNumber: string,
  destinationLabel: string | undefined
): Promise<{ transmissionId: number; attemptNumber: number }> {
  const attemptNumber = order.fulfillment_attempts + 1;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO fulfillment_transmissions
         (order_id, filing_session_id, attempt_number, destination_type, destination_label, destination_value, status)
       VALUES ($1, $2, $3, 'fax', $4, $5, 'pending')
       RETURNING id`,
      [order.order_id, order.filing_session_id, attemptNumber, destinationLabel ?? null, destinationNumber]
    );
    await client.query(`UPDATE orders SET fulfillment_attempts = $2 WHERE order_id = $1`, [order.order_id, attemptNumber]);
    await client.query("COMMIT");
    return { transmissionId: Number(rows[0].id), attemptNumber };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function attachDocument(pool: Pool, transmissionId: number, documentId: number): Promise<void> {
  await pool.query(`UPDATE fulfillment_transmissions SET document_id = $2 WHERE id = $1`, [transmissionId, documentId]);
}

async function markTransmissionFailed(pool: Pool, transmissionId: number, reason: string): Promise<void> {
  await pool.query(
    `UPDATE fulfillment_transmissions SET status = 'failed', failure_reason = $2, completed_at = now() WHERE id = $1`,
    [transmissionId, reason]
  );
}

/**
 * Written BEFORE the fax provider is ever called — the provider may
 * fetch media_url within moments of accepting the send request, so the
 * token must already be resolvable in the database by then. Sequencing
 * this after the send call would create a real race: a fast provider
 * fetch could 404 against a token that doesn't exist yet.
 */
async function attachMediaToken(pool: Pool, transmissionId: number, mediaTokenId: string, mediaExpiresAt: Date): Promise<void> {
  await pool.query(
    `UPDATE fulfillment_transmissions SET media_access_token_id = $2, media_access_expires_at = $3 WHERE id = $1`,
    [transmissionId, mediaTokenId, mediaExpiresAt]
  );
}

async function markTransmissionSubmitted(pool: Pool, transmissionId: number, providerTransmissionId: string): Promise<void> {
  await pool.query(
    `UPDATE fulfillment_transmissions SET status = 'submitted', provider_transmission_id = $2, submitted_at = now() WHERE id = $1`,
    [transmissionId, providerTransmissionId]
  );
}

/**
 * Records the outcome of an attempt that did not reach 'submitted' —
 * atomically applies the SAME backoff/dead-letter schedule
 * sync/backoff.ts already defines for crm_sync_queue (reused, not
 * duplicated): under the ceiling, the order goes back to 'ready' with
 * fulfillment_run_after set; at the ceiling, it moves to
 * 'requires_review' — a human must look, exactly the state this task
 * asked for. A filing_events audit row is written either way, reusing
 * the existing append-only audit table (migration 0002) rather than a
 * new one.
 */
async function recordAttemptFailure(
  pool: Pool,
  order: Pick<ClaimedOrder, "order_id" | "filing_session_id">,
  transmissionId: number,
  /** The attempt_number reserveTransmissionAttempt already assigned (and
   *  already wrote to orders.fulfillment_attempts) for THIS attempt —
   *  authoritative, never re-derived from a possibly-stale ClaimedOrder
   *  snapshot. Two different call sites (processOneFulfillmentJob, right
   *  after reservation, vs. reconcileOneTransmission, reading the order
   *  fresh afterwards) would otherwise disagree about whether
   *  order.fulfillment_attempts already reflects this attempt or not —
   *  passing the number explicitly removes that ambiguity entirely. */
  newAttempts: number,
  reason: string,
  maxAttempts: number
): Promise<void> {
  await markTransmissionFailed(pool, transmissionId, reason);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (isDeadLetter(newAttempts, maxAttempts)) {
      await client.query(
        `UPDATE orders
         SET fulfillment_status = 'requires_review', fulfillment_attempts = $2, fulfillment_last_error = $3
         WHERE order_id = $1`,
        [order.order_id, newAttempts, reason]
      );
      await client.query(
        `INSERT INTO filing_events (filing_session_id, event_type, payload) VALUES ($1, $2, $3)`,
        [order.filing_session_id, "fulfillment_requires_review", { order_id: order.order_id, attempts: newAttempts, reason }]
      );
    } else {
      const waitMs = backoffForAttempt(newAttempts);
      await client.query(
        `UPDATE orders
         SET fulfillment_status = 'ready', fulfillment_attempts = $2, fulfillment_last_error = $3,
             fulfillment_run_after = now() + ($4 || ' milliseconds')::interval
         WHERE order_id = $1`,
        [order.order_id, newAttempts, reason, String(waitMs)]
      );
      await client.query(
        `INSERT INTO filing_events (filing_session_id, event_type, payload) VALUES ($1, $2, $3)`,
        [order.filing_session_id, "fulfillment_attempt_failed", { order_id: order.order_id, attempts: newAttempts, reason, retry_in_ms: waitMs }]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Claims and fully processes exactly one eligible order: generate the
 * filing package, retain the PDF, transmit it, record the result.
 * Returns false when there was nothing eligible to claim (caller stops
 * polling).
 *
 * "Idempotent... a retry must not create a duplicate filing or duplicate
 * fulfillment record": the claim step (SKIP LOCKED, immediate
 * 'in_progress' transition) means no two concurrent ticks can ever
 * process the same order at once, and reserveTransmissionAttempt's
 * UNIQUE(order_id, attempt_number) makes a duplicate row for the SAME
 * attempt a constraint violation, not a possibility. A genuine retry
 * (this function running again after a prior attempt failed and its
 * backoff elapsed) is, by design, an explicit new attempt — a new row
 * with the next attempt_number — which is the intended, auditable
 * behavior, not a bug.
 */
export async function processOneFulfillmentJob(pool: Pool, deps: FulfillmentDeps): Promise<boolean> {
  const order = await claimNextFulfillmentJob(pool, deps.staleClaimTimeoutMs ?? DEFAULT_STALE_CLAIM_TIMEOUT_MS);
  if (!order) return false;

  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const generatePdf = deps.generatePdf ?? generateArticlesOfOrganizationPdf;
  const { transmissionId, attemptNumber } = await reserveTransmissionAttempt(pool, order, deps.destinationNumber, deps.destinationLabel);

  let pdfBytes: Buffer;
  try {
    const { rows } = await pool.query<{ filing_session_id: string; filing_data: unknown }>(
      "SELECT filing_session_id, filing_data FROM filing_sessions WHERE filing_session_id = $1",
      [order.filing_session_id]
    );
    if (!rows.length) throw new Error(`filing_sessions row ${order.filing_session_id} not found`);
    const record = filingSessionRecordFromRow(rows[0] as { filing_session_id: string; filing_data: unknown });
    const context = composeArticlesOfOrganizationContext(record);
    pdfBytes = await generatePdf(context);
  } catch (err) {
    await recordAttemptFailure(pool, order, transmissionId, attemptNumber, `PDF generation failed: ${describeError(err)}`, maxAttempts);
    return true;
  }

  const { documentId } = await storeFilingDocument(pool, {
    filingSessionId: order.filing_session_id,
    orderId: order.order_id,
    pdfBytes,
  });
  await attachDocument(pool, transmissionId, documentId);

  const { raw: mediaToken, tokenId: mediaTokenId } = mintMediaAccessToken();
  const mediaTokenTtlMs = deps.mediaTokenTtlMs ?? DEFAULT_MEDIA_TOKEN_TTL_MS;
  const now = deps.now?.() ?? new Date();
  const mediaExpiresAt = new Date(now.getTime() + mediaTokenTtlMs);
  // Persisted BEFORE sendFax is called — see attachMediaToken's own
  // comment on why this ordering matters.
  await attachMediaToken(pool, transmissionId, mediaTokenId, mediaExpiresAt);
  const mediaUrl = `${deps.mediaBaseUrl.replace(/\/$/, "")}/api/fax-media/${mediaToken}`;

  const sendResult = await deps.faxProvider.sendFax({ toNumber: deps.destinationNumber, mediaUrl });
  if (!sendResult.ok || !sendResult.providerTransmissionId) {
    await recordAttemptFailure(pool, order, transmissionId, attemptNumber, sendResult.error ?? "fax provider returned no transmission id", maxAttempts);
    return true;
  }

  await markTransmissionSubmitted(pool, transmissionId, sendResult.providerTransmissionId);
  await pool.query(
    `INSERT INTO filing_events (filing_session_id, event_type, payload) VALUES ($1, $2, $3)`,
    [order.filing_session_id, "fulfillment_transmission_submitted", { order_id: order.order_id, transmission_id: transmissionId, provider_transmission_id: sendResult.providerTransmissionId }]
  );
  // fulfillment_status stays 'in_progress' — reconcileOneTransmission is
  // what eventually moves it to 'transmitted' or back into the
  // retry/requires_review path above, once the provider reports a
  // terminal status.
  return true;
}

/**
 * Polls one 'submitted' transmission for a terminal provider status and
 * records the outcome. Claims via FOR UPDATE SKIP LOCKED on
 * fulfillment_transmissions itself (same pattern as the order claim
 * above) so two reconciliation ticks can never race on the same row.
 */
export async function reconcileOneTransmission(pool: Pool, deps: FulfillmentDeps): Promise<boolean> {
  const client = await pool.connect();
  let claimed: { id: number; order_id: string; filing_session_id: string; provider_transmission_id: string; attempt_number: number } | null = null;
  try {
    await client.query("BEGIN");
    const picked = await client.query<{
      id: number;
      order_id: string;
      filing_session_id: string;
      provider_transmission_id: string;
      attempt_number: number;
    }>(
      `SELECT t.id, t.order_id, t.filing_session_id, t.provider_transmission_id, t.attempt_number
       FROM fulfillment_transmissions t
       WHERE t.status = 'submitted'
       ORDER BY t.submitted_at ASC
       LIMIT 1
       FOR UPDATE OF t SKIP LOCKED`
    );
    if (picked.rowCount) claimed = picked.rows[0];
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  if (!claimed) return false;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  // attempt_number IS orders.fulfillment_attempts for this attempt —
  // reserveTransmissionAttempt set both, atomically, to the same value
  // when this row was created. Reading it straight off the transmission
  // row (rather than re-deriving it from orders) is what makes this
  // authoritative regardless of when orders.fulfillment_attempts is
  // re-read relative to that reservation.
  const attemptNumber = claimed.attempt_number;
  const order: Pick<ClaimedOrder, "order_id" | "filing_session_id"> = {
    order_id: claimed.order_id,
    filing_session_id: claimed.filing_session_id,
  };

  const status = await deps.faxProvider.getFaxStatus(claimed.provider_transmission_id);
  if (!status.ok) {
    // Could not even check status (provider unreachable) — leave the
    // transmission row exactly as 'submitted' and try again on the next
    // tick. Not a delivery failure; nothing about the fax itself is
    // known to have failed.
    return true;
  }

  if (status.state === "delivered") {
    await pool.query(
      `UPDATE fulfillment_transmissions SET status = 'delivered', completed_at = now() WHERE id = $1`,
      [claimed.id]
    );
    await pool.query(
      `UPDATE orders SET fulfillment_status = 'transmitted', fulfillment_completed_at = now() WHERE order_id = $1`,
      [order.order_id]
    );
    await pool.query(
      `INSERT INTO filing_events (filing_session_id, event_type, payload) VALUES ($1, $2, $3)`,
      [order.filing_session_id, "fulfillment_transmitted", { order_id: order.order_id, transmission_id: claimed.id, provider_transmission_id: claimed.provider_transmission_id }]
    );
    return true;
  }

  if (status.state === "failed") {
    await recordAttemptFailure(
      pool,
      order,
      claimed.id,
      attemptNumber,
      status.failureReason ?? `Telnyx reported failure (raw status: ${status.providerStatus ?? "unknown"})`,
      maxAttempts
    );
    return true;
  }

  // in_progress / unknown — no terminal outcome yet, leave as 'submitted'.
  return true;
}

/** Drains every currently-eligible fulfillment job, then every currently-
 *  reconcilable transmission. Used by both the production poller tick
 *  (index.ts) and tests. */
export async function runFulfillmentOnce(pool: Pool, deps: FulfillmentDeps): Promise<{ submitted: number; reconciled: number }> {
  let submitted = 0;
  while (await processOneFulfillmentJob(pool, deps)) submitted++;
  let reconciled = 0;
  while (await reconcileOneTransmission(pool, deps)) reconciled++;
  return { submitted, reconciled };
}
