import { Router } from "express";
import { pool } from "../db/pool.js";
import { describeError } from "../db/describeError.js";
import { LLC_STATUSES, recordSignup, unsubscribeByToken, type LlcStatus } from "../scorecard/service.js";

export const scorecardRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clip = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");

/**
 * POST /api/scorecard/signup — stores the sign-up and schedules the five
 * emails in one transaction. The CRM Lead and Email 1 follow from the
 * scorecard worker within seconds; neither blocks the visitor (standing rule:
 * a CRM or email failure must never block the user).
 */
scorecardRouter.post("/api/scorecard/signup", async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const email = clip(b.email, 255);
  const firstName = clip(b.first_name, 100);
  const country = clip(b.country, 100);
  const llc = clip(b.llc_status, 40) as LlcStatus;

  if (!firstName || !EMAIL_RE.test(email) || !country || !LLC_STATUSES.includes(llc)) {
    res.status(400).json({ success: false, error: "first_name, email, country and llc_status are required" });
    return;
  }
  try {
    const r = await recordSignup(pool, {
      email,
      firstName,
      country,
      llcStatus: llc,
      utm: {
        source: clip(b.utm_source, 120),
        medium: clip(b.utm_medium, 120),
        campaign: clip(b.utm_campaign, 120),
        content: clip(b.utm_content, 120),
      },
    });
    res.json({ success: true, outcome: r.outcome });
  } catch (err) {
    console.error("[scorecard signup] failed", describeError(err));
    res.status(500).json({ success: false, error: "could not record sign-up" });
  }
});

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<body style="font-family:Roboto,Arial,sans-serif;max-width:520px;margin:64px auto;padding:0 20px;color:#0A1F33"><h1 style="font-size:1.5rem">${title}</h1><p>${body}</p></body>`;

async function handleUnsubscribe(token: string): Promise<{ status: number; html: string }> {
  try {
    const ok = await unsubscribeByToken(pool, token);
    return ok
      ? { status: 200, html: page("You're unsubscribed", "You won't get any more emails from this series.") }
      : { status: 404, html: page("Link not recognised", "This unsubscribe link is not valid.") };
  } catch (err) {
    console.error("[scorecard unsubscribe] failed", describeError(err));
    return { status: 500, html: page("Something went wrong", "Please try the link again in a moment.") };
  }
}

// GET for the link in the email; POST for the one-click List-Unsubscribe header.
scorecardRouter.get("/api/scorecard/unsubscribe", async (req, res) => {
  const r = await handleUnsubscribe(typeof req.query.t === "string" ? req.query.t : "");
  res.status(r.status).type("html").send(r.html);
});
scorecardRouter.post("/api/scorecard/unsubscribe", async (req, res) => {
  const r = await handleUnsubscribe(typeof req.query.t === "string" ? req.query.t : "");
  res.status(r.status).type("html").send(r.html);
});
