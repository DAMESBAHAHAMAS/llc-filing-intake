import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getZohoAccessToken, invalidateZohoAccessToken } from "../src/zoho/client.js";

/**
 * The shared Zoho access token is cached: Zoho limits how often the refresh token may
 * mint access tokens, and the CRM sync, scorecard and EIN portal jobs all share it.
 */
describe("getZohoAccessToken cache", () => {
  let mints = 0;
  let expiresIn: unknown = 3600;
  const signals: Array<AbortSignal | undefined> = [];

  beforeEach(() => {
    mints = 0;
    expiresIn = 3600;
    signals.length = 0;
    invalidateZohoAccessToken();
    vi.stubEnv("ZOHO_CLIENT_ID", "id");
    vi.stubEnv("ZOHO_CLIENT_SECRET", "secret");
    vi.stubEnv("ZOHO_REFRESH_TOKEN", "refresh");
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      mints++;
      signals.push(init?.signal ?? undefined);
      await new Promise((r) => setTimeout(r, 1));
      return new Response(JSON.stringify({ access_token: `tok-${mints}`, expires_in: expiresIn }), { status: 200 });
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    invalidateZohoAccessToken();
  });

  it("mints once and reuses the token until a minute before it expires", async () => {
    let now = 1_000_000;
    const clock = () => now;
    expect(await getZohoAccessToken(clock)).toBe("tok-1");
    now += 58 * 60_000;
    expect(await getZohoAccessToken(clock)).toBe("tok-1");
    now += 60_000; // 59 min: within the last minute of a 60-min token
    expect(await getZohoAccessToken(clock)).toBe("tok-2");
    expect(mints).toBe(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("shares one refresh between concurrent callers", async () => {
    const tokens = await Promise.all(Array.from({ length: 20 }, () => getZohoAccessToken()));
    expect(new Set(tokens)).toEqual(new Set(["tok-1"]));
    expect(mints).toBe(1);
  });

  it("mints again after invalidation (a 401) or when the credentials change", async () => {
    await getZohoAccessToken();
    invalidateZohoAccessToken();
    expect(await getZohoAccessToken()).toBe("tok-2");
    vi.stubEnv("ZOHO_REFRESH_TOKEN", "another");
    expect(await getZohoAccessToken()).toBe("tok-3");
    expect(mints).toBe(3);
  });

  it("caches for 50 minutes when Zoho sends no expires_in, and does not cache a failure", async () => {
    expiresIn = undefined;
    let now = 0;
    await getZohoAccessToken(() => now);
    now = 48 * 60_000;
    await getZohoAccessToken(() => now);
    expect(mints).toBe(1);
    now = 50 * 60_000;
    await getZohoAccessToken(() => now);
    expect(mints).toBe(2);

    invalidateZohoAccessToken();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "invalid_code" }), { status: 200 }));
    await expect(getZohoAccessToken()).rejects.toThrow(/token refresh failed/);
    await expect(getZohoAccessToken()).rejects.toThrow(/token refresh failed/);
  });
});
