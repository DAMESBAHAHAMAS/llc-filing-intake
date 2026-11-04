export type TxClient = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };

/**
 * Queues a Deal update for an order's Deal, if one is known. A Deal this
 * data spine created itself (a synced order_deal job for the order) is
 * updated directly; a Deal id that came from intake metadata keeps the
 * email-ownership check in zoho/client.ts.
 */
export async function enqueueDealUpdate(
  client: TxClient,
  order: { order_id: string; filing_session_id: string; crm_deal_id: string | null },
  update: { target_stage: string; extra_fields: Record<string, unknown> }
): Promise<boolean> {
  if (!order.crm_deal_id) return false;
  const own = await client.query(
    `SELECT 1 FROM crm_sync_queue WHERE order_id = $1 AND sync_type = 'order_deal' AND status = 'synced' LIMIT 1`,
    [order.order_id]
  );
  const email = await client.query(`SELECT email FROM filing_sessions WHERE filing_session_id = $1`, [order.filing_session_id]);
  const expectedEmail = email.rows[0]?.email as string | undefined;
  if (!own.rowCount && !expectedEmail) return false;
  await client.query(
    `INSERT INTO crm_sync_queue (filing_session_id, order_id, sync_type, payload_snapshot)
     VALUES ($1, $2, 'deal_stage_update', $3)`,
    [
      order.filing_session_id,
      order.order_id,
      JSON.stringify({
        crm_deal_id: order.crm_deal_id,
        target_stage: update.target_stage,
        expected_email: expectedEmail ?? "",
        extra_fields: update.extra_fields,
        server_created: Boolean(own.rowCount),
      }),
    ]
  );
  return true;
}
