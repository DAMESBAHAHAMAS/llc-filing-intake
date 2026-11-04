import { describe, expect, it } from "vitest";
import { buildPdfContext } from "../src/pdf/context.js";
import { looksLikePoBox } from "../src/registeredAgent/poBox.js";

describe("looksLikePoBox", () => {
  it.each([
    "P.O. Box 123",
    "P. O. Box 123",
    "P O Box 123",
    "PO Box 123",
    "po box 123",
    "POBox 123",
    "P.O.Box 123",
    "P-O-Box 123",
    "P . O . Box 123",
    "100 Main St, P. O. Box 5, Miami",
    "Post Office Box 123",
    "POST OFFICE DRAWER 9",
    "Post Box 12",
    "POB 123",
    "P.O.B. 123",
    "P.O.B #123",
    "Box 123",
    "P．O． Box 123", // full-width dots, as a phone keyboard can produce
  ])("catches %s", (address) => {
    expect(looksLikePoBox(address)).toBe(true);
  });

  it.each([
    "200 Agent St",
    "3850 South University Drive, Unit #291921",
    "12 Port Orange Blvd",
    "9 Boxwood Lane",
    "7 Post Office Road",
    "45 Po River Rd",
    "1 Pobland Way",
    "88 Box Elder Ct",
    "",
  ])("leaves %s alone", (address) => {
    expect(looksLikePoBox(address)).toBe(false);
  });

  it("ignores anything that is not text", () => {
    expect(looksLikePoBox(undefined)).toBe(false);
    expect(looksLikePoBox(123)).toBe(false);
  });
});

describe("the Articles of a customer's own agent", () => {
  const filing = {
    llc_name: "Sol Ventures LLC",
    principal_address: "100 Main St",
    mailing_address: "100 Main St",
    effective_date_option: "Immediate" as const,
    authorized_persons: [{ name: "Ana", address: "100 Main St", article_iv_title: "AMBR" }],
    registered_agent_path: "customer" as const,
    registered_agent_name: "Sam Agent",
  };

  it("cannot name a P.O. Box as the agent's address", () => {
    const result = buildPdfContext({ ...filing, registered_agent_florida_address: "P. O. Box 9, Tampa, Florida 33601" }, "accepted");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missingFields.join()).toContain("no P.O. Box");
  });

  it("accepts a street address", () => {
    expect(buildPdfContext({ ...filing, registered_agent_florida_address: "9 Bay Rd, Tampa, Florida 33601" }, "accepted").ok).toBe(true);
  });
});
