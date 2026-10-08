import { readFileSync } from "node:fs";
import { newDb } from "pg-mem";
import { beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { recordSignup, runScorecardTick, unsubscribeByToken, scorecardLinks, type ScorecardEmailSender } from "../src/scorecard/service.js";
import { buildEmail, renderEmail } from "../src/scorecard/sequence.js";
import type { ScorecardCrm } from "../src/scorecard/crm.js";

let pool: Pool;

beforeEach(async () => {
  const db = newDb();
  const { Pool: MemPool } = db.adapters.createPg();
  pool = new MemPool() as unknown as Pool;
  await pool.query(readFileSync(new URL("../migrations/0019_scorecard_subscribers.sql", import.meta.url), "utf8"));
});

const T0 = new Date("2026-10-08T12:00:00Z");
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000 + 1000);
const input = { email: "x+test@example.com", firstName: "Ana", country: "Brazil", llcStatus: "Not yet" as const, utm: { source: "meta", medium: "paid_social", campaign: "c", content: "ad1" } };

const okCrm: ScorecardCrm = { upsertLead: async () => ({ ok: true, leadId: "L1" }) };
function recordingSender() {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const sender: ScorecardEmailSender = {
    async send(a) {
      sent.push({ to: a.to, subject: a.subject, text: a.text });
      return { ok: true, providerMessageId: `m${sent.length}` };
    },
  };
  return { sender, sent };
}

describe("scorecard funnel", () => {
  it("records a sign-up once and schedules emails on days 0, 2, 4, 7, 10", async () => {
    const a = await recordSignup(pool, input, T0);
    const b = await recordSignup(pool, { ...input, email: "X+TEST@example.com" }, T0);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    const r = await pool.query("SELECT step, send_at FROM scorecard_emails ORDER BY step");
    expect(r.rows.map((x) => Math.round((new Date(x.send_at).getTime() - T0.getTime()) / 86_400_000))).toEqual([0, 2, 4, 7, 10]);
    const s = await pool.query("SELECT lead_intent, is_test FROM scorecard_subscribers");
    expect(s.rows[0]).toMatchObject({ lead_intent: "Undecided", is_test: true });
  });

  it("syncs the CRM lead and sends Email 1 on the first tick, later steps only when due", async () => {
    await recordSignup(pool, input, T0);
    const { sender, sent } = recordingSender();
    const t1 = await runScorecardTick(pool, { sender, crm: okCrm, now: day(0) });
    expect(t1).toMatchObject({ crmSynced: 1, sent: 1 });
    expect(sent[0].subject).toBe("Your Florida Business Readiness Scorecard");
    const t2 = await runScorecardTick(pool, { sender, crm: okCrm, now: day(2) });
    expect(t2.sent).toBe(1);
    expect(sent[1].subject).toBe("The order matters more than the paperwork");
    await runScorecardTick(pool, { sender, crm: okCrm, now: day(10) });
    expect(sent.map((m) => m.subject)).toHaveLength(5);
    expect(sent[4].subject).toBe(`"Not yet" is a fine answer`);
  });

  it("retries a failed CRM write on the next tick without blocking email", async () => {
    await recordSignup(pool, input, T0);
    const { sender, sent } = recordingSender();
    let calls = 0;
    const flaky: ScorecardCrm = { upsertLead: async () => (++calls === 1 ? { ok: false, error: "boom" } : { ok: true, leadId: "L2" }) };
    const t1 = await runScorecardTick(pool, { sender, crm: flaky, now: day(0) });
    expect(t1).toMatchObject({ crmFailed: 1, sent: 1 });
    const t2 = await runScorecardTick(pool, { sender, crm: flaky, now: day(0) });
    expect(t2.crmSynced).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("unsubscribe stops every remaining email", async () => {
    await recordSignup(pool, input, T0);
    const { sender, sent } = recordingSender();
    await runScorecardTick(pool, { sender, crm: okCrm, now: day(0) });
    const { rows } = await pool.query("SELECT unsubscribe_token FROM scorecard_subscribers");
    expect(await unsubscribeByToken(pool, rows[0].unsubscribe_token, day(1))).toBe(true);
    expect(await unsubscribeByToken(pool, "nope")).toBe(false);
    await runScorecardTick(pool, { sender, crm: okCrm, now: day(10) });
    expect(sent).toHaveLength(1);
  });

  it("keeps a failed send pending, then marks it failed after five attempts", async () => {
    await recordSignup(pool, input, T0);
    const bad: ScorecardEmailSender = { send: async () => ({ ok: false, error: "nope" }) };
    for (let i = 0; i < 5; i++) await runScorecardTick(pool, { sender: bad, crm: okCrm, now: day(0) });
    const r = await pool.query("SELECT status FROM scorecard_emails WHERE step = 1");
    expect(r.rows[0].status).toBe("failed");
  });
});

describe("test preview", () => {
  it("sends Emails 2 to 5 once to a test address and leaves the real schedule pending", async () => {
    await recordSignup(pool, input, T0);
    const { sender, sent } = recordingSender();
    const env = { SCORECARD_TEST_PREVIEW: "on" } as NodeJS.ProcessEnv;
    await runScorecardTick(pool, { sender, crm: okCrm, now: day(0), env });
    await runScorecardTick(pool, { sender, crm: okCrm, now: day(0), env });
    expect(sent.filter((m) => m.subject.startsWith("[TEST] "))).toHaveLength(4);
    const r = await pool.query("SELECT count(*)::int AS n FROM scorecard_emails WHERE status = 'pending'");
    expect(r.rows[0].n).toBe(4);
  });
});

describe("email copy", () => {
  const links = { ...scorecardLinks({} as NodeJS.ProcessEnv), payAfterFiling: false };
  it("never mentions Premium, EIN Express, guarantees, or counts", () => {
    for (let s = 1; s <= 5; s++) {
      const m = renderEmail(s, "Ana", { ...links, payAfterFiling: true }, "https://x/u").text;
      expect(m).not.toMatch(/premium|ein express|guarantee|\$138|\$400|BOI|FinCEN|beneficial/i);
      expect(m).toContain("Unsubscribe");
      expect(m).toContain("Hi Ana,");
    }
  });
  it("drops only the payment paragraph from Email 4 when card-hold is not live", () => {
    const on = renderEmail(4, "Ana", { ...links, payAfterFiling: true }, "u").text;
    const off = renderEmail(4, "Ana", links, "u").text;
    expect(on).toContain("How payment works");
    expect(off).not.toContain("How payment works");
    expect(off).toContain("DIY — $139");
    expect(off).toContain("FastTrack — $499");
  });
  it("each email has one button action", () => {
    expect(buildEmail(2, links).button.url).toContain("us-llc-formation-checklist.pdf");
    expect(buildEmail(1, links).button.url).toContain("florida-business-readiness-scorecard.pdf");
  });
});
