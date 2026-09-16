import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/**
 * Node's built-in crypto only — no new dependency. This project has no
 * existing token/auth utility to reuse (only `randomUUID` in session.ts,
 * which mints non-secret row ids, not bearer secrets); this is the first.
 */

export interface AcceptanceToken {
  /** The secret. Goes in the emailed link. Never persisted anywhere. */
  raw: string;
  /** sha256(raw), hex-encoded. This is what acceptance_token_id stores —
   *  see migration 0005's comment for why a hash, not the raw value. */
  tokenId: string;
}

export function generateAcceptanceToken(): AcceptanceToken {
  const raw = randomBytes(32).toString("base64url");
  return { raw, tokenId: hashToken(raw) };
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Constant-time comparison of two token-id hex strings, so a lookup
 *  failure can't be timed to leak how much of a guessed token matched. */
export function tokenIdsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
