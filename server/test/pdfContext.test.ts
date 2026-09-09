import { describe, expect, it } from "vitest";
import { buildPdfContext } from "../src/pdf/context.js";
import { HOUSE_REGISTERED_AGENT, type FilingSessionRecord } from "../src/pdf/types.js";

/**
 * Gate 2 test-matrix item: "missing PDF variable surfaces as a
 * completeness gap, not a fabricated value or silent failure." This is
 * the thing that actually enforces it — proven here independent of any
 * DB or the PDF service itself.
 */

const validHouseRaRecord: Partial<FilingSessionRecord> = {
  llc_name: "Test Ventures LLC",
  principal_address: "123 Main St, Miami, FL 33101",
  mailing_address: "123 Main St, Miami, FL 33101",
  registered_agent_path: "house",
  authorized_persons: [{ article_iv_title: "AMBR", name: "Jane Doe", address: "123 Main St, Miami, FL 33101" }],
  effective_date_option: "Immediate",
};

describe("buildPdfContext", () => {
  it("returns ok:true with a complete context for a valid Immediate/house-RA record", () => {
    const result = buildPdfContext(validHouseRaRecord, null);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.llc_name).toBe("Test Ventures LLC");
      expect(result.context.registered_agent_name).toBe(HOUSE_REGISTERED_AGENT.name);
      expect(result.context.registered_agent_florida_address).toBe(HOUSE_REGISTERED_AGENT.florida_address);
    }
  });

  it("flags a missing llc_name as a completeness gap, not a blank value", () => {
    const { llc_name, ...rest } = validHouseRaRecord;
    const result = buildPdfContext(rest, null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missingFields).toContain("llc_name");
  });

  it("requires at least one authorized person", () => {
    const result = buildPdfContext({ ...validHouseRaRecord, authorized_persons: [] }, null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missingFields.some((f) => f.startsWith("authorized_persons"))).toBe(true);
  });

  it("ALWAYS stamps the house RA identity server-side, even if filing_data carries different RA fields", () => {
    const tampered: Partial<FilingSessionRecord> = {
      ...validHouseRaRecord,
      registered_agent_name: "Someone Else",
      registered_agent_florida_address: "999 Fake St",
    };
    const result = buildPdfContext(tampered, null);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.registered_agent_name).toBe(HOUSE_REGISTERED_AGENT.name);
      expect(result.context.registered_agent_name).not.toBe("Someone Else");
    }
  });

  it("Path B (customer RA): typing a name without acceptance is NOT enough", () => {
    const customerRa: Partial<FilingSessionRecord> = {
      ...validHouseRaRecord,
      registered_agent_path: "customer",
      registered_agent_name: "Custom Agent LLC",
      registered_agent_florida_address: "456 Oak Ave, Tampa, FL 33602",
    };
    const withoutAcceptance = buildPdfContext(customerRa, null);
    expect(withoutAcceptance.ok).toBe(false);
    if (!withoutAcceptance.ok) {
      expect(withoutAcceptance.missingFields.some((f) => f.startsWith("registered_agent_acceptance"))).toBe(true);
    }

    const withAcceptance = buildPdfContext(customerRa, "accepted");
    expect(withAcceptance.ok).toBe(true);
    if (withAcceptance.ok) {
      expect(withAcceptance.context.registered_agent_name).toBe("Custom Agent LLC");
    }
  });

  it("requires effective_date and annual_report_due_date when effective_date_option is Future", () => {
    const future: Partial<FilingSessionRecord> = { ...validHouseRaRecord, effective_date_option: "Future" };
    const result = buildPdfContext(future, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missingFields).toContain("effective_date");
      expect(result.missingFields).toContain("annual_report_due_date");
    }
  });

  it("accepts Future with both dates supplied", () => {
    const future: Partial<FilingSessionRecord> = {
      ...validHouseRaRecord,
      effective_date_option: "Future",
      effective_date: "2026-12-01",
      annual_report_due_date: "2027-05-01",
    };
    const result = buildPdfContext(future, null);
    expect(result.ok).toBe(true);
  });
});
