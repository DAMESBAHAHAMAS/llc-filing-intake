import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { applyFunnelProtection } from "../src/middleware/funnelProtection.js";
import { clientKey, createRateLimiter, funnelRateLimiters } from "../src/middleware/rateLimit.js";
import { createTurnstileGuard } from "../src/middleware/turnstile.js";

/**
 * Real HTTP against an Express app wired exactly as index.ts wires it
 * (applyFunnelProtection), with stub handlers in place of the real
 * routes so no database is needed.
 */
const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  servers.splice(0).forEach((s) => s.close());
});

async function startApp(botCheck?: express.RequestHandler) {
  const app = express();
  app.use(express.json());
  applyFunnelProtection(app, botCheck ? { botCheck } : {});
  app.all("*", (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  servers.push(server);
  await new Promise((r) => server.once("listening", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("funnel rate limits over real HTTP", () => {
  it("returns 429 with Retry-After on the 31st name check in a minute", async () => {
    const base = await startApp();
    const statuses: number[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 31; i++) {
      last = await fetch(`${base}/api/name-check`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "True-Client-IP": "203.0.113.7" },
        body: JSON.stringify({ name: "Test LLC" }),
      });
      statuses.push(last.status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect(Number(last!.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await last!.json()).toMatchObject({ error: "too_many_requests", limit: "name-check" });
  });

  it("counts each visitor separately", async () => {
    const base = await startApp();
    const hit = (ip: string) =>
      fetch(`${base}/api/checkout/create`, { method: "POST", headers: { "True-Client-IP": ip } }).then((r) => r.status);
    for (let i = 0; i < 10; i++) await hit("198.51.100.1");
    expect(await hit("198.51.100.1")).toBe(429);
    expect(await hit("198.51.100.2")).toBe(200);
  });

  it("allows only 5 registered-agent acceptance emails per hour per visitor", async () => {
    const base = await startApp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push(
        (await fetch(`${base}/api/registered-agent/request-acceptance`, { method: "POST", headers: { "True-Client-IP": "192.0.2.9" } }))
          .status
      );
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it("does not limit health checks", async () => {
    const base = await startApp();
    for (let i = 0; i < 150; i++) {
      expect((await fetch(`${base}/health`)).status).toBe(200);
    }
  });
});

describe("createRateLimiter", () => {
  it("opens a new window after the old one ends and sweeps expired keys", () => {
    let t = 0;
    const limiter = createRateLimiter({ name: "t", windowMs: 1000, max: 1, now: () => t });
    const run = () => {
      let status = 200;
      const res = {
        setHeader: () => undefined,
        status: (s: number) => ((status = s), res),
        json: () => res,
      } as unknown as express.Response;
      limiter({ method: "POST", ip: "1.1.1.1", get: () => undefined } as unknown as express.Request, res, () => undefined);
      return status;
    };
    expect(run()).toBe(200);
    expect(run()).toBe(429);
    t = 1000;
    expect(run()).toBe(200);
    t = 5000;
    limiter.sweep();
    expect(limiter.size()).toBe(0);
  });
});

describe("clientKey", () => {
  it("prefers the client IP header and falls back to req.ip", () => {
    const req = (h?: string) => ({ get: () => h, ip: "10.0.0.1" }) as unknown as express.Request;
    expect(clientKey(req("203.0.113.5, 10.1.1.1"))).toBe("203.0.113.5");
    expect(clientKey(req(undefined))).toBe("10.0.0.1");
  });
});

describe("funnelRateLimiters", () => {
  it("reads overrides from the environment", () => {
    process.env.RATE_LIMIT_NAME_CHECK_PER_MIN = "2";
    try {
      const l = funnelRateLimiters();
      let status = 200;
      const res = { setHeader: () => undefined, status: (s: number) => ((status = s), res), json: () => res } as unknown as express.Response;
      const req = { method: "POST", ip: "9.9.9.9", get: () => undefined } as unknown as express.Request;
      for (let i = 0; i < 3; i++) l.nameCheck(req, res, () => undefined);
      expect(status).toBe(429);
    } finally {
      delete process.env.RATE_LIMIT_NAME_CHECK_PER_MIN;
    }
  });
});

describe("Turnstile bot check", () => {
  it("is a pass-through when no secret is set", async () => {
    const base = await startApp(createTurnstileGuard({ secret: "" }));
    expect((await fetch(`${base}/api/checkout/create`, { method: "POST" })).status).toBe(200);
  });

  it("requires a token once the secret is set", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ success: true }))) as typeof fetch;
    const base = await startApp(createTurnstileGuard({ secret: "test-secret", fetchImpl: fakeFetch }));
    expect((await fetch(`${base}/api/checkout/create`, { method: "POST" })).status).toBe(403);
    expect((await fetch(`${base}/api/checkout/create`, { method: "POST", headers: { "X-Turnstile-Token": "tok" } })).status).toBe(200);
  });

  it("rejects a token Cloudflare says is invalid, and fails closed if Cloudflare is unreachable", async () => {
    const bad = (async () => new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }))) as typeof fetch;
    const down = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const base1 = await startApp(createTurnstileGuard({ secret: "s", fetchImpl: bad }));
    const r1 = await fetch(`${base1}/api/checkout/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turnstile_token: "x" }),
    });
    expect(r1.status).toBe(403);
    const base2 = await startApp(createTurnstileGuard({ secret: "s", fetchImpl: down }));
    expect((await fetch(`${base2}/api/checkout/create`, { method: "POST", headers: { "X-Turnstile-Token": "x" } })).status).toBe(503);
  });

  it("only guards the two costly submits", async () => {
    const base = await startApp(createTurnstileGuard({ secret: "s", fetchImpl: (async () => new Response("{}")) as typeof fetch }));
    expect((await fetch(`${base}/api/name-check`, { method: "POST" })).status).toBe(200);
    expect((await fetch(`${base}/api/registered-agent/request-acceptance`, { method: "POST" })).status).toBe(403);
  });
});
