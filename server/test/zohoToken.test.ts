import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getZohoAccessToken, invalidateZohoAccessToken, resetZohoTokenCache } from "../src/zoho/client.js";

/**
 * The shared Zoho access token is cached: Zoho limits how often the refresh token may
 * mint access tokens (~10 per 10 min), and the CRM sync, scorecard and EIN portal jobs
 * all share it.
 */
describe("getZohoAccessToken cache", () => {
  let mints = 0;
  let expiresIn: unknown = 3600;
  let fail = false;
  const signals: Array<AbortSignal | undefined> = [];

  beforeEach(() => {
    mints = 0;
    expiresIn = 3600;
    fail = false;
    signals.length = 0;
    resetZohoTokenCache();
    vi.stubEnv("ZOHO_CLIENT_ID", "id");
    vi.stubEnv("ZOHO_CLIENT_SECRET", "secret");
    vi.stubEnv("ZOHO_REFRESH_TOKEN", "refresh");
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      mints++;
      signals.push(init?.signal ?? undefined);
      await new Promise((r) => setTimeout(r, 1));
      if (fail) return new Response(JSON.stringify({ error: "Access Denied" }), { status: 400 });
      return new Response(JSON.stringify({ access_token: `tok-${mints}`, expires_in: expiresIn }), { status: 200 });
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetZohoTokenCache();
  });

  it("mints once and reuses the token until a minute before it expires, with a timeout on the refresh", async () => {
    let now = 1_000_000;
    const clock = () => now;
    expect(await getZohoAccessToken(clock)).toBe("tok-1");
    now += 58 * 60_000;
    expect(await getZohoAccessToken(clock)).toBe("tok-1");
    now += 60_000;
    expect(await getZohoAccessToken(clock)).toBe("tok-2");
    expect(mints).toBe(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("shares one refresh between concurrent callers", async () => {
    const tokens = await Promise.all(Array.from({ length: 20 }, () => getZohoAccessToken()));
    expect(new Set(tokens)).toEqual(new Set(["tok-1"]));
    expect(mints).toBe(1);
  });

  it("a 401 drops only the token that failed, at most once per two minutes", async () => {
    const t1 = await getZohoAccessToken();
    invalidateZohoAccessToken("some-older-token", 0);
    expect(await getZohoAccessToken()).toBe(t1);
    invalidateZohoAccessToken(t1, 0);
    const t2 = await getZohoAccessToken();
    expect(t2).toBe("tok-2");
    // A burst of 401s right after cannot force another refresh...
    for (let i = 0; i < 25; i++) invalidateZohoAccessToken(t2, 1_000 + i);
    expect(await getZohoAccessToken()).toBe("tok-2");
    // ...until the cooldown has passed.
    invalidateZohoAccessToken(t2, 2 * 60_000 + 1);
    expect(await getZohoAccessToken()).toBe("tok-3");
    expect(mints).toBe(3);
  });

  it("mints again when the credentials change", async () => {
    await getZohoAccessToken();
    vi.stubEnv("ZOHO_REFRESH_TOKEN", "another");
    expect(await getZohoAccessToken()).toBe("tok-2");
  });

  it("never caches past an hour (expires_in in milliseconds) and uses 50 minutes without expires_in", async () => {
    expiresIn = 3_600_000;
    let now = 0;
    await getZohoAccessToken(() => now);
    now = 59 * 60_000;
    await getZohoAccessToken(() => now);
    expect(mints).toBe(2);

    resetZohoTokenCache();
    mints = 0;
    expiresIn = undefined;
    now = 0;
    await getZohoAccessToken(() => now);
    now = 48 * 60_000;
    await getZohoAccessToken(() => now);
    expect(mints).toBe(1);
    now = 50 * 60_000;
    await getZohoAccessToken(() => now);
    expect(mints).toBe(2);
  });

  it("remembers a failed refresh for a minute instead of hammering Zoho", async () => {
    fail = true;
    let now = 0;
    await expect(getZohoAccessToken(() => now)).rejects.toThrow(/token refresh failed/);
    await expect(getZohoAccessToken(() => now)).rejects.toThrow(/token refresh failed/);
    expect(mints).toBe(1);
    fail = false;
    now = 61_000;
    expect(await getZohoAccessToken(() => now)).toBe("tok-2");
  });
});
