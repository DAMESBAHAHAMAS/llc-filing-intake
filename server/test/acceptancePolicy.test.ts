import { describe, expect, it } from "vitest";
import { isDuplicateAcceptanceRequest, shouldSendAfterPayment } from "../src/registeredAgent/acceptancePolicy.js";

describe("shouldSendAfterPayment", () => {
  it("sends for a customer agent with no live request", () => {
    expect(shouldSendAfterPayment("customer", "pending")).toBe(true);
    expect(shouldSendAfterPayment("customer", null)).toBe(true);
    expect(shouldSendAfterPayment("customer", "email_failed")).toBe(true);
    expect(shouldSendAfterPayment("customer", "expired")).toBe(true);
  });
  it("does not resend when the customer already sent it from the interview, or the agent accepted", () => {
    expect(shouldSendAfterPayment("customer", "acceptance_requested")).toBe(false);
    expect(shouldSendAfterPayment("customer", "accepted")).toBe(false);
  });
  it("never sends for the house agent", () => {
    expect(shouldSendAfterPayment("house", "pending")).toBe(false);
    expect(shouldSendAfterPayment(undefined, null)).toBe(false);
  });
});

describe("isDuplicateAcceptanceRequest", () => {
  const now = new Date("2026-11-25T12:00:00Z");
  const live = {
    status: "acceptance_requested",
    registered_agent_email: "rita@example.com",
    registered_agent_name: "Rita Gomez",
    requested_at: "2026-11-25T10:00:00Z",
  };
  it("treats a repeat request for the same live agent as a duplicate", () => {
    expect(isDuplicateAcceptanceRequest(live, "Rita Gomez", "RITA@example.com ", now)).toBe(true);
  });
  it("sends again for a different email or name", () => {
    expect(isDuplicateAcceptanceRequest(live, "Rita Gomez", "rgomez@example.com", now)).toBe(false);
    expect(isDuplicateAcceptanceRequest(live, "Rita M Gomez", "rita@example.com", now)).toBe(false);
  });
  it("sends again once the earlier link expired, failed, or was answered", () => {
    expect(isDuplicateAcceptanceRequest({ ...live, requested_at: "2026-11-17T11:00:00Z" }, "Rita Gomez", "rita@example.com", now)).toBe(false);
    expect(isDuplicateAcceptanceRequest({ ...live, status: "email_failed" }, "Rita Gomez", "rita@example.com", now)).toBe(false);
    expect(isDuplicateAcceptanceRequest({ ...live, status: "declined" }, "Rita Gomez", "rita@example.com", now)).toBe(false);
    expect(isDuplicateAcceptanceRequest(undefined, "Rita Gomez", "rita@example.com", now)).toBe(false);
  });
});
