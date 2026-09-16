import { describe, expect, it } from "vitest";
import { composeArticlesOfOrganizationContext } from "../../src/pdf/composeArticlesOfOrganizationContext.js";
import { mapEffectiveDateOption, computeAnnualReportDueDate } from "../../src/pdf/effectiveDate.js";
import { formatAddress } from "../../src/pdf/formatAddress.js";
import {
  baseFixture,
  ownAgentFixture,
  mailingSameFixture,
  immediateEffectiveFixture,
  futureEffectiveFixture,
  memberManagedFixture,
} from "./fixtures.js";

describe("formatAddress", () => {
  it("joins street, city/state/zip on one line, omitting domestic country", () => {
    expect(
      formatAddress({ street: "400 S Andrews Ave", city: "Fort Lauderdale", state: "FL", zip: "33301", country: "United States" })
    ).toBe("400 S Andrews Ave, Fort Lauderdale, FL 33301");
  });

  it("includes a unit when present", () => {
    expect(
      formatAddress({ street: "3850 South University Drive", unit: "Unit #291921", city: "Davie", state: "Florida", zip: "33329" })
    ).toBe("3850 South University Drive, Unit #291921, Davie, Florida 33329");
  });

  it("includes a non-US country", () => {
    expect(
      formatAddress({ street: "1 Bay St", city: "Toronto", state: "ON", zip: "M5J", country: "Canada" })
    ).toBe("1 Bay St, Toronto, ON M5J, Canada");
  });
});

describe("mapEffectiveDateOption", () => {
  it("maps the funnel's actual values to the template's expected values", () => {
    expect(mapEffectiveDateOption("Immediately")).toBe("Immediate");
    expect(mapEffectiveDateOption("Future Date")).toBe("Future");
  });

  it("passes already-canonical values through unchanged", () => {
    expect(mapEffectiveDateOption("Immediate")).toBe("Immediate");
    expect(mapEffectiveDateOption("Future")).toBe("Future");
    expect(mapEffectiveDateOption("Backdated")).toBe("Backdated");
  });

  it("throws on an unrecognized value rather than silently blanking Article V", () => {
    expect(() => mapEffectiveDateOption("Whenever")).toThrow(/Unrecognized effective_date_option/);
  });
});

describe("computeAnnualReportDueDate", () => {
  it("is May 1 of the year after the effective date", () => {
    expect(computeAnnualReportDueDate("2026-09-15")).toBe("May 1, 2027");
    expect(computeAnnualReportDueDate("2026-01-01")).toBe("May 1, 2027");
    expect(computeAnnualReportDueDate("2026-12-31")).toBe("May 1, 2027");
  });
});

describe("composeArticlesOfOrganizationContext — Article IV role preservation", () => {
  it("gives every authorized person, including all continuation-page entries, the correct article_iv_title", () => {
    const ctx = composeArticlesOfOrganizationContext(baseFixture);
    expect(ctx.authorized_persons).toHaveLength(5);
    // Primary array (Manager-Managed -> managers): both MGR.
    expect(ctx.authorized_persons[0]).toMatchObject({ name: "Alicia Manager", article_iv_title: "MGR" });
    expect(ctx.authorized_persons[1]).toMatchObject({ name: "Brian Manager", article_iv_title: "MGR" });
    // Overflow (5th+, continuation page under the template's [4:] slice):
    // proves title comes from the record, not from array position or
    // management_structure — person 5 (index 4) is AMBR despite this
    // being a Manager-Managed filing.
    expect(ctx.authorized_persons[2]).toMatchObject({ name: "Carlos Overflow", article_iv_title: "MGR" });
    expect(ctx.authorized_persons[3]).toMatchObject({ name: "Dana Overflow", article_iv_title: "MGR" });
    expect(ctx.authorized_persons[4]).toMatchObject({ name: "Erin Overflow", article_iv_title: "AMBR" });
  });

  it("reads from `members` instead of `managers` when management_structure is Member-Managed", () => {
    const ctx = composeArticlesOfOrganizationContext(memberManagedFixture);
    expect(ctx.authorized_persons).toHaveLength(5);
    expect(ctx.authorized_persons.every((p) => p.article_iv_title === "AMBR")).toBe(true);
  });

  it("throws rather than fabricating a title for a person missing one", () => {
    const broken = {
      ...baseFixture,
      managers: [{ ...baseFixture.managers[0], article_iv_title: "" as never }],
      additional_authorized_persons: [],
    };
    expect(() => composeArticlesOfOrganizationContext(broken)).toThrow(/article_iv_title/);
  });
});

describe("composeArticlesOfOrganizationContext — registered agent (A/B)", () => {
  it("A: Damian registered-agent path composes from the record, not a hardcoded constant", () => {
    const ctx = composeArticlesOfOrganizationContext(baseFixture);
    expect(ctx.registered_agent_name).toBe("Damian Knowles");
    expect(ctx.registered_agent_florida_address).toBe(
      "3850 South University Drive, Unit #291921, Davie, Florida 33329"
    );
  });

  it("B: customer-provided registered-agent path composes the customer's own address", () => {
    const ctx = composeArticlesOfOrganizationContext(ownAgentFixture);
    expect(ctx.registered_agent_name).toBe("Jordan Smith");
    expect(ctx.registered_agent_florida_address).toBe("500 Ocean Drive, Miami Beach, Florida 33139");
  });
});

describe("composeArticlesOfOrganizationContext — mailing address (C/D)", () => {
  it("C: mailing_same \"Yes\" falls back to the principal address", () => {
    const ctx = composeArticlesOfOrganizationContext(mailingSameFixture);
    expect(ctx.mailing_address).toBe(ctx.principal_address);
    expect(ctx.mailing_address).toBe("400 S Andrews Ave, Fort Lauderdale, FL 33301");
  });

  it("D: mailing_same \"No\" uses the explicit mailing address", () => {
    const ctx = composeArticlesOfOrganizationContext(baseFixture);
    expect(ctx.mailing_address).toBe("PO Box 1234, Miami, FL 33101");
    expect(ctx.mailing_address).not.toBe(ctx.principal_address);
  });
});

describe("composeArticlesOfOrganizationContext — effective date (E/F)", () => {
  it("E: immediate — effective_date and annual_report_due_date are absent, not fabricated", () => {
    const ctx = composeArticlesOfOrganizationContext(immediateEffectiveFixture);
    expect(ctx.effective_date_option).toBe("Immediate");
    expect(ctx.effective_date).toBeUndefined();
    expect(ctx.annual_report_due_date).toBeUndefined();
  });

  it("F: future — effective_date passes through and annual_report_due_date is computed", () => {
    const ctx = composeArticlesOfOrganizationContext(futureEffectiveFixture);
    expect(ctx.effective_date_option).toBe("Future");
    expect(ctx.effective_date).toBe("2026-09-15");
    expect(ctx.annual_report_due_date).toBe("May 1, 2027");
  });

  it("throws instead of silently omitting effective_date when Future is missing one", () => {
    const broken = { ...baseFixture, effective_date: undefined };
    expect(() => composeArticlesOfOrganizationContext(broken)).toThrow(/effective_date/);
  });
});

describe("composeArticlesOfOrganizationContext — required-field enforcement", () => {
  it("throws on a blank llc_name rather than stubbing one", () => {
    const broken = { ...baseFixture, llc_name: "" };
    expect(() => composeArticlesOfOrganizationContext(broken)).toThrow(/llc_name/);
  });

  it("allows other_provisions to be empty (template's own optional field)", () => {
    const noProvisions = { ...baseFixture, other_provisions: undefined };
    const ctx = composeArticlesOfOrganizationContext(noProvisions);
    expect(ctx.other_provisions).toBe("");
  });
});
