import { describe, expect, it } from "vitest";
import { floridaLongDate, stampEsignature } from "../src/filing/esignature.js";
import { buildPdfContext, longEffectiveDate } from "../src/pdf/context.js";
import type { FilingSessionRecord } from "../src/pdf/types.js";

const now = new Date("2026-11-25T15:04:05.000Z");
const stamp = { now, ip: "203.0.113.7", userAgent: "Mozilla/5.0 test" };

const signed = {
  signer_name: " Jordan Test Rivera ",
  signer_title: "Manager",
  over_18_confirmed: true,
  consent_text: "I authorize the use of an electronic signature…",
  consent_version: "esign-2026-11-25",
  method: "typed_name",
  signed_at: "2026-11-25T15:03:59.123Z",
};

describe("stampEsignature (T144 D9)", () => {
  it("stamps server time, IP and user agent onto a complete record", () => {
    const out = stampEsignature({ llc_name: "X LLC", esignature: signed }, stamp) as Record<string, unknown>;
    expect(out.llc_name).toBe("X LLC");
    expect(out.esignature).toEqual({
      ...signed,
      signer_name: "Jordan Test Rivera",
      server_received_at: "2026-11-25T15:04:05.000Z",
      ip: "203.0.113.7",
      user_agent: "Mozilla/5.0 test",
    });
  });

  it("ignores a client-sent server_received_at or ip", () => {
    const out = stampEsignature({ esignature: { ...signed, server_received_at: "2020-01-01T00:00:00Z", ip: "1.1.1.1" } }, stamp) as {
      esignature: { server_received_at: string; ip: string };
    };
    expect(out.esignature.server_received_at).toBe("2026-11-25T15:04:05.000Z");
    expect(out.esignature.ip).toBe("203.0.113.7");
  });

  it("drops a record with no signer name or an invalid signed_at", () => {
    expect(stampEsignature({ a: 1, esignature: { ...signed, signer_name: " " } }, stamp)).toEqual({ a: 1 });
    expect(stampEsignature({ a: 1, esignature: { ...signed, signed_at: "yesterday" } }, stamp)).toEqual({ a: 1 });
    expect(stampEsignature({ a: 1, esignature: "x" }, stamp)).toEqual({ a: 1 });
  });

  it("omits over_18_confirmed when the website does not send it (7B)", () => {
    const { over_18_confirmed: _drop, ...without } = signed;
    const out = stampEsignature({ esignature: without }, stamp) as { esignature: Record<string, unknown> };
    expect(out.esignature).not.toHaveProperty("over_18_confirmed");
    expect(out.esignature.consent_version).toBe("esign-2026-11-25");
    const legacy = stampEsignature({ esignature: { ...signed, over_18_confirmed: "yes" } }, stamp) as { esignature: Record<string, unknown> };
    expect(legacy.esignature).not.toHaveProperty("over_18_confirmed");
  });

  it("leaves filing_data without a record untouched", () => {
    const fd = { llc_name: "X LLC" };
    expect(stampEsignature(fd, stamp)).toBe(fd);
    expect(stampEsignature(null, stamp)).toBe(null);
  });

  it("formats the signing date in Florida time", () => {
    expect(floridaLongDate("2026-11-26T03:30:00Z")).toBe("November 25, 2026");
  });
});

describe("buildPdfContext e-signature and name case (T144 D9)", () => {
  const record: Partial<FilingSessionRecord> = {
    llc_name: " Test Dispatch Nine llc ",
    principal_address: "100 S Biscayne Blvd, Suite 300, Miami, FL, 33131",
    mailing_address: "100 S Biscayne Blvd, Suite 300, Miami, FL, 33131",
    registered_agent_path: "house",
    authorized_persons: [{ article_iv_title: "MGR", name: "Jordan Test Rivera", address: "x" }],
    effective_date_option: "Immediate",
  };

  it("prints the LLC name in ALL CAPS", () => {
    const r = buildPdfContext(record, null);
    expect(r.ok && r.context.llc_name).toBe("TEST DISPATCH NINE LLC");
  });

  it("passes esignature: null when there is no record (Zoho Sign anchors print as before)", () => {
    const r = buildPdfContext(record, null);
    expect(r.ok && r.context.esignature).toBeNull();
  });

  it("uses the server receipt time for the signed date", () => {
    const fd = stampEsignature({ ...record, esignature: signed }, { ...stamp, now: new Date("2026-11-26T04:59:00Z") }) as Partial<FilingSessionRecord>;
    const r = buildPdfContext(fd, null);
    expect(r.ok && r.context.esignature).toEqual({ signer_name: "Jordan Test Rivera", signer_title: "Manager", signed_date: "November 25, 2026" });
  });

  it("ignores a non-string title instead of throwing", () => {
    const r = buildPdfContext({ ...record, esignature: { ...signed, signer_title: 7 as unknown as string } }, null);
    expect(r.ok && r.context.esignature).toMatchObject({ signer_title: "" });
  });

  it("never puts the IP or user agent into the PDF context", () => {
    const fd = stampEsignature({ ...record, esignature: signed }, stamp) as Partial<FilingSessionRecord>;
    const r = buildPdfContext(fd, null);
    expect(JSON.stringify(r)).not.toContain("203.0.113.7");
    expect(JSON.stringify(r)).not.toContain("Mozilla");
  });
});

describe("longEffectiveDate (T144 D9)", () => {
  it("prints a stored YYYY-MM-DD date in words", () => {
    expect(longEffectiveDate("2026-12-10")).toBe("December 10, 2026");
    expect(longEffectiveDate("2027-02-01")).toBe("February 1, 2027");
  });
  it("leaves anything else unchanged", () => {
    expect(longEffectiveDate("12/10/2026")).toBe("12/10/2026");
    expect(longEffectiveDate("2026-02-30")).toBe("2026-02-30");
    expect(longEffectiveDate("")).toBe("");
  });
  it("is what buildPdfContext prints for a Future date", () => {
    const r = buildPdfContext({
      llc_name: "A LLC", principal_address: "p", mailing_address: "m", registered_agent_path: "house",
      authorized_persons: [{ article_iv_title: "MGR", name: "n", address: "a" }],
      effective_date_option: "Future", effective_date: "2026-12-10", annual_report_due_date: "May 1, 2027",
    }, null);
    expect(r.ok && r.context.effective_date).toBe("December 10, 2026");
  });
});
