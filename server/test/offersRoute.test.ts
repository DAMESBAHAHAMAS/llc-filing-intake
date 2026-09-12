import "dotenv/config";
import http from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { offersRouter } from "../src/routes/offers.js";

/**
 * GET /api/offers is what the storefront renders its prices from, so the
 * properties that matter here are (a) only sellable offers appear, and
 * (b) the Stripe Price ID never leaks to the browser — the browser must
 * influence pricing only by naming an offer_code, never by holding the
 * identifier that determines the charge.
 *
 * Runs against the real dev Supabase instance, same convention as the
 * other integration-style tests in this suite.
 */

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(offersRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("failed to bind test server");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("GET /api/offers", () => {
  it("returns active offers with the fields the storefront needs", async () => {
    const res = await fetch(`${baseUrl}/api/offers`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { offers: Record<string, unknown>[] };
    expect(Array.isArray(body.offers)).toBe(true);
    expect(body.offers.length).toBeGreaterThan(0);

    for (const offer of body.offers) {
      expect(typeof offer.offer_code).toBe("string");
      expect(typeof offer.display_name).toBe("string");
      expect(typeof offer.unit_amount_cents).toBe("number");
      expect(typeof offer.currency).toBe("string");
    }
  });

  it("never exposes the Stripe Price ID or product ID to the browser", async () => {
    const res = await fetch(`${baseUrl}/api/offers`);
    const body = (await res.json()) as { offers: Record<string, unknown>[] };

    for (const offer of body.offers) {
      expect(offer).not.toHaveProperty("stripe_price_id");
      expect(offer).not.toHaveProperty("stripe_product_id");
      expect(offer).not.toHaveProperty("internal_cost_cents");
    }
    // Belt-and-braces: no price_/prod_ identifier anywhere in the payload.
    expect(JSON.stringify(body)).not.toMatch(/price_[A-Za-z0-9]/);
    expect(JSON.stringify(body)).not.toMatch(/prod_[A-Za-z0-9]/);
  });

  it("excludes draft offers — a draft offer must be neither renderable nor sellable", async () => {
    const res = await fetch(`${baseUrl}/api/offers`);
    const body = (await res.json()) as { offers: { offer_code: string }[] };
    const codes = body.offers.map((o) => o.offer_code);

    // EIN_FILING_EXPRESS is seeded status='draft' (price unconfirmed).
    expect(codes).not.toContain("EIN_FILING_EXPRESS");
    // Sanity: the tiers the storefront depends on ARE present.
    expect(codes).toContain("FASTTRACK");
    expect(codes).toContain("PREMIUM");
    expect(codes).toContain("DIY_STATE_FEE");
  });
});
