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
