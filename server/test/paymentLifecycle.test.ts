import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db/pool.js", () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
const { handlePaymentLifecycleEvent } = await import("../src/routes/webhooksStripe.js");

/** A fake transaction client: answers the order lookup, the "own Deal"
 *  check and the email lookup; records every write. */
function fakeClient(order: Record<string, unknown> | null, ownDeal = true) {
  const writes: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    writes,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (/FROM orders\s+WHERE/.test(sql) && /FOR UPDATE/.test(sql)) return { rows: order ? [order] : [], rowCount: order ? 1 : 0 };
      if (/sync_type = 'order_deal'/.test(sql)) return { rows: ownDeal ? [{}] : [], rowCount: ownDeal ? 1 : 0 };
      if (/SELECT email FROM filing_sessions/.test(sql)) return { rows: [{ email: "founder@example.com" }], rowCount: 1 };
      writes.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }),
  };
}
const baseOrder = {
  order_id: "0f6c1d3e-1111-4a2b-9c3d-000000000001",
  filing_session_id: "fs-1",
  payment_status: "authorized",
  fulfillment_status: "ready",
  crm_deal_id: "deal-1",
  proof_of_filing_at: new Date("2026-10-02T15:00:00Z"),
};
const event = (type: string, object: Record<string, unknown>) => ({ id: "evt_1", type, data: { object } }) as never;

describe("handlePaymentLifecycleEvent", () => {
  it("marks a held order paid when the hold is collected and moves the Deal to Closed Won", async () => {
    const c = fakeClient(baseOrder);
    const r = await handlePaymentLifecycleEvent(c as never, event("payment_intent.succeeded", { id: "pi_1", metadata: { order_id: baseOrder.order_id } }));
    expect(r.processingResult).toBe("collected_deal_update_enqueued");
    expect(c.writes[0].sql).toMatch(/payment_status = 'paid'/);
    const job = JSON.parse(String(c.writes[1].params?.[2]));
    expect(job).toMatchObject({
      crm_deal_id: "deal-1",
      target_stage: "Closed Won",
      server_created: true,
      extra_fields: { Payment_Status: "Payment Collected", Proof_of_Filing_Date: "2026-10-02" },
    });
  });

  it("ignores payment_intent.succeeded for an order still pending (checkout event owns that)", async () => {
    const c = fakeClient({ ...baseOrder, payment_status: "pending" });
    const r = await handlePaymentLifecycleEvent(c as never, event("payment_intent.succeeded", { id: "pi_1" }));
    expect(r.processingResult).toBe("ignored_not_awaiting_collection");
    expect(c.writes).toHaveLength(0);
  });

  it("releases a hold and stops a filing that has not started", async () => {
    const c = fakeClient(baseOrder);
    const r = await handlePaymentLifecycleEvent(c as never, event("payment_intent.canceled", { id: "pi_1", cancellation_reason: "automatic" }));
    expect(r.processingResult).toBe("hold_released");
    expect(c.writes[0].sql).toMatch(/payment_status = 'released'/);
    expect(c.writes[0].params?.[1]).toBe("not_ready");
  });

  it("records a full refund on a paid order", async () => {
    const c = fakeClient({ ...baseOrder, payment_status: "paid", fulfillment_status: "requires_review" });
    const r = await handlePaymentLifecycleEvent(c as never, event("charge.refunded", { id: "ch_1", payment_intent: "pi_1", refunded: true }));
    expect(r.processingResult).toBe("refunded");
    expect(c.writes[0].params?.[1]).toBe("requires_review");
    expect(JSON.parse(String(c.writes[1].params?.[2])).target_stage).toBe("Closed Lost");
  });

  it("leaves partial refunds to Stripe", async () => {
    const c = fakeClient({ ...baseOrder, payment_status: "paid" });
    const r = await handlePaymentLifecycleEvent(c as never, event("charge.refunded", { id: "ch_1", payment_intent: "pi_1", refunded: false }));
    expect(r.processingResult).toBe("partial_refund_recorded_in_stripe_only");
    expect(c.writes).toHaveLength(0);
  });

  it("records the separate service charge (EIN) without touching the order's payment state", async () => {
    const c = fakeClient({ ...baseOrder, payment_status: "paid" });
    const r = await handlePaymentLifecycleEvent(
      c as never,
      event("payment_intent.succeeded", { id: "pi_ein", metadata: { order_id: baseOrder.order_id, kind: "deferred_service" } })
    );
    expect(r.processingResult).toBe("deferred_service_collected");
    expect(c.writes).toHaveLength(1);
    expect(c.writes[0].sql).toMatch(/deferred_charged_at/);
    expect(c.writes[0].sql).not.toMatch(/payment_status/);
  });

  it("does not mark the whole order refunded when only the service charge is refunded", async () => {
    const c = fakeClient({ ...baseOrder, payment_status: "paid", deferred_payment_intent_id: "pi_ein" });
    const r = await handlePaymentLifecycleEvent(c as never, event("charge.refunded", { id: "ch_2", payment_intent: "pi_ein", refunded: true }));
    expect(r.processingResult).toBe("deferred_service_charge_refunded_stripe_only");
    expect(c.writes).toHaveLength(0);
  });

  it("reports an unknown order", async () => {
    const c = fakeClient(null);
    expect((await handlePaymentLifecycleEvent(c as never, event("payment_intent.succeeded", { id: "pi_x" }))).processingResult).toBe(
      "order_not_found"
    );
  });
});
