import type { NextFunction, Request, RequestHandler, Response } from "express";
import { clientKey } from "./rateLimit.js";

/**
 * Cloudflare Turnstile check for the funnel's submit endpoints.
 *
 * OFF until TURNSTILE_SECRET_KEY is set. Turning it on also needs the
 * Turnstile widget on the frontend (site key) sending its token, either
 * in the X-Turnstile-Token header or as `turnstile_token` in the JSON
 * body. Setting the secret before the frontend sends tokens would block
 * every real customer, so the two go live together.
 */
export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

type Fetch = typeof fetch;

export function createTurnstileGuard(opts: { secret?: string; fetchImpl?: Fetch } = {}): RequestHandler {
  const secret = opts.secret ?? process.env.TURNSTILE_SECRET_KEY;
  const doFetch = opts.fetchImpl ?? fetch;

  if (!secret) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "OPTIONS") return next();
    const headerToken = req.get("X-Turnstile-Token");
    const bodyToken = typeof req.body?.turnstile_token === "string" ? req.body.turnstile_token : undefined;
    const token = headerToken || bodyToken;
    if (!token) {
      res.status(403).json({ error: "bot_check_required" });
      return;
    }

    try {
      const form = new URLSearchParams({ secret, response: token });
      form.set("remoteip", clientKey(req));
      const r = await doFetch(TURNSTILE_VERIFY_URL, { method: "POST", body: form });
      const data = (await r.json().catch(() => ({}))) as { success?: boolean; "error-codes"?: string[] };
      if (data.success === true) return next();
      res.status(403).json({ error: "bot_check_failed", codes: data["error-codes"] ?? [] });
    } catch (err) {
      // Cloudflare unreachable: fail closed on these few endpoints and say
      // so, rather than silently letting every request through.
      console.error("[turnstile] verification request failed:", err instanceof Error ? err.message : err);
      res.status(503).json({ error: "bot_check_unavailable" });
    }
  };
}
