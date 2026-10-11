import { describe, expect, it } from "vitest";
import {
  buildOperatingAgreementContext,
  formatLegalDate,
  OPERATING_AGREEMENT_WORDING_APPROVED,
} from "../src/pdf/operatingAgreementContext.js";
import { HOUSE_REGISTERED_AGENT, type FilingSessionRecord } from "../src/pdf/types.js";

const singleMember: Partial<FilingSessionRecord> = {
  llc_name: "Test Ventures LLC",
  principal_address: "123 Main St, Miami, FL 33101",
  mailing_address: "PO Box 9, Miami, FL 33101",
  registered_agent_path: "house",
  authorized_persons: [{ article_iv_title: "AMBR", name: "Jane Doe", address: "123 Main St, Miami, FL 33101" }],
  effective_date_option: "Immediate",
};

const filed = { filing_date: "2026-10-01", document_number: "L26000123456" };

const multiMember: Partial<FilingSessionRecord> = {
  ...singleMember,
  authorized_persons: [
    { article_iv_title: "AMBR", name: "Jane Doe", address: "123 Main St, Miami, FL 33101" },
    { article_iv_title: "AMBR", name: "Raj Patel", address: "9 Bay Rd, Tampa, FL 33602" },
  ],
};

const multiInputs = {
  members: [
    { name: "Jane Doe", address: "123 Main St, Miami, FL 33101", percentage: 60, contribution: "$6,000 cash" },
    { name: "Raj Patel", address: "9 Bay Rd, Tampa, FL 33602", percentage: 40 },
  ],
  borrowing_limit: "$25,000",
  payment_period_months: 24,
  partnership_representative: "Jane Doe",
};

describe("buildOperatingAgreementContext", () => {
  it("builds a single-member, member-managed context from the Article IV member", () => {
    const r = buildOperatingAgreementContext(singleMember, filed);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.template).toBe("operating_agreement_single_member");
    expect(r.context.management).toBe("member");
    expect(r.context.member).toEqual({ name: "Jane Doe", address: "123 Main St, Miami, FL 33101", contribution: "" });
    expect(r.context.registered_agent_name).toBe(HOUSE_REGISTERED_AGENT.name);
    expect(r.context.document_number).toBe("L26000123456");
  });

  it("uses the filing date as the effective date when the Articles were effective on filing", () => {
    const r = buildOperatingAgreementContext(singleMember, filed);
    expect(r.ok && r.context.effective_date).toBe("October 1, 2026");
    expect(r.ok && r.context.filing_date).toBe("October 1, 2026");
  });

  it("uses the Articles' own effective date when it was a future or backdated one", () => {
    const r = buildOperatingAgreementContext(
      { ...singleMember, effective_date_option: "Future", effective_date: "2026-11-15" },
      filed
    );
    expect(r.ok && r.context.effective_date).toBe("November 15, 2026");
  });

  it("cannot be generated before filing: missing filing facts are named gaps", () => {
    const r = buildOperatingAgreementContext(singleMember, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missingFields).toContain("filing_date (from proof of filing)");
    expect(r.missingFields).toContain("document_number (from proof of filing)");
  });

  it("rejects a filing date that is not a real YYYY-MM-DD date", () => {
    const r = buildOperatingAgreementContext(singleMember, { ...filed, filing_date: "2026-02-30" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missingFields).toContain("filing_date (must be YYYY-MM-DD)");
  });

  it("carries the draft banner until the wording is approved", () => {
    expect(OPERATING_AGREEMENT_WORDING_APPROVED).toBe(false);
    const draft = buildOperatingAgreementContext(singleMember, filed);
    expect(draft.ok && draft.context.draft).toBe(true);
    const approved = buildOperatingAgreementContext(singleMember, filed, {}, { wordingApproved: true });
    expect(approved.ok && approved.context.draft).toBe(false);
  });

  it("asks for the owners when the Articles list a manager", () => {
    const managerManaged: Partial<FilingSessionRecord> = {
      ...singleMember,
      authorized_persons: [{ article_iv_title: "MGR", name: "Alex Kim", address: "1 Ocean Dr, Miami, FL 33139" }],
    };
    const gap = buildOperatingAgreementContext(managerManaged, filed);
    expect(gap.ok).toBe(false);
    if (!gap.ok) {
      expect(gap.missingFields).toContain("members (the Articles list a manager, so the owners must be given separately)");
    }

    const r = buildOperatingAgreementContext(managerManaged, filed, {
      members: [{ name: "Jane Doe", address: "123 Main St, Miami, FL 33101" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.context.management).toBe("manager");
    expect(r.context.manager_names).toBe("Alex Kim");
    expect(r.context.managers).toEqual([{ name: "Alex Kim", address: "1 Ocean Dr, Miami, FL 33139" }]);
    expect((r.context.member as { name: string }).name).toBe("Jane Doe");
  });

  it("needs each manager's address, because Schedule A lists managers", () => {
    const noAddress = {
      ...singleMember,
      authorized_persons: [{ article_iv_title: "MGR", name: "Alex Kim", address: "" }],
    } as Partial<FilingSessionRecord>;
    const r = buildOperatingAgreementContext(noAddress, filed, {
      members: [{ name: "Jane Doe", address: "123 Main St, Miami, FL 33101" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missingFields).toContain("authorized_persons: every manager needs an address");
  });

  it("passes no managers for a member-managed company", () => {
    const r = buildOperatingAgreementContext(singleMember, filed);
    expect(r.ok && r.context.managers).toEqual([]);
  });

  it("switches to the multi-member template and requires its four extra inputs", () => {
    const r = buildOperatingAgreementContext(multiMember, filed);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missingFields).toEqual(
      expect.arrayContaining([
        "members[0].percentage (multi-member: 0-100 required)",
        "members[1].percentage (multi-member: 0-100 required)",
        "borrowing_limit (multi-member, Section 9A)",
        "payment_period_months (multi-member, Section 16, whole months)",
        "partnership_representative (multi-member, Section 12)",
      ])
    );
  });

  it("builds a multi-member context when every input is given", () => {
    const r = buildOperatingAgreementContext(multiMember, filed, multiInputs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.template).toBe("operating_agreement_multi_member");
    expect(r.context.members).toEqual([
      { name: "Jane Doe", address: "123 Main St, Miami, FL 33101", contribution: "$6,000 cash", percentage: "60%" },
      { name: "Raj Patel", address: "9 Bay Rd, Tampa, FL 33602", contribution: "", percentage: "40%" },
    ]);
    expect(r.context.payment_period_months).toBe(24);
  });

  it("refuses percentages that do not total 100", () => {
    const r = buildOperatingAgreementContext(multiMember, filed, {
      ...multiInputs,
      members: [
        { ...multiInputs.members[0], percentage: 60 },
        { ...multiInputs.members[1], percentage: 30 },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missingFields).toContain("members percentages must total 100 (they total 90)");
  });

  it("requires the customer's registered agent details on the customer path", () => {
    const r = buildOperatingAgreementContext({ ...singleMember, registered_agent_path: "customer" }, filed);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missingFields).toContain("registered_agent_name");
      expect(r.missingFields).toContain("registered_agent_florida_address");
    }
  });

  it("joins several manager names naturally", () => {
    const r = buildOperatingAgreementContext(
      {
        ...singleMember,
        authorized_persons: [
          { article_iv_title: "MGR", name: "A One", address: "x" },
          { article_iv_title: "MGR", name: "B Two", address: "y" },
          { article_iv_title: "MGR", name: "C Three", address: "z" },
        ],
      },
      filed,
      { members: [{ name: "Jane Doe", address: "123 Main St" }] }
    );
    expect(r.ok && r.context.manager_names).toBe("A One, B Two and C Three");
  });
});

describe("formatLegalDate", () => {
  it("formats ISO dates and rejects anything else", () => {
    expect(formatLegalDate("2026-01-09")).toBe("January 9, 2026");
    expect(formatLegalDate("01/09/2026")).toBeNull();
    expect(formatLegalDate("2026-13-01")).toBeNull();
  });
});
