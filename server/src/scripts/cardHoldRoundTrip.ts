import "dotenv/config";
import {
  cancelPaymentIntent,
  capturePaymentIntent,
  holdDetails,
  retrievePaymentIntent,
  type StripePaymentIntent,
} from "../stripe/restClient.js";

/**
 * Card-hold round trip against Stripe TEST MODE, using this repo's own
 * client functions. Refuses to run with a live key.
 *
 *   npm run check:card-hold
 *
 * A: hold (manual capture, card saved) → read expiry → collect → collect
 *    again with the same idempotency key (must not charge twice).
 * B: hold → release (as the Day-5 job does). Nothing is charged after a
 *    release: the off-session saved-card fallback was removed on 25 Nov 2026
 *    (owner's final hold rule); the customer gets a Payment Link instead.
 */
const key = process.env.STRIPE_SECRET_KEY ?? "";
if (!key.startsWith("sk_test_")) {
  console.error("Refusing to run: STRIPE_SECRET_KEY is not a test-mode key.");
  process.exit(1);
}

async function post<T>(path: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const json = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) throw new Error(`${path}: ${json.error?.message}`);
  return json;
}

/** Stands in for what Checkout creates in hold mode (Checkout itself needs a browser). */
async function placeHold(customer: string, label: string): Promise<StripePaymentIntent> {
  return post<StripePaymentIntent>("/payment_intents", {
    amount: "49900",
    currency: "usd",
    customer,
    payment_method: "pm_card_visa",
    "payment_method_types[]": "card",
    capture_method: "manual",
    setup_future_usage: "off_session",
    confirm: "true",
    "metadata[order_id]": label,
    "metadata[purpose]": "card-hold round trip (test mode)",
  });
}

const run = Date.now().toString(36);
const result: Record<string, unknown> = { run };

const customer = await post<{ id: string }>("/customers", {
  email: `launch-test-hold-${run}@example.invalid`,
  "metadata[purpose]": "card-hold round trip (test mode)",
});
result.customer = customer.id;

// A — hold, read expiry, collect, collect again.
const a = await placeHold(customer.id, `roundtrip-A-${run}`);
const aRead = await retrievePaymentIntent(a.id);
const aHold = holdDetails(aRead);
result.A_hold_status = aRead.status;
result.A_amount_capturable = aRead.amount_capturable;
result.A_capture_before = aHold.captureBefore?.toISOString() ?? null;
result.A_hold_days = aHold.captureBefore ? ((aHold.captureBefore.getTime() - Date.now()) / 86_400_000).toFixed(2) : null;
result.A_extended = aHold.extended;
result.A_saved_card = aRead.payment_method;
const aCap1 = await capturePaymentIntent(a.id, `capture-roundtrip-A-${run}`);
const aCap2 = await capturePaymentIntent(a.id, `capture-roundtrip-A-${run}`);
result.A_after_collect = aCap1.status;
result.A_amount_received = aCap1.amount_received;
result.A_repeat_collect_same_result = aCap2.status === aCap1.status && aCap2.amount_received === aCap1.amount_received;

// B — hold, release. Nothing is charged afterwards.
const b = await placeHold(customer.id, `roundtrip-B-${run}`);
const bCancel = await cancelPaymentIntent(b.id, `release-roundtrip-B-${run}`, "abandoned");
result.B_after_release = bCancel.status;
result.payment_intents = [a.id, b.id];

console.log(JSON.stringify(result, null, 2));
