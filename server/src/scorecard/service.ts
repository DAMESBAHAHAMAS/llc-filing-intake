import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { isTestEmail } from "../zoho/client.js";
import { realScorecardCrm, type ScorecardCrm } from "./crm.js";
import { renderEmail, STEP_OFFSET_DAYS, type SequenceLinks } from "./sequence.js";

export const LLC_STATUSES = ["Not yet", "Yes, in Florida", "Yes, in another state"] as const;
export type LlcStatus = (typeof LLC_STATUSES)[number];

export const leadIntentFor = (s: LlcStatus): string => (s === "Not yet" ? "Undecided" : "Self-Filer");

export interface SignupInput {
  email: string;
  firstName: string;
  country: string;
  llcStatus: LlcStatus;
  utm?: { source?: string; medium?: string; campaign?: string; content?: string };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function scorecardLinks(env: NodeJS.ProcessEnv = process.env): SequenceLinks {
  const site = (env.FRONTEND_BASE_URL || "https://damianknowles.com").replace(/\/$/, "");
  return {
    pdf: env.SCORECARD_PDF_URL || `${site}/downloads/florida-business-readiness-scorecard.pdf`,
    checklist: env.SCORECARD_CHECKLIST_URL || `${site}/downloads/us-llc-formation-checklist.pdf`,
    booking: env.SCORECARD_BOOKING_URL || "https://bookings.damianknowles.com/#/file-an-llc-in-florida",
    packages: env.SCORECARD_PACKAGES_URL || `${site}/llc-formation-packages`,
    payAfterFiling: env.SCORECARD_PAY_AFTER_FILING === "on",
  };
}

export function unsubscribeUrl(token: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.PUBLIC_BASE_URL || "https://llc-data-spine.onrender.com").replace(/\/$/, "");
  return `${base}/api/scorecard/unsubscribe?t=${token}`;
}

/** Stores the sign-up and schedules the five emails. Idempotent per email. */
export async function recordSignup(
  pool: Pool,
  input: SignupInput,
  now: Date = new Date()
): Promise<{ subscriberId: number; created: boolean }> {
  const email = input.email.trim();
  const token = randomBytes(24).toString("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ id: number }>(
      "SELECT id FROM scorecard_subscribers WHERE lower(email) = lower($1)",
      [email]
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return { subscriberId: Number(existing.rows[0].id), created: false };
    }
    const ins = await client.query<{ id: number }>(
      `INSERT INTO scorecard_subscribers
         (email, first_name, country, llc_status, lead_intent, utm_source, utm_medium,
          utm_campaign, utm_content, is_test, unsubscribe_token, signed_up_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        email,
        input.firstName.trim(),
        input.country,
        input.llcStatus,
        leadIntentFor(input.llcStatus),
        input.utm?.source || null,
        input.utm?.medium || null,
        input.utm?.campaign || null,
        input.utm?.content || null,
        isTestEmail(email),
        token,
        now.toISOString(),
      ]
    );
    const id = Number(ins.rows[0].id);
    for (const [step, days] of Object.entries(STEP_OFFSET_DAYS)) {
      await client.query(
        "INSERT INTO scorecard_emails (subscriber_id, step, send_at) VALUES ($1,$2,$3)",
        [id, Number(step), new Date(now.getTime() + days * DAY_MS).toISOString()]
      );
    }
    await client.query("COMMIT");
    return { subscriberId: id, created: true };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Marks the subscriber unsubscribed and skips every pending email. */
export async function unsubscribeByToken(pool: Pool, token: string, now: Date = new Date()): Promise<boolean> {
  if (!/^[0-9a-f]{48}$/.test(token)) return false;
  const r = await pool.query<{ id: number }>(
    `UPDATE scorecard_subscribers SET unsubscribed_at = COALESCE(unsubscribed_at, $2)
       WHERE unsubscribe_token = $1 RETURNING id`,
    [token, now.toISOString()]
  );
  if (!r.rows[0]) return false;
  await pool.query(
    "UPDATE scorecard_emails SET status = 'skipped' WHERE subscriber_id = $1 AND status = 'pending'",
    [r.rows[0].id]
  );
  return true;
}

export interface ScorecardEmailSender {
  send(args: {
    to: string;
    subject: string;
    html: string;
    text: string;
    unsubscribeUrl: string;
  }): Promise<{ ok: boolean; error?: string; providerMessageId?: string }>;
}

export interface TickResult {
  crmSynced: number;
  crmFailed: number;
  sent: number;
  failed: number;
}

const MAX_ATTEMPTS = 5;

/** One worker pass: retry unsynced CRM leads, then send every due email. */
export async function runScorecardTick(
  pool: Pool,
  deps: { sender: ScorecardEmailSender; crm?: ScorecardCrm; now?: Date; env?: NodeJS.ProcessEnv }
): Promise<TickResult> {
  const now = deps.now ?? new Date();
  const crm = deps.crm ?? realScorecardCrm;
  const env = deps.env ?? process.env;
  const out: TickResult = { crmSynced: 0, crmFailed: 0, sent: 0, failed: 0 };

  const unsynced = await pool.query(
    `SELECT id, email, first_name, country, lead_intent, utm_source, utm_medium, utm_campaign, utm_content
       FROM scorecard_subscribers WHERE crm_synced_at IS NULL AND crm_attempts < 12 ORDER BY id LIMIT 20`
  );
  for (const s of unsynced.rows) {
    const r = await crm.upsertLead({
      email: s.email,
      firstName: s.first_name,
      country: s.country,
      leadIntent: s.lead_intent,
      utmSource: s.utm_source,
      utmMedium: s.utm_medium,
      utmCampaign: s.utm_campaign,
      utmContent: s.utm_content,
    });
    if (r.ok) {
      await pool.query(
        "UPDATE scorecard_subscribers SET crm_synced_at = $2, crm_lead_id = $3, crm_last_error = NULL WHERE id = $1",
        [s.id, now.toISOString(), r.leadId ?? null]
      );
      out.crmSynced++;
    } else {
      await pool.query(
        "UPDATE scorecard_subscribers SET crm_attempts = crm_attempts + 1, crm_last_error = $2, crm_lead_id = COALESCE($3, crm_lead_id) WHERE id = $1",
        [s.id, (r.error ?? "unknown").slice(0, 500), r.leadId ?? null]
      );
      out.crmFailed++;
    }
  }

  // Test addresses only, and only with SCORECARD_TEST_PREVIEW=on: send Emails 2 to 5
  // once, right away, marked [TEST], so each can be checked for rendering and button
  // targets. The real schedule rows stay pending for their own days.
  if (env.SCORECARD_TEST_PREVIEW === "on") {
    const prev = await pool.query(
      `SELECT id, email, first_name, unsubscribe_token FROM scorecard_subscribers
        WHERE is_test = true AND preview_sent_at IS NULL AND unsubscribed_at IS NULL ORDER BY id LIMIT 5`
    );
    const pl = scorecardLinks(env);
    for (const s of prev.rows) {
      const unsub = unsubscribeUrl(s.unsubscribe_token, env);
      let allOk = true;
      for (const step of [2, 3, 4, 5]) {
        const mail = renderEmail(step, s.first_name, pl, unsub);
        const r = await deps.sender.send({ to: s.email, ...mail, subject: `[TEST] ${mail.subject}`, unsubscribeUrl: unsub });
        if (!r.ok) allOk = false;
      }
      if (allOk) await pool.query("UPDATE scorecard_subscribers SET preview_sent_at = $2 WHERE id = $1", [s.id, now.toISOString()]);
    }
  }

  const due = await pool.query(
    `SELECT e.id AS email_id, e.step, e.attempts, s.email, s.first_name, s.unsubscribe_token
       FROM scorecard_emails e JOIN scorecard_subscribers s ON s.id = e.subscriber_id
      WHERE e.status = 'pending' AND e.send_at <= $1 AND s.unsubscribed_at IS NULL
      ORDER BY e.send_at LIMIT 25`,
    [now.toISOString()]
  );
  const links = scorecardLinks(env);
  for (const row of due.rows) {
    const unsub = unsubscribeUrl(row.unsubscribe_token, env);
    const mail = renderEmail(Number(row.step), row.first_name, links, unsub);
    const r = await deps.sender.send({ to: row.email, ...mail, unsubscribeUrl: unsub });
    if (r.ok) {
      await pool.query(
        "UPDATE scorecard_emails SET status = 'sent', sent_at = $2, provider_message_id = $3, attempts = attempts + 1, last_error = NULL WHERE id = $1",
        [row.email_id, now.toISOString(), r.providerMessageId ?? null]
      );
      out.sent++;
    } else {
      const attempts = Number(row.attempts) + 1;
      await pool.query(
        "UPDATE scorecard_emails SET attempts = $2, last_error = $3, status = $4 WHERE id = $1",
        [row.email_id, attempts, (r.error ?? "unknown").slice(0, 500), attempts >= MAX_ATTEMPTS ? "failed" : "pending"]
      );
      out.failed++;
    }
  }
  return out;
}
