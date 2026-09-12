import http from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { corsMiddleware } from "../src/middleware/cors.js";

/**
 * Proves the fix for the P0 bug found 2026-09-12: every browser call
 * from the live frontend to this service failed at the CORS preflight
 * stage (confirmed live — "No 'Access-Control-Allow-Origin' header is
 * present"), because no CORS handling existed at all. Isolated from
 * index.ts (which binds a real port and starts background pollers) —
 * same pattern as security/paymentAuthority.test.ts building its own
 * minimal app around just the piece under test.
 */

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(corsMiddleware);
  app.use(express.json());
  app.get("/probe", (_req, res) => res.status(200).json({ ok: true }));
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("failed to bind test server");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("CORS", () => {
  it("the production origin gets Access-Control-Allow-Origin echoed back", async () => {
    const res = await fetch(`${baseUrl}/probe`, {
      headers: { Origin: "https://damianknowles.com" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://damianknowles.com");
  });

  it("the local dev origin gets Access-Control-Allow-Origin echoed back", async () => {
    const res = await fetch(`${baseUrl}/probe`, {
      headers: { Origin: "http://localhost:8080" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:8080");
  });

  it("an unrelated origin gets no Access-Control-Allow-Origin header", async () => {
    const res = await fetch(`${baseUrl}/probe`, {
      headers: { Origin: "https://evil-scraper-example.com" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("a request with no Origin header (non-browser caller) is unaffected", async () => {
    const res = await fetch(`${baseUrl}/probe`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("an OPTIONS preflight for the production origin succeeds with the right headers", async () => {
    const res = await fetch(`${baseUrl}/probe`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://damianknowles.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://damianknowles.com");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("Content-Type");
  });
});
