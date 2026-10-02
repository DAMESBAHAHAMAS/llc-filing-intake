import { afterEach, describe, expect, it, vi } from "vitest";
import { orderAlertTitle, sendOpsAlert } from "../src/ops/alerts.js";

const env = { ...process.env };
const originalFetch = global.fetch;
afterEach(() => {
  process.env = { ...env };
  global.fetch = originalFetch;
});

describe("orderAlertTitle", () => {
  it("alerts on new orders and money events", () => {
    expect(orderAlertTitle("held_deal_enqueued")).toMatch(/New order/);
    expect(orderAlertTitle("paid_deal_enqueued")).toMatch(/New order/);
    expect(orderAlertTitle("collected_deal_update_enqueued")).toMatch(/collected/);
    expect(orderAlertTitle("hold_released")).toMatch(/released/);
    expect(orderAlertTitle("refunded")).toMatch(/refunded/);
  });
  it("stays quiet on routine outcomes", () => {
    expect(orderAlertTitle("ignored_event_type")).toBeNull();
    expect(orderAlertTitle("abandoned_cart_enqueued")).toBeNull();
  });
});

describe("sendOpsAlert", () => {
  it("posts to the Cliq webhook when configured", async () => {
    process.env.CLIQ_WEBHOOK_URL = "https://cliq.example/webhook";
    const calls: Array<{ url: string; body: string }> = [];
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body) });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await sendOpsAlert("New order", "Order 1");
    expect(r).toEqual({ channel: "cliq", ok: true });
    expect(calls[0].url).toBe("https://cliq.example/webhook");
    expect(JSON.parse(calls[0].body).text).toContain("New order");
  });
  it("reports a Cliq failure instead of throwing", async () => {
    process.env.CLIQ_WEBHOOK_URL = "https://cliq.example/webhook";
    global.fetch = vi.fn(async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sendOpsAlert("x", "y")).toEqual({ channel: "cliq", ok: false, error: "HTTP 401" });
    spy.mockRestore();
  });
  it("falls back to the logs when nothing is configured", async () => {
    delete process.env.CLIQ_WEBHOOK_URL;
    delete process.env.RESEND_API_KEY;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sendOpsAlert("Payment could not be collected", "Order 1")).toEqual({ channel: "log", ok: true });
    expect(spy.mock.calls[0][0]).toContain("[OPS ALERT] Payment could not be collected");
    spy.mockRestore();
  });
});
