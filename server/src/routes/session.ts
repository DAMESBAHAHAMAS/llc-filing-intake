import { randomUUID } from "node:crypto";
import { Router } from "express";
import { pool } from "../db/pool.js";
import { describeError } from "../db/describeError.js";

export const sessionRouter = Router();

/**
 * Server-defined whitelist of session fields a client may set. Never
 * derived from request body keys — values are parameterized, but which
 * *columns* can be touched is fixed here, not client-controlled.
 *
 * GATE 2 P0 SECURITY FIX (2026-09-09, see DECISIONS.md): payment_status,
 * crm_lead_id, crm_deal_id, crm_sync_status, crm_last_synced_at,
 * pdf_generated_at, and pdf_storage_ref were REMOVED from this list.
 * They are exclusively written by server-side workers (the CRM sync
 * worker, the Stripe webhook handler, the fulfillment worker) via direct
 * SQL, never through this public HTTP endpoint. Before this fix, a
 * client could POST payment_status: "paid" here directly, and the Gate 1
 * sync worker (zoho/client.ts realZohoClient.syncSession) would read
 * exactly that field to decide whether to create a Zoho Deal — i.e. a
 * forged field on this endpoint could create a real Deal with no actual
 * payment. filing_sessions.payment_status already carried a Postgres
 * column COMMENT (migration 0009) claiming this fix already existed; it
 * did not, until now. See the corresponding fix in zoho/client.ts
 * (syncSession no longer creates Deals at all — that is now exclusively
 * the webhook-triggered order_deal path's job, per the frozen CRM
 * sequencing rule: Deal only after a verified Stripe webhook).
 */
const SESSION_FIELDS = [
  "email",
  "phone",
  "full_name",
  "country",
  "entity_name_primary",
  "entity_name_backup",
  "name_check_results",
  "order_total_cents",
  "payment_ref",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "abandoned_at",
] as const;

type SessionField = (typeof SESSION_FIELDS)[number];
type SessionPatch = Partial<Record<SessionField, unknown>>;

function extractPatch(body: Record<string, unknown>): SessionPatch {
  const patch: SessionPatch = {};
  for (const field of SESSION_FIELDS) {
    if (body[field] !== undefined) {
      patch[field] = body[field];
    }
  }
  return patch;
}

/**
 * POST /api/session/stage
 *
 * Mints filing_session_id server-side on first call (no id in the
 * request, or an id the DB doesn't recognize), upserts filing_sessions,
 * and — only when the stage actually changes — appends a filing_events
 * row and enqueues a crm_sync_queue job in the SAME transaction as the
 * session write. Idempotent on (filing_session_id, stage): calling this
 * twice in a row with the same session + stage does not create a second
 * event or a second queue job, though the session's other fields are
 * still upserted with whatever was sent (safe either way — upserting
 * identical values twice is a no-op in effect).
 *
 * A sync job is only enqueued once an email exists (either already on
 * the session or provided in this call) — there is no Zoho entity to
 * sync to before that. The worker decides Lead vs. Deal from
 * payload_snapshot (e.g. a paid payment_status means "convert to
 * Deal"), so this endpoint only needs one generic sync_type.
 */
sessionRouter.post("/api/session/stage", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const stage = typeof body.stage === "string" ? body.stage.trim() : "";

  if (!stage) {
    res.status(400).json({ error: "stage is required" });
    return;
  }

  const requestedId = typeof body.filing_session_id === "string" ? body.filing_session_id : null;
  const patch = extractPatch(body);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Determine the session id and its CURRENT stage (before this
    // write) — the idempotency check compares against this value.
    let sessionId = requestedId;
    let previousStage: string | null = null;
    let sessionExists = false;

    if (sessionId) {
      const existing = await client.query<{ current_stage: string | null }>(
        "SELECT current_stage FROM filing_sessions WHERE filing_session_id = $1 FOR UPDATE",
        [sessionId]
      );
      if (existing.rowCount) {
        sessionExists = true;
        previousStage = existing.rows[0].current_stage;
      }
    }

    if (!sessionId || !sessionExists) {
      sessionId = sessionId ?? randomUUID();
    }

    // Build a dynamic but safe SET list — only columns in SESSION_FIELDS,
    // only ones actually present in this request, values parameterized.
    const patchKeys = Object.keys(patch) as SessionField[];
    const setClauses = patchKeys.map((key, i) => `${key} = $${i + 3}`);
    const setValues = patchKeys.map((key) => patch[key]);

    if (sessionExists) {
      const sql = `
        UPDATE filing_sessions
        SET current_stage = $2${setClauses.length ? ", " + setClauses.join(", ") : ""}
        WHERE filing_session_id = $1
      `;
      await client.query(sql, [sessionId, stage, ...setValues]);
    } else {
      const insertCols = ["filing_session_id", "current_stage", ...patchKeys];
      const insertPlaceholders = insertCols.map((_, i) => `$${i + 1}`);
      const sql = `
        INSERT INTO filing_sessions (${insertCols.join(", ")})
        VALUES (${insertPlaceholders.join(", ")})
      `;
      await client.query(sql, [sessionId, stage, ...setValues]);
    }

    const stageChanged = previousStage !== stage;
    let eventId: number | null = null;
    let queueId: number | null = null;

    if (stageChanged) {
      const eventResult = await client.query<{ id: string }>(
        `INSERT INTO filing_events (filing_session_id, event_type, payload)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [sessionId, stage, JSON.stringify(body)]
      );
      eventId = Number(eventResult.rows[0].id);

      // Effective email after this write: whatever was just patched, or
      // whatever was already on the row.
      const effectiveEmail =
        (patch.email as string | undefined) ??
        (sessionExists
          ? (await client.query<{ email: string | null }>(
              "SELECT email FROM filing_sessions WHERE filing_session_id = $1",
              [sessionId]
            )).rows[0]?.email
          : null);

      if (effectiveEmail) {
        const snapshot = await client.query(
          "SELECT * FROM filing_sessions WHERE filing_session_id = $1",
          [sessionId]
        );
        const queueResult = await client.query<{ id: string }>(
          `INSERT INTO crm_sync_queue (filing_session_id, sync_type, payload_snapshot)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [sessionId, "session_sync", JSON.stringify(snapshot.rows[0])]
        );
        queueId = Number(queueResult.rows[0].id);
      }
    }

    await client.query("COMMIT");

    res.status(200).json({
      filing_session_id: sessionId,
      current_stage: stage,
      stage_changed: stageChanged,
      event_id: eventId,
      queued_sync_id: queueId,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "session stage write failed", detail: describeError(err) });
  } finally {
    client.release();
  }
});
