import type { Request, Response, NextFunction } from "express";

/**
 * Until this existed, every browser call from the live frontend
 * (florida-business-launchpad, served at damianknowles.com) to this
 * service failed at the preflight stage — confirmed live 2026-09-12:
 * "No 'Access-Control-Allow-Origin' header is present on the requested
 * resource." Same bug class already fixed on sunbiz-proxy (that fix's
 * own commit: "the CORS allowlist listed damianmaknowles.com... not the
 * real production domain") — this service simply had no CORS handling
 * of any kind, not a wrong domain. Practical effect while broken:
 * POST /api/session/stage — the call LLCFilingIntake.tsx's
 * handleComplete() makes on final submit — failed for every real
 * customer, every time; the backend logic itself was always correct
 * (confirmed via a direct, non-browser POST during the same
 * investigation, which succeeded and produced a real filing_sessions
 * row and a real synced Zoho Lead).
 *
 * Explicit allowlist, not a wildcard — same rigor as the sunbiz-proxy
 * fix, not a default-open policy:
 *   - https://damianknowles.com — the live production origin (confirmed
 *     serving the app, HTTP 200)
 *   - https://www.damianknowles.com — 302-redirects to the apex before
 *     any page loads (confirmed), so no browser request should ever
 *     actually originate from here; included anyway as a harmless
 *     safety margin in case that redirect ever changes
 *   - http://localhost:8080 — this frontend's actual Vite dev port
 *     (florida-business-launchpad/vite.config.ts), so local development
 *     keeps working
 *
 * Hand-written rather than the `cors` package — no new dependency
 * needed for three response headers on a handful of routes.
 */
export const ALLOWED_ORIGINS = new Set([
  "https://damianknowles.com",
  "https://www.damianknowles.com",
  "http://localhost:8080",
]);

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
}
