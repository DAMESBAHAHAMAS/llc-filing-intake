import type { Pool } from "pg";

/**
 * Offer Master row shape (server/migrations/0012_offer_master.sql).
 * unit_amount_cents is informational only — stripe_price_id is what
 * Stripe actually charges. Never trust a client-sent amount; always
 * resolve through this table.
 */
export interface Offer {
  id: number;
  offer_code: string;
  offer_version: string;
  display_name: string;
  crm_intent: string;
  stripe_product_id: string;
  stripe_price_id: string;
  unit_amount_cents: number;
  currency: string;
  status: "draft" | "active" | "retired";
}

const OFFER_COLUMNS = `
  id, offer_code, offer_version, display_name, crm_intent,
  stripe_product_id, stripe_price_id, unit_amount_cents, currency, status
`;

/**
 * Resolves offer_codes to their currently ACTIVE offer row. Never
 * resolves a 'draft' or 'retired' offer — 'draft' means not yet
 * confirmed sellable (e.g. EIN_FILING_EXPRESS pending a real price
 * confirmation), 'retired' means superseded by a newer version.
 * Returns exactly the rows found; the caller is responsible for
 * detecting missing codes (found.length !== codes.length) and rejecting
 * the request rather than silently proceeding with a partial cart.
 */
export async function resolveActiveOffers(pool: Pool, offerCodes: string[]): Promise<Offer[]> {
  if (offerCodes.length === 0) return [];
  const { rows } = await pool.query<Offer>(
    `SELECT ${OFFER_COLUMNS} FROM offers WHERE offer_code = ANY($1) AND status = 'active'`,
    [offerCodes]
  );
  return rows;
}

export async function getActiveOfferByCode(pool: Pool, offerCode: string): Promise<Offer | null> {
  const rows = await resolveActiveOffers(pool, [offerCode]);
  return rows[0] ?? null;
}

/** An active offer as the storefront is allowed to see it. Deliberately
 *  omits stripe_product_id/stripe_price_id and internal_cost_cents — the
 *  browser never needs them, and the Price ID in particular is the thing
 *  that actually determines the charge, so there is no reason to publish
 *  it to a surface that must never influence pricing. */
export interface PublicOffer {
  offer_code: string;
  offer_version: string;
  display_name: string;
  unit_amount_cents: number;
  currency: string;
  inclusions: unknown;
  exclusions: unknown;
}

/**
 * Every currently-sellable offer, for the storefront to RENDER from.
 *
 * This exists to close a specific, already-observed failure: before it,
 * the packages page hardcoded its own prices, and those prices had
 * drifted badly from the Offer Master — the page advertised EIN at $75
 * while the catalog would have charged $299, and three add-ons it sold
 * had no offer at all. Rendering from this endpoint means the displayed
 * price and the charged price come from the same row, so they cannot
 * disagree. The browser still only ever SENDS offer_code identifiers
 * (POST /api/checkout/create) — this endpoint is display-only and
 * confers no pricing authority on the client.
 */
export async function listActiveOffers(pool: Pool): Promise<PublicOffer[]> {
  const { rows } = await pool.query<PublicOffer>(
    `SELECT offer_code, offer_version, display_name, unit_amount_cents, currency, inclusions, exclusions
       FROM offers
      WHERE status = 'active'
      ORDER BY unit_amount_cents ASC`
  );
  return rows;
}
