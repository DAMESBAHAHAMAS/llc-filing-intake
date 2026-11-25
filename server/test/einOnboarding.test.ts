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
  runEinPortalInvitesOnce,
  runEinPortalSweepOnce,
  type EinPortalDeps,
} from "../src/ein/portalJobs.js";
import { createEinOnboardingRouter } from "../src/routes/einOnboarding.js";
import { buildOrderEmail, type OrderEmailRow } from "../src/orderEmails/templates.js";
import { realEinPortalClient, type DealSnapshot, type EinPortalClient } from "../src/zoho/einPortal.js";

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
    expect(c.passportField).toBe("");
    expect(c.purgeStages).toEqual(["Cancelled"]);
    expect(c.purgeDays).toBe(30);
    expect(c.inviteLookbackDays).toBe(30);
    expect(portalUrlFor(c)).toBeNull();
    expect(invitesEnabled(c)).toBe(false);
    expect(sweepEnabled(c)).toBe(false);
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
  email: string | null;
}

interface InviteRow {
  order_id: string;
  filing_session_id: string;
  zoho_deal_id: string;
  zoho_contact_id: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  invited_at: Date | null;
  docs_received_at: Date | null;
  closed_seen_at: Date | null;
  passport_purged_at: Date | null;
  updated_at: Date;
}

function memoryDb(orders: OrderRow[], invites: Map<string, InviteRow>) {
  return {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes("FROM orders o") && sql.includes("LEFT JOIN ein_portal_invites")) {
        const [codes, since, retryBefore] = params as [string[], Date, Date];
        const rows = orders
          .filter((o) => ["authorized", "paid"].includes(o.payment_status))
          .filter((o) => o.crm_deal_id !== null && o.money_at >= since)
          .filter((o) => o.codes.some((c) => codes.includes(c)))
          .filter((o) => {
            const i = invites.get(o.order_id);
            return !i || (["pending", "failed"].includes(i.status) && i.updated_at < retryBefore);
          })
          .map((o) => ({ order_id: o.order_id, filing_session_id: o.filing_session_id, crm_deal_id: o.crm_deal_id, email: o.email }));
        return { rows };
      }
      if (sql.includes("INSERT INTO ein_portal_invites")) {
        const [orderId, sid, dealId, now, retryBefore] = params as [string, string, string, Date, Date];
        const existing = invites.get(orderId);
        if (!existing) {
          const row: InviteRow = {
            order_id: orderId, filing_session_id: sid, zoho_deal_id: dealId, zoho_contact_id: null, status: "pending",
            attempts: 1, last_error: null, invited_at: null, docs_received_at: null, closed_seen_at: null,
            passport_purged_at: null, updated_at: now,
          };
          invites.set(orderId, row);
          return { rows: [{ attempts: 1 }] };
        }
        if (["pending", "failed"].includes(existing.status) && existing.updated_at < retryBefore) {
          existing.status = "pending";
          existing.attempts += 1;
          existing.updated_at = now;
          return { rows: [{ attempts: existing.attempts }] };
        }
        return { rows: [] };
      }
      if (sql.includes("SET status = 'invited'")) {
        const [orderId, contactId, now] = params as [string, string, Date];
        Object.assign(invites.get(orderId)!, { status: "invited", zoho_contact_id: contactId, invited_at: now, last_error: null, updated_at: now });
        return { rows: [] };
      }
      if (sql.includes("SET status = $2, last_error")) {
        const [orderId, status, error, now] = params as [string, string, string, Date];
        Object.assign(invites.get(orderId)!, { status, last_error: error, updated_at: now });
        return { rows: [] };
      }
      if (sql.includes("FROM ein_portal_invites i JOIN orders o")) {
        const rows = [...invites.values()]
          .filter((i) => i.status === "invited" && i.passport_purged_at === null)
          .map((i) => ({
            order_id: i.order_id,
            zoho_deal_id: i.zoho_deal_id,
            docs_received_at: i.docs_received_at,
            closed_seen_at: i.closed_seen_at,
            payment_status: orders.find((o) => o.order_id === i.order_id)!.payment_status,
          }));
        return { rows };
      }
      if (sql.includes("SET last_error = $2, updated_at = $3")) {
        const [orderId, error, now] = params as [string, string, Date];
        Object.assign(invites.get(orderId)!, { last_error: error, updated_at: now });
        return { rows: [] };
      }
      if (sql.includes("SET docs_received_at = $2")) {
        const [orderId, docs, closed, purged, now] = params as [string, Date | null, Date | null, Date | null, Date];
        Object.assign(invites.get(orderId)!, { docs_received_at: docs, closed_seen_at: closed, passport_purged_at: purged, last_error: null, updated_at: now });
        return { rows: [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
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
    async clearFileField(dealId, field) {
      calls.push(`clear ${dealId} ${field}`);
      if (zoho.clearFails) return { ok: false, error: "still there" };
      deals.get(dealId)!.passportFiles = [];
      return { ok: true };
    },
  };
  return { zoho, calls };
}

const NOW = new Date("2026-11-25T12:00:00Z");

function order(over: Partial<OrderRow> = {}): OrderRow {
  return {
    order_id: "ord-1",
    filing_session_id: "sess-1",
    crm_deal_id: "deal-1",
    payment_status: "authorized",
    money_at: new Date("2026-11-25T10:00:00Z"),
    codes: ["FASTTRACK"],
    email: "ada@example.test",
    ...over,
  };
}

function setup(orders: OrderRow[], deals = new Map<string, DealSnapshot>(), config = cfg()) {
  const invites = new Map<string, InviteRow>();
  const { zoho, calls } = fakeZoho(deals);
  const alerts: Array<{ subject: string; body: string }> = [];
  let now = NOW;
  const deps: EinPortalDeps = {
    db: memoryDb(orders, invites) as never,
    zoho,
    config,
    now: () => now,
    alert: async (subject, body) => {
      alerts.push({ subject, body });
    },
  };
  return { deps, invites, zoho, calls, alerts, deals, setNow: (d: Date) => (now = d) };
}

describe("portal invites", () => {
  it("does nothing while switched off or without a user type", async () => {
    for (const config of [cfg({ enabled: false }), cfg({ portalUserTypeId: "" }), cfg({ portalUrl: "" })]) {
      const t = setup([order()], undefined, config);
      expect(await runEinPortalInvitesOnce(t.deps)).toEqual({ invited: [], failed: [], blocked: [] });
      expect(t.calls).toEqual([]);
    }
  });

  it("invites each EIN order's customer once, for the order's own Deal", async () => {
    const t = setup([
      order(),
      order({ order_id: "ord-diy", crm_deal_id: "deal-2", codes: ["DIY_STATE_FEE", "DIY_SERVICE_FEE"] }),
      order({ order_id: "ord-pending", crm_deal_id: "deal-3", payment_status: "pending" }),
      order({ order_id: "ord-old", crm_deal_id: "deal-4", money_at: new Date("2026-09-01T00:00:00Z") }),
      order({ order_id: "ord-nodeal", crm_deal_id: null }),
    ]);
    expect((await runEinPortalInvitesOnce(t.deps)).invited).toEqual(["ord-1"]);
    expect(t.calls).toEqual(["invite deal-1 ada@example.test 2654294000099000001"]);
    expect(t.invites.get("ord-1")).toMatchObject({ status: "invited", zoho_contact_id: "contact-1", invited_at: NOW });
    // Second tick: already invited, nothing sent again.
    await runEinPortalInvitesOnce(t.deps);
    expect(t.calls).toHaveLength(1);
  });

  it("blocks and alerts when the Deal has no matching Contact", async () => {
    const t = setup([order()]);
    t.zoho.inviteResult = { ok: false, permanent: true, error: "Deal deal-1 has no linked Contact to invite" };
    expect((await runEinPortalInvitesOnce(t.deps)).blocked).toEqual(["ord-1"]);
    expect(t.invites.get("ord-1")?.status).toBe("blocked");
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
    expect(t.invites.get("ord-1")).toMatchObject({ status: "failed", attempts: 1 });
    // Within the hour: not retried.
    t.setNow(new Date(NOW.getTime() + 30 * 60_000));
    await runEinPortalInvitesOnce(t.deps);
    expect(t.calls).toHaveLength(1);
    for (let i = 1; i < INVITE_MAX_ATTEMPTS; i++) {
      t.setNow(new Date(NOW.getTime() + i * 2 * 3600_000));
      await runEinPortalInvitesOnce(t.deps);
    }
    expect(t.calls).toHaveLength(INVITE_MAX_ATTEMPTS);
    expect(t.invites.get("ord-1")).toMatchObject({ status: "blocked", attempts: INVITE_MAX_ATTEMPTS });
    expect(t.alerts).toHaveLength(1);
  });
});

describe("docs received and passport retention sweep", () => {
  const FILE = { attachment_Id: "att-1", File_Name__s: "passport.jpg" };

  function deal(over: Partial<DealSnapshot> = {}): DealSnapshot {
    return { stage: "Payment Pending", docsReceived: false, passportFiles: [], einIssuedDate: null, ...over };
  }

  async function invited(deals: Map<string, DealSnapshot>, orders = [order()], config = cfg()) {
    const t = setup(orders, deals, config);
    await runEinPortalInvitesOnce(t.deps);
    t.calls.length = 0;
    return t;
  }

  it("does nothing while switched off or without the passport field", async () => {
    for (const config of [cfg({ enabled: false }), cfg({ passportField: "" })]) {
      const t = await invited(new Map([["deal-1", deal({ passportFiles: [FILE] })]]), [order()], cfg());
      t.deps.config = config;
      expect(await runEinPortalSweepOnce(t.deps)).toEqual({ docsReceived: [], purged: [], errors: [] });
      expect(t.calls).toEqual([]);
    }
  });

  it("waits while no passport is on the Deal", async () => {
    const t = await invited(new Map([["deal-1", deal()]]));
    expect((await runEinPortalSweepOnce(t.deps)).docsReceived).toEqual([]);
    expect(t.calls).toEqual(["read deal-1"]);
    expect(t.invites.get("ord-1")?.docs_received_at).toBeNull();
  });

  it("ticks EIN Docs Received with its timestamp and alerts the team, once", async () => {
    const t = await invited(new Map([["deal-1", deal({ passportFiles: [FILE] })]]));
    expect((await runEinPortalSweepOnce(t.deps)).docsReceived).toEqual(["ord-1"]);
    expect(t.calls).toEqual(["read deal-1", `mark deal-1 EIN_Docs_Received EIN_Docs_Received_At ${NOW.toISOString()}`]);
    expect(t.invites.get("ord-1")?.docs_received_at).toEqual(NOW);
    expect(t.alerts.map((a) => a.subject)).toEqual(["EIN docs received"]);
    await runEinPortalSweepOnce(t.deps);
    expect(t.calls.filter((c) => c.startsWith("mark"))).toHaveLength(1);
    expect(t.alerts).toHaveLength(1);
  });

  it("does not rewrite the Deal when a Zoho workflow already ticked it", async () => {
    const t = await invited(new Map([["deal-1", deal({ passportFiles: [FILE], docsReceived: true })]]));
    expect((await runEinPortalSweepOnce(t.deps)).docsReceived).toEqual(["ord-1"]);
    expect(t.calls).toEqual(["read deal-1"]);
  });

  it("clears the passport 30 days after the EIN is issued, not before", async () => {
    const deals = new Map([["deal-1", deal({ passportFiles: [FILE], docsReceived: true, einIssuedDate: "2026-11-01" })]]);
    const t = await invited(deals);
    t.setNow(new Date("2026-11-30T23:00:00Z"));
    expect((await runEinPortalSweepOnce(t.deps)).purged).toEqual([]);
    t.setNow(new Date("2026-12-01T00:30:00Z"));
    expect((await runEinPortalSweepOnce(t.deps)).purged).toEqual(["ord-1"]);
    expect(t.calls).toContain("clear deal-1 Passport_Photo_Page");
    expect(t.invites.get("ord-1")?.passport_purged_at).toEqual(new Date("2026-12-01T00:30:00Z"));
    expect(t.invites.get("ord-1")?.docs_received_at).not.toBeNull();
    // Purged rows are not swept again.
    t.calls.length = 0;
    await runEinPortalSweepOnce(t.deps);
    expect(t.calls).toEqual([]);
  });

  it("clears within 30 days of a cancelled Deal or a released/refunded order", async () => {
    for (const variant of ["stage", "released", "refunded"] as const) {
      const deals = new Map([["deal-1", deal({ passportFiles: [FILE], docsReceived: true, stage: variant === "stage" ? "Cancelled" : "Paid" })]]);
      const orders = [order()];
      const t = await invited(deals, orders);
      if (variant !== "stage") orders[0].payment_status = variant;
      await runEinPortalSweepOnce(t.deps);
      expect(t.invites.get("ord-1")?.closed_seen_at).toEqual(NOW);
      t.setNow(new Date(NOW.getTime() + 28 * 86_400_000));
      expect((await runEinPortalSweepOnce(t.deps)).purged).toEqual([]);
      expect(t.invites.get("ord-1")?.closed_seen_at).toEqual(NOW);
      t.setNow(new Date(NOW.getTime() + 29 * 86_400_000));
      expect((await runEinPortalSweepOnce(t.deps)).purged).toEqual(["ord-1"]);
    }
  });

  it("alerts when a due passport cannot be cleared, and tries again next time", async () => {
    const deals = new Map([["deal-1", deal({ passportFiles: [FILE], docsReceived: true, einIssuedDate: "2026-10-01" })]]);
    const t = await invited(deals);
    t.zoho.clearFails = true;
    const r = await runEinPortalSweepOnce(t.deps);
    expect(r.purged).toEqual([]);
    expect(r.errors[0]).toContain("still there");
    expect(t.alerts.at(-1)?.subject).toBe("EIN passport purge failed");
    expect(t.invites.get("ord-1")?.passport_purged_at).toBeNull();
    t.zoho.clearFails = false;
    expect((await runEinPortalSweepOnce(t.deps)).purged).toEqual(["ord-1"]);
  });

  it("keeps going past a Deal it cannot read", async () => {
    const deals = new Map([["deal-2", deal({ passportFiles: [FILE] })]]);
    const t = await invited(deals, [order(), order({ order_id: "ord-2", crm_deal_id: "deal-2" })]);
    const r = await runEinPortalSweepOnce(t.deps);
    expect(r.errors).toEqual(["ord-1: not found"]);
    expect(r.docsReceived).toEqual(["ord-2"]);
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

  it("reads the Deal fields the sweep needs", async () => {
    responses = [() => json({ data: [{ Stage: "Cancelled", EIN_Docs_Received: true, Passport: [{ attachment_Id: "a1" }], EIN_Issued: "2026-11-02" }] })];
    const r = await realEinPortalClient.readDeal("d-1", { docsReceived: "EIN_Docs_Received", passport: "Passport", einIssuedDate: "EIN_Issued" });
    expect(r).toEqual({ ok: true, value: { stage: "Cancelled", docsReceived: true, passportFiles: [{ attachment_Id: "a1" }], einIssuedDate: "2026-11-02" } });
    expect(requests[0].url).toBe("https://www.zohoapis.com/crm/v2/Deals/d-1?fields=Stage,EIN_Docs_Received,Passport,EIN_Issued");
  });

  it("ticks the checkbox and writes the timestamp", async () => {
    responses = [() => json({ data: [{ status: "success" }] })];
    const r = await realEinPortalClient.markDocsReceived("d-1", { docsReceived: "EIN_Docs_Received", docsReceivedAt: "EIN_Docs_Received_At" }, NOW);
    expect(r).toEqual({ ok: true });
    expect(JSON.parse(requests[0].body!)).toEqual({ data: [{ EIN_Docs_Received: true, EIN_Docs_Received_At: "2026-11-25T12:00:00+00:00" }] });
  });

  it("clears the passport field and confirms it is empty", async () => {
    responses = [() => json({ data: [{ status: "success" }] }), () => json({ data: [{ Passport: [] }] })];
    const r = await realEinPortalClient.clearFileField("d-1", "Passport", [{ attachment_Id: "a1" }]);
    expect(r).toEqual({ ok: true });
    expect(JSON.parse(requests[0].body!)).toEqual({ data: [{ Passport: [{ attachment_id: "a1", _delete: null }] }] });
  });

  it("does not report a purge Zoho ignored", async () => {
    responses = [() => json({ data: [{ status: "success" }] }), () => json({ data: [{ Passport: [{ attachment_Id: "a1" }] }] })];
    expect(await realEinPortalClient.clearFileField("d-1", "Passport", [{ attachment_Id: "a1" }])).toMatchObject({ ok: false });
  });
});
