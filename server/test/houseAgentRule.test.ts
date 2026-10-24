import { describe, expect, it } from "vitest";
import { houseAgentLineMissing } from "../src/offers/houseAgentRule.js";

describe("house registered agent billing rule", () => {
  it("rejects a house-agent checkout without the 3-year agent line", () => {
    expect(houseAgentLineMissing("house", ["FASTTRACK"], false)).toBe(true);
    expect(houseAgentLineMissing("house", ["DIY_STATE_FEE", "DIY_SERVICE_FEE", "DIY_CERT_OF_STATUS"], false)).toBe(true);
  });
  it("accepts when the agent line, a bundle, or an earlier payment covers it", () => {
    expect(houseAgentLineMissing("house", ["FASTTRACK", "REGISTERED_AGENT_3YR"], false)).toBe(false);
    expect(houseAgentLineMissing("house", ["PREMIUM"], false)).toBe(false);
    expect(houseAgentLineMissing("house", ["EIN_FILING"], true)).toBe(false);
  });
  it("never applies to a customer's own agent or an undecided session", () => {
    expect(houseAgentLineMissing("customer", ["FASTTRACK"], false)).toBe(false);
    expect(houseAgentLineMissing(undefined, ["FASTTRACK"], false)).toBe(false);
  });
});
