import type { Pool } from "pg";

type Runner = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };

/**
 * Money that landed on a hold the order does not use. Nothing more is collected
 * until all of it is refunded. `stray_capture_pi` is the one the routes name,
 * and `more_stray_capture_pis` holds any others, so a refund of one can't lift
 * the block while another stands. Callers hold a transaction.
 */
async function readStrays(client: Runner, orderId: string): Promise<string[]> {
  const { rows } = await client.query(`SELECT stray_capture_pi, more_stray_capture_pis FROM orders WHERE order_id = $1 FOR UPDATE`, [orderId]);
  const first = rows[0]?.stray_capture_pi as string | null | undefined;
  return [...(first ? [first] : []), ...((rows[0]?.more_stray_capture_pis as string[] | null) ?? [])];
}

async function writeStrays(client: Runner, orderId: string, strays: string[]): Promise<void> {
  await client.query(`UPDATE orders SET stray_capture_pi = $2, more_stray_capture_pis = $3::jsonb WHERE order_id = $1`, [orderId, strays[0] ?? null, JSON.stringify(strays.slice(1))]);
}

export async function recordStray(client: Runner, orderId: string, paymentIntentId: string): Promise<void> {
  const strays = await readStrays(client, orderId);
  if (!strays.includes(paymentIntentId)) await writeStrays(client, orderId, [...strays, paymentIntentId]);
}

/** Takes refunded payments off the order, and returns what is still unrefunded. */
export async function dropStrays(client: Runner, orderId: string, refunded: string[]): Promise<string[]> {
  const left = (await readStrays(client, orderId)).filter((id) => !refunded.includes(id));
  await writeStrays(client, orderId, left);
  return left;
}

/** For the sweep, which has no transaction of its own. */
export async function inTransaction<T>(pool: Pool, step: (client: Runner) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await step(client as unknown as Runner);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
