import { isLiveTestOrder } from "./liveTest.js";

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
const UUID = /^[0-9a-f-]{36}$/i;

/**
 * A live test's filing session is closed to every public route. Its id can
 * be read from the public order status, so without this anyone holding it
 * could rewrite the session, start a registered agent request or build
 * Articles from it.
 */
export async function isLiveTestSession(db: Queryable, filingSessionId: unknown): Promise<boolean> {
  if (typeof filingSessionId !== "string" || !UUID.test(filingSessionId)) return false;
  const { rows } = await db.query(`SELECT filing_data FROM filing_sessions WHERE filing_session_id = $1`, [filingSessionId]);
  return (rows[0] as { filing_data?: { live_test?: unknown } | null } | undefined)?.filing_data?.live_test === true;
}

export async function orderIsLiveTest(db: Queryable, orderId: unknown): Promise<boolean> {
  if (typeof orderId !== "string" || !UUID.test(orderId)) return false;
  const { rows } = await db.query(`SELECT line_items FROM orders WHERE order_id = $1`, [orderId]);
  return isLiveTestOrder((rows[0] as { line_items?: Array<{ offer_code?: string }> | null } | undefined)?.line_items);
}

export const LIVE_TEST_SESSION_REFUSED = { error: "this session belongs to an internal test", code: "live_test_session" };
