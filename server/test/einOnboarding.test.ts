import http from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The route module imports the shared pg Pool, which needs a URL but connects lazily.
// Every query here goes to the in-memory fake below, never to a database.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://unused.invalid/none";
});
import { signEinOnboardingToken, verifyEinOnboardingToken } from "../src/ein/onboardingToken.js";
import {
  ATTESTATION_VERSION,
  buildSs4Summary,
  einIncluded,
  einOnboardingConfig,
  onboardingOpen,
  onboardingTokenFor,
  onboardingUrlFor,
  packageFromCodes,
  successPageTokenFor,
  validateSubmission,
  type EinOnboardingConfig,
} from "../src/ein/onboarding.js";
import { createEinOnboardingRouter, einOnboardingPreParse } from "../src/routes/einOnboarding.js";
import { buildOrderEmail, type OrderEmailRow } from "../src/orderEmails/templates.js";

/**
 * ST17 EIN / Form SS-4 onboarding. Pure rules plus the route against an in-memory
 * fake database, Zoho client and alert sink: no real database, Zoho or email.
 */

const SECRET = "x".repeat(40);
const SID = "11111111-2222-4333-8444-555555555555";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2]);

describe("link token", () => {
  it("verifies for its own session until it expires", () => {
    const t = signEinOnboardingToken(SECRET, SID, 1_000, 100);
    expect(verifyEinOnboardingToken(SECRET, SID, t, 1_050)).toBe("ok");
    expect(verifyEinOnboardingToken(SECRET, SID, t, 1_101)).toBe("expired");
  });

  it("refuses another session, another secret, tampering and junk", () => {
    const t = signEinOnboardingToken(SECRET, SID, 1_000, 100);
    expect(verifyEinOnboardingToken(SECRET, "22222222-2222-4333-8444-555555555555", t, 1_050)).toBe("invalid");
    expect(verifyEinOnboardingToken("y".repeat(40), SID, t, 1_050)).toBe("invalid");
    const [exp, sig] = t.split(".");
    expect(verifyEinOnboardingToken(SECRET, SID, `${(parseInt(exp, 36) + 999).toString(36)}.${sig}`, 1_050)).toBe("invalid");
    for (const junk of [undefined, "", "abc", "a.b.c", 42, "z".repeat(300)]) {
      expect(verifyEinOnboardingToken(SECRET, SID, junk, 1_050)).toBe("invalid");
    }
    expect(verifyEinOnboardingToken("", SID, t, 1_050)).toBe("invalid");
  });

  it("contains nothing but an expiry and a MAC", () => {
    const t = signEinOnboardingToken(SECRET, SID);
    expect(t).not.toContain(SID);
    expect(t).toMatch(/^[0-9a-z]+\.[A-Za-z0-9_-]+$/);
  });
});

describe("package and eligibility (from held or paid orders)", () => {
  it("derives the package", () => {
    expect(packageFromCodes(["DIY_STATE_FEE", "DIY_SERVICE_FEE"])).toBe("DIY");
    expect(packageFromCodes(["FASTTRACK"])).toBe("BANK_READY");
    expect(packageFromCodes(["PREMIUM", "REGISTERED_AGENT_3YR"])).toBe("PREMIUM");
    expect(packageFromCodes(["EIN_FILING"])).toBeNull();
  });

  it("includes the EIN for Bank-Ready, Premium and the EIN add-on only", () => {
    expect(einIncluded(["FASTTRACK"])).toBe(true);
    expect(einIncluded(["PREMIUM"])).toBe(true);
    expect(einIncluded(["DIY_STATE_FEE", "EIN_FILING"])).toBe(true);
    expect(einIncluded(["DIY_STATE_FEE"])).toBe(false);
  });
});

describe("configuration gate", () => {
  const cfg = (env: Record<string, string>) => einOnboardingConfig(env as NodeJS.ProcessEnv);

  it("is closed unless switched on with a strong secret", () => {
    expect(onboardingOpen(cfg({}))).toBe(false);
    expect(onboardingOpen(cfg({ EIN_ONBOARDING_ENABLED: "true" }))).toBe(false);
    expect(onboardingOpen(cfg({ EIN_ONBOARDING_ENABLED: "true", EIN_ONBOARDING_TOKEN_SECRET: "short" }))).toBe(false);
    expect(onboardingOpen(cfg({ EIN_ONBOARDING_ENABLED: "true", EIN_ONBOARDING_TOKEN_SECRET: SECRET }))).toBe(true);
    expect(onboardingOpen(cfg({ EIN_ONBOARDING_ENABLED: "true", EIN_ONBOARDING_REQUIRE_TOKEN: "false" }))).toBe(true);
  });

  it("issues no token or link while closed", () => {
    expect(onboardingTokenFor(cfg({ EIN_ONBOARDING_TOKEN_SECRET: SECRET }), SID)).toBeNull();
    expect(onboardingUrlFor(cfg({ EIN_ONBOARDING_TOKEN_SECRET: SECRET, FRONTEND_BASE_URL: "https://x.test" }), SID)).toBeNull();
  });

  it("builds the magic link with the token in the fragment", () => {
    const open = cfg({ EIN_ONBOARDING_ENABLED: "true", EIN_ONBOARDING_TOKEN_SECRET: SECRET, FRONTEND_BASE_URL: "https://x.test/" });
    const url = onboardingUrlFor(open, SID)!;
    expect(url).toMatch(new RegExp(`^https://x\\.test/onboarding/ein\\?filing_session_id=${SID}#t=[0-9a-z]+\\.[A-Za-z0-9_-]+$`));
    const token = new URLSearchParams(url.split("#")[1]).get("t");
    expect(verifyEinOnboardingToken(SECRET, SID, token)).toBe("ok");
  });
});

describe("success page token (the order endpoint is public)", () => {
  const open: EinOnboardingConfig = { enabled: true, tokenSecret: SECRET, requireToken: true, einDocsReceivedField: "", frontendBaseUrl: "" };
  const now = 1_800_000_000;

  it("is issued only within two hours of the hold or charge, and expires with that window", () => {
    const t = successPageTokenFor(open, SID, new Date((now - 60 * 60) * 1000), now)!;
    expect(verifyEinOnboardingToken(SECRET, SID, t, now + 59 * 60)).toBe("ok");
    expect(verifyEinOnboardingToken(SECRET, SID, t, now + 61 * 60)).toBe("expired");
    expect(successPageTokenFor(open, SID, new Date((now - 3 * 60 * 60) * 1000), now)).toBeNull();
    expect(successPageTokenFor(open, SID, null, now)).toBeNull();
    expect(successPageTokenFor({ ...open, enabled: false }, SID, new Date(now * 1000), now)).toBeNull();
  });
});

describe("Form SS-4 summary", () => {
  it("pre-fills what we hold, with the LLC name in ALL CAPS", () => {
    const lines = buildSs4Summary(
      {
        llc_name: "Sunshine Holdings LLC",
        mailing_address: "1 Main St, Miami, FL 33101",
        principal_address: "1 Main St, Miami, FL 33101",
        effective_date_option: "Immediate",
        authorized_persons: [{ name: "A", address: "x", article_iv_title: "AMBR" }],
      },
      null,
    );
    const byLine = Object.fromEntries(lines.map((l) => [l.line, l.value]));
    expect(byLine["1"]).toBe("SUNSHINE HOLDINGS LLC");
    expect(byLine["7b"]).toMatch(/None/);
    expect(byLine["9a"]).toBe("Other: Foreign-owned U.S. disregarded entity");
    expect(byLine["8a–8c"]).toBe("Yes · 1 · Yes");
  });

  it("leaves out lines it cannot fill and falls back to the intake name", () => {
    const lines = buildSs4Summary(null, "Fallback Name LLC");
    expect(lines.find((l) => l.line === "1")?.value).toBe("FALLBACK NAME LLC");
    expect(lines.some((l) => l.line === "9a" || l.line === "4a–4b")).toBe(false);
  });
});

function body(overrides: Record<string, unknown> = {}) {
  return {
    filing_session_id: SID,
    attestation_version: ATTESTATION_VERSION,
    responsible_party: {
      full_legal_name: "Ada  Lovelace",
      title: "Member",
      citizenship_country: "United Kingdom",
      address_street: "12 St James's Square",
      address_city: "London",
      address_region: "",
      address_postal_code: "SW1Y 4LB",
      address_country: "United Kingdom",
      phone: "+44 20 7946 0000",
    },
    no_ssn_confirmed: true,
    signature: { typed_name: "ada lovelace", agreed: true },
    passport: { filename: "me.png", content_type: "image/png", data_base64: PNG.toString("base64") },
    ...overrides,
  };
}

describe("validateSubmission", () => {
  it("accepts a complete submission and drops the customer's filename", () => {
    const r = validateSubmission(body());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.responsibleParty.full_legal_name).toBe("Ada Lovelace");
      expect(r.value.passport.filename).toBe("passport-photo-page.png");
    }
  });

  it("refuses anything that looks like an SSN or ITIN", () => {
    const rp = { ...body().responsible_party, address_street: "123-45-6789" };
    expect(validateSubmission(body({ responsible_party: rp }))).toMatchObject({ ok: false, message: expect.stringMatching(/SSN/) });
  });

  it("requires the no-SSN confirmation, a matching signature and the current attestation", () => {
    expect(validateSubmission(body({ no_ssn_confirmed: false })).ok).toBe(false);
    expect(validateSubmission(body({ signature: { typed_name: "Someone Else", agreed: true } })).ok).toBe(false);
    expect(validateSubmission(body({ signature: { typed_name: "Ada Lovelace", agreed: false } })).ok).toBe(false);
    expect(validateSubmission(body({ attestation_version: "old" })).ok).toBe(false);
  });

  it("catches spaced and dotted SSNs, and the dashed shape even in phone and postal code", () => {
    for (const v of ["123 45 6789", "123.45.6789", "123456789"]) {
      const rp = { ...body().responsible_party, address_city: v };
      expect(validateSubmission(body({ responsible_party: rp })).ok).toBe(false);
    }
    for (const key of ["phone", "address_postal_code"]) {
      const rp = { ...body().responsible_party, [key]: "123-45-6789" };
      expect(validateSubmission(body({ responsible_party: rp })).ok).toBe(false);
    }
    const ok = { ...body().responsible_party, phone: "+34 612 345 678", address_postal_code: "33139-1234" };
    expect(validateSubmission(body({ responsible_party: ok })).ok).toBe(true);
    const longPostal = { ...body().responsible_party, address_postal_code: "1234567890123" };
    expect(validateSubmission(body({ responsible_party: longPostal })).ok).toBe(false);
  });

  it("checks the passport by its bytes, type and size", () => {
    expect(validateSubmission(body({ passport: { content_type: "image/jpeg", data_base64: PNG.toString("base64") } })).ok).toBe(false);
    expect(validateSubmission(body({ passport: { content_type: "image/jpeg", data_base64: JPEG.toString("base64") } })).ok).toBe(true);
    expect(validateSubmission(body({ passport: { content_type: "image/gif", data_base64: PNG.toString("base64") } })).ok).toBe(false);
    expect(validateSubmission(body({ passport: { content_type: "image/png", data_base64: "not base64!" } })).ok).toBe(false);
    const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]);
    expect(validateSubmission(body({ passport: { content_type: "image/png", data_base64: big.toString("base64") } }))).toMatchObject({
      ok: false,
      message: expect.stringMatching(/10 MB/),
    });
  });
});

// ── Route ───────────────────────────────────────────────────────────────

interface FakeState {
  session: Record<string, unknown> | null;
  codes: string[];
  deal: { crm_deal_id: string | null; order_id: string } | null;
  submissions: Map<string, Record<string, unknown>>;
  alerts: string[];
  attachOk: boolean;
  attached: number;
  marked: Array<{ field: string }>;
  config: EinOnboardingConfig;
  dealQueryCodes?: string[];
  failAfterUpload?: boolean;
}

let state: FakeState;

const fakeDb = {
  async query(sql: string, params: unknown[] = []) {
    if (sql.includes("FROM filing_sessions")) return { rows: state.session ? [state.session] : [] };
    if (sql.includes("SELECT line_items FROM orders")) return { rows: [{ line_items: state.codes.map((offer_code) => ({ offer_code })) }] };
    if (sql.includes("SELECT signed_at FROM ein_onboarding_submissions")) {
      const row = state.submissions.get(params[0] as string);
      return { rows: row ? [row] : [] };
    }
    if (sql.includes("SELECT crm_deal_id, order_id FROM orders")) {
      state.dealQueryCodes = params[1] as string[];
      return { rows: state.deal ? [state.deal] : [] };
    }
    if (sql.includes("DELETE FROM ein_onboarding_submissions")) {
      state.submissions.delete(params[0] as string);
      return { rows: [] };
    }
    if (sql.includes("INSERT INTO ein_onboarding_submissions")) {
      const id = params[0] as string;
      if (state.submissions.has(id)) return { rows: [] };
      const row = { signed_at: new Date("2026-11-25T10:00:00Z"), params };
      state.submissions.set(id, row);
      return { rows: [row] };
    }
    if (sql.includes("SET zoho_attachment_id")) {
      if (state.failAfterUpload) throw new Error("db went away");
      Object.assign(state.submissions.get(params[0] as string) ?? {}, { zoho_attachment_id: params[1] });
      return { rows: [] };
    }
    if (sql.includes("UPDATE ein_onboarding_submissions")) {
      Object.assign(state.submissions.get(params[0] as string) ?? {}, { crm_status: params[1], crm_error: params[2] });
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  },
} as never;

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use("/api/onboarding/ein", einOnboardingPreParse(() => state.config), express.json({ limit: "15mb" }));
  app.use(
    createEinOnboardingRouter({
      db: fakeDb,
      docs: {
        async attachToDeal() {
          state.attached += 1;
          return state.attachOk ? { ok: true, attachmentId: "att-1" } : { ok: false, error: "zoho down" };
        },
        async markDocsReceived(_deal, field) {
          state.marked.push({ field });
          return { ok: true, via: field ? "field" : "note" };
        },
      },
      alert: async (subject, text) => {
        state.alerts.push(`${subject} | ${text}`);
      },
      config: () => state.config,
    }),
  );
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("failed to bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(() => {
  state = {
    session: { filing_data: { llc_name: "Sunshine Holdings LLC" }, entity_name_primary: null, full_name: "Ada Lovelace", country: "United Kingdom" },
    codes: ["FASTTRACK"],
    deal: { crm_deal_id: "deal-9", order_id: "99999999-2222-4333-8444-555555555555" },
    submissions: new Map(),
    alerts: [],
    attachOk: true,
    attached: 0,
    marked: [],
    config: { enabled: true, tokenSecret: SECRET, requireToken: true, einDocsReceivedField: "", frontendBaseUrl: "https://x.test" },
  };
});

const token = () => signEinOnboardingToken(SECRET, SID);
const get = (qs: string) => fetch(`${baseUrl}/api/onboarding/ein?${qs}`);
const post = (b: unknown) =>
  fetch(`${baseUrl}/api/onboarding/ein`, { method: "POST", headers: { "Content-Type": "application/json", "true-client-ip": "203.0.113.7" }, body: JSON.stringify(b) });

describe("GET /api/onboarding/ein", () => {
  it("is closed (503 not_open) until the owner switches it on", async () => {
    state.config.enabled = false;
    const res = await get(`filing_session_id=${SID}&t=${token()}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not_open" });
  });

  it("needs a valid token for this session", async () => {
    expect((await get(`filing_session_id=${SID}`)).status).toBe(403);
    expect(await (await get(`filing_session_id=${SID}&t=bad.token`)).json()).toEqual({ error: "invalid_token" });
  });

  it("returns not_found for malformed or unknown sessions, not_eligible without an EIN", async () => {
    expect((await get(`filing_session_id=nope&t=x`)).status).toBe(404);
    state.session = null;
    expect(await (await get(`filing_session_id=${SID}&t=${token()}`)).json()).toEqual({ error: "not_found" });
    state.session = { filing_data: null, entity_name_primary: "X", full_name: null, country: null };
    state.codes = ["DIY_STATE_FEE"];
    expect(await (await get(`filing_session_id=${SID}&t=${token()}`)).json()).toEqual({ error: "not_eligible" });
  });

  it("returns the pre-filled form with the ALL-CAPS name and the attestation", async () => {
    const res = await get(`filing_session_id=${SID}&t=${token()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const json = (await res.json()) as { attestation: { version: string; text: string }; ss4_summary: unknown[] };
    expect(json).toMatchObject({ status: "open", llc_name: "SUNSHINE HOLDINGS LLC", prefill: { full_legal_name: "Ada Lovelace" } });
    expect(json.attestation.version).toBe(ATTESTATION_VERSION);
    expect(json.attestation.text).toContain("SUNSHINE HOLDINGS LLC");
    expect(json.ss4_summary[0]).toEqual({ line: "1", label: "Legal name of entity", value: "SUNSHINE HOLDINGS LLC" });
  });
});

describe("POST /api/onboarding/ein/load (token in the body, out of request logs)", () => {
  it("returns the same form as the GET", async () => {
    const res = await fetch(`${baseUrl}/api/onboarding/ein/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filing_session_id: SID, t: token() }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "open", llc_name: "SUNSHINE HOLDINGS LLC" });
  });
});

describe("POST /api/onboarding/ein", () => {
  it("attaches the passport, records the signature with server time and IP, marks the Deal and alerts the team", async () => {
    const res = await post(body({ t: token() }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "submitted", submitted_at: "2026-11-25T10:00:00.000Z" });
    expect(state.attached).toBe(1);
    const saved = state.submissions.get(SID) as { params: unknown[]; crm_status: string };
    expect(saved.params[6]).toBe("deal-9"); // the verified order's Deal
    expect(saved.params[7]).toBe("ada lovelace"); // the signature exactly as typed
    expect(saved.params[9]).toMatch(/^[0-9a-f]{64}$/); // attestation hash
    expect(saved.params[10]).toBe("203.0.113.7"); // signer IP, as seen by the server
    expect(JSON.stringify(saved.params)).not.toContain(PNG.toString("base64")); // image never stored
    expect(saved.crm_status).toBe("done_note");
    expect(state.dealQueryCodes).toEqual(expect.arrayContaining(["FASTTRACK", "PREMIUM", "EIN_FILING"]));
    expect(state.marked).toEqual([{ field: "" }]);
    expect(state.alerts.at(-1)).toMatch(/^EIN details received — SUNSHINE HOLDINGS LLC/);
    expect(state.alerts.at(-1)).not.toMatch(/Ada|London/);
  });

  it("writes the EIN Docs Received field once its API name is configured", async () => {
    state.config.einDocsReceivedField = "EIN_Docs_Received";
    await post(body({ t: token() }));
    expect(state.marked).toEqual([{ field: "EIN_Docs_Received" }]);
  });

  it("refuses a second submission without uploading again", async () => {
    await post(body({ t: token() }));
    const res = await post(body({ t: token() }));
    expect(res.status).toBe(409);
    expect(state.attached).toBe(1);
  });

  it("still confirms to the customer when a step after the upload fails, and tells the team", async () => {
    state.failAfterUpload = true;
    const res = await post(body({ t: token() }));
    expect(res.status).toBe(200);
    expect(state.attached).toBe(1);
    expect(state.alerts.at(-1)).toMatch(/follow-up failed/);
  });

  it("uploads once when two submits race", async () => {
    const [a, b] = await Promise.all([post(body({ t: token() })), post(body({ t: token() }))]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(state.attached).toBe(1);
  });

  it("stores nothing when the Zoho upload fails, and tells the team", async () => {
    state.attachOk = false;
    const res = await post(body({ t: token() }));
    expect(res.status).toBe(502);
    expect(state.submissions.size).toBe(0);
    expect(state.alerts.at(-1)).toMatch(/upload failed/);
  });

  it("waits for the verified Deal instead of using a client-supplied one", async () => {
    state.deal = { crm_deal_id: null, order_id: "x" };
    expect((await post(body({ t: token() }))).status).toBe(503);
    state.deal = null;
    const res = await post(body({ t: token() }));
    expect(res.status).toBe(503);
    expect(state.attached).toBe(0);
  });

  it("validates before touching Zoho", async () => {
    const res = await post(body({ t: token(), no_ssn_confirmed: false }));
    expect(res.status).toBe(422);
    expect(state.attached).toBe(0);
  });

  it("refuses a closed form or an oversized body before reading it", async () => {
    state.config.enabled = false;
    expect(await (await post(body({ t: token() }))).json()).toEqual({ error: "not_open" });
    state.config.enabled = true;
    const res = await fetch(`${baseUrl}/api/onboarding/ein`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(16 * 1024 * 1024) },
      body: "{}",
    }).catch(() => null);
    // Either the gate answers 413 or the client aborts the mismatched body; nothing is stored.
    if (res) expect(res.status).toBe(413);
    expect(state.submissions.size).toBe(0);
  });

  it("is closed and token-gated on POST too", async () => {
    expect((await post(body())).status).toBe(403);
    state.config.enabled = false;
    expect((await post(body({ t: token() }))).status).toBe(503);
  });
});

describe("order confirmation magic link", () => {
  const row: OrderEmailRow = {
    order_id: "ord-1",
    line_items: [{ offer_code: "FASTTRACK", display_name: "Bank-Ready", unit_amount_cents: 49900, quantity: 1 }],
    total_cents: 49900,
    proof_of_filing_ref: null,
    email: "customer@example.test",
    full_name: "Ada Lovelace",
    phone: null,
    country: null,
    entity_name_primary: "Sunshine Holdings LLC",
    entity_name_backup: null,
    filing_data: { llc_name: "Sunshine Holdings LLC" },
    registered_agent_status: null,
  };

  it("adds the EIN step with the link when one is given", () => {
    const url = `https://x.test/onboarding/ein?filing_session_id=${SID}#t=abc.def`;
    const email = buildOrderEmail("order_confirmation", { ...row, ein_onboarding_url: url }, "hold");
    expect(email.text).toContain("Next Step: Your EIN");
    expect(email.text).toContain(url);
    expect(email.html).toContain(url);
  });

  it("leaves it out otherwise", () => {
    const email = buildOrderEmail("order_confirmation", row, "hold");
    expect(email.text).not.toContain("/onboarding/ein");
  });
});
