import { describe, expect, it, vi } from "vitest";
import { runSavedCardCleanupOnce } from "../src/payments/savedCardCleanup.js";
import { StripeApiError } from "../src/stripe/restClient.js";

function fakePool(rows: Array<Record<string, unknown>>) {
  const writes: Array<{ sql: string; params?: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (/^\s*SELECT/.test(sql)) return { rows, rowCount: rows.length };
    writes.push({ sql, params });
    return { rows: [], rowCount: 1 };
  });
  return { pool: { query } as never, writes, query };
}

const order = { order_id: "ord-1", stripe_payment_intent_id: "pi_1", saved_card_detach_error: null };
const deps = (over: Record<string, unknown> = {}) => ({
  retrievePaymentIntent: vi.fn(async () => ({ id: "pi_1", payment_method: "pm_1" })) as never,
  detachPaymentMethod: vi.fn(async () => ({ id: "pm_1" })),
  alert: vi.fn(async () => undefined),
  ...over,
});

describe("runSavedCardCleanupOnce", () => {
  it("detaches the card of a closed order and records it", async () => {
    const { pool, writes } = fakePool([order]);
    const d = deps();
    expect(await runSavedCardCleanupOnce(pool, d)).toEqual({ detached: 1, failed: 0 });
    expect(d.detachPaymentMethod).toHaveBeenCalledWith("pm_1");
    expect(writes[0].sql).toMatch(/saved_card_detached_at = now\(\)/);
  });

  it("looks only at orders that closed, keeping the card for a service charge still to come", async () => {
    const { pool, query } = fakePool([]);
    await runSavedCardCleanupOnce(pool, deps());
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/payment_status = 'paid' AND \(deferred_cents = 0 OR deferred_charged_at IS NOT NULL\)/);
    expect(sql).toMatch(/payment_status = 'refunded'/);
    expect(sql).toMatch(/cancelled_at IS NOT NULL AND payment_status <> 'authorized'/);
    expect(sql).toMatch(/saved_card_detached_at IS NULL/);
    expect(sql).toMatch(/authorized_at IS NOT NULL/);
  });

  it("counts a card already detached as done", async () => {
    const { pool, writes } = fakePool([order]);
    const d = deps({ detachPaymentMethod: vi.fn(async () => { throw new StripeApiError("The payment method you provided is not attached to a customer", 400, {}); }) });
    expect((await runSavedCardCleanupOnce(pool, d)).detached).toBe(1);
    expect(writes[0].sql).toMatch(/saved_card_detached_at = now\(\)/);
  });

  it("records a failure, alerts once and leaves the order for the next pass", async () => {
    const failing = deps({ detachPaymentMethod: vi.fn(async () => { throw new Error("stripe unavailable"); }) });
    const first = fakePool([order]);
    expect(await runSavedCardCleanupOnce(first.pool, failing)).toEqual({ detached: 0, failed: 1 });
    expect(first.writes[0].sql).toMatch(/saved_card_detach_error/);
    expect(failing.alert).toHaveBeenCalledTimes(1);

    const second = fakePool([{ ...order, saved_card_detach_error: "stripe unavailable" }]);
    await runSavedCardCleanupOnce(second.pool, failing);
    expect(failing.alert).toHaveBeenCalledTimes(1);
  });
});
