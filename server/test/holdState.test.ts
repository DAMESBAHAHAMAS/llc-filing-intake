import { describe, expect, it } from "vitest";
import {
  classifyCheckoutCompletion,
  fulfillmentAfterPaymentEnds,
  holdNoLongerCapturable,
  ordersNeedingExpiryFlag,
  shouldMarkPaidOnPaymentIntentSucceeded,
} from "../src/payments/holdState.js";
import { holdsEnabled, requiresPayAfterFiling } from "../src/offers/payAfterFiling.js";

describe("classifyCheckoutCompletion", () => {
  it("treats a paid session as paid", () => {
    expect(classifyCheckoutCompletion("paid", "pi_1", "pending")).toBe("paid");
  });
  it("treats an unpaid session with a PaymentIntent as a card hold", () => {
    expect(classifyCheckoutCompletion("unpaid", "pi_1", "pending")).toBe("authorized");
  });
  it("ignores a repeat for an order already held or paid", () => {
    expect(classifyCheckoutCompletion("unpaid", "pi_1", "authorized")).toBe("ignore");
    expect(classifyCheckoutCompletion("paid", "pi_1", "paid")).toBe("ignore");
  });
  it("ignores an unpaid session with no PaymentIntent (e.g. async method not yet confirmed)", () => {
    expect(classifyCheckoutCompletion("unpaid", null, "pending")).toBe("ignore");
  });
});

describe("shouldMarkPaidOnPaymentIntentSucceeded", () => {
  it("collects on held or released orders only", () => {
    expect(shouldMarkPaidOnPaymentIntentSucceeded("authorized")).toBe(true);
    expect(shouldMarkPaidOnPaymentIntentSucceeded("released")).toBe(true);
  });
  it("leaves pending orders to checkout.session.completed", () => {
    expect(shouldMarkPaidOnPaymentIntentSucceeded("pending")).toBe(false);
    expect(shouldMarkPaidOnPaymentIntentSucceeded("paid")).toBe(false);
    expect(shouldMarkPaidOnPaymentIntentSucceeded("refunded")).toBe(false);
  });
});

describe("fulfillmentAfterPaymentEnds", () => {
  it("stops a filing that has not started", () => {
    expect(fulfillmentAfterPaymentEnds("ready")).toBe("not_ready");
  });
  it("leaves in-progress or finished filings for review", () => {
    expect(fulfillmentAfterPaymentEnds("requires_review")).toBe("requires_review");
    expect(fulfillmentAfterPaymentEnds("not_ready")).toBe("not_ready");
  });
});

describe("ordersNeedingExpiryFlag", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const h = (hours: number) => new Date(now.getTime() + hours * 3600_000);
  it("flags holds within 48h with no proof and no earlier flag", () => {
    const flagged = ordersNeedingExpiryFlag(
      [
        { order_id: "soon", capture_before: h(24), proof_of_filing_at: null, hold_expiry_flagged_at: null },
        { order_id: "later", capture_before: h(72), proof_of_filing_at: null, hold_expiry_flagged_at: null },
        { order_id: "filed", capture_before: h(10), proof_of_filing_at: now, hold_expiry_flagged_at: null },
        { order_id: "already", capture_before: h(10), proof_of_filing_at: null, hold_expiry_flagged_at: now },
        { order_id: "unknown", capture_before: null, proof_of_filing_at: null, hold_expiry_flagged_at: null },
        { order_id: "past", capture_before: h(-1), proof_of_filing_at: null, hold_expiry_flagged_at: null },
      ],
      now
    );
    expect(flagged).toEqual(["soon", "past"]);
  });
});

describe("holdNoLongerCapturable", () => {
  it("recognises expired or cancelled holds", () => {
    expect(holdNoLongerCapturable("charge_expired_for_capture")).toBe(true);
    expect(holdNoLongerCapturable("payment_intent_unexpected_state")).toBe(true);
    expect(holdNoLongerCapturable(undefined, "canceled")).toBe(true);
  });
  it("does not fall back on other errors", () => {
    expect(holdNoLongerCapturable("card_declined")).toBe(false);
    expect(holdNoLongerCapturable(undefined)).toBe(false);
  });
});

describe("requiresPayAfterFiling / holdsEnabled", () => {
  it("holds for Sunbiz filings and EIN filings", () => {
    expect(requiresPayAfterFiling([{ offer_code: "FASTTRACK" }])).toBe(true);
    expect(requiresPayAfterFiling([{ offer_code: "PREMIUM" }, { offer_code: "REGISTERED_AGENT_3YR" }])).toBe(true);
    expect(requiresPayAfterFiling([{ offer_code: "DIY_STATE_FEE" }])).toBe(true);
    expect(requiresPayAfterFiling([{ offer_code: "EIN_FILING" }])).toBe(true);
  });
  it("collects at checkout when nothing is filed", () => {
    expect(requiresPayAfterFiling([{ offer_code: "REGISTERED_AGENT_3YR" }])).toBe(false);
    expect(requiresPayAfterFiling([{ offer_code: "CREDENTIALS_KIT" }])).toBe(false);
  });
  it("has a rollback switch", () => {
    const prev = process.env.PAYMENT_CAPTURE_MODE;
    delete process.env.PAYMENT_CAPTURE_MODE;
    expect(holdsEnabled()).toBe(true);
    process.env.PAYMENT_CAPTURE_MODE = "immediate";
    expect(holdsEnabled()).toBe(false);
    if (prev === undefined) delete process.env.PAYMENT_CAPTURE_MODE;
    else process.env.PAYMENT_CAPTURE_MODE = prev;
  });
});
