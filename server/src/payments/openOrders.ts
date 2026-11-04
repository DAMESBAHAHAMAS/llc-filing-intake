import { needsSunbizFiling } from "../offers/sunbizFiling.js";
import { requiresPayAfterFiling } from "../offers/payAfterFiling.js";

type Runner = { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };

export interface SessionOrder {
  order_id: string;
  payment_status: string;
  checkout_status: string;
  cancelled_at: Date | string | null;
  proof_of_filing_at: Date | string | null;
  line_items: Array<{ offer_code?: string }> | null;
  stripe_checkout_session_id: string | null;
  created_at: Date | string;
}

export async function listSessionOrders(runner: Runner, filingSessionId: string): Promise<SessionOrder[]> {
  const { rows } = await runner.query(
    `SELECT order_id, payment_status, checkout_status, cancelled_at, proof_of_filing_at, line_items, stripe_checkout_session_id, created_at
     FROM orders WHERE filing_session_id = $1`,
    [filingSessionId]
  );
  return rows as SessionOrder[];
}

/** Money or a hold stands behind this order. A released hold counts, because
 *  the saved card still covers it, unless the order was cancelled. */
export function isSecuredOrder(order: Pick<SessionOrder, "payment_status" | "cancelled_at">): boolean {
  if (order.cancelled_at) return false;
  return ["authorized", "paid", "released"].includes(order.payment_status);
}

/** A checkout that was started and has not finished either way. */
export function isUnfinishedCheckout(order: Pick<SessionOrder, "payment_status" | "checkout_status">): boolean {
  return order.payment_status === "pending" && ["pending", "checkout_created"].includes(order.checkout_status);
}

/**
 * The order a new checkout would duplicate. A session is one LLC, so it gets
 * one Sunbiz filing for as long as an earlier one stands, finished or not.
 * A second filing service, such as an EIN-only order, waits until the first
 * has closed. An order with no filing in it (a Registered Agent term, a
 * Credentials Kit) never conflicts: buying the 3-year agent service is how a
 * customer whose own agent fell through switches to Damian.
 */
export function findOrderConflict(requested: Array<{ offer_code?: string }>, orders: SessionOrder[]): SessionOrder | null {
  for (const order of orders) {
    if (!isSecuredOrder(order)) continue;
    const items = order.line_items ?? [];
    if (needsSunbizFiling(requested) && needsSunbizFiling(items)) return order;
    const stillOpen = order.payment_status !== "paid" || !order.proof_of_filing_at;
    if (stillOpen && requiresPayAfterFiling(requested) && requiresPayAfterFiling(items)) return order;
  }
  return null;
}

/** MIR-321: once a filing order stands, what was reviewed and paid for is what gets filed. */
export function filingDataIsLocked(orders: SessionOrder[]): boolean {
  return orders.some((order) => isSecuredOrder(order) && requiresPayAfterFiling(order.line_items ?? []));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)])
    );
  }
  return value ?? null;
}

/**
 * A browser retry that changes nothing is not a replacement. Stored data can
 * hold keys the browser never sends, written by the registered-agent routes,
 * so only the keys it did send are compared. The caller writes nothing either
 * way, so a key left out here cannot erase what is stored.
 */
export function filingDataUnchanged(stored: unknown, incoming: unknown): boolean {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return false;
  const current = (stored ?? {}) as Record<string, unknown>;
  return Object.entries(incoming as Record<string, unknown>).every(
    ([key, value]) => JSON.stringify(canonical(value)) === JSON.stringify(canonical(current[key]))
  );
}
