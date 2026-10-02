import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Per-IP request limits for the public filing-funnel endpoints.
 *
 * Fixed window, in memory, no new dependency. This service runs as one
 * Render instance (render.yaml: starter plan, no numInstances), so one
 * process sees every request. If it is ever scaled out, each instance
 * keeps its own counts and the effective limit multiplies by the
 * instance count; move the counter to Postgres or Redis at that point.
 *
 * Client IP: Render puts several proxies in front of the app, and Render
 * staff point to the True-Client-IP header for the real client address
 * rather than a fixed proxy count. clientKey() uses that header when it
 * is present (name configurable with RATE_LIMIT_CLIENT_IP_HEADER) and
 * falls back to req.ip. Without this, every request would look like it
 * came from Render's proxy and one busy visitor would block everyone.
 * Check it once after deploy: the logged key must be a visitor's IP, not
 * a Render or Cloudflare address.
 */
export function clientKey(req: Request, headerName = process.env.RATE_LIMIT_CLIENT_IP_HEADER ?? "true-client-ip"): string {
  const fromHeader = headerName ? req.get(headerName) : undefined;
  const first = fromHeader?.split(",")[0]?.trim();
  if (first) return first;
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}
export interface RateLimitOptions {
  /** Short name used in the 429 body and the counter key, e.g. "name-check". */
  name: string;
  windowMs: number;
  max: number;
  /** Injected in tests. */
  now?: () => number;
}

interface Counter {
  windowStart: number;
  count: number;
}

export interface RateLimiter extends RequestHandler {
  /** Number of keys currently tracked (tests and diagnostics). */
  size(): number;
  /** Drop expired windows; also runs on its own every few minutes. */
  sweep(): void;
}

export function createRateLimiter(opts: RateLimitOptions): RateLimiter {
  const now = opts.now ?? Date.now;
  const counters = new Map<string, Counter>();

  const handler = ((req: Request, res: Response, next: NextFunction) => {
    if (req.method === "OPTIONS") return next();

    const key = clientKey(req);
    const t = now();
    let c = counters.get(key);
    if (!c || t - c.windowStart >= opts.windowMs) {
      c = { windowStart: t, count: 0 };
      counters.set(key, c);
    }
    c.count += 1;

    const remaining = Math.max(0, opts.max - c.count);
    const resetSeconds = Math.max(1, Math.ceil((c.windowStart + opts.windowMs - t) / 1000));
    res.setHeader("RateLimit-Limit", String(opts.max));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(resetSeconds));

    if (c.count > opts.max) {
      res.setHeader("Retry-After", String(resetSeconds));
      res.status(429).json({
        error: "too_many_requests",
        limit: opts.name,
        retry_after_seconds: resetSeconds,
      });
      return;
    }
    next();
  }) as RateLimiter;

  handler.size = () => counters.size;
  handler.sweep = () => {
    const t = now();
    for (const [k, c] of counters) {
      if (t - c.windowStart >= opts.windowMs) counters.delete(k);
    }
  };

  // Keeps memory bounded without holding the process open.
  const timer = setInterval(handler.sweep, Math.max(60_000, opts.windowMs));
  timer.unref?.();

  return handler;
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

const MINUTE = 60_000;

/**
 * Limits per public route group. Generous enough that a real customer
 * working through the interview never meets them; tight where a request
 * costs money, sends email or does heavy work. Each max can be changed
 * without a deploy of code via its RATE_LIMIT_* variable.
 */
export function funnelRateLimiters() {
  return {
    // Every interview stage autosaves here.
    sessionStage: createRateLimiter({ name: "session-stage", windowMs: MINUTE, max: envInt("RATE_LIMIT_SESSION_STAGE_PER_MIN", 120) }),
    // Each call queries Sunbiz.
    nameCheck: createRateLimiter({ name: "name-check", windowMs: MINUTE, max: envInt("RATE_LIMIT_NAME_CHECK_PER_MIN", 30) }),
    // Creates a Stripe Checkout Session.
    checkoutCreate: createRateLimiter({ name: "checkout-create", windowMs: 10 * MINUTE, max: envInt("RATE_LIMIT_CHECKOUT_PER_10MIN", 10) }),
    // Sends an email to a third-party registered agent: the main abuse risk.
    raRequestAcceptance: createRateLimiter({ name: "ra-request-acceptance", windowMs: 60 * MINUTE, max: envInt("RATE_LIMIT_RA_EMAIL_PER_HOUR", 5) }),
    raOther: createRateLimiter({ name: "registered-agent", windowMs: 10 * MINUTE, max: envInt("RATE_LIMIT_RA_PER_10MIN", 30) }),
    // CPU-heavy PDF render.
    filingPdf: createRateLimiter({ name: "filing-pdf", windowMs: 10 * MINUTE, max: envInt("RATE_LIMIT_FILING_PDF_PER_10MIN", 10) }),
    // Cheap reads.
    reads: createRateLimiter({ name: "reads", windowMs: MINUTE, max: envInt("RATE_LIMIT_READS_PER_MIN", 120) }),
  };
}
