import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyStripeSignature, WebhookSignatureError } from "../src/stripe/webhookSignature.js";

/**
 * Proves the hand-rolled signature verification (server/src/stripe/webhookSignature.ts)
 * against Stripe's own documented scheme, independent of any real Stripe
 * webhook delivery — this project deliberately doesn't use the `stripe`
 * npm SDK (see DECISIONS.md), so this file is the only thing proving the
 * hand-rolled implementation is actually correct rather than just
 * asserted to be.
 */

const SECRET = "whsec_test_secret_1234567890";

function signPayload(payload: string, secret: string, timestamp: number): string {
  const signedPayload = `${timestamp}.${payload}`;
  const signature = createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

describe("verifyStripeSignature", () => {
  it("accepts a correctly signed, fresh payload", () => {
    const payload = JSON.stringify({ id: "evt_123", type: "checkout.session.completed" });
    const header = signPayload(payload, SECRET, Math.floor(Date.now() / 1000));
    expect(() => verifyStripeSignature(Buffer.from(payload), header, SECRET)).not.toThrow();
  });

  it("rejects a tampered payload (signature no longer matches)", () => {
    const payload = JSON.stringify({ id: "evt_123", amount: 100 });
    const header = signPayload(payload, SECRET, Math.floor(Date.now() / 1000));
    const tampered = JSON.stringify({ id: "evt_123", amount: 999999 });
    expect(() => verifyStripeSignature(Buffer.from(tampered), header, SECRET)).toThrow(WebhookSignatureError);
  });

  it("rejects a payload signed with the wrong secret", () => {
    const payload = JSON.stringify({ id: "evt_123" });
    const header = signPayload(payload, "whsec_wrong_secret", Math.floor(Date.now() / 1000));
    expect(() => verifyStripeSignature(Buffer.from(payload), header, SECRET)).toThrow(WebhookSignatureError);
  });

  it("rejects a stale timestamp outside tolerance (replay protection)", () => {
    const payload = JSON.stringify({ id: "evt_123" });
    const staleTimestamp = Math.floor(Date.now() / 1000) - 3600; // 1 hour old
    const header = signPayload(payload, SECRET, staleTimestamp);
    expect(() => verifyStripeSignature(Buffer.from(payload), header, SECRET)).toThrow(WebhookSignatureError);
  });

  it("rejects a missing signature header", () => {
    const payload = JSON.stringify({ id: "evt_123" });
    expect(() => verifyStripeSignature(Buffer.from(payload), undefined, SECRET)).toThrow(WebhookSignatureError);
  });

  it("rejects a malformed signature header", () => {
    const payload = JSON.stringify({ id: "evt_123" });
    expect(() => verifyStripeSignature(Buffer.from(payload), "not-a-real-header", SECRET)).toThrow(WebhookSignatureError);
  });

  it("accepts when at least one of multiple v1 signatures matches (key rotation)", () => {
    const payload = JSON.stringify({ id: "evt_123" });
    const timestamp = Math.floor(Date.now() / 1000);
    const validSig = signPayload(payload, SECRET, timestamp).split(",")[1];
    const header = `t=${timestamp},v1=deadbeef00000000000000000000000000000000000000000000000000000000,${validSig}`;
    expect(() => verifyStripeSignature(Buffer.from(payload), header, SECRET)).not.toThrow();
  });
});
