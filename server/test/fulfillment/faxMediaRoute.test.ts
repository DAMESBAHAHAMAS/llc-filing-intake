import "dotenv/config";
import { randomUUID } from "node:crypto";
import http from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool.js";
import { faxMediaRouter } from "../../src/routes/faxMedia.js";
import { storeFilingDocument, mintMediaAccessToken } from "../../src/fulfillment/documentStore.js";

/**
 * Real http.Server + real fetch, same convention as
 * checkout/checkoutReturnRoutes.test.ts — no new test-http dependency.
 * Proves the actual thing a fax provider does: an unauthenticated GET
 * against a capability URL, nothing else.
 */

const createdSessionIds: string[] = [];
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(faxMediaRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("failed to bind test server");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  if (createdSessionIds.length) {
    await pool.query(
      "DELETE FROM fulfillment_transmissions WHERE order_id IN (SELECT order_id FROM orders WHERE filing_session_id = ANY($1))",
      [createdSessionIds]
    );
    await pool.query("DELETE FROM filing_documents WHERE filing_session_id = ANY($1)", [createdSessionIds]);
    await pool.query("DELETE FROM orders WHERE filing_session_id = ANY($1)", [createdSessionIds]);
    await pool.query("DELETE FROM filing_sessions WHERE filing_session_id = ANY($1)", [createdSessionIds]);
  }
});

async function createOrderWithDocument(): Promise<{ orderId: string; filingSessionId: string; pdfBytes: Buffer; documentId: number }> {
  const filingSessionId = randomUUID();
  createdSessionIds.push(filingSessionId);
  await pool.query(
    `INSERT INTO filing_sessions (filing_session_id, current_stage, email, filing_data, registered_agent_status)
     VALUES ($1, 'complete', 'fax-media-test@example.com', $2, 'accepted')`,
    [filingSessionId, { llc_name: "Fax Media Test LLC" }]
  );
  const orderRes = await pool.query<{ order_id: string }>(
    `INSERT INTO orders (filing_session_id, crm_intent, product, line_items, total_cents, currency, checkout_status, payment_status, fulfillment_status)
     VALUES ($1, 'LLC_FORMATION_DIY', 'LLC_FORMATION_DIY', '[]', 12900, 'usd', 'checkout_created', 'paid', 'in_progress')
     RETURNING order_id`,
    [filingSessionId]
  );
  const orderId = orderRes.rows[0].order_id;
  const pdfBytes = Buffer.from(`%PDF-1.4 fake pdf for ${filingSessionId}`);
  const { documentId } = await storeFilingDocument(pool, { filingSessionId, orderId, pdfBytes });
  return { orderId, filingSessionId, pdfBytes, documentId };
}

async function createTransmission(
  orderId: string,
  filingSessionId: string,
  documentId: number,
  opts: { expiresInMs: number }
): Promise<{ rawToken: string }> {
  const { raw, tokenId } = mintMediaAccessToken();
  await pool.query(
    `INSERT INTO fulfillment_transmissions
       (order_id, filing_session_id, document_id, attempt_number, destination_value, status, media_access_token_id, media_access_expires_at)
     VALUES ($1, $2, $3, 1, '+15551234567', 'submitted', $4, now() + ($5 || ' milliseconds')::interval)`,
    [orderId, filingSessionId, documentId, tokenId, String(opts.expiresInMs)]
  );
  return { rawToken: raw };
}

describe("GET /api/fax-media/:token", () => {
  it("serves the exact retained PDF bytes for a valid, unexpired token", async () => {
    const { orderId, filingSessionId, pdfBytes, documentId } = await createOrderWithDocument();
    const { rawToken } = await createTransmission(orderId, filingSessionId, documentId, { expiresInMs: 60_000 });

    const res = await fetch(`${baseUrl}/api/fax-media/${rawToken}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(pdfBytes)).toBe(true);
  }, 15000);

  it("returns 404 for an unknown token", async () => {
    const res = await fetch(`${baseUrl}/api/fax-media/not-a-real-token`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for an expired token, even though the row exists", async () => {
    const { orderId, filingSessionId, documentId } = await createOrderWithDocument();
    const { rawToken } = await createTransmission(orderId, filingSessionId, documentId, { expiresInMs: -1000 }); // already expired

    const res = await fetch(`${baseUrl}/api/fax-media/${rawToken}`);
    expect(res.status).toBe(404);
  });
});
