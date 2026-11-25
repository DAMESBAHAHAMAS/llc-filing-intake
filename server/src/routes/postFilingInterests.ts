import { Router, type Request, type Response } from "express";
import { pool } from "../db/pool.js";
import { describeError } from "../db/describeError.js";
import {
  cleanNote,
  isInterest,
  isMissingTable,
  isUuid,
  postFilingConfig,
  readInterests,
  saveInterest,
  sessionHasHeldOrPaidOrder,
  type Db,
  type InterestState,
  type PostFilingConfig,
} from "../postFiling/interests.js";

/**
 * A6Y2-T144 Dispatch 13: the post-filing roadmap on /checkout/success.
 *
 *   GET  /api/post-filing-interests?filing_session_id=…&order_id=…
 *        -> 200 { status: "open", interests, license_note }
 *   POST /api/post-filing-interests
 *        { filing_session_id, order_id, interest, selected, note? }
 *        -> 200 { status: "saved", interests, license_note }
 *
 * Both need the filing session and one of its held or paid orders (the pair in the
 * Stripe success URL); anything else is 404 "not_found", so the endpoint never says
 * whether a session exists. 400 for a malformed body, 503 "not_open" when switched
 * off (POST_FILING_INTERESTS_ENABLED=false) or before migration 0032 is applied.
 * The website shows the toggles only after
 * a 200 from GET. Rate-limited per IP in middleware/funnelProtection.ts. The Zoho
 * Deal is never taken from the request: postFiling/interests.ts resolves it.
 */
export function createPostFilingInterestsRouter(
  deps: { db?: Db; config?: () => PostFilingConfig; now?: () => Date } = {},
): Router {
  const db = deps.db ?? pool;
  const config = deps.config ?? (() => postFilingConfig());
  const now = deps.now ?? (() => new Date());
  const router = Router();

  function view(state: InterestState) {
    return {
      interests: {
        bank_account: state.bank_account,
        licenses_permits: state.licenses_permits,
        tax_compliance: state.tax_compliance,
      },
      license_note: state.license_note,
    };
  }

  function failed(res: Response, err: unknown, what: "read" | "save"): void {
    // Merged before migration 0032 ran: behave as switched off, not as broken.
    if (isMissingTable(err)) {
      res.status(503).json({ error: "not_open" });
      return;
    }
    console.error(`[post-filing-interests] ${what} failed:`, describeError(err));
    res.status(500).json({ error: `${what}_failed` });
  }

  /** Every answer is no-store; switched off wins over everything else. */
  function open(res: Response): boolean {
    res.setHeader("Cache-Control", "no-store");
    if (config().enabled) return true;
    res.status(503).json({ error: "not_open" });
    return false;
  }

  async function authorize(res: Response, filingSessionId: unknown, orderId: unknown): Promise<boolean> {
    if (!isUuid(filingSessionId) || !isUuid(orderId)) {
      res.status(400).json({ error: "invalid_request" });
      return false;
    }
    if (!(await sessionHasHeldOrPaidOrder(db, filingSessionId, orderId))) {
      res.status(404).json({ error: "not_found" });
      return false;
    }
    return true;
  }

  router.get("/api/post-filing-interests", async (req: Request, res: Response) => {
    if (!open(res)) return;
    try {
      const { filing_session_id: sid, order_id: oid } = req.query;
      if (!(await authorize(res, sid, oid))) return;
      res.status(200).json({ status: "open", ...view(await readInterests(db, sid as string)) });
    } catch (err) {
      failed(res, err, "read");
    }
  });

  router.post("/api/post-filing-interests", async (req: Request, res: Response) => {
    if (!open(res)) return;
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { filing_session_id: sid, order_id: oid, interest, selected } = body;
      const noteOk = body.note === undefined || body.note === null || typeof body.note === "string";
      if (!isInterest(interest) || typeof selected !== "boolean" || !noteOk) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      if (!(await authorize(res, sid, oid))) return;
      // A note is kept only for the licence and permit check, and only when it is sent.
      const note = interest === "licenses_permits" && body.note !== undefined ? cleanNote(body.note) : undefined;
      const state = await saveInterest(db, sid as string, interest, selected, note, now());
      res.status(200).json({ status: "saved", ...view(state) });
    } catch (err) {
      failed(res, err, "save");
    }
  });

  return router;
}

export const postFilingInterestsRouter = createPostFilingInterestsRouter();
