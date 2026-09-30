import { describe, expect, it, vi } from "vitest";
import { runHoldSweepOnce } from "../src/fulfillment/holdSweep.js";
import { buildDealRecord, isTestEmail, packageLabel, type OrderSyncPayload } from "../src/zoho/client.js";

describe("runHoldSweepOnce", () => {
  it("records hold expiry and alerts once for a hold near expiry without proof", async () => {
    const now = new Date("2026-10-01T12:00:00Z");
    const soon = new Date("2026-10-02T12:00:00Z");
    const updates: unknown[][] = [];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (/capture_before IS NULL/.test(sql)) return { rows: [{ order_id: "ord-1", stripe_payment_intent_id: "pi_1" }] };
        if (/capture_before IS NOT NULL/.test(sql))
          return { rows: [{ order_id: "ord-1", capture_before: soon, proof_of_filing_at: null, hold_expiry_flagged_at: null }] };
        updates.push([sql, params]);
        return { rows: [], rowCount: 1 };
      }),
    };
    const alert = vi.fn(async () => {});
    const result = await runHoldSweepOnce(pool as never, {
      now: () => now,
      alert,
      retrievePaymentIntent: async () =>
        ({
          id: "pi_1",
          latest_charge: { id: "ch_1", payment_method_details: { card: { capture_before: soon.getTime() / 1000 } } },
        }) as never,
    });
    expect(result).toEqual({ recorded: 1, flagged: ["ord-1"] });
    expect(alert).toHaveBeenCalledTimes(1);
    expect(String(updates[0][0])).toMatch(/SET capture_before/);
    expect(String(updates[1][0])).toMatch(/hold_expiry_flagged_at = now\(\)/);
  });
});

describe("Deal record", () => {
  const payload = (kind: "held_deal" | "paid_deal", email = "founder@example.com"): OrderSyncPayload =>
    ({
      kind,
      order: { order_id: "ord-1", filing_session_id: "fs-1", product: "FASTTRACK", total_cents: 49900, stripe_payment_intent_id: "pi_1" },
      filing_session: { email, entity_name_primary: "Sunshine Ventures LLC", utm_source: "facebook", utm_medium: "paid", utm_campaign: "scorecard" },
    }) as unknown as OrderSyncPayload;

  it("opens a held order at SERVICE REQUESTED with Hold Placed", () => {
    delete process.env.ZOHO_DEAL_STAGE_ON_HOLD;
    const r = buildDealRecord(payload("held_deal"));
    expect(r.Stage).toBe("SERVICE REQUESTED");
    expect(r.Payment_Status).toBe("Hold Placed");
    expect(r.Package).toBe("FastTrack");
    expect(r.Amount).toBe(499);
    expect(r.UTM_Campaign).toBe("scorecard");
    expect(r.Test_Record).toBe(false);
  });

  it("opens a checkout-paid order at Closed Won", () => {
    delete process.env.ZOHO_DEAL_STAGE_ON_PAYMENT;
    const r = buildDealRecord(payload("paid_deal"));
    expect(r.Stage).toBe("Closed Won");
    expect(r.Payment_Status).toBe("Payment Collected");
  });

  it("marks test orders", () => {
    expect(buildDealRecord(payload("held_deal", "damian+test1@example.com")).Test_Record).toBe(true);
    expect(isTestEmail("launch-test-01@example.invalid")).toBe(true);
    expect(isTestEmail("maria@gmail.com")).toBe(false);
  });

  it("labels packages", () => {
    expect(packageLabel("PREMIUM")).toBe("Premium");
    expect(packageLabel("DIY_STATE_FEE")).toBe("DIY");
    expect(packageLabel("EIN_FILING_EXPRESS")).toBe("EIN Express");
    expect(packageLabel("UNKNOWN")).toBeUndefined();
  });
});
