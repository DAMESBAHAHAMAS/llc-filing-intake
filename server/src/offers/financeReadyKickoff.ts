/**
 * Finance-Ready ($997) kickoff hold (Damian, 25 Nov 2026; Zoho task A6Y2-T144,
 * Dispatch 8).
 *
 * Finance-Ready (offer_code PREMIUM) stays closed to full-price checkout
 * (closedOffers.ts): its custom scope is set on a strategy call with Damian.
 * A customer may still lock in and start the filing right away: checkout places
 * a card hold for the base Florida filing only, and the rest of the package
 * price is not collected until Damian has reviewed the build parameters with
 * the customer and reset the scope.
 *
 * How the order is recorded:
 *  - The hold is charged from the File It base offers (state fee, service fee,
 *    Certificate of Status): their existing Stripe Prices, so no new Stripe
 *    object and no amount from the browser. Today that is $139.00.
 *  - The order's line_items carry one more line: a zero-amount PREMIUM line
 *    (role "selected_package") that records the package price, the hold and the
 *    remaining balance. Everything that reads line_items (EIN included, the
 *    package on the success page, the EIN portal invite, the order emails, the
 *    house-agent rule) therefore sees a Finance-Ready order, while total_cents
 *    stays exactly what the card hold covers. That matters: a lapsed hold is
 *    re-collected for total_cents (routes/orders.ts), so it can never reach the
 *    remaining balance.
 *  - Nothing in this service ever collects the remaining balance.
 */

export const KICKOFF_PAYMENT_PLAN = "finance_ready_kickoff";
export const KICKOFF_PACKAGE_CODE = "PREMIUM";
/** File It's base filing: Florida state fee, service fee, Certificate of Status. */
export const KICKOFF_HOLD_CODES: readonly string[] = ["DIY_STATE_FEE", "DIY_SERVICE_FEE", "DIY_CERT_OF_STATUS"];
export const SELECTED_PACKAGE_ROLE = "selected_package";
export const PENDING_SCOPE_REVIEW = "pending_scope_review";

/** FINANCE_READY_KICKOFF=off switches the kickoff checkout off (rollback). On by default. */
export function kickoffEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.FINANCE_READY_KICKOFF ?? "on").trim().toLowerCase() !== "off";
}

/** The kickoff cart is exactly one Finance-Ready package; add-ons are all included in it. */
export function isKickoffCart(items: Array<{ offer_code: string; quantity: number }>): boolean {
  return items.length === 1 && items[0].offer_code === KICKOFF_PACKAGE_CODE && items[0].quantity === 1;
}

/** "$139.00" — the disclosure always shows cents. */
export function moneyWithCents(cents: number): string {
  return `$${(cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

/** "$997", or "$997.50" when there are cents — the form the Deal fields use. */
export function wholeDollars(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : moneyWithCents(cents);
}

/** The owner-approved disclosure, shown on the card, in the checkout summary and on Stripe. */
export function kickoffDisclosure(holdCents: number, remainingCents: number): string {
  return (
    `${moneyWithCents(holdCents)} authorized today (captured on Sunbiz submission). ` +
    `Remaining ${moneyWithCents(remainingCents)} balance is not collected until Damian reviews your build parameters with you and resets your custom scope.`
  );
}

export interface KickoffOffer {
  offer_code: string;
  offer_version: string;
  display_name: string;
  stripe_price_id: string;
  unit_amount_cents: number;
}

export interface KickoffLine {
  offer_code: string;
  offer_version: string;
  display_name: string;
  /** null on the selected-package line: it is a record, not something Stripe charges. */
  stripe_price_id: string | null;
  unit_amount_cents: number;
  quantity: number;
  role?: typeof SELECTED_PACKAGE_ROLE;
  package_price_cents?: number;
  initial_hold_cents?: number;
  remaining_balance_cents?: number;
  remaining_balance_status?: typeof PENDING_SCOPE_REVIEW;
}

export type KickoffPlan =
  | { ok: true; lines: KickoffLine[]; holdCents: number; remainingCents: number; packagePriceCents: number }
  | { ok: false; error: string };

/**
 * The order lines for a kickoff: the hold lines (charged) plus the zero-amount
 * selected-package line. Every amount comes from the resolved Offer Master rows.
 */
export function buildKickoffLines(byCode: Map<string, KickoffOffer>): KickoffPlan {
  const pkg = byCode.get(KICKOFF_PACKAGE_CODE);
  const holdOffers = KICKOFF_HOLD_CODES.map((c) => byCode.get(c));
  if (!pkg || holdOffers.some((o) => o === undefined)) {
    return { ok: false, error: "the Finance-Ready package or its base filing offers are not in the catalog" };
  }
  const holds = holdOffers as KickoffOffer[];
  const holdCents = holds.reduce((sum, o) => sum + o.unit_amount_cents, 0);
  const remainingCents = pkg.unit_amount_cents - holdCents;
  if (!(holdCents > 0) || !(remainingCents > 0)) {
    return { ok: false, error: "the Finance-Ready price does not exceed the base filing hold" };
  }
  const lines: KickoffLine[] = holds.map((o) => ({
    offer_code: o.offer_code,
    offer_version: o.offer_version,
    display_name: o.display_name,
    stripe_price_id: o.stripe_price_id,
    unit_amount_cents: o.unit_amount_cents,
    quantity: 1,
  }));
  lines.push({
    offer_code: pkg.offer_code,
    offer_version: pkg.offer_version,
    display_name: `${pkg.display_name} (${wholeDollars(pkg.unit_amount_cents)}): ${moneyWithCents(remainingCents)} balance pending scope review`,
    stripe_price_id: null,
    unit_amount_cents: 0,
    quantity: 1,
    role: SELECTED_PACKAGE_ROLE,
    package_price_cents: pkg.unit_amount_cents,
    initial_hold_cents: holdCents,
    remaining_balance_cents: remainingCents,
    remaining_balance_status: PENDING_SCOPE_REVIEW,
  });
  return { ok: true, lines, holdCents, remainingCents, packagePriceCents: pkg.unit_amount_cents };
}

/**
 * Zoho Deal fields for a kickoff order (Deals: Selected_Package, Initial_Hold,
 * Remaining_Balance — text fields created 25 Nov 2026). Empty for any other order.
 */
export function kickoffDealFields(lineItems: unknown): Record<string, string> {
  if (!Array.isArray(lineItems)) return {};
  const line = lineItems.find(
    (li): li is KickoffLine =>
      typeof li === "object" && li !== null && (li as KickoffLine).role === SELECTED_PACKAGE_ROLE && (li as KickoffLine).offer_code === KICKOFF_PACKAGE_CODE,
  );
  if (!line) return {};
  const { package_price_cents: price, initial_hold_cents: hold, remaining_balance_cents: remaining } = line;
  if (![price, hold, remaining].every((c) => Number.isInteger(c) && (c as number) > 0)) return {};
  return {
    Selected_Package: `Finance-Ready (${wholeDollars(price as number)})`,
    Initial_Hold: wholeDollars(hold as number),
    Remaining_Balance: `${wholeDollars(remaining as number)} (Pending Scope Review)`,
  };
}
