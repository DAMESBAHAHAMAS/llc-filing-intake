import { Router, type Request, type Response } from "express";
import { pool } from "../db/pool.js";
import { describeError } from "../db/describeError.js";
import { orderedOfferCodes, type Queryable } from "../offers/einUpsell.js";
import { sendOpsAlert } from "../ops/alerts.js";
import { clientKey } from "../middleware/rateLimit.js";
import { realEinDocsClient, type EinDocsClient } from "../zoho/einDocs.js";
import { verifyEinOnboardingToken } from "../ein/onboardingToken.js";
import {
  ATTESTATION_VERSION,
  attestationText,
  buildSs4Summary,
  einIncluded,
  einOnboardingConfig,
  onboardingOpen,
  sha256Hex,
  validateSubmission,
  type EinOnboardingConfig,
} from "../ein/onboarding.js";

/**
 * ST17 (A6Y2-T144 item 6): tokenized EIN / Form SS-4 onboarding.
 *
 *   GET  /api/onboarding/ein?filing_session_id=…&t=…  → the pre-filled form
 *   POST /api/onboarding/ein                           → Responsible Party, passport, e-signature
 *
 * Closed (503 { error: "not_open" }) until EIN_ONBOARDING_ENABLED=true: the owner has
 * not yet approved passport storage, the access token and the SS-4 attestation text.
 *
 * Access: the filing session must have an authorized or paid order that includes the
 * EIN (Bank-Ready, Premium or the EIN add-on), and, unless the owner decides
 * otherwise, a valid signed link token (ein/onboardingToken.ts).
 *
 * The passport photo page goes straight to the customer's Zoho Deal (the Deal the
 * verified Stripe webhook recorded on the order, never the client-suppliable
 * filing_sessions.crm_deal_id) and is never stored here. The e-signature record is
 * the typed name, this server's clock, the client IP and user agent.
 */
export interface EinOnboardingDeps {
  db: Queryable;
  docs: EinDocsClient;
  alert: (subject: string, body: string) => Promise<unknown>;
  config: () => EinOnboardingConfig;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Gate =
  | { ok: true; sessionId: string; llcName: string; session: SessionRow }
  | { ok: false; status: number; body: Record<string, unknown> };

interface SessionRow {
  filing_data: Record<string, unknown> | null;
  entity_name_primary: string | null;
  full_name: string | null;
  country: string | null;
}

async function gate(deps: EinOnboardingDeps, sessionIdRaw: unknown, token: unknown): Promise<Gate> {
  const cfg = deps.config();
  if (!onboardingOpen(cfg)) return { ok: false, status: 503, body: { error: "not_open" } };
  const sessionId = typeof sessionIdRaw === "string" ? sessionIdRaw.trim() : "";
  if (!UUID.test(sessionId)) return { ok: false, status: 404, body: { error: "not_found" } };
  if (cfg.requireToken) {
    const check = verifyEinOnboardingToken(cfg.tokenSecret, sessionId, token);
    if (check === "expired") return { ok: false, status: 403, body: { error: "expired_token" } };
    if (check !== "ok") return { ok: false, status: 403, body: { error: "invalid_token" } };
  }
  const { rows } = await deps.db.query<SessionRow>(
    `SELECT filing_data, entity_name_primary, full_name, country FROM filing_sessions WHERE filing_session_id = $1`,
    [sessionId],
  );
  if (rows.length === 0) return { ok: false, status: 404, body: { error: "not_found" } };
  const codes = await orderedOfferCodes(deps.db, sessionId);
  if (!einIncluded(codes)) return { ok: false, status: 403, body: { error: "not_eligible" } };
  const session = rows[0];
  const data = session.filing_data ?? {};
  const llcName = (typeof data.llc_name === "string" && data.llc_name.trim() ? data.llc_name : session.entity_name_primary ?? "").trim().toUpperCase();
  return { ok: true, sessionId, llcName, session };
}

async function existingSubmission(db: Queryable, sessionId: string): Promise<string | null> {
  const { rows } = await db.query<{ signed_at: Date | string }>(
    `SELECT signed_at FROM ein_onboarding_submissions WHERE filing_session_id = $1`,
    [sessionId],
  );
  if (rows.length === 0) return null;
  const at = rows[0].signed_at;
  return at instanceof Date ? at.toISOString() : String(at);
}

export function createEinOnboardingRouter(deps: EinOnboardingDeps): Router {
  const router = Router();

  router.get("/api/onboarding/ein", async (req: Request, res: Response) => {
    try {
      const g = await gate(deps, req.query.filing_session_id, req.query.t);
      if (!g.ok) {
        res.status(g.status).json(g.body);
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      const submittedAt = await existingSubmission(deps.db, g.sessionId);
      if (submittedAt) {
        res.status(200).json({ status: "submitted", llc_name: g.llcName, submitted_at: submittedAt, ss4_summary: [], attestation: { version: ATTESTATION_VERSION, text: "" } });
        return;
      }
      res.status(200).json({
        status: "open",
        llc_name: g.llcName,
        prefill: { full_legal_name: g.session.full_name ?? "", country: g.session.country ?? "" },
        ss4_summary: buildSs4Summary(g.session.filing_data, g.session.entity_name_primary),
        attestation: { version: ATTESTATION_VERSION, text: attestationText(g.llcName) },
      });
    } catch (err) {
      res.status(500).json({ error: "lookup_failed", detail: describeError(err) });
    }
  });

  router.post("/api/onboarding/ein", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    let sessionId = "";
    try {
      const g = await gate(deps, body.filing_session_id, body.t);
      if (!g.ok) {
        res.status(g.status).json(g.body);
        return;
      }
      sessionId = g.sessionId;
      const checked = validateSubmission(body);
      if (!checked.ok) {
        res.status(422).json({ error: "invalid", message: checked.message });
        return;
      }
      if (await existingSubmission(deps.db, sessionId)) {
        res.status(409).json({ error: "already_submitted" });
        return;
      }

      // Only the Deal the verified Stripe webhook recorded on a held or paid order.
      const { rows: dealRows } = await deps.db.query<{ crm_deal_id: string; order_id: string }>(
        `SELECT crm_deal_id, order_id FROM orders
         WHERE filing_session_id = $1 AND payment_status IN ('authorized', 'paid') AND crm_deal_id IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
        [sessionId],
      );
      const deal = dealRows[0];
      if (!deal) {
        await deps.alert("EIN details could not be received", `Filing session ${sessionId} (${g.llcName}) tried to submit EIN details, but its order has no Zoho Deal yet.`);
        res.status(503).json({ error: "crm_not_ready", message: "We are still setting up your file. Please try again in a few minutes." });
        return;
      }

      const { passport } = checked.value;
      const attached = await deps.docs.attachToDeal(deal.crm_deal_id, passport);
      if (!attached.ok) {
        await deps.alert("EIN passport upload failed", `Filing session ${sessionId} (${g.llcName}), Deal ${deal.crm_deal_id}: ${attached.error}`);
        res.status(502).json({ error: "upload_failed", message: "We couldn't save your passport. Please try again in a moment." });
        return;
      }

      const v = checked.value;
      const { rows: inserted } = await deps.db.query<{ signed_at: Date | string }>(
        `INSERT INTO ein_onboarding_submissions
           (filing_session_id, order_id, responsible_party, no_ssn_confirmed, passport_sha256, passport_bytes,
            passport_content_type, zoho_deal_id, zoho_attachment_id, signature_typed_name, attestation_version,
            attestation_sha256, signer_ip, signer_user_agent)
         VALUES ($1, $2, $3, true, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (filing_session_id) DO NOTHING
         RETURNING signed_at`,
        [
          sessionId,
          deal.order_id,
          JSON.stringify(v.responsibleParty),
          sha256Hex(passport.bytes),
          passport.bytes.length,
          passport.contentType,
          deal.crm_deal_id,
          attached.attachmentId,
          v.signatureName,
          v.attestationVersion,
          sha256Hex(attestationText(g.llcName)),
          clientKey(req),
          (req.get("user-agent") ?? "").slice(0, 300),
        ],
      );
      if (inserted.length === 0) {
        res.status(409).json({ error: "already_submitted" });
        return;
      }
      const signedAt = inserted[0].signed_at instanceof Date ? inserted[0].signed_at.toISOString() : String(inserted[0].signed_at);

      // The customer's part is done; a CRM problem from here on is the team's to fix.
      const cfg = deps.config();
      const marked = await deps.docs.markDocsReceived(
        deal.crm_deal_id,
        cfg.einDocsReceivedField,
        `EIN Docs Received = Yes. Responsible Party details, passport photo page and signed Form SS-4 summary received ${signedAt}.`,
      );
      await deps.db.query(`UPDATE ein_onboarding_submissions SET crm_status = $2, crm_error = $3 WHERE filing_session_id = $1`, [
        sessionId,
        marked.ok ? `done_${marked.via}` : "failed",
        marked.ok ? null : marked.error,
      ]);
      await deps.alert(
        `EIN details received — ${g.llcName || "LLC"}`,
        [
          `Filing session ${sessionId}. Passport photo page attached to Zoho Deal ${deal.crm_deal_id}.`,
          marked.ok
            ? `Deal marked EIN Docs Received (${marked.via === "field" ? "field" : "note; the EIN Docs Received field is not configured yet"}).`
            : `Could not mark the Deal: ${marked.error}`,
          "Ready to prepare Form SS-4.",
        ].join(" "),
      );
      res.status(200).json({ status: "submitted", submitted_at: signedAt });
    } catch (err) {
      console.error(`[ein-onboarding] submit failed for ${sessionId || "unknown session"}:`, describeError(err));
      res.status(500).json({ error: "submit_failed" });
    }
  });

  return router;
}

export const einOnboardingRouter = createEinOnboardingRouter({
  db: pool,
  docs: realEinDocsClient,
  alert: sendOpsAlert,
  config: () => einOnboardingConfig(),
});
