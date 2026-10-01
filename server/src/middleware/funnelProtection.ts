import type { Express, RequestHandler } from "express";
import { funnelRateLimiters } from "./rateLimit.js";
import { createTurnstileGuard } from "./turnstile.js";

/**
 * Per-IP limits on the public funnel endpoints (429 when exceeded), and
 * the Turnstile bot check on the two submits that cost money or send
 * email. The bot check is a no-op until TURNSTILE_SECRET_KEY is set; see
 * turnstile.ts before setting it. Health and the Stripe webhook are
 * deliberately not limited.
 *
 * Must be applied after CORS (so a 429 still carries CORS headers and the
 * browser can read it) and after express.json() (the bot check can read
 * its token from the body).
 */
export function applyFunnelProtection(
  app: Express,
  deps: { limits?: ReturnType<typeof funnelRateLimiters>; botCheck?: RequestHandler } = {}
): ReturnType<typeof funnelRateLimiters> {
  const limits = deps.limits ?? funnelRateLimiters();
  const botCheck = deps.botCheck ?? createTurnstileGuard();

  app.use("/api/session/stage", limits.sessionStage);
  app.use("/api/name-check", limits.nameCheck);
  app.use("/api/checkout/create", limits.checkoutCreate, botCheck);
  app.use("/api/checkout/order", limits.reads);
  app.use("/api/registered-agent/request-acceptance", limits.raRequestAcceptance, botCheck);
  app.use(["/api/registered-agent", "/registered-agent"], limits.raOther);
  app.use("/api/filing-session/:filingSessionId/pdf", limits.filingPdf);
  app.use(["/api/offers", "/api/ein-express"], limits.reads);

  return limits;
}
