import type { Pool } from "pg";
import { getActiveOfferByCode } from "./catalog.js";
import { einUpsellEligible } from "./einBundleRule.js";

/** Only the queries this module runs, so tests can pass a small fake. */
export type Queryable = Pick<Pool, "query">;

/** Payment states in which money has actually been taken or held. */
const MONEY_TAKEN = "('authorized', 'paid')";

/**
 * Offer codes on every authorized or paid order of a filing session. Pending,
 * failed, released and refunded orders are excluded on purpose: they moved no
 * money, so they must not block or satisfy anything.
 */
export async function orderedOfferCodes(db: Queryable, filingSessionId: string): Promise<string[]> {
  const { rows } = await db.query<{ line_items: Array<{ offer_code?: unknown }> | null }>(
    `SELECT line_items FROM orders WHERE filing_session_id = $1 AND payment_status IN ${MONEY_TAKEN}`,
    [filingSessionId],
  );
  return rows.flatMap((row) =>
    (row.line_items ?? []).map((li) => li.offer_code).filter((code): code is string => typeof code === "string"),
  );
}

/** What the success page may show: an offer identifier and its catalog price. */
export interface EinUpsell {
  offer_code: string;
  display_name: string;
  unit_amount_cents: number;
  currency: string;
}

/**
 * The post-payment EIN upsell for an order, or null when it must not be shown.
 * The server decides: the browser never infers eligibility, and the price comes
 * from the Offer Master, never from the client or a constant. Only orders whose
 * card is already held or charged qualify, since the upsell is a post-payment
 * offer.
 */
export async function getEinUpsell(
  db: Queryable,
  order: { filing_session_id: string; payment_status: string },
): Promise<EinUpsell | null> {
  if (order.payment_status !== "authorized" && order.payment_status !== "paid") return null;
  const codes = await orderedOfferCodes(db, order.filing_session_id);
  if (!einUpsellEligible(codes)) return null;
  const offer = await getActiveOfferByCode(db as Pool, "EIN_FILING");
  if (!offer) return null;
  return {
    offer_code: offer.offer_code,
    display_name: offer.display_name,
    unit_amount_cents: offer.unit_amount_cents,
    currency: offer.currency,
  };
}
