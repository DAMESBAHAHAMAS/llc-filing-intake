/**
 * Price parity: every ACTIVE offer's displayed amount (offers.unit_amount_cents,
 * what GET /api/offers shows the storefront) must equal the amount Stripe will
 * actually charge for its stripe_price_id, and that price must be active.
 * Also checks the package totals against the decision record (DECISIONS.md,
 * 2026-09-17 "Package pricing").
 *
 * Read-only against both the database and Stripe. Exit code 1 on any mismatch.
 * Run after any offers migration or Stripe price change:
 *   npm run verify:prices
 */
import "dotenv/config";
import { pool } from "../db/pool.js";
import { retrievePrice } from "../stripe/restClient.js";

/** Totals from the decision record, in cents. Change only with a DECISIONS.md entry. */
export const DECIDED_TOTALS_CENTS = {
  DIY: 13_900,
  FASTTRACK: 49_900,
  PREMIUM: 99_900,
  REGISTERED_AGENT_3YR: 9_800,
  EIN_FILING: 29_900,
  CREDENTIALS_KIT: 8_900,
} as const;

const DIY_COMPONENTS = ["DIY_STATE_FEE", "DIY_SERVICE_FEE", "DIY_CERT_OF_STATUS"];

async function main() {
  const { rows } = await pool.query<{ offer_code: string; offer_version: string; stripe_price_id: string; unit_amount_cents: number }>(
    "SELECT offer_code, offer_version, stripe_price_id, unit_amount_cents FROM offers WHERE status = 'active' ORDER BY offer_code",
  );
  const failures: string[] = [];
  const amounts = new Map<string, number>();

  for (const row of rows) {
    const price = await retrievePrice(row.stripe_price_id);
    const charged = price.unit_amount ?? -1;
    const ok = price.active && charged === row.unit_amount_cents;
    console.log(`${ok ? "OK  " : "FAIL"} ${row.offer_code} ${row.offer_version}: displayed ${row.unit_amount_cents}, Stripe ${charged}${price.active ? "" : " (INACTIVE price)"}`);
    if (!ok) failures.push(row.offer_code);
    amounts.set(row.offer_code, row.unit_amount_cents);
  }

  const diy = DIY_COMPONENTS.reduce((sum, code) => sum + (amounts.get(code) ?? NaN), 0);
  const totals: Record<string, number> = { DIY: diy };
  for (const code of Object.keys(DECIDED_TOTALS_CENTS)) if (code !== "DIY") totals[code] = amounts.get(code) ?? NaN;
  for (const [code, decided] of Object.entries(DECIDED_TOTALS_CENTS)) {
    const ok = totals[code] === decided;
    console.log(`${ok ? "OK  " : "FAIL"} decision ${code}: expected ${decided}, catalog ${totals[code]}`);
    if (!ok) failures.push(`decision:${code}`);
  }

  await pool.end();
  if (failures.length) {
    console.error(`Price parity FAILED: ${failures.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("Price parity OK: displayed = catalog = Stripe for every active offer.");
  }
}

main().catch((err) => {
  console.error("verify:prices failed to run:", err);
  process.exitCode = 1;
});
