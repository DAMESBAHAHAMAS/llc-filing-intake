import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed, expiring link token for /onboarding/ein (ST17). It is bound to one
 * filing session and one purpose, so a filing_session_id seen in a Stripe URL,
 * browser history or analytics is not on its own enough to read or submit
 * identity documents.
 *
 * Format: `<expiry, unix seconds, base36>.<base64url HMAC-SHA256>`, where the
 * MAC covers "ein-onboarding:v1:<filing_session_id>:<expiry>". Nothing personal
 * is inside it.
 */
const PURPOSE = "ein-onboarding:v1";
export const EIN_TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60;

function mac(secret: string, filingSessionId: string, expiry: number): string {
  return createHmac("sha256", secret).update(`${PURPOSE}:${filingSessionId}:${expiry}`).digest("base64url");
}

export function signEinOnboardingToken(
  secret: string,
  filingSessionId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  ttlSeconds = EIN_TOKEN_TTL_SECONDS,
): string {
  if (!secret) throw new Error("EIN onboarding token secret is not set");
  const expiry = nowSeconds + ttlSeconds;
  return `${expiry.toString(36)}.${mac(secret, filingSessionId, expiry)}`;
}

export type TokenCheck = "ok" | "invalid" | "expired";

export function verifyEinOnboardingToken(
  secret: string,
  filingSessionId: string,
  token: unknown,
  nowSeconds = Math.floor(Date.now() / 1000),
): TokenCheck {
  if (!secret || typeof token !== "string" || token.length > 200) return "invalid";
  const [expPart, sig, extra] = token.split(".");
  if (!expPart || !sig || extra !== undefined || !/^[0-9a-z]+$/.test(expPart)) return "invalid";
  const expiry = parseInt(expPart, 36);
  if (!Number.isSafeInteger(expiry)) return "invalid";
  const expected = Buffer.from(mac(secret, filingSessionId, expiry));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return "invalid";
  return expiry < nowSeconds ? "expired" : "ok";
}
