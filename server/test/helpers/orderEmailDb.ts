import { newDb } from "pg-mem";
import type { Pool } from "pg";

/**
 * In-memory stand-in for the tables the order emails touch, using the
 * columns as the migrations leave them. pg-mem cannot run the migrations
 * themselves (plpgsql triggers) and has no SAVEPOINT or SKIP LOCKED, so
 * those two are removed here; real lock behaviour is covered by
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
    filing_data jsonb, registered_agent_status text
  );
  CREATE TABLE orders (
    order_id uuid PRIMARY KEY,
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
    fulfillment_ready_at timestamptz,
    paid_at timestamptz, authorized_at timestamptz,
    crm_deal_id text,
    proof_of_filing_ref text, proof_of_filing_at timestamptz,
    capture_error text
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
  return sql.replace(/FOR UPDATE SKIP LOCKED/g, "FOR UPDATE");
}

type Runner = { query: (sql: string, params?: never) => Promise<{ rows: unknown[]; rowCount: number | null }> };

async function run(runner: Runner, sql: string, params?: unknown[]) {
  if (/INSERT INTO stripe_webhook_events/.test(sql)) {
    const seen = await runner.query("SELECT id FROM stripe_webhook_events WHERE id = $1", [params?.[0]] as never);
    if (seen.rows.length) return { rows: [], rowCount: 0 };
  }
  return runner.query(adapt(sql), params as never);
}

export async function createOrderEmailDb(): Promise<Pool> {
  const db = newDb();
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
