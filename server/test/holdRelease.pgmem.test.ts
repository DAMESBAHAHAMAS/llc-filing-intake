import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOrderEmailDb } from "./helpers/orderEmailDb.js";
import type { HoldReleaseDeps } from "../src/payments/holdRelease.js";

/**
 * Day-5 hold release (owner's final hold rule, 25 Nov 2026), with the real SQL of
 * migration 0038 against pg-mem, the real email queue and worker, and the real
 * webhook handler for the customer's payment. Stripe is faked: no card is touched,
 * no link is created, no email is sent.
 */
vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://unused.invalid/none";
});
vi.mock("../src/ops/alerts.js", () => ({ sendOpsAlert: vi.fn(async () => ({ channel: "log", ok: true })), notifyOrderEvent: vi.fn() }));

const {
  floridaMidnight,
  holdReleaseConfig,
  paymentLinkLines,
  runHoldReleaseOnce,
  zohoDateTime,
} = await import("../src/payments/holdRelease.js");
const { handlePaymentLifecycleEvent } = await import("../src/routes/webhooksStripe.js");
const { runOnce: runOrderEmails } = await import("../src/orderEmails/worker.js");

const NOW = new Date("2026-12-10T15:00:00Z");
const START = "2026-11-25";
const HOURS = 3600 * 1000;

const FS = "11111111-1111-4111-8111-111111111111";
const DUE = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001"; // held 121 h ago, after the start date
const YOUNG = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002"; // held 100 h ago
const OLD = "aaaaaaaa-aaaa-4aaa-8aaa-000000000003"; // held before the start date
const FILED = "aaaaaaaa-aaaa-4aaa-8aaa-000000000004"; // proof recorded, capture failed
const KICKOFF = "aaaaaaaa-aaaa-4aaa-8aaa-000000000005"; // Finance-Ready $139 kickoff hold
const OPERATOR = "aaaaaaaa-aaaa-4aaa-8aaa-000000000006"; // released by an operator (customer cancelled)

const BANK_READY = [
  { offer_code: "FASTTRACK", offer_version: "v3", display_name: "Bank-Ready", stripe_price_id: "price_bank", unit_amount_cents: 49900, quantity: 1 },
];
const KICKOFF_LINES = [
  { offer_code: "DIY_STATE_FEE", stripe_price_id: "price_state", unit_amount_cents: 12500, quantity: 1 },
  { offer_code: "DIY_SERVICE_FEE", stripe_price_id: "price_service", unit_amount_cents: 900, quantity: 1 },
  { offer_code: "DIY_CERT_OF_STATUS", stripe_price_id: "price_cert", unit_amount_cents: 500, quantity: 1 },
  { offer_code: "PREMIUM", stripe_price_id: null, unit_amount_cents: 0, quantity: 1, role: "selected_package" },
];

function migration0038(): string {
  return readFileSync(new URL("../migrations/0038_orders_hold_release.sql", import.meta.url), "utf8").replace(/^--.*$/gm, "");
}

interface Harness {
  pool: Pool;
  deps: HoldReleaseDeps;
  stripe: { cancel: ReturnType<typeof vi.fn>; retrieve: ReturnType<typeof vi.fn>; link: ReturnType<typeof vi.fn> };
  alerts: Array<{ subject: string; body: string }>;
  order: (id: string) => Promise<Record<string, unknown>>;
}

async function setup(env: Record<string, string> = {}): Promise<Harness> {
  const pool = await createOrderEmailDb();
  await pool.query(`ALTER TABLE orders ADD COLUMN released_at timestamptz`);
  await pool.query(`ALTER TABLE orders ADD COLUMN created_at timestamptz NOT NULL DEFAULT now()`);
  await pool.query(`ALTER TABLE orders ADD COLUMN captured_at timestamptz`);
  await pool.query(migration0038());
  await pool.query(
    `INSERT INTO filing_sessions (filing_session_id, email, full_name, entity_name_primary, filing_data)
     VALUES ($1, 'ada@example.test', 'Ada Test', 'ADA TEST LLC', '{"llc_name":"ADA TEST LLC","registered_agent_path":"house"}')`,
    [FS]
  );
  const add = (id: string, hoursAgo: number, lines: unknown[], total: number, over: Record<string, unknown> = {}) =>
    pool.query(
      `INSERT INTO orders (order_id, filing_session_id, crm_intent, product, line_items, total_cents, stripe_payment_intent_id,
                           payment_status, fulfillment_status, authorized_at, crm_deal_id, proof_of_filing_at, hold_release_started_at)
       VALUES ($1, $2, 'X', 'FASTTRACK', $3, $4, $5, $6, $7, $8, $9, $10, NULL)`,
      [
        id,
        FS,
        JSON.stringify(lines),
        total,
        `pi_${id.slice(-1)}`,
        over.payment_status ?? "authorized",
        over.fulfillment_status ?? "ready",
        new Date(NOW.getTime() - hoursAgo * HOURS),
        "deal-1",
        over.proof_of_filing_at ?? null,
      ]
    );
  await add(DUE, 121, BANK_READY, 49900);
  await add(YOUNG, 100, BANK_READY, 49900);
  await add(OLD, 24 * 20, BANK_READY, 49900); // 20 Nov: before HOLD_RELEASE_START
  await add(FILED, 130, BANK_READY, 49900, { proof_of_filing_at: new Date(NOW.getTime() - 10 * HOURS), fulfillment_status: "requires_review" });
  await add(KICKOFF, 125, KICKOFF_LINES, 13900);
  await add(OPERATOR, 140, BANK_READY, 49900, { payment_status: "released", fulfillment_status: "not_ready" });
  // The Deal of these orders was verified by its own sync job.
  await pool.query(
    `INSERT INTO crm_sync_queue (filing_session_id, order_id, sync_type, payload_snapshot, status) VALUES ($1, $2, 'order_deal', '{}', 'synced')`,
    [FS, DUE]
  );

  const stripe = {
    cancel: vi.fn(async (id: string) => ({ id, status: "canceled" })),
    retrieve: vi.fn(async (id: string) => ({ id, status: "canceled" })),
    link: vi.fn(async (p: { idempotencyKey: string }) => ({ id: `plink_${p.idempotencyKey.slice(-1)}`, url: `https://buy.stripe.com/test_${p.idempotencyKey.slice(-1)}`, active: true })),
  };
  const alerts: Array<{ subject: string; body: string }> = [];
  const deps: HoldReleaseDeps = {
    cancelPaymentIntent: stripe.cancel as unknown as HoldReleaseDeps["cancelPaymentIntent"],
    retrievePaymentIntent: stripe.retrieve as unknown as HoldReleaseDeps["retrievePaymentIntent"],
    createPaymentLink: stripe.link as unknown as HoldReleaseDeps["createPaymentLink"],
    alert: async (subject, body) => {
      alerts.push({ subject, body });
    },
    now: () => NOW,
    config: () => holdReleaseConfig({ HOLD_RELEASE_START: START, ...env }),
  };
  const order = async (id: string) => (await pool.query(`SELECT * FROM orders WHERE order_id = $1`, [id])).rows[0] as Record<string, unknown>;
  return { pool, deps, stripe, alerts, order };
}

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => undefined));

describe("config", () => {
  it("defaults: on, start 25 Nov 2026 at midnight in Florida, 120 hours", () => {
    const cfg = holdReleaseConfig({});
    expect(cfg).toEqual({ enabled: true, start: new Date("2026-11-25T05:00:00Z"), afterHours: 120 });
    expect(floridaMidnight("2026-07-04")?.toISOString()).toBe("2026-07-04T04:00:00.000Z"); // EDT
  });

  it("HOLD_RELEASE_ENABLED=off is the kill switch; a bad value switches the job off with a reason", () => {
    expect(holdReleaseConfig({ HOLD_RELEASE_ENABLED: "off" }).enabled).toBe(false);
    expect(holdReleaseConfig({ HOLD_RELEASE_START: "soon" }).error).toMatch(/HOLD_RELEASE_START/);
    expect(holdReleaseConfig({ HOLD_RELEASE_AFTER_HOURS: "200" }).error).toMatch(/HOLD_RELEASE_AFTER_HOURS/);
  });

  it("builds the link from the order's own Prices; the kickoff's zero-amount package line is left out", () => {
    expect(paymentLinkLines(KICKOFF_LINES, 13900)).toEqual([
      { price: "price_state", quantity: 1 },
      { price: "price_service", quantity: 1 },
      { price: "price_cert", quantity: 1 },
    ]);
    expect(paymentLinkLines(BANK_READY, 49900)).toEqual([{ price: "price_bank", quantity: 1 }]);
    expect(paymentLinkLines(BANK_READY, 50000)).toBeNull(); // does not add up: no link
    expect(paymentLinkLines([{ offer_code: "X", unit_amount_cents: 100 }], 100)).toBeNull();
    expect(zohoDateTime(NOW)).toBe("2026-12-10T15:00:00+00:00");
  });
});

describe("runHoldReleaseOnce", () => {
  it("releases only uncaptured holds placed since the start date and at least 120 h old, then emails a payment link", async () => {
    const t = await setup();
    const r = await runHoldReleaseOnce(t.pool, t.deps);
    expect(r.released.sort()).toEqual([DUE, KICKOFF].sort());
    expect(r.alertedLegacy).toEqual([OLD]);
    expect(r.alertedWithProof).toEqual([FILED]);

    // Stripe: cancelled as abandoned, link from the same Prices, metadata.order_id; never a charge.
    expect(t.stripe.cancel).toHaveBeenCalledWith("pi_1", `day5-release-${DUE}`, "abandoned");
    expect(t.stripe.cancel).toHaveBeenCalledTimes(2);
    expect(t.stripe.link).toHaveBeenCalledWith(
      expect.objectContaining({
        lineItems: [{ price: "price_bank", quantity: 1 }],
        metadata: expect.objectContaining({ order_id: DUE }),
        idempotencyKey: `day5-paylink-${DUE}`,
      })
    );
    expect(t.stripe.link).toHaveBeenCalledWith(expect.objectContaining({ lineItems: paymentLinkLines(KICKOFF_LINES, 13900) }));

    const due = await t.order(DUE);
    expect(due.payment_status).toBe("released");
    expect(due.fulfillment_status).toBe("not_ready"); // filing that had not started stops
    expect(due.payment_link_url).toBe("https://buy.stripe.com/test_1");
    expect(due.hold_auto_released_at).toEqual(NOW);

    // Untouched: too young, before the start date, filed, operator-released.
    expect((await t.order(YOUNG)).payment_status).toBe("authorized");
    expect((await t.order(OLD)).payment_status).toBe("authorized");
    expect((await t.order(FILED)).payment_status).toBe("authorized");
    expect((await t.order(OPERATOR)).payment_link_url).toBeNull();
    for (const pi of ["pi_2", "pi_3", "pi_4", "pi_6"]) expect(t.stripe.cancel).not.toHaveBeenCalledWith(pi, expect.anything(), expect.anything());

    // Zoho: a field-only Deal update with the existing Hold Released value and Hold_Expires.
    const deal = (await t.pool.query(`SELECT payload_snapshot FROM crm_sync_queue WHERE order_id = $1 AND sync_type = 'deal_stage_update'`, [DUE])).rows;
    expect(deal).toHaveLength(1);
    expect(deal[0].payload_snapshot).toMatchObject({
      crm_deal_id: "deal-1",
      extra_fields: { Payment_Status: "Hold Released", Hold_Expires: "2026-12-10T15:00:00+00:00" },
      server_created: true,
    });
    expect(deal[0].payload_snapshot.target_stage).toBeUndefined();

    // One alert for the legacy holds, one for the filed one, one summary of releases.
    expect(t.alerts.map((a) => a.subject)).toEqual([
      "Card holds placed before the Day-5 release started",
      "Filed orders still not collected at Day 5",
      "Card holds released at Day 5",
    ]);
    expect(t.alerts[0].body).toContain(OLD);
  });

  it("sends the customer the link through the email queue, once", async () => {
    const t = await setup();
    await runHoldReleaseOnce(t.pool, t.deps);
    const sent: Array<{ to: string; subject: string; text: string; idempotencyKey: string }> = [];
    await runOrderEmails(t.pool, {
      send: async (m) => {
        sent.push(m);
        return { ok: true, providerMessageId: "msg" };
      },
    });
    const mine = sent.filter((m) => m.idempotencyKey === `order-email/${DUE}/hold_released`);
    expect(mine).toHaveLength(1);
    expect(mine[0].to).toBe("ada@example.test");
    expect(mine[0].text).toContain("Nothing was charged.");
    expect(mine[0].text).toContain("Pay $499.00 securely (https://buy.stripe.com/test_1)");
    expect(sent.find((m) => m.idempotencyKey === `order-email/${KICKOFF}/hold_released`)?.text).toContain("Pay $139.00 securely");
  });

  it("is idempotent: a second run releases nothing and alerts nothing new", async () => {
    const t = await setup();
    await runHoldReleaseOnce(t.pool, t.deps);
    t.alerts.length = 0;
    const again = await runHoldReleaseOnce(t.pool, t.deps);
    expect(t.alerts.map((a) => a.subject + ": " + a.body)).toEqual([]);
    expect(again.released).toEqual([]);
    expect(again.alertedLegacy).toEqual([]);
    expect(t.alerts).toEqual([]);
    expect(t.stripe.link).toHaveBeenCalledTimes(2);
    const emails = await t.pool.query(`SELECT 1 FROM crm_sync_queue WHERE sync_type = 'customer_email_hold_released'`);
    expect(emails.rows).toHaveLength(2);
  });

  it("resumes a run that stopped after the cancel, even once the webhook marked the order released", async () => {
    const t = await setup();
    const realLink = t.stripe.link.getMockImplementation() as (p: { idempotencyKey: string }) => Promise<unknown>;
    t.stripe.link.mockImplementation(async (p: { idempotencyKey: string }) => {
      if (p.idempotencyKey.endsWith(DUE)) throw new Error("Stripe down");
      return realLink(p);
    });
    const first = await runHoldReleaseOnce(t.pool, t.deps);
    expect(first.failed).toContain(DUE);
    expect((await t.order(DUE)).hold_release_error).toMatch(/payment link could not be created/);
    // Stripe's payment_intent.canceled webhook arrives in between.
    await t.pool.query(`UPDATE orders SET payment_status = 'released', released_at = now(), fulfillment_status = 'not_ready' WHERE order_id = $1`, [DUE]);
    t.stripe.link.mockImplementation(realLink);
    t.stripe.cancel.mockRejectedValueOnce(new Error("already canceled"));
    const second = await runHoldReleaseOnce(t.pool, t.deps);
    expect(second.released).toEqual([DUE]);
    const due = await t.order(DUE);
    expect(due.payment_link_url).toBe("https://buy.stripe.com/test_1");
    expect(due.hold_release_error).toBeNull();
  });

  it("leaves a hold that was captured meanwhile to the webhook", async () => {
    const t = await setup();
    t.stripe.cancel.mockImplementation(async () => {
      throw new Error("unexpected state");
    });
    t.stripe.retrieve.mockImplementation(async (id: string) => ({ id, status: "succeeded" }));
    const r = await runHoldReleaseOnce(t.pool, t.deps);
    expect(r.released).toEqual([]);
    expect(t.stripe.link).not.toHaveBeenCalled();
    expect((await t.order(DUE)).hold_release_started_at).toBeNull();
  });

  it("does not release when no link can be made, and alerts once", async () => {
    const t = await setup();
    await t.pool.query(`UPDATE orders SET total_cents = 50000 WHERE order_id = $1`, [DUE]);
    await runHoldReleaseOnce(t.pool, t.deps);
    await runHoldReleaseOnce(t.pool, t.deps);
    expect(t.stripe.cancel).not.toHaveBeenCalledWith("pi_1", expect.anything(), expect.anything());
    expect((await t.order(DUE)).payment_status).toBe("authorized");
    expect(t.alerts.filter((a) => a.subject === "Day-5 hold release needs a person")).toHaveLength(1);
  });

  it("does nothing at all with the kill switch off", async () => {
    const t = await setup({ HOLD_RELEASE_ENABLED: "off" });
    const r = await runHoldReleaseOnce(t.pool, t.deps);
    expect(r).toMatchObject({ ran: false, released: [], alertedLegacy: [] });
    expect(t.stripe.cancel).not.toHaveBeenCalled();
    expect(t.alerts).toEqual([]);
  });

  it("does nothing, quietly, before migration 0038 is applied", async () => {
    const pool = await createOrderEmailDb();
    const t = await setup();
    const r = await runHoldReleaseOnce(pool, t.deps);
    expect(r.ran).toBe(false);
    expect(t.stripe.cancel).not.toHaveBeenCalled();
  });

  it("the customer's payment through the link marks the order paid via metadata.order_id", async () => {
    const t = await setup();
    await runHoldReleaseOnce(t.pool, t.deps);
    const client = await t.pool.connect();
    const out = await handlePaymentLifecycleEvent(client as never, {
      id: "evt_1",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_from_link", metadata: { order_id: DUE, reason: "day5_hold_release" } } },
    });
    client.release();
    expect(out).toEqual({ processingResult: "collected_deal_update_enqueued", orderId: DUE });
    expect((await t.order(DUE)).payment_status).toBe("paid");
  });
});
