import { Router } from "express";
import { pool } from "../db/pool.js";
import { describeError } from "../db/describeError.js";
import { listActiveOffers } from "../offers/catalog.js";

export const offersRouter = Router();

/**
 * GET /api/offers
 *
 * The storefront's read model for the Offer Master. The packages page
 * renders its tiers and add-ons from this, rather than from prices
 * hardcoded in the frontend — see listActiveOffers' comment for the
 * drift this is closing (a page advertising EIN at $75 against a
 * catalog that would charge $299).
 *
 * Only status='active' rows are returned, so a 'draft' offer
 * (EIN_FILING_EXPRESS, pending price confirmation) is never renderable
 * and never sellable — the same rule checkout enforces, applied at the
 * display layer too, so the storefront can't offer something checkout
 * would then refuse.
 */
offersRouter.get("/api/offers", async (_req, res) => {
  try {
    const offers = await listActiveOffers(pool);
    res.status(200).json({ offers });
  } catch (err) {
    res.status(500).json({ error: "offer catalog read failed", detail: describeError(err) });
  }
});
