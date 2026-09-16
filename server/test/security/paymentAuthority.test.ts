import "dotenv/config";
import { randomUUID } from "node:crypto";
import http from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool.js";
import { sessionRouter } from "../../src/routes/session.js";
import { checkoutRouter } from "../../src/routes/checkout.js";
import { isVerifiedPaidSnapshot } from "../../src/zoho/client.js";

/**
 * Gate 2 payment-authority security fix. Proves the vulnerability
 * described in GATE2-PAYMENT-AUTHORITY-STATUS.md is actually closed —
 * not just that the code looks right, but that a malicious client
 * cannot, through any real HTTP request, cause a paid state anywhere in
 * the system without a verified Stripe webhook. Runs against the real
 * dev Supabase instance, same convention as every other integration
 * test in this repo.
 */

const createdSessionIds: string[] = [];

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(sessionRouter);
  app.use(checkoutRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("failed to bind test server");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  if (createdSessionIds.length) {
    await pool.query("DELETE FROM orders WHERE filing_session_id = ANY($1)", [createdSessionIds]);
    await pool.query("DELETE FROM crm_sync_queue WHERE filing_session_id = ANY($1)", [createdSessionIds]);
    await pool.query("DELETE FROM filing_events WHERE filing_session_id = ANY($1)", [createdSessionIds]);
    await pool.query("DELETE FROM filing_sessions WHERE filing_session_id = ANY($1)", [createdSessionIds]);
  }
});

describe("A. POST /api/session/stage cannot set payment_status=paid", () => {
  it("silently drops a client-supplied payment_status — the column stays unset, and no Order exists to be paid", async () => {
    const res = await fetch(`${baseUrl}/api/session/stage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stage: "complete",
        email: "attack-a@example.com",
        payment_status: "paid", // attack payload
        order_total_cents: 999999999, // attack payload
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { filing_session_id: string };
    createdSessionIds.push(json.filing_session_id);

    const { rows } = await pool.query(
      "SELECT payment_status, order_total_cents FROM filing_sessions WHERE filing_session_id = $1",
      [json.filing_session_id]
    );
    expect(rows[0].payment_status).toBeNull(); // not "paid" — the field was never in the whitelist to begin with

    const { rows: orderRows } = await pool.query(
      "SELECT count(*) AS n FROM orders WHERE filing_session_id = $1",
      [json.filing_session_id]
    );
    expect(orderRows[0].n).toBe("0"); // this route never touches orders at all
  });
});

describe("B. No public route can set orders.payment_status", () => {
  it("POST /checkout/session ignores a client-supplied payment_status field entirely — the created Order stays pending", async () => {
    // Real prerequisite: a session that has actually reached 'complete'.
    const stageRes = await fetch(`${baseUrl}/api/session/stage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "complete", email: "attack-b@example.com" }),
    });
    const { filing_session_id: filingSessionId } = (await stageRes.json()) as { filing_session_id: string };
    createdSessionIds.push(filingSessionId);

    const checkoutRes = await fetch(`${baseUrl}/checkout/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filing_session_id: filingSessionId,
        crm_intent: "LLC_FORMATION_DIY",
        payment_status: "paid", // attack payload — checkout.ts never reads this key
        order: { payment_status: "paid" }, // attack payload — nested, also never read
      }),
    });
    // 200 (real key configured) or 502 (Stripe unreachable) are both
    // acceptable outcomes here — what matters is payment_status.
    expect([200, 502]).toContain(checkoutRes.status);

    const { rows } = await pool.query(
      "SELECT payment_status FROM orders WHERE filing_session_id = $1",
      [filingSessionId]
    );
    expect(rows.length).toBe(1); // an Order was created (that's expected/legitimate)
    expect(rows[0].payment_status).toBe("pending"); // but never paid by the request itself
  });
});

describe("C. Fabricated filing-session payment status cannot trigger CRM Deal logic", () => {
  it("isVerifiedPaidSnapshot() — the exact boundary zoho/client.ts's Deal conversion is gated on — rejects every client-reachable shape", () => {
    // What an attacker can actually get into a filing_sessions row is
    // now nothing (A, above) — but even if it somehow were something,
    // or a future bug reintroduced a payment_status write path, the CRM
    // boundary itself must independently refuse to trust it.
    expect(isVerifiedPaidSnapshot({ payment_status: "paid" })).toBe(false);
    expect(isVerifiedPaidSnapshot({ payment_status: "completed" })).toBe(false);
    expect(isVerifiedPaidSnapshot({ payment_status: "PAID" })).toBe(false);
    expect(isVerifiedPaidSnapshot({ verified_paid: "true" })).toBe(false); // string, not boolean true
    expect(isVerifiedPaidSnapshot({ verified_paid: 1 })).toBe(false);
    expect(isVerifiedPaidSnapshot({})).toBe(false);
    // The one shape that IS trusted — deliberately not derivable from any
    // filing_sessions column, so routes/session.ts's `SELECT * FROM
    // filing_sessions` snapshot can never produce it.
    expect(isVerifiedPaidSnapshot({ verified_paid: true })).toBe(true);
  });

  it("end-to-end: a fabricated payment_status never survives into the CRM sync queue's payload_snapshot as a trusted claim", async () => {
    const res = await fetch(`${baseUrl}/api/session/stage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "complete", email: "attack-c@example.com", payment_status: "paid" }),
    });
    const json = (await res.json()) as { filing_session_id: string; queued_sync_id: number };
    createdSessionIds.push(json.filing_session_id);
    expect(json.queued_sync_id).toBeTruthy(); // a Lead-upsert job IS legitimately enqueued

    const { rows } = await pool.query("SELECT payload_snapshot FROM crm_sync_queue WHERE id = $1", [
      json.queued_sync_id,
    ]);
    const snapshot = rows[0].payload_snapshot as Record<string, unknown>;
    // The snapshot is `SELECT * FROM filing_sessions` — payment_status is
    // present as a key (it's a real column) but never "paid", and there
    // is no verified_paid key at all — isVerifiedPaidSnapshot(snapshot)
    // would return false, exactly as asserted directly above.
    expect(snapshot.payment_status).not.toBe("paid");
    expect(isVerifiedPaidSnapshot(snapshot)).toBe(false);
  });
});

describe("D. Filing completed without payment stays unpaid", () => {
  it("persistence + Order creation succeed; payment_status stays pending with no webhook delivered", async () => {
    const stageRes = await fetch(`${baseUrl}/api/session/stage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "complete", email: "attack-d@example.com" }),
    });
    const { filing_session_id: filingSessionId, current_stage: currentStage } = (await stageRes.json()) as {
      filing_session_id: string;
      current_stage: string;
    };
    createdSessionIds.push(filingSessionId);
    expect(currentStage).toBe("complete");

    const checkoutRes = await fetch(`${baseUrl}/checkout/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filing_session_id: filingSessionId, crm_intent: "LLC_FORMATION_DIY" }),
    });
    expect([200, 502]).toContain(checkoutRes.status);

    const { rows } = await pool.query(
      "SELECT checkout_status, payment_status FROM orders WHERE filing_session_id = $1",
      [filingSessionId]
    );
    expect(rows[0].payment_status).toBe("pending");
    expect(["checkout_created", "checkout_failed"]).toContain(rows[0].checkout_status);
  });
});
