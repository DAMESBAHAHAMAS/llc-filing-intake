import { isLiveTestOrder } from "./liveTest.js";

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };

/**
 * The id in its one standard spelling, or null if it isn't a uuid. Postgres also
 * takes a uuid with no hyphens, or in braces, so a stricter check here would
 * wave those past the seal while the database still found the row.
 */
function canonicalUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hex = value.trim().replace(/^\{(.*)\}$/, "$1").replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A live test's filing session is closed to every public route. Its id can
 * be read from the public order status, so without this anyone holding it
 * could rewrite the session, start a registered agent request or build
 * Articles from it.
 */
export async function isLiveTestSession(db: Queryable, filingSessionId: unknown): Promise<boolean> {
  const id = canonicalUuid(filingSessionId);
  if (!id) return false;
  const { rows } = await db.query(`SELECT filing_data FROM filing_sessions WHERE filing_session_id = $1`, [id]);
  return (rows[0] as { filing_data?: { live_test?: unknown } | null } | undefined)?.filing_data?.live_test === true;
}

export async function orderIsLiveTest(db: Queryable, orderId: unknown): Promise<boolean> {
  const id = canonicalUuid(orderId);
  if (!id) return false;
  const { rows } = await db.query(`SELECT line_items FROM orders WHERE order_id = $1`, [id]);
  return isLiveTestOrder((rows[0] as { line_items?: Array<{ offer_code?: string }> | null } | undefined)?.line_items);
}

export const LIVE_TEST_SESSION_REFUSED = { error: "this session belongs to an internal test", code: "live_test_session" };
