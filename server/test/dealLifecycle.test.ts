import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db/pool.js", () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
const { handlePaymentLifecycleEvent } = await import("../src/routes/webhooksStripe.js");
const { buildDealRecord } = await import("../src/zoho/client.js");
type Payload = import("../src/zoho/client.js").OrderSyncPayload;

/**
 * The CRM Deal lifecycle as built (DECISIONS.md, 2026-11-04): intake creates
 * no Deal, the verified hold opens it at SERVICE REQUESTED, and only a
 * collected hold moves it to Closed Won. The same sequence ran against real
 * Stripe test objects on 4 Nov 2026 (docs/ADR-244-CHECKOUT-REVIEW-2026-11-04.md).
 */
const worker = readFileSync(new URL("../../llc-worker.js", import.meta.url), "utf8");

const order = {
  order_id: "0f6c1d3e-1111-4a2b-9c3d-000000000001",
  filing_session_id: "fs-1",
  payment_status: "authorized",
  fulfillment_status: "requires_review",
  crm_deal_id: "deal-1",
  stripe_payment_intent_id: "pi_1",
  proof_of_filing_at: new Date("2026-11-04T15:00:00Z"),
};
function fakeClient() {
  const writes: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    writes,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (/FROM orders\s+WHERE/.test(sql) && /FOR UPDATE/.test(sql)) return { rows: [order], rowCount: 1 };
      if (/sync_type = 'order_deal'/.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/SELECT email FROM filing_sessions/.test(sql)) return { rows: [{ email: "founder@example.com" }], rowCount: 1 };
      writes.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }),
  };
}

describe("CRM Deal lifecycle", () => {
  it("intake creates no Deal: the Worker never calls the Deals API", () => {
    expect(worker).not.toMatch(/crm\/v2\/Deals/);
    expect(worker).toMatch(/deal_id: null/);
  });

  it("the Worker's comments describe the hold, not 'only after verified payment'", () => {
    expect(worker).not.toMatch(/only after verified (Stripe )?payment/i);
    expect(worker).toMatch(/verified card hold/);
  });

  it("a verified hold opens the Deal without marking the money collected", () => {
    delete process.env.ZOHO_DEAL_STAGE_ON_HOLD;
    const record = buildDealRecord({
      kind: "held_deal",
      order: { order_id: order.order_id, filing_session_id: "fs-1", product: "FASTTRACK", total_cents: 49900, stripe_payment_intent_id: "pi_1" },
      filing_session: { email: "founder@example.com", entity_name_primary: "Sol Ventures LLC" },
    } as unknown as Payload);
    expect(record).toMatchObject({ Stage: "SERVICE REQUESTED", Payment_Status: "Hold Placed" });
  });

  it("only a collected hold moves the Deal to Closed Won", async () => {
    delete process.env.ZOHO_DEAL_STAGE_ON_CAPTURE;
    delete process.env.ZOHO_DEAL_STAGE_ON_PAYMENT;
    const c = fakeClient();
    await handlePaymentLifecycleEvent(c as never, { id: "evt_1", type: "payment_intent.succeeded", data: { object: { id: "pi_1", metadata: { order_id: order.order_id } } } } as never);
    const job = JSON.parse(String(c.writes.find((w) => /crm_sync_queue/.test(w.sql))?.params?.[2]));
    expect(job).toMatchObject({ target_stage: "Closed Won", extra_fields: { Payment_Status: "Payment Collected" } });
  });

  it("a released hold never reaches Closed Won", async () => {
    delete process.env.ZOHO_DEAL_STAGE_ON_HOLD;
    const c = fakeClient();
    await handlePaymentLifecycleEvent(c as never, { id: "evt_2", type: "payment_intent.canceled", data: { object: { id: "pi_1", metadata: { order_id: order.order_id } } } } as never);
    const job = JSON.parse(String(c.writes.find((w) => /crm_sync_queue/.test(w.sql))?.params?.[2]));
    expect(job.target_stage).not.toBe("Closed Won");
    expect(job.extra_fields.Payment_Status).toBe("Hold Released");
  });
});
