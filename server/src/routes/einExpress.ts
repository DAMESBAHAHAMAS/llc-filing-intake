import { Router } from "express";
import { pool } from "../db/pool.js";
import { describeError } from "../db/describeError.js";
import { getEinExpressAvailability } from "../ein/capacity.js";

export const einExpressRouter = Router();

/**
 * GET /api/ein-express/availability
 *
 * Count-based same-day capacity governor (frozen rule) — the frontend
 * calls this before offering the EIN Filing Express option, and
 * POST /api/checkout/create independently re-checks it server-side too
 * (never trust a client-side "still available" read alone). Note:
 * EIN_FILING_EXPRESS is currently seeded status='draft' in the Offer
 * Master (unconfirmed price) — this endpoint reports capacity
 * regardless, since capacity and price-confirmation are independent
 * facts, but checkout will refuse to sell it until it's flipped active.
 */
einExpressRouter.get("/api/ein-express/availability", async (_req, res) => {
  try {
    const availability = await getEinExpressAvailability(pool);
    res.status(200).json(availability);
  } catch (err) {
    res.status(500).json({ error: "availability check failed", detail: describeError(err) });
  }
});
