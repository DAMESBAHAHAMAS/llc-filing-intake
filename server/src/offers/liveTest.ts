/**
 * One controlled live payment that can never become a Florida filing.
 *
 * A test order uses the real hold and the real capture, so it proves the
 * money path. It is not a filing, and that is enforced in four places:
 * needsSunbizFiling refuses it, the fulfillment worker will not claim it,
 * the database refuses any fulfillment state on it (migration 0025), and
 * the Sunbiz routes refuse an order with no filing in it. It also opens no
 * Zoho Deal and queues no customer email.
 */
export const LIVE_TEST_OFFER_CODE = "LIVE_TEST_NO_FILING";

export function isLiveTestOrder(lineItems: Array<{ offer_code?: string }> | null | undefined): boolean {
  return (lineItems ?? []).some((li) => li.offer_code === LIVE_TEST_OFFER_CODE);
}

/** Off unless both are set. Remove both after the test. */
export function liveTestEmail(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.LIVE_TEST_ENABLED !== "true") return null;
  const email = env.LIVE_TEST_EMAIL?.trim();
  return email ? email : null;
}
