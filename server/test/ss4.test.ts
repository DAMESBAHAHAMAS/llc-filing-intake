import { describe, expect, it } from "vitest";
import { buildSs4Values, CHECK, FIELD, splitUsAddress, ss4Date } from "../src/ein/ss4.js";
import type { FilingSessionRecord } from "../src/pdf/types.js";

const filing = {
  llc_name: "Test Dispatch Eleven llc",
  principal_address: "100 S Biscayne Blvd, Suite 300, Miami, FL, 33131",
  mailing_address: "200 E Las Olas Blvd, Floor 2, Fort Lauderdale, FL, 33301",
  registered_agent_path: "house",
  authorized_persons: [{ article_iv_title: "AR", name: "Jordan Test Rivera", address: "x" }],
  effective_date_option: "Immediate",
  esignature: { signer_name: "Jordan Test Rivera", signer_title: "Member", signed_at: "2026-11-25T15:00:00Z" },
} as Partial<FilingSessionRecord>;

const inputs = {
  member_count: 1,
  responsible_party_name: "Jordan Test Rivera",
  responsible_party_has_ssn_or_itin: false,
  applicant_title: "Member",
  county_and_state: "Miami-Dade County, Florida",
  business_type: "Consulting",
  principal_activity: "Business consulting",
  principal_products_or_services: "Business consulting services",
  designee: { name: "Damian Knowles", phone: "(000) 000-0000", fax: "(000) 000-0001", address: "3850 South University Drive, Unit #291921, Davie, FL 33329" },
};

describe("buildSs4Values (T144 D11)", () => {
  it("fills a foreign-owned single-member LLC", () => {
    const r = buildSs4Values(filing, { filing_date: "2026-11-30" }, inputs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.values.text;
    expect(t[FIELD.line1LegalName]).toBe("TEST DISPATCH ELEVEN LLC");
    expect(t[FIELD.line4aMailingStreet]).toBe("200 E Las Olas Blvd, Floor 2");
    expect(t[FIELD.line4bMailingCityStateZip]).toBe("Fort Lauderdale, FL 33301");
    expect(t[FIELD.line5aStreet]).toBe("100 S Biscayne Blvd, Suite 300");
    expect(t[FIELD.line5bCityStateZip]).toBe("Miami, FL 33131");
    expect(t[FIELD.line7aResponsibleParty]).toBe("Jordan Test Rivera");
    expect(t[FIELD.line7bSsnItin]).toBe("Foreign");
    expect(t[FIELD.line8bMemberCount]).toBe("1");
    expect(t[FIELD.line9aOtherSpecify]).toBe("Foreign-owned U.S. disregarded entity-Form 5472");
    expect(r.values.font_size).toEqual({ [FIELD.line9aOtherSpecify]: 6.5 });
    expect(t[FIELD.line15FirstWages]).toBe("N/A");
    expect(t[FIELD.line11DateStarted]).toBe("11/30/2026");
    expect(t[FIELD.line12ClosingMonth]).toBe("December");
    expect(t[FIELD.designeeName]).toBe("Damian Knowles");
    expect(t[FIELD.applicantNameTitle]).toBe("Jordan Test Rivera, Member");
    expect(r.values.check).toContainEqual([CHECK.line9aOther.field, CHECK.line9aOther.on]);
    expect(r.values.check).toContainEqual([CHECK.line8aLlcYes.field, CHECK.line8aLlcYes.on]);
    expect(r.values.check).toContainEqual([CHECK.line18AppliedBeforeNo.field, CHECK.line18AppliedBeforeNo.on]);
  });

  it("treats two or more members as a partnership", () => {
    const r = buildSs4Values(filing, { filing_date: "2026-11-30" }, { ...inputs, member_count: 2 });
    expect(r.ok && r.values.check).toContainEqual([CHECK.line9aPartnership.field, CHECK.line9aPartnership.on]);
    expect(r.ok && r.values.text[FIELD.line9aOtherSpecify]).toBeUndefined();
    expect(r.ok && r.values.font_size).toBeUndefined();
  });

  it("leaves lines 5a-5b empty when the street matches the mailing address", () => {
    const r = buildSs4Values({ ...filing, mailing_address: filing.principal_address }, { filing_date: "2026-11-30" }, inputs);
    expect(r.ok && r.values.text[FIELD.line5aStreet]).toBeUndefined();
  });

  it("uses a chosen effective date as the date started", () => {
    const r = buildSs4Values({ ...filing, effective_date_option: "Future", effective_date: "2026-12-10" }, { filing_date: "2026-11-30" }, inputs);
    expect(r.ok && r.values.text[FIELD.line11DateStarted]).toBe("12/10/2026");
  });

  it("names every gap and never guesses", () => {
    const r = buildSs4Values({ llc_name: "A LLC", principal_address: "Calle 1, Madrid", mailing_address: "", esignature: { signer_name: "X Y" } } as never, {}, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    for (const g of ["mailing_address", "principal_address", "county_and_state", "responsible_party_name", "member_count",
      "business_type", "date_started", "principal_activity", "principal_products_or_services", "applicant_title",
      "designee.name", "designee.phone", "designee.fax", "designee.address", "responsible_party_has_ssn_or_itin"]) {
      expect(r.missingFields.join("|")).toContain(g);
    }
  });

  it("refuses a responsible party with an SSN or ITIN (never holds U.S. tax numbers)", () => {
    const r = buildSs4Values(filing, { filing_date: "2026-11-30" }, { ...inputs, responsible_party_has_ssn_or_itin: true });
    expect(r.ok).toBe(false);
  });
});

describe("helpers", () => {
  it("splits a canonical U.S. address", () => {
    expect(splitUsAddress("1 Main St, Tampa, FL, 33602")).toEqual({ street: "1 Main St", cityStateZip: "Tampa, FL 33602" });
    expect(splitUsAddress("1 Main St, Apt 4, Tampa, Florida, 33602")).toEqual({ street: "1 Main St, Apt 4", cityStateZip: "Tampa, FL 33602" });
    expect(splitUsAddress("123 Main St, Miami, FL 33101")).toEqual({ street: "123 Main St", cityStateZip: "Miami, FL 33101" });
    expect(splitUsAddress("123 Main St, Miami, FL 33131, USA")).toEqual({ street: "123 Main St", cityStateZip: "Miami, FL 33131" });
  });
  it("refuses what it cannot split safely", () => {
    expect(splitUsAddress("Calle 1, 28001 Madrid, Spain")).toBeNull();
    expect(splitUsAddress("Unit 5, 123 Main St, Miami FL, 33101")).toBeNull();
    expect(splitUsAddress("Miami, FL, 33101")).toBeNull();
    expect(splitUsAddress("1 Main St, Tampa, ZZ, 33602")).toBeNull();
  });
  it("never takes the responsible party from the Articles signer", () => {
    const { responsible_party_name: _r, ...rest } = inputs;
    const r = buildSs4Values(filing, { filing_date: "2026-11-30" }, rest);
    expect(r.ok).toBe(false);
  });
  it("refuses a line 10 type too long for its box", () => {
    const r = buildSs4Values(filing, { filing_date: "2026-11-30" }, { ...inputs, business_type: "Consulting services for SaaS" });
    expect(r.ok).toBe(false);
  });
  it("prints dates as MM/DD/YYYY", () => {
    expect(ss4Date("2026-11-30")).toBe("11/30/2026");
    expect(ss4Date("2026-02-30")).toBeNull();
  });
});
