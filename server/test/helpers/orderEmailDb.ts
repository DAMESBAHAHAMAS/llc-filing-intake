import { randomUUID } from "node:crypto";
import { DataType, newDb } from "pg-mem";
import type { Pool } from "pg";

/**
 * In-memory stand-in for the tables the order emails touch, using the
 * columns as the migrations leave them. pg-mem cannot run the migrations
 * themselves (plpgsql triggers) and has no SAVEPOINT, SKIP LOCKED or IS
 * DISTINCT FROM, so those are adapted here; real lock behaviour is covered by
 * syncWorker.integration.test.ts, which shares the claim pattern. pg-mem
 * also returns the row from ON CONFLICT DO NOTHING RETURNING when it
 * skipped the insert, so the webhook's event-id check is answered here.
 */
const SCHEMA = `
  CREATE TABLE filing_sessions (
    filing_session_id uuid PRIMARY KEY,
    email text, phone text, full_name text, country text,
    entity_name_primary text, entity_name_backup text,
    crm_lead_id text, crm_deal_id text, crm_sync_status text, crm_last_synced_at timestamptz,
    utm_source text, utm_medium text, utm_campaign text,
    filing_data jsonb, registered_agent_status text,
    current_stage text, name_check_results jsonb, order_total_cents integer, payment_ref text, abandoned_at timestamptz
  );
  CREATE TABLE orders (
    order_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    filing_session_id uuid NOT NULL,
    crm_intent text NOT NULL,
    product text NOT NULL,
    line_items jsonb NOT NULL,
    total_cents integer NOT NULL,
    currency text NOT NULL DEFAULT 'usd',
    stripe_checkout_session_id text,
    stripe_payment_intent_id text,
    payment_status text NOT NULL DEFAULT 'pending',
    fulfillment_status text NOT NULL DEFAULT 'not_ready',
    fulfillment_ready_at timestamptz, fulfillment_started_at timestamptz, fulfillment_run_after timestamptz,
    fulfillment_attempts integer NOT NULL DEFAULT 0, fulfillment_last_error text,
    paid_at timestamptz, authorized_at timestamptz,
    crm_deal_id text,
    proof_of_filing_ref text, proof_of_filing_at timestamptz,
    proof_delivered_at timestamptz, proof_delivery_message_id text, proof_delivery_error text,
    capture_error text, capture_mode text, stripe_livemode boolean,
    saved_card_authorized_at timestamptz, saved_card_authorization_text text,
    saved_card_attempts integer NOT NULL DEFAULT 0, saved_card_payment_intent_id text,
    deferred_cents integer NOT NULL DEFAULT 0, deferred_service_ref text, deferred_payment_intent_id text,
    deferred_requested_at timestamptz, deferred_charged_at timestamptz, deferred_charge_error text,
    deferred_attempts integer NOT NULL DEFAULT 0,
    cancelled_at timestamptz, cancellation_reason text,
    saved_card_detached_at timestamptz, saved_card_detach_error text,
    fulfillment_completed_at timestamptz,
    sunbiz_tracking_number text, sunbiz_submitted_at timestamptz, sunbiz_resubmitted_at timestamptz,
    sunbiz_rejected_at timestamptz, sunbiz_rejection_reason text, sunbiz_rejection_count integer NOT NULL DEFAULT 0,
    other_payment_at timestamptz, other_payment_method text, other_payment_reference text, other_payment_cents integer,
    checkout_status text NOT NULL DEFAULT 'pending', failure_reason text,
    captured_at timestamptz, released_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE filing_documents (
    id bigserial PRIMARY KEY,
    filing_session_id uuid NOT NULL,
    order_id uuid,
    byte_size integer NOT NULL,
    sha256 text NOT NULL,
    pdf_bytes bytea NOT NULL
  );
  CREATE TABLE filing_events (
    id bigserial PRIMARY KEY,
    filing_session_id uuid NOT NULL,
    event_type text NOT NULL,
    payload jsonb
  );
  CREATE TABLE registered_agent_acceptances (
    id bigserial PRIMARY KEY,
    filing_session_id uuid NOT NULL,
    status text NOT NULL,
    requested_at timestamptz,
    registered_agent_name text,
    registered_agent_email text,
    acceptance_token_id text,
    acceptance_version text,
    accepted_at timestamptz,
    accepted_ip text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE crm_sync_queue (
    id bigserial PRIMARY KEY,
    filing_session_id uuid NOT NULL,
    order_id uuid,
    sync_type text NOT NULL,
    payload_snapshot jsonb NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    attempts integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL DEFAULT 6,
    run_after timestamptz NOT NULL DEFAULT now(),
    locked_at timestamptz,
    locked_by text,
    last_error text
  );
  CREATE TABLE stripe_webhook_events (
    id text PRIMARY KEY,
    type text NOT NULL,
    payload jsonb NOT NULL,
    order_id uuid,
    processing_result text,
    processed_at timestamptz
  );
`;

function adapt(sql: string): string {
  if (/^\s*(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)\b/i.test(sql)) return "SELECT 1";
  return sql.replace(/FOR UPDATE SKIP LOCKED/g, "FOR UPDATE").replace(/IS DISTINCT FROM 'accepted'/g, "<> 'accepted'");
}

type Runner = { query: (sql: string, params?: never) => Promise<{ rows: unknown[]; rowCount: number | null }> };

async function run(runner: Runner, sql: string, params?: unknown[]) {
  if (/INSERT INTO stripe_webhook_events/.test(sql)) {
    const seen = await runner.query("SELECT id FROM stripe_webhook_events WHERE id = $1", [params?.[0]] as never);
    if (seen.rows.length) return { rows: [], rowCount: 0 };
  }
  return runner.query(adapt(sql), params as never);
}

/** What the operator's submission leaves behind: a filing proof can be accepted for. */
export async function markSubmitted(db: Pool, orderId: string): Promise<void> {
  const { rows } = await db.query<{ filing_session_id: string }>(`SELECT filing_session_id FROM orders WHERE order_id = $1`, [orderId]);
  await db.query(`INSERT INTO filing_documents (filing_session_id, order_id, byte_size, sha256, pdf_bytes) VALUES ($1, $2, 4, 'abc', $3)`, [
    rows[0].filing_session_id,
    orderId,
    Buffer.from("%PDF"),
  ]);
  await db.query(`UPDATE orders SET fulfillment_status = 'transmitted', sunbiz_tracking_number = 'T100', sunbiz_submitted_at = now() WHERE order_id = $1`, [orderId]);
}

export async function createOrderEmailDb(): Promise<Pool> {
  const db = newDb();
  db.public.registerFunction({ name: "gen_random_uuid", returns: DataType.uuid, implementation: randomUUID, impure: true });
  const { Pool: MemPool } = db.adapters.createPg();
  const mem = new MemPool() as unknown as Pool;
  await mem.query(SCHEMA);
  return {
    query: (sql: string, params?: unknown[]) => run(mem as unknown as Runner, sql, params),
    connect: async () => {
      const client = await mem.connect();
      return { query: (sql: string, params?: unknown[]) => run(client as unknown as Runner, sql, params), release: () => client.release() };
    },
  } as unknown as Pool;
}
