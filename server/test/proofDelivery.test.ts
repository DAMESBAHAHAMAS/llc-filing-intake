import { describe, expect, it, vi } from "vitest";
import { deliverProofToCustomer, renderProofEmail, type ProofOrderRow } from "../src/proofDelivery/deliverProof.js";
import { realOrderEmailSender, type OrderEmailMessage, type OrderEmailSender } from "../src/orderEmails/sender.js";
import { DISCLAIMER } from "../src/orderEmails/templates.js";

const row: ProofOrderRow = {
  order_id: "ord-1",
  line_items: [{ offer_code: "FASTTRACK" }],
  total_cents: 19900,
  proof_of_filing_ref: "L26000123456",
  proof_delivered_at: null,
  email: "founder@example.com",
  full_name: "Ana Maria Silva",
  phone: null,
  country: null,
  entity_name_primary: "Fallback Name LLC",
  entity_name_backup: null,
  filing_data: { llc_name: "Sol Ventures LLC" },
  registered_agent_status: "accepted",
  payment_status: "authorized",
  authorized_at: new Date(),
  cancelled_at: null,
  deferred_charged_at: null,
  stripe_livemode: true,
};

function fakePool(found: ProofOrderRow | null) {
  const writes: Array<{ sql: string; params?: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (/^\s*SELECT/.test(sql)) return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    writes.push({ sql, params });
    return { rows: [], rowCount: 1 };
  });
  return { pool: { query } as never, writes };
}

function recordingSender(result: { ok: boolean; providerMessageId?: string; error?: string } = { ok: true, providerMessageId: "msg_1" }) {
  const sent: OrderEmailMessage[] = [];
  const sender: OrderEmailSender = {
    send: vi.fn(async (message) => {
      sent.push(message);
      return result;
    }),
  };
  return { sender, sent };
}

describe("deliverProofToCustomer", () => {
  it("emails the document number and records the delivery", async () => {
    const { pool, writes } = fakePool(row);
    const { sender, sent } = recordingSender();
    expect(await deliverProofToCustomer(pool, "ord-1", sender)).toEqual({ ok: true, alreadyDelivered: false });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "founder@example.com", idempotencyKey: "proof-of-filing/ord-1" });
    expect(sent[0].text).toContain("L26000123456");
    expect(writes[0].sql).toMatch(/proof_delivered_at = now\(\)/);
    expect(writes[0].params).toEqual(["ord-1", "msg_1"]);
  });

  it("treats a send that takes too long as not delivered, and keeps the key for the retry", async () => {
    const { pool, writes } = fakePool(row);
    const stalled: OrderEmailSender = { send: () => new Promise(() => undefined) };
    const result = await deliverProofToCustomer(pool, "ord-1", stalled, 5);
    expect(result.ok).toBe(false);
    expect(writes.some((w) => /proof_delivered_at = now\(\)/.test(w.sql))).toBe(false);
    expect(writes.some((w) => /proof_delivery_error/.test(w.sql))).toBe(true);
  });

  it("does not send twice", async () => {
    const { pool, writes } = fakePool({ ...row, proof_delivered_at: new Date() });
    const { sender, sent } = recordingSender();
    expect(await deliverProofToCustomer(pool, "ord-1", sender)).toEqual({ ok: true, alreadyDelivered: true });
    expect(sent).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it("fails, and records why, when the provider refuses", async () => {
    const { pool, writes } = fakePool(row);
    const { sender } = recordingSender({ ok: false, error: "domain not verified" });
    expect(await deliverProofToCustomer(pool, "ord-1", sender)).toEqual({ ok: false, error: "domain not verified" });
    expect(writes).toHaveLength(1);
    expect(writes[0].sql).toMatch(/proof_delivery_error/);
    expect(writes[0].sql).not.toMatch(/proof_delivered_at/);
  });

  it("fails when the order has no customer email", async () => {
    const { pool } = fakePool({ ...row, email: "  " });
    const { sender, sent } = recordingSender();
    const r = await deliverProofToCustomer(pool, "ord-1", sender);
    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("fails when no proof is recorded or the order is unknown", async () => {
    const { sender, sent } = recordingSender();
    expect((await deliverProofToCustomer(fakePool({ ...row, proof_of_filing_ref: null }).pool, "ord-1", sender)).ok).toBe(false);
    expect((await deliverProofToCustomer(fakePool(null).pool, "ord-1", sender)).ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("does not report success when the delivery cannot be recorded", async () => {
    const query = vi.fn(async (sql: string) => {
      if (/^\s*SELECT/.test(sql)) return { rows: [row], rowCount: 1 };
      throw new Error("database unavailable");
    });
    const { sender } = recordingSender();
    const r = await deliverProofToCustomer({ query } as never, "ord-1", sender);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("database unavailable") });
  });

  it("does not throw when the database read fails", async () => {
    const query = vi.fn(async () => {
      throw new Error("no such column");
    });
    const { sender, sent } = recordingSender();
    expect((await deliverProofToCustomer({ query } as never, "ord-1", sender)).ok).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe("renderProofEmail", () => {
  it("names the company and the document number, in text and html", () => {
    const e = renderProofEmail(row);
    expect(e.subject).toBe("Your LLC is filed: Sol Ventures LLC");
    for (const body of [e.text, e.html]) {
      expect(body).toContain("L26000123456");
      expect(body).toContain("Sol Ventures LLC");
      expect(body).toContain("Hi Ana,");
      expect(body).toContain(DISCLAIMER);
    }
  });

  it("falls back to the session's entity name", () => {
    expect(renderProofEmail({ ...row, filing_data: null }).subject).toContain("Fallback Name LLC");
  });

  it("keeps an EIN out of the email on an EIN-only order", () => {
    const e = renderProofEmail({ ...row, line_items: [{ offer_code: "EIN_FILING" }], proof_of_filing_ref: "12-3456789" });
    expect(e.subject).toBe("Your filing is complete");
    expect(e.text).not.toContain("12-3456789");
    expect(e.html).not.toContain("12-3456789");
  });

  it("escapes customer text in html", () => {
    const e = renderProofEmail({ ...row, filing_data: { llc_name: `<img src=x onerror="a">` } });
    expect(e.html).not.toContain("<img");
  });
});

describe("realOrderEmailSender", () => {
  it("fails clearly when Resend is not configured", async () => {
    const saved = { key: process.env.RESEND_API_KEY, from: process.env.RESEND_FROM_EMAIL };
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    const r = await realOrderEmailSender.send({ to: "a@example.com", subject: "s", text: "t", html: "h", idempotencyKey: "k" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not configured/);
    if (saved.key !== undefined) process.env.RESEND_API_KEY = saved.key;
    if (saved.from !== undefined) process.env.RESEND_FROM_EMAIL = saved.from;
  });
});
