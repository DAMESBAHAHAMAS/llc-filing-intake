import { Router } from "express";
import { pool } from "../db/pool.js";
import { getDocumentByMediaToken } from "../fulfillment/documentStore.js";

export const faxMediaRouter = Router();

/**
 * GET /api/fax-media/:token
 *
 * The only reason this route exists: Telnyx's Fax API sends by
 * `media_url` — a URL IT fetches the PDF from — rather than accepting an
 * uploaded file body (see fulfillment/faxProvider.ts's file comment on
 * why Telnyx was the chosen provider despite this extra step). This is
 * therefore an unauthenticated, public endpoint by necessity — Telnyx's
 * servers have no credentials of ours to present — but it is not an open
 * document store: :token is an unguessable, single-purpose, expiring
 * capability (fulfillment/documentStore.ts's mintMediaAccessToken/
 * getDocumentByMediaToken), the exact same posture this codebase already
 * uses for the registered-agent acceptance links. A token grants access
 * to exactly one document, for a bounded window, and reveals nothing
 * about any other filing.
 */
faxMediaRouter.get("/api/fax-media/:token", async (req, res) => {
  const document = await getDocumentByMediaToken(pool, req.params.token);
  if (!document) {
    res.status(404).json({ error: "Not found or expired" });
    return;
  }
  res.status(200);
  res.setHeader("Content-Type", document.contentType);
  res.setHeader("Content-Length", String(document.byteSize));
  res.send(document.pdfBytes);
});
