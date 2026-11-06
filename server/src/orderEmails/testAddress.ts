/**
 * A test-mode Stripe event must never email a real address. Only domains
 * reserved for testing are safe: example.com/.net/.org and the .test,
 * .example and .invalid TLDs (RFC 2606), plus Resend's own sink. A "+test"
 * tag does not count, because that still lands in a real inbox.
 */
const RESERVED = /@(?:[a-z0-9-]+\.)*(?:example\.(?:com|net|org)|resend\.dev)$|\.(?:test|example|invalid)$/i;

export function isReservedTestAddress(email: string): boolean {
  return RESERVED.test(email.trim());
}

/** Only an explicit false is test mode. Migration 0026 marks every earlier
 *  order false, and the webhook sets the column on every order after the
 *  deploy, so null lasts only as long as the runbook's window between the two.
 *  The runbook closes that window straight after the deploy. */
export function blockedByTestMode(stripeLivemode: boolean | null | undefined, email: string): boolean {
  return stripeLivemode === false && !isReservedTestAddress(email);
}

export const TEST_MODE_NOT_SENT = "test-mode order: not sent, because this is not a reserved test address";
