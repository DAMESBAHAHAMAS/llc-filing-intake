import { describe, expect, it } from "vitest";
import {
  buildCoverLetterContext,
  buildNextStepsContext,
  FORMATION_PACKAGE_WORDING_APPROVED,
  formatUsd,
  orderPackageParts,
} from "../src/pdf/formationPackage.js";
import { HOUSE_REGISTERED_AGENT, type FilingSessionRecord } from "../src/pdf/types.js";

const filing: Partial<FilingSessionRecord> = {
  llc_name: "Test Ventures LLC",
  principal_address: "123 Main St, Miami, FL 33101",
  mailing_address: "123 Main St, Miami, FL 33101",
  registered_agent_path: "house",
  authorized_persons: [{ article_iv_title: "AMBR", name: "Jane Doe", address: "123 Main St, Miami, FL 33101" }],
  effective_date_option: "Immediate",
};
const filed = { filing_date: "2026-10-01", document_number: "L26000123456" };
const order = {
  customer_first_name: "Jane",
  order_total_cents: 99900,
  package: "premium" as const,
  ein_ordered: true,
  booking_link: "https://example.com/book",
};

describe("buildCoverLetterContext", () => {
  it("builds the letter context with the amount collected and the house agent", () => {
    const r = buildCoverLetterContext(filing, filed, order);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.context.order_total).toBe("$999.00");
    expect(r.context.registered_agent_name).toBe(HOUSE_REGISTERED_AGENT.name);
    expect(r.context.effective_on_filing).toBe(true);
    expect(r.context.effective_date).toBe("October 1, 2026");
    expect(r.context.includes_operating_agreement).toBe(true);
  });

  it("carries the draft banner until the wording is approved", () => {
    expect(FORMATION_PACKAGE_WORDING_APPROVED).toBe(false);
    const r = buildCoverLetterContext(filing, filed, order);
    expect(r.ok && r.context.draft).toBe(true);
  });

  it("names every missing value instead of filling it in", () => {
    const r = buildCoverLetterContext(filing, {}, { package: "fasttrack" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missingFields).toEqual(
      expect.arrayContaining([
        "customer_first_name",
        "order_total_cents (the amount collected)",
        "booking_link",
        "filing_date (from proof of filing)",
        "document_number (from proof of filing)",
      ])
    );
  });

  it("only promises an Operating Agreement on Premium", () => {
    const r = buildCoverLetterContext(filing, filed, { ...order, package: "diy", order_total_cents: 13900 });
    expect(r.ok && r.context.includes_operating_agreement).toBe(false);
  });

  it("uses the chosen effective date when it wasn't the filing date", () => {
    const r = buildCoverLetterContext(
      { ...filing, effective_date_option: "Future", effective_date: "2026-10-20" },
      filed,
      order
    );
    expect(r.ok && r.context.effective_on_filing).toBe(false);
    expect(r.ok && r.context.effective_date).toBe("October 20, 2026");
  });
});

describe("buildNextStepsContext", () => {
  it("reflects the package and the EIN order", () => {
    const r = buildNextStepsContext({ package: "fasttrack", ein_ordered: false });
    expect(r.ok && r.context.includes_operating_agreement).toBe(false);
    expect(r.ok && r.context.ein_ordered).toBe(false);
  });
});

describe("orderPackageParts", () => {
  const b = (s: string) => Buffer.from(s);

  it("orders a Premium package: letter, Articles, confirmation, agreement, next steps", () => {
    const r = orderPackageParts("premium", {
      nextSteps: b("5"),
      operatingAgreement: b("4"),
      filingConfirmation: b("3"),
      articles: b("2"),
      coverLetter: b("1"),
    });
    expect(r.ok && r.parts.map(String)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("refuses a Premium package without the Operating Agreement", () => {
    const r = orderPackageParts("premium", { coverLetter: b("1"), articles: b("2"), filingConfirmation: b("3"), nextSteps: b("5") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missingFields).toContain("operatingAgreement (Premium)");
  });

  it("refuses an Operating Agreement on a package that doesn't include one", () => {
    const r = orderPackageParts("diy", {
      coverLetter: b("1"),
      articles: b("2"),
      filingConfirmation: b("3"),
      operatingAgreement: b("4"),
      nextSteps: b("5"),
    });
    expect(r.ok).toBe(false);
  });

  it("refuses a package without the state's filing confirmation", () => {
    const r = orderPackageParts("fasttrack", { coverLetter: b("1"), articles: b("2"), nextSteps: b("5") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missingFields).toContain("filingConfirmation (the state's filing confirmation)");
  });
});

describe("formatUsd", () => {
  it("formats cents as US dollars", () => {
    expect(formatUsd(13900)).toBe("$139.00");
    expect(formatUsd(129800)).toBe("$1,298.00");
  });
});
