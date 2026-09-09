import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Hand-rolled implementation of Stripe's documented webhook signature
 * scheme (Stripe-Signature header: "t=<timestamp>,v1=<sig>[,v1=<sig>...]").
 * Verifies against the RAW request body — this MUST be the exact bytes
 * Stripe sent, before any JSON parsing (standing frozen rule: raw-body
 * middleware only on the webhook route, JSON everywhere else).
 *
 * No new dependency — see stripe/restClient.ts for why this project
 * isn't using the `stripe` npm package.
 */
export class WebhookSignatureError extends Error {}

const DEFAULT_TOLERANCE_SECONDS = 300;

export function verifyStripeSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  webhookSecret: string,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS
): void {
  if (!signatureHeader) {
    throw new WebhookSignatureError("Missing Stripe-Signature header");
  }

  const parts = signatureHeader.split(",").reduce<Record<string, string[]>>((acc, part) => {
    const [key, value] = part.split("=");
    if (!key || value === undefined) return acc;
    (acc[key] ??= []).push(value);
    return acc;
  }, {});

  const timestamp = parts.t?.[0];
  const v1Signatures = parts.v1 ?? [];
  if (!timestamp || v1Signatures.length === 0) {
    throw new WebhookSignatureError("Malformed Stripe-Signature header");
  }

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > toleranceSeconds) {
    throw new WebhookSignatureError("Stripe-Signature timestamp outside tolerance (possible replay)");
  }

  const signedPayload = `${timestamp}.${rawBody.toString("utf8")}`;
  const expected = createHmac("sha256", webhookSecret).update(signedPayload, "utf8").digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");

  const matches = v1Signatures.some((sig) => {
    const sigBuf = Buffer.from(sig, "hex");
    return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
  });

  if (!matches) {
    throw new WebhookSignatureError("Stripe-Signature verification failed");
  }
}
