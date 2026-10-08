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

const RESEND_COOLDOWN_MS = DAY_MS;
const MAX_RESENDS = 3;

export type SignupOutcome = "created" | "repeat_resent" | "repeat_no_email";

/**
 * Stores the sign-up and schedules the five emails (new address), or handles a
 * repeat sign-up for an address already on file:
 *  - details are refreshed and the CRM Lead is re-synced;
 *  - the Scorecard email (Email 1) is sent again, at most once per 24 hours and
 *    at most 3 times in total, so the form cannot be used to mail someone repeatedly;
 *  - an address that unsubscribed gets the Scorecard it asked for but is NOT put
 *    back into the sequence: re-subscribing needs more than a form post.
 */
export async function recordSignup(
  pool: Pool,
  input: SignupInput,
  now: Date = new Date()
): Promise<{ subscriberId: number; outcome: SignupOutcome }> {
  const email = input.email.trim();
  const token = randomBytes(24).toString("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ id: number; unsubscribed_at: string | null }>(
      "SELECT id, unsubscribed_at FROM scorecard_subscribers WHERE lower(email) = lower($1) FOR UPDATE",
      [email]
    );
    const found = existing.rows[0];
    if (found) {
      const id = Number(found.id);
      await client.query(
        `UPDATE scorecard_subscribers
            SET first_name = $2, country = $3, llc_status = $4, lead_intent = $5,
                utm_source = COALESCE(utm_source, $6), utm_medium = COALESCE(utm_medium, $7),
                utm_campaign = COALESCE(utm_campaign, $8), utm_content = COALESCE(utm_content, $9),
                crm_synced_at = NULL, crm_next_at = $10
          WHERE id = $1`,
        [
          id, input.firstName.trim(), input.country, input.llcStatus, leadIntentFor(input.llcStatus),
          input.utm?.source || null, input.utm?.medium || null, input.utm?.campaign || null,
          input.utm?.content || null, now.toISOString(),
        ]
      );
      const e1 = await client.query<{ n: string; last: string | null }>(
        "SELECT count(*) AS n, max(send_at) AS last FROM scorecard_emails WHERE subscriber_id = $1 AND step = 1",
        [id]
      );
      const rows = Number(e1.rows[0].n);
      const last = e1.rows[0].last ? new Date(e1.rows[0].last).getTime() : 0;
      const canResend = rows - 1 < MAX_RESENDS && now.getTime() - last >= RESEND_COOLDOWN_MS;
      if (canResend) {
        await client.query(
          "INSERT INTO scorecard_emails (subscriber_id, step, seq, send_at) VALUES ($1, 1, $2, $3)",
          [id, rows, now.toISOString()]
        );
      }
      await client.query("COMMIT");
      return { subscriberId: id, outcome: canResend ? "repeat_resent" : "repeat_no_email" };
    }

    const ins = await client.query<{ id: number }>(
      `INSERT INTO scorecard_subscribers
         (email, first_name, country, llc_status, lead_intent, utm_source, utm_medium,
          utm_campaign, utm_content, is_test, unsubscribe_token, signed_up_at, crm_next_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id`,
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
        "INSERT INTO scorecard_emails (subscriber_id, step, seq, send_at) VALUES ($1,$2,0,$3)",
        [id, Number(step), new Date(now.getTime() + days * DAY_MS).toISOString()]
      );
    }
    await client.query("COMMIT");
    return { subscriberId: id, outcome: "created" };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    // Two simultaneous first sign-ups for one address: the unique index makes the
    // second insert fail; treat it as a repeat rather than an error.
    if (err && typeof err === "object" && (err as { code?: string }).code === "23505") {
      return { subscriberId: 0, outcome: "repeat_no_email" };
    }
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
    /** Same key for the same email: the provider will not send it twice. */
    idempotencyKey?: string;
  }): Promise<{ ok: boolean; error?: string; providerMessageId?: string }>;
}

export interface TickResult {
  crmSynced: number;
  crmFailed: number;
  sent: number;
  failed: number;
  recovered: number;
}

/** Minutes to wait after the Nth consecutive failure: 1, 2, 4, ... capped at 6 hours. */
export const backoffMs = (attempts: number): number =>
  Math.min(2 ** Math.max(0, attempts - 1), 360) * 60_000;

/** An email is given up on (status 'failed', needs a person) after this many failed sends. */
const MAX_SEND_ATTEMPTS = 12;
/** A claimed email with no outcome after this long is treated as a crashed send and re-queued. */
const STALE_CLAIM_MS = 15 * 60_000;

let ticking = false;

/**
 * One worker pass: re-queue crashed sends, retry unsynced CRM Leads (with
 * backoff, never abandoned), then send every due email. Each email is claimed
 * with a conditional UPDATE before sending, so overlapping ticks (or a second
 * instance) cannot send the same email twice. An in-process guard also stops a
 * slow tick from overlapping the next one.
 */
export async function runScorecardTick(
  pool: Pool,
  deps: { sender: ScorecardEmailSender; crm?: ScorecardCrm; now?: Date; env?: NodeJS.ProcessEnv }
): Promise<TickResult> {
  const out: TickResult = { crmSynced: 0, crmFailed: 0, sent: 0, failed: 0, recovered: 0 };
  if (ticking) return out;
  ticking = true;
  try {
    return await tickOnce(pool, deps, out);
  } finally {
    ticking = false;
  }
}

async function tickOnce(
  pool: Pool,
  deps: { sender: ScorecardEmailSender; crm?: ScorecardCrm; now?: Date; env?: NodeJS.ProcessEnv },
  out: TickResult
): Promise<TickResult> {
  const now = deps.now ?? new Date();
  const crm = deps.crm ?? realScorecardCrm;
  const env = deps.env ?? process.env;
  const iso = (d: Date) => d.toISOString();

  const stale = await pool.query(
    `UPDATE scorecard_emails SET status = 'pending', last_error = 'claim expired; re-queued'
      WHERE status = 'sending' AND claimed_at < $1 RETURNING id`,
    [iso(new Date(now.getTime() - STALE_CLAIM_MS))]
  );
  out.recovered = stale.rows.length;

  const unsynced = await pool.query(
    `SELECT id, email, first_name, country, lead_intent, crm_attempts, utm_source, utm_medium, utm_campaign, utm_content
       FROM scorecard_subscribers WHERE crm_synced_at IS NULL AND crm_next_at <= $1 ORDER BY id LIMIT 20`,
    [iso(now)]
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
        "UPDATE scorecard_subscribers SET crm_synced_at = $2, crm_lead_id = $3, crm_last_error = NULL, crm_attempts = 0 WHERE id = $1",
        [s.id, iso(now), r.leadId ?? null]
      );
      out.crmSynced++;
    } else {
      const attempts = Number(s.crm_attempts) + 1;
      await pool.query(
        `UPDATE scorecard_subscribers SET crm_attempts = $2, crm_last_error = $3,
                crm_lead_id = COALESCE($4, crm_lead_id), crm_next_at = $5 WHERE id = $1`,
        [s.id, attempts, (r.error ?? "unknown").slice(0, 500), r.leadId ?? null, iso(new Date(now.getTime() + backoffMs(attempts)))]
      );
      out.crmFailed++;
    }
  }

  const links = scorecardLinks(env);

  // Test addresses only, and only with SCORECARD_TEST_PREVIEW=on: send Emails 2 to 5
  // once, right away, marked [TEST]. The real schedule rows stay pending. The
  // subscriber is claimed first, so the preview is at-most-once.
  if (env.SCORECARD_TEST_PREVIEW === "on") {
    const prev = await pool.query(
      `SELECT id, email, first_name, unsubscribe_token FROM scorecard_subscribers
        WHERE is_test = true AND preview_sent_at IS NULL AND unsubscribed_at IS NULL ORDER BY id LIMIT 5`
    );
    for (const s of prev.rows) {
      const claim = await pool.query(
        "UPDATE scorecard_subscribers SET preview_sent_at = $2 WHERE id = $1 AND preview_sent_at IS NULL RETURNING id",
        [s.id, iso(now)]
      );
      if (!claim.rows[0]) continue;
      const unsub = unsubscribeUrl(s.unsubscribe_token, env);
      for (const step of [2, 3, 4, 5]) {
        const mail = renderEmail(step, s.first_name, links, unsub);
        await deps.sender.send({
          to: s.email, ...mail, subject: `[TEST] ${mail.subject}`, unsubscribeUrl: unsub,
          idempotencyKey: `scorecard-preview-${s.id}-${step}`,
        });
      }
    }
  }

  const due = await pool.query(
    `SELECT e.id AS email_id, e.step, e.attempts, s.email, s.first_name, s.unsubscribe_token
       FROM scorecard_emails e JOIN scorecard_subscribers s ON s.id = e.subscriber_id
      WHERE e.status = 'pending' AND e.send_at <= $1
        AND (s.unsubscribed_at IS NULL OR e.seq > 0)
      ORDER BY e.send_at LIMIT 25`,
    [iso(now)]
  );
  for (const row of due.rows) {
    const claim = await pool.query(
      "UPDATE scorecard_emails SET status = 'sending', claimed_at = $2 WHERE id = $1 AND status = 'pending' RETURNING id",
      [row.email_id, iso(now)]
    );
    if (!claim.rows[0]) continue; // another tick or instance has it
    const unsub = unsubscribeUrl(row.unsubscribe_token, env);
    const mail = renderEmail(Number(row.step), row.first_name, links, unsub);
    const r = await deps.sender.send({
      to: row.email, ...mail, unsubscribeUrl: unsub, idempotencyKey: `scorecard-email-${row.email_id}`,
    });
    if (r.ok) {
      await pool.query(
        "UPDATE scorecard_emails SET status = 'sent', sent_at = $2, provider_message_id = $3, attempts = attempts + 1, last_error = NULL WHERE id = $1",
        [row.email_id, iso(now), r.providerMessageId ?? null]
      );
      out.sent++;
    } else {
      const attempts = Number(row.attempts) + 1;
      const giveUp = attempts >= MAX_SEND_ATTEMPTS;
      await pool.query(
        "UPDATE scorecard_emails SET attempts = $2, last_error = $3, status = $4, send_at = $5 WHERE id = $1",
        [
          row.email_id, attempts, (r.error ?? "unknown").slice(0, 500), giveUp ? "failed" : "pending",
          iso(new Date(now.getTime() + backoffMs(attempts))),
        ]
      );
      if (giveUp) console.error(`[scorecard] email ${row.email_id} failed ${attempts} times; needs a person`);
      out.failed++;
    }
  }
  return out;
}
