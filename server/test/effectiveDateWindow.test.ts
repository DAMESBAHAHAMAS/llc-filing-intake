import { describe, expect, it } from "vitest";
import {
  addBusinessDays, annualReportDueDate, checkEffectiveDate, effectiveDateWindow, floridaStateHolidays,
  floridaToday, formatLongDate, isBusinessDay, windowForFilingDate,
} from "../src/filing/effectiveDateWindow.js";

describe("Florida business days", () => {
  it("knows the 2026 Florida state holidays, as observed", () => {
    const h = floridaStateHolidays(2026);
    for (const d of ["2026-01-01", "2026-01-19", "2026-05-25", "2026-07-03", "2026-09-07", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-25"]) {
      expect(h.has(d)).toBe(true);
    }
    expect(isBusinessDay("2026-07-03")).toBe(false); // July 4 is a Saturday in 2026
    expect(isBusinessDay("2026-11-28")).toBe(false); // Saturday
    expect(isBusinessDay("2026-11-30")).toBe(true);
  });
  it("counts across weekends and Thanksgiving", () => {
    expect(addBusinessDays("2026-11-25", 1)).toBe("2026-11-30");
    expect(addBusinessDays("2026-11-30", -5)).toBe("2026-11-19"); // skips Thanksgiving and the Friday after
    expect(addBusinessDays("2026-11-28", 0)).toBe("2026-11-30");
  });
});

describe("floridaToday", () => {
  it("uses Florida's date, not the visitor's", () => {
    // 03:00 UTC on 26 Nov is still 25 Nov in Florida (UTC-5).
    expect(floridaToday(new Date("2026-11-26T03:00:00Z"))).toBe("2026-11-25");
    expect(floridaToday(new Date("2026-11-26T06:00:00Z"))).toBe("2026-11-26");
  });
});

describe("effective date window", () => {
  it("runs from 5 business days before to 90 calendar days after the expected filing date", () => {
    // Wednesday 25 Nov 2026: Florida is expected to receive it Monday 30 Nov (Thanksgiving + Friday).
    const w = effectiveDateWindow(new Date("2026-11-25T15:00:00Z"));
    expect(w).toEqual({ filingDate: "2026-11-30", earliest: "2026-11-19", latest: "2027-02-28" });
  });
  it("accepts dates inside the window and names the kind", () => {
    const w = windowForFilingDate("2026-11-30");
    expect(checkEffectiveDate("2026-11-19", w)).toEqual({ ok: true, kind: "Backdated" });
    expect(checkEffectiveDate("2026-11-30", w)).toEqual({ ok: true, kind: "SameDay" });
    expect(checkEffectiveDate("2027-02-28", w)).toEqual({ ok: true, kind: "Future" });
  });
  it("rejects dates outside the window with the range spelled out", () => {
    const w = windowForFilingDate("2026-11-30");
    expect(checkEffectiveDate("2026-11-18", w)).toEqual({ ok: false, error: "Choose a date from November 19, 2026 through February 28, 2027." });
    expect(checkEffectiveDate("2027-03-01", w).ok).toBe(false);
    expect(checkEffectiveDate("2026-02-30", w)).toEqual({ ok: false, error: "Enter a real date." });
    expect(checkEffectiveDate("", w).ok).toBe(false);
  });
});

describe("formatting", () => {
  it("spells the month out", () => {
    expect(formatLongDate("2026-11-25")).toBe("November 25, 2026");
    expect(formatLongDate("2027-01-05")).toBe("January 5, 2027");
  });
  it("puts the first annual report due May 1 of the year after the effective year", () => {
    expect(annualReportDueDate("2026-12-15")).toBe("May 1, 2027");
    expect(annualReportDueDate("2027-01-04")).toBe("May 1, 2028");
  });
});

describe("pre-submission guard", () => {
  it("passes no date, and a date still inside the window", async () => {
    const { effectiveDateProblem } = await import("../src/filing/effectiveDateWindow.js");
    expect(effectiveDateProblem({ effective_date_option: "Immediate" }, "2026-11-30")).toBeNull();
    expect(effectiveDateProblem({ effective_date_option: "Future", effective_date: "2027-01-04" }, "2026-11-30")).toBeNull();
  });
  it("pauses a backdated date that a delay pushed out of range", async () => {
    const { effectiveDateProblem } = await import("../src/filing/effectiveDateWindow.js");
    const problem = effectiveDateProblem({ effective_date_option: "Backdated", effective_date: "2026-11-19" }, "2026-12-07");
    expect(problem).toMatch(/no longer fits Florida's window for a filing on December 7, 2026/);
    expect(problem).toMatch(/Ask the customer for a new date/);
  });
});

describe("fulfillment worker", () => {
  it("stops at requires_review and alerts when the effective date no longer fits", async () => {
    const { processClaimedOrder } = await import("../src/fulfillment/fulfillmentWorker.js");
    const updates: unknown[][] = [];
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        if (/FROM filing_sessions/.test(sql))
          return { rows: [{ filing_data: { effective_date_option: "Future", effective_date: "2026-12-01" }, registered_agent_status: "accepted" }] };
        updates.push([sql, params]);
        return { rows: [], rowCount: 1 };
      },
    };
    const alerts: string[] = [];
    await processClaimedOrder(pool as never, { order_id: "ord-1", filing_session_id: "fs-1", fulfillment_attempts: 0 }, {
      now: () => new Date("2027-03-15T15:00:00Z"),
      alert: async (subject: string) => { alerts.push(subject); },
    });
    expect(updates).toHaveLength(1);
    expect(String(updates[0][0])).toMatch(/requires_review/);
    expect(alerts).toEqual(["Effective date needs a new date (order ord-1)"]);
  });
});
