import { describe, expect, it } from "vitest";
import { agentLineIssue, coversHouseAgent, houseAgentLineMissing } from "../src/offers/houseAgentRule.js";

const DIY = ["DIY_STATE_FEE", "DIY_SERVICE_FEE", "DIY_CERT_OF_STATUS"];

describe("house registered agent billing rule", () => {
  it("rejects a File It house-agent checkout without the $98 agent line", () => {
    expect(houseAgentLineMissing("house", DIY, false)).toBe(true);
    expect(houseAgentLineMissing("house", ["EIN_FILING"], false)).toBe(true);
  });

  it("Bank-Ready and Finance-Ready (including the $139 kickoff, sent as PREMIUM) include the agent (25 Nov 2026)", () => {
    expect(houseAgentLineMissing("house", ["FASTTRACK"], false)).toBe(false);
    expect(houseAgentLineMissing("house", ["PREMIUM"], false)).toBe(false);
  });

  it("accepts when the agent line or an earlier covering order is there", () => {
    expect(houseAgentLineMissing("house", [...DIY, "REGISTERED_AGENT_3YR"], false)).toBe(false);
    expect(houseAgentLineMissing("house", ["EIN_FILING"], true)).toBe(false);
  });

  it("counts an earlier Bank-Ready, Finance-Ready kickoff or $98 order as coverage", () => {
    expect(coversHouseAgent(["FASTTRACK"])).toBe(true);
    // The kickoff order's lines: the $139 hold lines plus the zero-amount PREMIUM line.
    expect(coversHouseAgent([...DIY, "PREMIUM"])).toBe(true);
    expect(coversHouseAgent([...DIY, "REGISTERED_AGENT_3YR"])).toBe(true);
    expect(coversHouseAgent(DIY)).toBe(false);
  });

  it("never applies to a customer's own agent or an undecided session", () => {
    expect(houseAgentLineMissing("customer", DIY, false)).toBe(false);
    expect(houseAgentLineMissing(undefined, DIY, false)).toBe(false);
  });
});

describe("the $98 agent line is never sold twice", () => {
  it("is refused on a package that already includes it", () => {
    expect(agentLineIssue(["FASTTRACK", "REGISTERED_AGENT_3YR"], [])).toBe("bundled_in_cart");
    expect(agentLineIssue(["PREMIUM", "REGISTERED_AGENT_3YR"], [])).toBe("bundled_in_cart");
  });

  it("is refused after an earlier order already includes or bought it", () => {
    expect(agentLineIssue(["REGISTERED_AGENT_3YR"], ["FASTTRACK"])).toBe("already_included");
    expect(agentLineIssue(["REGISTERED_AGENT_3YR"], [...DIY, "PREMIUM"])).toBe("already_included");
    expect(agentLineIssue(["REGISTERED_AGENT_3YR"], [...DIY, "REGISTERED_AGENT_3YR"])).toBe("already_included");
  });

  it("is fine on File It, and when no agent line is requested", () => {
    expect(agentLineIssue([...DIY, "REGISTERED_AGENT_3YR"], [])).toBeNull();
    expect(agentLineIssue(["REGISTERED_AGENT_3YR"], DIY)).toBeNull();
    expect(agentLineIssue(["FASTTRACK"], ["FASTTRACK"])).toBeNull();
  });
});
