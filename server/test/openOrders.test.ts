import { describe, expect, it } from "vitest";
import { filingDataIsLocked, filingDataUnchanged, findOrderConflict, isSecuredOrder, isUnfinishedCheckout, type SessionOrder } from "../src/payments/openOrders.js";

const order = (over: Partial<SessionOrder> = {}): SessionOrder => ({
  order_id: "o1",
  payment_status: "authorized",
  checkout_status: "checkout_created",
  cancelled_at: null,
  proof_of_filing_at: null,
  line_items: [{ offer_code: "FASTTRACK" }],
  stripe_checkout_session_id: "cs_1",
  created_at: new Date(),
  ...over,
});
const FILING = [{ offer_code: "FASTTRACK" }];
const AGENT_ONLY = [{ offer_code: "REGISTERED_AGENT_3YR" }];
const EIN_ONLY = [{ offer_code: "EIN_FILING" }];

describe("findOrderConflict", () => {
  it.each([
    ["a held filing", order()],
    ["a paid filing", order({ payment_status: "paid" })],
    ["a lapsed hold the saved card still covers", order({ payment_status: "released" })],
    ["a filing already confirmed", order({ payment_status: "paid", proof_of_filing_at: new Date() })],
  ])("refuses a second filing over %s", (_name, existing) => {
    expect(findOrderConflict(FILING, [existing])?.order_id).toBe("o1");
  });

  it.each([
    ["a cancelled order", order({ payment_status: "released", cancelled_at: new Date() })],
    ["a refunded order", order({ payment_status: "refunded" })],
    ["a failed checkout", order({ payment_status: "failed" })],
    ["an unfinished checkout, which is closed instead", order({ payment_status: "pending" })],
  ])("allows a filing after %s", (_name, existing) => {
    expect(findOrderConflict(FILING, [existing])).toBeNull();
  });

  it("allows the agent service on a held filing, which is how a customer switches to Damian", () => {
    expect(findOrderConflict(AGENT_ONLY, [order()])).toBeNull();
  });

  it("refuses an EIN-only hold while the filing is open, and allows it once the filing has closed", () => {
    expect(findOrderConflict(EIN_ONLY, [order()])?.order_id).toBe("o1");
    expect(findOrderConflict(EIN_ONLY, [order({ payment_status: "paid", proof_of_filing_at: new Date() })])).toBeNull();
  });
});

describe("order states", () => {
  it("a cancelled release is not secured; an uncancelled one is", () => {
    expect(isSecuredOrder(order({ payment_status: "released" }))).toBe(true);
    expect(isSecuredOrder(order({ payment_status: "released", cancelled_at: new Date() }))).toBe(false);
  });
  it("a checkout Stripe refused to open is not unfinished", () => {
    expect(isUnfinishedCheckout(order({ payment_status: "pending", checkout_status: "checkout_failed" }))).toBe(false);
    expect(isUnfinishedCheckout(order({ payment_status: "pending" }))).toBe(true);
  });
});

describe("the filing data lock", () => {
  it("locks on a held, paid or lapsed filing order", () => {
    expect(filingDataIsLocked([order()])).toBe(true);
    expect(filingDataIsLocked([order({ payment_status: "paid" })])).toBe(true);
    expect(filingDataIsLocked([order({ payment_status: "released" })])).toBe(true);
  });
  it("stays open before payment, after cancelling, and for an order with no filing", () => {
    expect(filingDataIsLocked([order({ payment_status: "pending" })])).toBe(false);
    expect(filingDataIsLocked([order({ payment_status: "released", cancelled_at: new Date() })])).toBe(false);
    expect(filingDataIsLocked([order({ payment_status: "paid", line_items: AGENT_ONLY })])).toBe(false);
  });
  it("a repeat of what is stored is not a replacement, whatever the key order", () => {
    const stored = { llc_name: "Sol", authorized_persons: [{ name: "Ana", address: "1 Main" }], registered_agent_email: "a@example.com" };
    expect(filingDataUnchanged(stored, { authorized_persons: [{ address: "1 Main", name: "Ana" }], llc_name: "Sol" })).toBe(true);
  });
  it("any changed value is a replacement", () => {
    expect(filingDataUnchanged({ llc_name: "Sol" }, { llc_name: "Other" })).toBe(false);
    expect(filingDataUnchanged({ llc_name: "Sol" }, { llc_name: "Sol", extra: 1 })).toBe(false);
    expect(filingDataUnchanged({ llc_name: "Sol" }, "not an object")).toBe(false);
    expect(filingDataUnchanged({ llc_name: "Sol" }, null)).toBe(false);
  });
});
