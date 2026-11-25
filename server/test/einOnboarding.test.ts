import http from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Modules here import the shared pg Pool, which needs a URL but connects lazily.
// Every query goes to the in-memory fake below, never to a database.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://unused.invalid/none";
});
import {
  einIncluded,
  einPortalConfig,
  invitesEnabled,
  packageFromCodes,
  portalUrlFor,
  safeHttpsUrl,
  sweepEnabled,
  type EinPortalConfig,
} from "../src/ein/onboarding.js";
import {
  INVITE_MAX_ATTEMPTS,
  cancellationPurgeDue,
  daysPassedSinceDate,
  registerEinDeals,
  runEinPortalInvitesOnce,
  runEinPortalSweepOnce,
  type EinPortalDeps,
} from "../src/ein/portalJobs.js";
import { createEinOnboardingRouter } from "../src/routes/einOnboarding.js";
import { buildOrderEmail, type OrderEmailRow } from "../src/orderEmails/templates.js";
import { inviteOutcome, realEinPortalClient, type DealSnapshot, type EinPortalClient } from "../src/zoho/einPortal.js";

/**
 * ST17 EIN onboarding through the Zoho CRM Portal: config rules, the portal-link
 * endpoint, the confirmation email, and the invite / sweep jobs against an in-memory
 * database and a fake Zoho client. The real Zoho client is checked against a mocked
 * fetch. No real database, Zoho or email.
 */

const PORTAL = "https://clients.example.test/portal";

function cfg(over: Partial<EinPortalConfig> = {}): EinPortalConfig {
  return {
    ...einPortalConfig({
      EIN_ONBOARDING_ENABLED: "true",
      EIN_PORTAL_URL: PORTAL,
      EIN_PORTAL_USER_TYPE_ID: "2654294000099000001",
      EIN_PASSPORT_FIELD: "Passport_Photo_Page",
      EIN_DOCS_RECEIVED_AT_FIELD: "EIN_Docs_Received_At",
      EIN_ISSUED_DATE_FIELD: "EIN_Issued_Date",
    }),
    ...over,
  };
}

// ── Pure rules ────────────────────────────────────────────────────────────

describe("package and EIN rules", () => {
  it("names the package from the paid offer codes", () => {
    expect(packageFromCodes(["DIY_STATE_FEE", "DIY_SERVICE_FEE"])).toBe("DIY");
    expect(packageFromCodes(["FASTTRACK"])).toBe("BANK_READY");
    expect(packageFromCodes(["PREMIUM", "FASTTRACK"])).toBe("PREMIUM");
    expect(packageFromCodes(["EIN_FILING"])).toBeNull();
  });

  it("knows which orders include the EIN", () => {
    expect(einIncluded(["FASTTRACK"])).toBe(true);
    expect(einIncluded(["PREMIUM"])).toBe(true);
    expect(einIncluded(["DIY_STATE_FEE", "EIN_FILING"])).toBe(true);
    expect(einIncluded(["DIY_STATE_FEE", "DIY_SERVICE_FEE"])).toBe(false);
  });
});

describe("configuration", () => {
  it("is off by default, with safe defaults", () => {
    const c = einPortalConfig({});
    expect(c.enabled).toBe(false);
    expect(c.portalUrl).toBe("");
    expect(c.portalUserTypeId).toBe("");
    expect(c.docsReceivedField).toBe("EIN_Docs_Received");
    expect(c.docsReceivedAtField).toBe("EIN_Docs_Received_At");
    expect(c.passportField).toBe("Passport_Photo_Page");
    expect(c.einIssuedDateField).toBe("EIN_Issued_Date");
    expect(c.purgeStages).toEqual(["Cancelled"]);
    expect(c.purgePaymentStatuses).toEqual(["Refunded"]);
    expect(c.purgeDays).toBe(30);
    expect(c.inviteLookbackDays).toBe(30);
    expect(portalUrlFor(c)).toBeNull();
    expect(invitesEnabled(c)).toBe(false);
    expect(sweepEnabled(c)).toBe(false);
  });

  it("uses the Deal fields created in Zoho unless overridden", () => {
    const c = einPortalConfig({ EIN_PASSPORT_FIELD: "Other_Image", EIN_PURGE_PAYMENT_STATUSES: "Refunded, Charged Back" });
    expect(c.passportField).toBe("Other_Image");
    expect(c.purgePaymentStatuses).toEqual(["Refunded", "Charged Back"]);
  });

  it("shows no portal link while switched off, even with a URL", () => {
    expect(portalUrlFor(einPortalConfig({ EIN_PORTAL_URL: PORTAL }))).toBeNull();
    expect(portalUrlFor(einPortalConfig({ EIN_ONBOARDING_ENABLED: "true" }))).toBeNull();
    expect(portalUrlFor(einPortalConfig({ EIN_ONBOARDING_ENABLED: "true", EIN_PORTAL_URL: PORTAL }))).toBe(PORTAL);
  });

  it("accepts only an absolute https portal URL without credentials", () => {
    expect(safeHttpsUrl("http://clients.example.test")).toBe("");
    expect(safeHttpsUrl("javascript:alert(1)")).toBe("");
    expect(safeHttpsUrl("/portal")).toBe("");
    expect(safeHttpsUrl("https://user:pw@clients.example.test")).toBe("");
    expect(safeHttpsUrl(" https://clients.example.test/x ")).toBe("https://clients.example.test/x");
  });

  it("rejects malformed user type ids and field names", () => {
    const c = einPortalConfig({ EIN_PORTAL_USER_TYPE_ID: "12a", EIN_PASSPORT_FIELD: "Passport Photo", EIN_PASSPORT_PURGE_DAYS: "-3" });
    expect(c.portalUserTypeId).toBe("");
    expect(c.passportField).toBe("");
    expect(c.purgeDays).toBe(30);
  });

  it("needs the user type for invites and the passport field for the sweep", () => {
    expect(invitesEnabled(cfg())).toBe(true);
    expect(invitesEnabled(cfg({ portalUserTypeId: "" }))).toBe(false);
    expect(invitesEnabled(cfg({ portalUrl: "" }))).toBe(false);
    expect(sweepEnabled(cfg())).toBe(true);
    expect(sweepEnabled(cfg({ passportField: "" }))).toBe(false);
    expect(sweepEnabled(cfg({ enabled: false }))).toBe(false);
  });

  it("dates the retention periods", () => {
    expect(daysPassedSinceDate("2026-11-01", 30, new Date("2026-11-30T23:59:59Z"))).toBe(false);
    expect(daysPassedSinceDate("2026-11-01", 30, new Date("2026-12-01T00:00:00Z"))).toBe(true);
    const seen = new Date("2026-11-01T12:00:00Z");
    expect(cancellationPurgeDue(seen, 30, new Date("2026-11-30T11:59:59Z"))).toBe(false);
    expect(cancellationPurgeDue(seen, 30, new Date("2026-11-30T12:00:00Z"))).toBe(true);
  });
});

// ── GET /api/onboarding/ein ───────────────────────────────────────────────

describe("GET /api/onboarding/ein", () => {
  let current = cfg({ enabled: false });
  let server: http.Server;
  let base = "";

  beforeAll(async () => {
    const app = express();
    app.use(createEinOnboardingRouter(() => current));
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it("is 503 not_open while switched off or without a URL", async () => {
    current = cfg({ enabled: false });
    let res = await fetch(`${base}/api/onboarding/ein`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not_open" });
    current = cfg({ portalUrl: "" });
    res = await fetch(`${base}/api/onboarding/ein`);
    expect(res.status).toBe(503);
  });

  it("returns only the portal URL once open, never cached", async () => {
    current = cfg();
    const res = await fetch(`${base}/api/onboarding/ein?filing_session_id=whatever`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "open", portal_url: PORTAL });
  });

  it("has no POST: nothing is uploaded to this server", async () => {
    current = cfg();
    const res = await fetch(`${base}/api/onboarding/ein`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });
});

// ── Confirmation email ────────────────────────────────────────────────────

describe("order confirmation EIN step", () => {
  const row: OrderEmailRow = {
    order_id: "ord-1",
    line_items: [{ offer_code: "FASTTRACK", display_name: "Bank-Ready", unit_amount_cents: 49900, quantity: 1 }],
    total_cents: 49900,
    proof_of_filing_ref: null,
    email: "customer@example.test",
    full_name: "Ada Lovelace",
    phone: null,
    country: null,
    entity_name_primary: "Sunshine Holdings LLC",
    entity_name_backup: null,
    filing_data: { llc_name: "Sunshine Holdings LLC" },
    registered_agent_status: null,
  };

  it("points to the portal when a portal URL is given", () => {
    const email = buildOrderEmail("order_confirmation", { ...row, ein_portal_url: PORTAL }, "hold");
    expect(email.text).toContain("Next Step: Your EIN");
    expect(email.text).toContain(PORTAL);
    expect(email.html).toContain(PORTAL);
    expect(email.text).toContain("Please don't send your passport by email.");
  });

  it("leaves the step out otherwise", () => {
    const email = buildOrderEmail("order_confirmation", row, "hold");
    expect(email.text).not.toContain("Next Step: Your EIN");
    expect(email.text).not.toContain("portal");
  });
});

// ── Jobs against an in-memory database ────────────────────────────────────

interface OrderRow {
  order_id: string;
  filing_session_id: string;
  crm_deal_id: string | null;
  payment_status: string;
  money_at: Date;
  codes: string[];
  /** A synced order_deal / ownership-verified deal_stage_update job exists. */
  verified: boolean;
}

interface DealRow {
  zoho_deal_id: string;
  filing_session_id: string;
  first_order_id: string;
  invite_status: string;
  invite_attempts: number;
  invite_claimed_at: Date | null;
  invited_at: Date | null;
  zoho_contact_id: string | null;
  docs_received_at: Date | null;
  closed_seen_at: Date | null;
  passport_purged_at: Date | null;
  next_check_at: Date;
  retired_at: Date | null;
  last_error: string | null;
  created_at: Date;
}

/**
 * Mirrors each SQL statement in ein/portalJobs.ts on plain objects. It checks the
 * statement shapes the jobs send; it is not a substitute for running the SQL once
 * against a scratch Postgres before switching on.
 */
function memoryDb(orders: OrderRow[], deals: Map<string, DealRow>, emails: Record<string, string | null>) {
  const lineItems = (o: OrderRow) => o.codes.map((offer_code) => ({ offer_code, unit_amount_cents: 100, quantity: 1 }));
  const db = {
    sql: [] as string[],
    async query(sql: string, params: unknown[] = []) {
      db.sql.push(sql);
      if (sql.includes("COALESCE(o.authorized_at, o.paid_at) >= $1")) {
        expect(sql).toContain("q.status = 'synced'");
        const [since] = params as [Date];
        const rows = orders
          .filter((o) => ["authorized", "paid"].includes(o.payment_status) && o.crm_deal_id && o.money_at >= since && o.verified)
          .sort((a, b) => a.money_at.getTime() - b.money_at.getTime())
          .map((o) => ({ order_id: o.order_id, filing_session_id: o.filing_session_id, crm_deal_id: o.crm_deal_id, line_items: lineItems(o) }));
        return { rows };
      }
      if (sql.includes("INSERT INTO ein_portal_deals")) {
        const [id, sid, orderId, now] = params as [string, string, string, Date];
        if (deals.has(id)) return { rows: [], rowCount: 0 };
        deals.set(id, {
          zoho_deal_id: id, filing_session_id: sid, first_order_id: orderId,
          invite_status: "pending", invite_attempts: 0, invite_claimed_at: null, invited_at: null, zoho_contact_id: null,
          docs_received_at: null, closed_seen_at: null, passport_purged_at: null, next_check_at: now, retired_at: null,
          last_error: null, created_at: now,
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("WHERE o.crm_deal_id = $1 AND o.payment_status IN")) {
        expect(sql).toContain("q.status = 'synced'");
        const [id] = params as [string];
        const rows = orders
          .filter((o) => o.crm_deal_id === id && ["authorized", "paid", "refunded"].includes(o.payment_status) && o.verified)
          .map((o) => ({ payment_status: o.payment_status, line_items: lineItems(o) }));
        return { rows };
      }
      if (sql.includes("JOIN filing_sessions fs ON fs.filing_session_id = d.filing_session_id")) {
        const [retryBefore] = params as [Date];
        const rows = [...deals.values()]
          .filter((d) => ["pending", "failed"].includes(d.invite_status) && (!d.invite_claimed_at || d.invite_claimed_at < retryBefore))
          .map((d) => ({ zoho_deal_id: d.zoho_deal_id, email: emails[d.filing_session_id] ?? null }));
        return { rows };
      }
      if (sql.includes("SET invite_status = 'pending', invite_attempts")) {
        const [id, now, retryBefore] = params as [string, Date, Date];
        const d = deals.get(id)!;
        if (!["pending", "failed"].includes(d.invite_status) || (d.invite_claimed_at && d.invite_claimed_at >= retryBefore)) return { rows: [] };
        Object.assign(d, { invite_status: "pending", invite_attempts: d.invite_attempts + 1, invite_claimed_at: now });
        return { rows: [{ invite_attempts: d.invite_attempts }] };
      }
      if (sql.includes("SET invite_status = 'invited'")) {
        const [id, contact, now] = params as [string, string, Date];
        Object.assign(deals.get(id)!, { invite_status: "invited", zoho_contact_id: contact, invited_at: now });
        return { rows: [] };
      }
      if (sql.includes("SET invite_status = $2, last_error")) {
        const [id, status, error] = params as [string, string, string];
        Object.assign(deals.get(id)!, { invite_status: status, last_error: error });
        return { rows: [] };
      }
      if (sql.includes("FROM ein_portal_deals d") && sql.includes("d.next_check_at <= $1")) {
        const [now] = params as [Date];
        const rows = [...deals.values()]
          .filter((d) => d.retired_at === null && d.next_check_at <= now)
          .sort((a, b) => a.next_check_at.getTime() - b.next_check_at.getTime())
          .map((d) => ({
            zoho_deal_id: d.zoho_deal_id,
            docs_received_at: d.docs_received_at,
            closed_seen_at: d.closed_seen_at,
            passport_purged_at: d.passport_purged_at,
            last_error: d.last_error,
          }));
        return { rows };
      }
      if (sql.includes("SET docs_received_at = $2, updated_at = $2")) {
        const [id, now] = params as [string, Date];
        const d = deals.get(id)!;
        if (d.docs_received_at) return { rows: [] };
        d.docs_received_at = now;
        return { rows: [{ zoho_deal_id: id }] };
      }
      if (sql.includes("SET docs_received_at = NULL")) {
        deals.get(params[0] as string)!.docs_received_at = null;
        return { rows: [] };
      }
      if (sql.includes("SET last_error = $2, next_check_at = $3")) {
        const [id, error, next] = params as [string, string, Date];
        Object.assign(deals.get(id)!, { last_error: error, next_check_at: next });
        return { rows: [] };
      }
      if (sql.includes("SET closed_seen_at = $2, passport_purged_at = $3")) {
        const [id, closed, purged, error, next, retired] = params as [string, Date | null, Date | null, string | null, Date, Date | null];
        Object.assign(deals.get(id)!, { closed_seen_at: closed, passport_purged_at: purged, last_error: error, next_check_at: next, retired_at: retired });
        return { rows: [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return db;
}

function fakeZoho(deals: Map<string, DealSnapshot>) {
  const calls: string[] = [];
  const zoho: EinPortalClient & { inviteResult: Awaited<ReturnType<EinPortalClient["inviteDealContact"]>>; clearFails: boolean } = {
    inviteResult: { ok: true, value: { contactId: "contact-1" } },
    clearFails: false,
    async inviteDealContact(dealId, email, userTypeId) {
      calls.push(`invite ${dealId} ${email} ${userTypeId}`);
      return zoho.inviteResult;
    },
    async readDeal(dealId) {
      calls.push(`read ${dealId}`);
      const d = deals.get(dealId);
      return d ? { ok: true, value: structuredClone(d) } : { ok: false, permanent: true, error: "not found" };
    },
    async markDocsReceived(dealId, fields, at) {
      calls.push(`mark ${dealId} ${fields.docsReceived} ${fields.docsReceivedAt} ${at.toISOString()}`);
      deals.get(dealId)!.docsReceived = true;
      return { ok: true };
    },
    async clearImageField(dealId, field) {
      calls.push(`clear ${dealId} ${field}`);
      if (zoho.clearFails) return { ok: false, error: "still there" };
      deals.get(dealId)!.passportFiles = [];
      return { ok: true };
    },
  };
  return { zoho, calls };
}

const NOW = new Date("2026-11-25T12:00:00Z");
const DAY = 86_400_000;

function order(over: Partial<OrderRow> = {}): OrderRow {
  return {
    order_id: "ord-1",
    filing_session_id: "sess-1",
    crm_deal_id: "deal-1",
    payment_status: "authorized",
    money_at: new Date("2026-11-25T10:00:00Z"),
    codes: ["FASTTRACK"],
    verified: true,
    ...over,
  };
}

function setup(orders: OrderRow[], zohoDeals = new Map<string, DealSnapshot>(), config = cfg()) {
  const deals = new Map<string, DealRow>();
  const { zoho, calls } = fakeZoho(zohoDeals);
  const alerts: Array<{ subject: string; body: string }> = [];
  let now = NOW;
  const db = memoryDb(orders, deals, { "sess-1": "ada@example.test", "sess-2": "bob@example.test", "sess-x": null });
  const deps: EinPortalDeps = {
    db: db as never,
    zoho,
    config,
    now: () => now,
    alert: async (subject, body) => {
      alerts.push({ subject, body });
    },
  };
  return { deps, deals, zoho, calls, alerts, zohoDeals, db, orders, setNow: (d: Date) => (now = d) };
}

describe("Deal registration", () => {
  it("keeps one row per verified Deal with a held or paid EIN order from the last 30 days", async () => {
    const t = setup([
      order(),
      order({ order_id: "ord-1b", crm_deal_id: "deal-1", codes: ["EIN_FILING"], money_at: new Date("2026-11-25T11:00:00Z") }),
      order({ order_id: "ord-diy", crm_deal_id: "deal-2", codes: ["DIY_STATE_FEE", "DIY_SERVICE_FEE"] }),
      order({ order_id: "ord-pending", crm_deal_id: "deal-3", payment_status: "pending" }),
      order({ order_id: "ord-old", crm_deal_id: "deal-4", money_at: new Date("2026-09-01T00:00:00Z") }),
      order({ order_id: "ord-nodeal", crm_deal_id: null }),
      order({ order_id: "ord-unverified", crm_deal_id: "deal-5", verified: false }),
    ]);
    expect(await registerEinDeals(t.deps)).toBe(1);
    expect([...t.deals.keys()]).toEqual(["deal-1"]);
    expect(t.deals.get("deal-1")?.first_order_id).toBe("ord-1");
    expect(await registerEinDeals(t.deps)).toBe(0);
  });
});

describe("portal invites", () => {
  it("does nothing while switched off or without a user type", async () => {
    for (const config of [cfg({ enabled: false }), cfg({ portalUserTypeId: "" }), cfg({ portalUrl: "" })]) {
      const t = setup([order()], undefined, config);
      expect(await runEinPortalInvitesOnce(t.deps)).toEqual({ invited: [], failed: [], blocked: [] });
      expect(t.calls).toEqual([]);
      expect(t.db.sql).toEqual([]);
    }
  });

  it("invites each Deal's customer once, even with two EIN orders on it", async () => {
    const t = setup([order(), order({ order_id: "ord-1b", codes: ["EIN_FILING"] })]);
    expect((await runEinPortalInvitesOnce(t.deps)).invited).toEqual(["deal-1"]);
    expect(t.calls).toEqual(["invite deal-1 ada@example.test 2654294000099000001"]);
    expect(t.deals.get("deal-1")).toMatchObject({ invite_status: "invited", zoho_contact_id: "contact-1", invited_at: NOW });
    t.setNow(new Date(NOW.getTime() + 3 * 3600_000));
    await runEinPortalInvitesOnce(t.deps);
    expect(t.calls).toHaveLength(1);
  });

  it("never invites through an unverified Deal id", async () => {
    const t = setup([order({ verified: false })]);
    await runEinPortalInvitesOnce(t.deps);
    expect(t.calls).toEqual([]);
  });

  it("blocks and alerts when the Deal has no matching Contact, with no personal data in the alert", async () => {
    const t = setup([order()]);
    t.zoho.inviteResult = { ok: false, permanent: true, error: "Deal deal-1 has no linked Contact to invite" };
    expect((await runEinPortalInvitesOnce(t.deps)).blocked).toEqual(["deal-1"]);
    expect(t.deals.get("deal-1")?.invite_status).toBe("blocked");
    expect(t.alerts[0].subject).toBe("EIN portal invite needs a person");
    expect(t.alerts[0].body).toContain("deal-1");
    expect(t.alerts[0].body).not.toContain("ada@example.test");
    t.setNow(new Date(NOW.getTime() + 2 * 3600_000));
    await runEinPortalInvitesOnce(t.deps);
    expect(t.calls).toHaveLength(1);
  });

  it("retries a failed invite after an hour, then gives up and alerts", async () => {
    const t = setup([order()]);
    t.zoho.inviteResult = { ok: false, error: "Zoho portal invite failed: 500" };
    await runEinPortalInvitesOnce(t.deps);
    expect(t.deals.get("deal-1")).toMatchObject({ invite_status: "failed", invite_attempts: 1 });
    t.setNow(new Date(NOW.getTime() + 30 * 60_000));
    await runEinPortalInvitesOnce(t.deps);
    expect(t.calls).toHaveLength(1);
    for (let i = 1; i < INVITE_MAX_ATTEMPTS; i++) {
      t.setNow(new Date(NOW.getTime() + i * 2 * 3600_000));
      await runEinPortalInvitesOnce(t.deps);
    }
    expect(t.calls).toHaveLength(INVITE_MAX_ATTEMPTS);
    expect(t.deals.get("deal-1")).toMatchObject({ invite_status: "blocked", invite_attempts: INVITE_MAX_ATTEMPTS });
    expect(t.alerts).toHaveLength(1);
  });

  it("keeps retrying an old failed invite: the lookback only limits new Deals", async () => {
    const t = setup([order()]);
    t.zoho.inviteResult = { ok: false, error: "Zoho portal invite failed: 500" };
    await runEinPortalInvitesOnce(t.deps);
    t.zoho.inviteResult = { ok: true, value: { contactId: "c-2" } };
    t.setNow(new Date(NOW.getTime() + 40 * DAY));
    expect((await runEinPortalInvitesOnce(t.deps)).invited).toEqual(["deal-1"]);
  });
});

describe("docs received and passport retention sweep", () => {
  const IMG = { id: "img-1", File_Name__s: "passport.jpg" };

  function deal(over: Partial<DealSnapshot> = {}): DealSnapshot {
    return { stage: "Payment Pending", paymentStatus: "Hold Placed", docsReceived: false, passportFiles: [], einIssuedDate: null, ...over };
  }

  function sweepSetup(zohoDeals: Map<string, DealSnapshot>, orders = [order()], config = cfg()) {
    return setup(orders, zohoDeals, config);
  }

  it("does nothing while switched off", async () => {
    const t = sweepSetup(new Map([["deal-1", deal({ passportFiles: [IMG] })]]), [order()], cfg({ enabled: false }));
    expect(await runEinPortalSweepOnce(t.deps)).toEqual({ docsReceived: [], purged: [], errors: [] });
    expect(t.calls).toEqual([]);
    expect(t.db.sql).toEqual([]);
  });

  it("works without invites: a Deal whose customer was invited by hand is still swept", async () => {
    const t = sweepSetup(new Map([["deal-1", deal({ passportFiles: [IMG] })]]), [order()], cfg({ portalUserTypeId: "" }));
    expect((await runEinPortalSweepOnce(t.deps)).docsReceived).toEqual(["deal-1"]);
    expect(t.deals.get("deal-1")?.invite_status).toBe("pending");
  });

  it("sweeps a Deal whose invite was blocked", async () => {
    const t = sweepSetup(new Map([["deal-1", deal({ passportFiles: [IMG] })]]));
    t.zoho.inviteResult = { ok: false, permanent: true, error: "no Contact" };
    await runEinPortalInvitesOnce(t.deps);
    expect((await runEinPortalSweepOnce(t.deps)).docsReceived).toEqual(["deal-1"]);
  });

  it("waits while no passport is on the Deal", async () => {
    const t = sweepSetup(new Map([["deal-1", deal()]]));
    expect((await runEinPortalSweepOnce(t.deps)).docsReceived).toEqual([]);
    expect(t.calls).toEqual(["read deal-1"]);
    expect(t.deals.get("deal-1")?.docs_received_at).toBeNull();
  });

  it("detects the upload itself, ticks EIN Docs Received with its timestamp and alerts once", async () => {
    const t = sweepSetup(new Map([["deal-1", deal({ passportFiles: [IMG] })]]));
    expect((await runEinPortalSweepOnce(t.deps)).docsReceived).toEqual(["deal-1"]);
    expect(t.calls).toEqual(["read deal-1", `mark deal-1 EIN_Docs_Received EIN_Docs_Received_At ${NOW.toISOString()}`]);
    expect(t.deals.get("deal-1")?.docs_received_at).toEqual(NOW);
    expect(t.alerts.map((a) => a.subject)).toEqual(["EIN docs received"]);
    t.setNow(new Date(NOW.getTime() + 3600_000));
    await runEinPortalSweepOnce(t.deps);
    expect(t.calls.filter((c) => c.startsWith("mark"))).toHaveLength(1);
    expect(t.alerts).toHaveLength(1);
  });

  it("does not rewrite the Deal when a Zoho workflow already ticked it", async () => {
    const t = sweepSetup(new Map([["deal-1", deal({ passportFiles: [IMG], docsReceived: true })]]));
    expect((await runEinPortalSweepOnce(t.deps)).docsReceived).toEqual(["deal-1"]);
    expect(t.calls).toEqual(["read deal-1"]);
  });

  it("clears the passport 30 days after the EIN is issued, not before", async () => {
    const zohoDeals = new Map([["deal-1", deal({ passportFiles: [IMG], docsReceived: true, einIssuedDate: "2026-11-01" })]]);
    const t = sweepSetup(zohoDeals);
    t.setNow(new Date("2026-11-30T23:00:00Z"));
    expect((await runEinPortalSweepOnce(t.deps)).purged).toEqual([]);
    t.setNow(new Date("2026-12-01T00:30:00Z"));
    expect((await runEinPortalSweepOnce(t.deps)).purged).toEqual(["deal-1"]);
    expect(t.calls).toContain("clear deal-1 Passport_Photo_Page");
    expect(t.deals.get("deal-1")).toMatchObject({ passport_purged_at: new Date("2026-12-01T00:30:00Z"), retired_at: null });
    expect(t.deals.get("deal-1")?.docs_received_at).not.toBeNull();
  });

  it("after a purge, checks daily and clears a re-upload; retires 90 days after retention fell due", async () => {
    const zohoDeals = new Map([["deal-1", deal({ passportFiles: [IMG], docsReceived: true, einIssuedDate: "2026-10-01" })]]);
    const t = sweepSetup(zohoDeals);
    expect((await runEinPortalSweepOnce(t.deps)).purged).toEqual(["deal-1"]);
    t.calls.length = 0;
    t.setNow(new Date(NOW.getTime() + 3600_000));
    await runEinPortalSweepOnce(t.deps);
    expect(t.calls).toEqual([]);
    zohoDeals.get("deal-1")!.passportFiles = [{ id: "img-2" }];
    t.setNow(new Date(NOW.getTime() + DAY));
    expect((await runEinPortalSweepOnce(t.deps)).purged).toEqual(["deal-1"]);
    // Retention fell due on 31 Oct; retired once 90 days have passed with nothing on the Deal.
    t.setNow(new Date("2026-12-15T12:00:00Z"));
    await runEinPortalSweepOnce(t.deps);
    expect(t.deals.get("deal-1")?.retired_at).toBeNull();
    t.setNow(new Date("2027-01-29T12:00:00Z"));
    await runEinPortalSweepOnce(t.deps);
    expect(t.deals.get("deal-1")?.retired_at).not.toBeNull();
  });

  it("clears within 30 days of a Cancelled stage, a Refunded Deal or every EIN order refunded", async () => {
    for (const variant of ["stage", "deal-refunded", "orders-refunded"] as const) {
      const zohoDeals = new Map([
        [
          "deal-1",
          deal({
            passportFiles: [IMG],
            docsReceived: true,
            stage: variant === "stage" ? "Cancelled" : "Paid",
            paymentStatus: variant === "deal-refunded" ? "Refunded" : "Payment Collected",
          }),
        ],
      ]);
      const t = sweepSetup(zohoDeals);
      await registerEinDeals(t.deps);
      if (variant === "orders-refunded") t.orders[0].payment_status = "refunded";
      await runEinPortalSweepOnce(t.deps);
      expect(t.deals.get("deal-1")?.closed_seen_at).toEqual(NOW);
      t.setNow(new Date(NOW.getTime() + 28 * DAY));
      expect((await runEinPortalSweepOnce(t.deps)).purged).toEqual([]);
      expect(t.deals.get("deal-1")?.closed_seen_at).toEqual(NOW);
      t.setNow(new Date(NOW.getTime() + 29 * DAY));
      expect((await runEinPortalSweepOnce(t.deps)).purged).toEqual(["deal-1"]);
    }
  });

  it("does not treat a released card hold as a cancellation", async () => {
    const t = sweepSetup(new Map([["deal-1", deal({ passportFiles: [IMG], docsReceived: true })]]));
    await registerEinDeals(t.deps);
    t.orders[0].payment_status = "released";
    await runEinPortalSweepOnce(t.deps);
    expect(t.deals.get("deal-1")?.closed_seen_at).toBeNull();
    t.setNow(new Date(NOW.getTime() + 40 * DAY));
    expect((await runEinPortalSweepOnce(t.deps)).purged).toEqual([]);
  });

  it("keeps the passport while another EIN order on the same Deal is still live", async () => {
    const t = sweepSetup(new Map([["deal-1", deal({ passportFiles: [IMG], docsReceived: true })]]), [
      order(),
      order({ order_id: "ord-dup", codes: ["EIN_FILING"] }),
    ]);
    await registerEinDeals(t.deps);
    t.orders[1].payment_status = "refunded";
    await runEinPortalSweepOnce(t.deps);
    expect(t.deals.get("deal-1")?.closed_seen_at).toBeNull();
  });

  it("restarts the clock if the Deal stops being cancelled", async () => {
    const zohoDeals = new Map([["deal-1", deal({ passportFiles: [IMG], docsReceived: true, stage: "Cancelled" })]]);
    const t = sweepSetup(zohoDeals);
    await runEinPortalSweepOnce(t.deps);
    expect(t.deals.get("deal-1")?.closed_seen_at).toEqual(NOW);
    zohoDeals.get("deal-1")!.stage = "Paid";
    t.setNow(new Date(NOW.getTime() + 10 * DAY));
    await runEinPortalSweepOnce(t.deps);
    expect(t.deals.get("deal-1")?.closed_seen_at).toBeNull();
    t.setNow(new Date(NOW.getTime() + 35 * DAY));
    expect((await runEinPortalSweepOnce(t.deps)).purged).toEqual([]);
  });

  it("alerts once when a due passport cannot be cleared, retries hourly, then succeeds", async () => {
    const zohoDeals = new Map([["deal-1", deal({ passportFiles: [IMG], docsReceived: true, einIssuedDate: "2026-10-01" })]]);
    const t = sweepSetup(zohoDeals);
    t.zoho.clearFails = true;
    const r = await runEinPortalSweepOnce(t.deps);
    expect(r.purged).toEqual([]);
    expect(r.errors[0]).toContain("still there");
    expect(t.deals.get("deal-1")?.last_error).toBe("still there");
    t.setNow(new Date(NOW.getTime() + 3600_000));
    await runEinPortalSweepOnce(t.deps);
    expect(t.alerts.filter((a) => a.subject === "EIN passport purge failed")).toHaveLength(1);
    t.zoho.clearFails = false;
    t.setNow(new Date(NOW.getTime() + 2 * 3600_000));
    expect((await runEinPortalSweepOnce(t.deps)).purged).toEqual(["deal-1"]);
    expect(t.deals.get("deal-1")?.last_error).toBeNull();
  });

  it("undoes the docs-received claim if the Deal write fails, and keeps going past an unreadable Deal", async () => {
    const zohoDeals = new Map([["deal-2", deal({ passportFiles: [IMG] })]]);
    const t = sweepSetup(zohoDeals, [order(), order({ order_id: "ord-2", filing_session_id: "sess-2", crm_deal_id: "deal-2" })]);
    t.zoho.markDocsReceived = async () => ({ ok: false, error: "Zoho Deal update failed: 500" });
    const r = await runEinPortalSweepOnce(t.deps);
    expect(r.errors).toEqual(["deal-1: not found", "deal-2: Zoho Deal update failed: 500"]);
    expect(t.deals.get("deal-2")?.docs_received_at).toBeNull();
    expect(t.deals.get("deal-1")?.next_check_at).toEqual(new Date(NOW.getTime() + DAY));
    expect(t.alerts).toEqual([]);
  });
});

// ── Real Zoho client against a mocked fetch ───────────────────────────────

describe("realEinPortalClient", () => {
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  let responses: Array<(url: string) => Response | undefined> = [];

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  beforeEach(() => {
    requests.length = 0;
    responses = [];
    vi.stubEnv("ZOHO_CLIENT_ID", "id");
    vi.stubEnv("ZOHO_CLIENT_SECRET", "secret");
    vi.stubEnv("ZOHO_REFRESH_TOKEN", "refresh");
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://accounts.zoho.com/")) return json({ access_token: "tok", expires_in: 3600 });
      requests.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
      const next = responses.shift();
      const res = next?.(url);
      if (!res) throw new Error(`unexpected request ${url}`);
      return res;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("invites the Deal's Contact through the v8 portal_invite action", async () => {
    responses = [
      () => json({ data: [{ Contact_Name: { id: "c-9" } }] }),
      () => json({ data: [{ Email: "Ada@Example.test" }] }),
      () => json({ data: [{ status: "success", code: "SUCCESS" }] }),
    ];
    const r = await realEinPortalClient.inviteDealContact("d-1", "ada@example.test", "777");
    expect(r).toEqual({ ok: true, value: { contactId: "c-9" } });
    expect(requests[2].method).toBe("POST");
    expect(requests[2].url).toBe("https://www.zohoapis.com/crm/v8/Contacts/c-9/actions/portal_invite?user_type_id=777&type=invite&language=en_US");
  });

  it("reads portal_invite answers: top-level success, already a portal user, unfamiliar 2xx, errors", () => {
    expect(inviteOutcome(200, JSON.stringify({ status: "success", code: "SUCCESS", details: { record_id: "c-9" } }))).toBe("invited");
    expect(inviteOutcome(200, JSON.stringify({ data: [{ status: "success" }] }))).toBe("invited");
    expect(inviteOutcome(202, "")).toBe("invited");
    expect(inviteOutcome(400, JSON.stringify({ code: "ALREADY_INVITED", message: "user already invited", status: "error" }))).toBe("invited");
    expect(inviteOutcome(200, JSON.stringify({ status: "error", code: "NO_PERMISSION", message: "permission denied" }))).toBe("NO_PERMISSION permission denied");
    expect(inviteOutcome(500, "oops")).toBe("oops");
  });

  it("sends each Zoho call with a timeout", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://accounts.zoho.com/")) return json({ access_token: "tok" });
      seen.push(init?.signal ?? undefined);
      return json({ data: [{ Stage: "Paid" }] });
    });
    await realEinPortalClient.readDeal("d-1", { docsReceived: "EIN_Docs_Received", passport: "Passport", einIssuedDate: "" });
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });

  it("never invites a Contact whose email is not the customer's", async () => {
    responses = [() => json({ data: [{ Contact_Name: { id: "c-9" } }] }), () => json({ data: [{ Email: "someone@else.test" }] })];
    const r = await realEinPortalClient.inviteDealContact("d-1", "ada@example.test", "777");
    expect(r).toMatchObject({ ok: false, permanent: true });
    expect(requests.some((q) => q.url.includes("portal_invite"))).toBe(false);
  });

  it("treats a Deal with no Contact as needing a person", async () => {
    responses = [() => json({ data: [{ Contact_Name: null }] })];
    expect(await realEinPortalClient.inviteDealContact("d-1", "ada@example.test", "777")).toMatchObject({ ok: false, permanent: true });
  });

  it("reports a record-level Zoho error as a failure", async () => {
    responses = [
      () => json({ data: [{ Contact_Name: { id: "c-9" } }] }),
      () => json({ data: [{ Email: "ada@example.test" }] }),
      () => json({ data: [{ status: "error", code: "NO_PERMISSION", message: "permission denied" }] }),
    ];
    const r = await realEinPortalClient.inviteDealContact("d-1", "ada@example.test", "777");
    expect(r).toMatchObject({ ok: false });
    expect(r.ok ? "" : r.error).toContain("NO_PERMISSION");
  });

  it("reads the Deal fields the sweep needs (v8)", async () => {
    responses = [
      () => json({ data: [{ Stage: "Cancelled", Payment_Status: "Refunded", EIN_Docs_Received: true, Passport: [{ id: "a1" }], EIN_Issued: "2026-11-02" }] }),
    ];
    const r = await realEinPortalClient.readDeal("d-1", { docsReceived: "EIN_Docs_Received", passport: "Passport", einIssuedDate: "EIN_Issued" });
    expect(r).toEqual({
      ok: true,
      value: { stage: "Cancelled", paymentStatus: "Refunded", docsReceived: true, passportFiles: [{ id: "a1" }], einIssuedDate: "2026-11-02" },
    });
    expect(requests[0].url).toBe("https://www.zohoapis.com/crm/v8/Deals/d-1?fields=Stage,Payment_Status,EIN_Docs_Received,Passport,EIN_Issued");
  });

  it("ticks the checkbox and writes the timestamp", async () => {
    responses = [() => json({ data: [{ status: "success" }] })];
    const r = await realEinPortalClient.markDocsReceived("d-1", { docsReceived: "EIN_Docs_Received", docsReceivedAt: "EIN_Docs_Received_At" }, NOW);
    expect(r).toEqual({ ok: true });
    expect(JSON.parse(requests[0].body!)).toEqual({ data: [{ EIN_Docs_Received: true, EIN_Docs_Received_At: "2026-11-25T12:00:00+00:00" }] });
  });

  it("deletes the passport image through v8 Update Records and confirms the field is empty", async () => {
    responses = [() => json({ data: [{ status: "success" }] }), () => json({ data: [{ Passport: null }] })];
    const r = await realEinPortalClient.clearImageField("d-1", "Passport", [{ id: "a1", File_Name__s: "p.jpg" }]);
    expect(r).toEqual({ ok: true });
    expect(requests[0].method).toBe("PUT");
    expect(requests[0].url).toBe("https://www.zohoapis.com/crm/v8/Deals/d-1");
    expect(JSON.parse(requests[0].body!)).toEqual({ data: [{ Passport: [{ id: "a1", _delete: null }] }] });
  });

  it("does not report a purge Zoho ignored", async () => {
    responses = [() => json({ data: [{ status: "success" }] }), () => json({ data: [{ Passport: [{ id: "a1" }] }] })];
    expect(await realEinPortalClient.clearImageField("d-1", "Passport", [{ id: "a1" }])).toMatchObject({ ok: false });
  });

  it("refuses to send a partial delete when an image entry has no id", async () => {
    expect(await realEinPortalClient.clearImageField("d-1", "Passport", [{ id: "a1" }, { File_Name__s: "x" }])).toMatchObject({ ok: false });
    expect(requests).toHaveLength(0);
  });
});
