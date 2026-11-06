/**
 * The check before the live test: does the row the test will use point at the
 * real $139 live Price? Reads DIY_PACKAGE whatever its status, because it is
 * still a draft at this point, and never reads another offer. verify:prices
 * is the full check, for after go-live.
 *
 * Read-only against both the database and Stripe. Exit code 1 on any problem.
 *   npm run verify:live-price
 */
import "dotenv/config";
import { pool } from "../db/pool.js";
import { DIY_PACKAGE_OFFER_CODE, livePriceProblems } from "../offers/diyPackage.js";
import { retrievePrice } from "../stripe/restClient.js";

async function main() {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  console.log(`Stripe key class: ${/^(sk|rk)_live_/.test(key) ? "live" : /^(sk|rk)_test_/.test(key) ? "test" : "unknown"}`);
  const { rows } = await pool.query<{ stripe_price_id: string; unit_amount_cents: number; status: string }>(
    `SELECT stripe_price_id, unit_amount_cents, status FROM offers WHERE offer_code = $1 AND status IN ('draft', 'active') ORDER BY created_at DESC LIMIT 1`,
    [DIY_PACKAGE_OFFER_CODE]
  );
  await pool.end();
  if (!rows.length) throw new Error("no DIY_PACKAGE offer; apply migration 0020");
  const price = await retrievePrice(rows[0].stripe_price_id);
  const problems = livePriceProblems(price);
  if (rows[0].unit_amount_cents !== price.unit_amount) problems.push("the offer row and the Price disagree");
  for (const problem of problems) console.error(`FAIL ${problem}`);
  if (problems.length) process.exitCode = 1;
  else console.log(`OK DIY_PACKAGE (${rows[0].status}): live, active, $139.00 USD, ${price.id}`);
}

main().catch((err) => {
  console.error("verify:live-price failed to run:", err);
  process.exitCode = 1;
});
