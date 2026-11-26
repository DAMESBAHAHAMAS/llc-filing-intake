import { Router, type Request, type Response } from "express";
import { pool } from "../db/pool.js";
import { describeError } from "../db/describeError.js";
import { clientKey } from "../middleware/rateLimit.js";
import { isUuid, type Db } from "../postFiling/interests.js";
import {
  SS4_DESIGNEE_STATEMENT_CLAUSES,
  SS4_DESIGNEE_STATEMENT_INTRO,
  SS4_DESIGNEE_STATEMENT_SHA256,
  SS4_DESIGNEE_STATEMENT_TEXT,
  SS4_DESIGNEE_STATEMENT_TITLE,
  SS4_DESIGNEE_STATEMENT_VERSION,
  checkSignatureInput,
  designeeConfig,
  designeeSession,
  isMissingDesigneeTable,
  readSignature,
  saveSignature,
  type DesigneeConfig,
  type DesigneeSession,
} from "../ein/designee.js";

/**
 * ST17: the IRS Form SS-4 Third-Party Designee e-signature.
 *
 *   GET  /api/ein/designee-authorization?filing_session_id=…&order_id=…
 *        -> 200 { status: "open", entity_name, statement, signature | null }
 *   POST /api/ein/designee-authorization
 *        { filing_session_id, order_id, statement_version, signer_name, signer_title?, consent: true }
 *        -> 201 { status: "signed", signature }   (200 if it was already signed)
 *
 * Both need the filing session and one of its held or paid orders (the pair in the
 * Stripe success URL), and the session's paid or held orders must include the EIN;
 * anything else is 404 "not_found", so the endpoint never says whether a session
 * exists. 503 "not_open" while switched off (default; EIN_DESIGNEE_ESIGN_ENABLED=true
 * turns it on) or before migration 0040 is applied. 409 "entity_name_missing" when the
 * interview has no LLC name yet (the statement refers to "the entity listed above"),
 * 409 "statement_changed" when the page showed an older wording. Rate-limited per IP
 * in middleware/funnelProtection.ts.
 */
export function createEinDesigneeRouter(
  deps: { db?: Db; config?: () => DesigneeConfig; now?: () => Date } = {},
): Router {
  const db = deps.db ?? pool;
  const config = deps.config ?? (() => designeeConfig());
  const now = deps.now ?? (() => new Date());
  const router = Router();

  const statement = {
    version: SS4_DESIGNEE_STATEMENT_VERSION,
    title: SS4_DESIGNEE_STATEMENT_TITLE,
    intro: SS4_DESIGNEE_STATEMENT_INTRO,
    clauses: SS4_DESIGNEE_STATEMENT_CLAUSES,
    text: SS4_DESIGNEE_STATEMENT_TEXT,
    sha256: SS4_DESIGNEE_STATEMENT_SHA256,
  };

  /** Every answer is no-store; switched off wins over everything else. */
  function open(res: Response): boolean {
    res.setHeader("Cache-Control", "no-store");
    if (config().enabled) return true;
    res.status(503).json({ error: "not_open" });
    return false;
  }

  function failed(res: Response, err: unknown, what: "read" | "save"): void {
    if (isMissingDesigneeTable(err)) {
      res.status(503).json({ error: "not_open" });
      return;
    }
    console.error(`[ein-designee] ${what} failed:`, describeError(err));
    res.status(500).json({ error: `${what}_failed` });
  }

  async function authorize(res: Response, filingSessionId: unknown, orderId: unknown): Promise<DesigneeSession | null> {
    if (!isUuid(filingSessionId) || !isUuid(orderId)) {
      res.status(400).json({ error: "invalid_request" });
      return null;
    }
    const session = await designeeSession(db, filingSessionId, orderId);
    if (!session) res.status(404).json({ error: "not_found" });
    return session;
  }

  router.get("/api/ein/designee-authorization", async (req: Request, res: Response) => {
    if (!open(res)) return;
    try {
      const { filing_session_id: sid, order_id: oid } = req.query;
      const session = await authorize(res, sid, oid);
      if (!session) return;
      const signature = await readSignature(db, sid as string);
      res.status(200).json({ status: "open", entity_name: session.entityName, statement, signature });
    } catch (err) {
      failed(res, err, "read");
    }
  });

  router.post("/api/ein/designee-authorization", async (req: Request, res: Response) => {
    if (!open(res)) return;
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { filing_session_id: sid, order_id: oid } = body;
      if (!isUuid(sid) || !isUuid(oid)) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      const input = checkSignatureInput(body);
      if (!input.ok) {
        res.status(input.status).json({ error: input.error, ...(input.status === 409 ? { statement } : {}) });
        return;
      }
      const session = await authorize(res, sid, oid);
      if (!session) return;
      if (!session.entityName) {
        res.status(409).json({ error: "entity_name_missing" });
        return;
      }
      const ip = clientKey(req);
      const { signature, created } = await saveSignature(
        db,
        { filingSessionId: sid, orderId: oid, signerName: input.signerName, signerTitle: input.signerTitle, entityName: session.entityName },
        { now: now(), ip: ip === "unknown" ? null : ip, userAgent: req.get("user-agent") ?? null },
      );
      res.status(created ? 201 : 200).json({ status: "signed", signature });
    } catch (err) {
      failed(res, err, "save");
    }
  });

  return router;
}

export const einDesigneeRouter = createEinDesigneeRouter();
