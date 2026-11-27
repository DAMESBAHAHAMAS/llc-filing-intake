import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { newDb } from "pg-mem";
import { describe, expect, it, vi } from "vitest";
import {
  generateForOrder,
  loadSunbizFilingDate,
  OA_STATUS,
  oaDealField,
  packageIncludesOperatingAgreement,
  runOperatingAgreementJobOnce,
  type OaDeps,
} from "../src/formation/operatingAgreementJob.js";
import { buildBankingResolutionContext, BANKING_RESOLUTION_WORDING_VERSION } from "../src/pdf/bankingResolutionContext.js";
import { fileURLToPath } from "node:url";

const S1 = "11111111-1111-4111-8111-111111111111"; // Bank-Ready, single member
const S2 = "22222222-2222-4222-8222-222222222222"; // File It, asked for an OA at Article VI
const S3 = "33333333-3333-4333-8333-333333333333"; // Finance-Ready kickoff, manager-managed
const O1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const O2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const O3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";

const base = {
  principal_address: "100 S Biscayne Blvd, Suite 300, Miami, FL, 33131",
  mailing_address: "100 S Biscayne Blvd, Suite 300, Miami, FL, 33131",
  registered_agent_path: "house",
  effective_date_option: "Immediate",
};
const sm = { ...base, llc_name: "Test Dispatch Ten SM llc", authorized_persons: [{ article_iv_title: "AR", name: "Jordan Test Rivera", address: base.principal_address }], operating_agreement_requested: true,
  management_structure: "Member-Managed", member_count: "Single" };
const fileIt = { ...sm, llc_name: "TEST DISPATCH TEN FILE IT LLC" };
const mgr = { ...base, llc_name: "TEST DISPATCH TEN MGR LLC", authorized_persons: [{ article_iv_title: "MGR", name: "Casey Test Morgan", address: base.principal_address }] };

function migration(file: string): string {
  return readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8")
    .replace(/^--.*$/gm, "")
    .replace(/ALTER TABLE \w+ ENABLE ROW LEVEL SECURITY;/g, "");
}

async function setup(env: NodeJS.ProcessEnv = {}) {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  await pool.query(`
    CREATE TABLE filing_sessions (filing_session_id uuid PRIMARY KEY, filing_data jsonb);
    CREATE TABLE orders (order_id uuid PRIMARY KEY, filing_session_id uuid NOT NULL, line_items jsonb NOT NULL,
      payment_status text NOT NULL, paid_at timestamptz, authorized_at timestamptz, crm_deal_id text,
      proof_of_filing_ref text, proof_of_filing_at timestamptz, sunbiz_filing_date date);
    CREATE TABLE crm_sync_queue (id bigserial PRIMARY KEY, filing_session_id uuid NOT NULL, order_id uuid, sync_type text NOT NULL,
      payload_snapshot jsonb NOT NULL, status text NOT NULL DEFAULT 'pending');
  `);
  await pool.query(migration("0034_formation_documents.sql"));
  await pool.query(migration("0036_formation_followups.sql"));
  for (const [s, fd] of [[S1, sm], [S2, fileIt], [S3, mgr]] as const) {
    await pool.query(`INSERT INTO filing_sessions VALUES ($1, $2)`, [s, JSON.stringify(fd)]);
  }
  const li = (c: string) => JSON.stringify([{ offer_code: c }]);
  await pool.query(`INSERT INTO orders VALUES
    ($1, $4, $7, 'authorized', NULL, '2026-11-25T10:00:00Z', 'deal-1', NULL, NULL, NULL),
    ($2, $5, $8, 'paid', '2026-11-25T11:00:00Z', NULL, 'deal-2', NULL, NULL, NULL),
    ($3, $6, $9, 'authorized', NULL, '2026-11-25T12:00:00Z', 'deal-3', NULL, NULL, NULL)`,
    [O1, O2, O3, S1, S2, S3, li("FASTTRACK"), li("DIY_STATE_FEE"), li("PREMIUM")]);
  for (const o of [O1, O2, O3]) {
    await pool.query(`INSERT INTO crm_sync_queue (filing_session_id, order_id, sync_type, payload_snapshot, status) SELECT filing_session_id, order_id, 'order_deal', '{}'::jsonb, 'synced' FROM orders WHERE order_id = $1`, [o]);
  }
  const updates: Array<[string, Record<string, unknown>]> = [];
  const alerts: string[] = [];
  const pdf = (tag: string) => {
    const pdfBytes = Buffer.from(`%PDF-${tag}`);
    return { ok: true as const, pdfBytes, sha256: createHash("sha256").update(pdfBytes).digest("hex") };
  };
  const deps: OaDeps = {
    db: pool as never,
    zoho: { updateDeal: vi.fn(async (id: string, f: Record<string, unknown>) => { updates.push([id, f]); return { ok: true }; }) },
    renderOperatingAgreement: vi.fn(async (t: string) => pdf(t)),
    renderBankingResolution: vi.fn(async (t: string) => pdf(t)),
    alert: vi.fn(async (s: string, b: string) => { alerts.push(`${s}: ${b}`); }),
    now: () => new Date("2026-11-30T15:00:00Z"),
    env,
  };
  return { pool, deps, updates, alerts };
}

const statusOf = async (pool: { query: (q: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }, deal: string) =>
  (await pool.query(`SELECT status, deal_synced_status, last_error FROM operating_agreement_status WHERE crm_deal_id = $1`, [deal])).rows[0];

describe("Operating Agreement job (T144 D10)", () => {
  it("knows which packages include the agreement", () => {
    expect(packageIncludesOperatingAgreement(["FASTTRACK"])).toBe(true);
    expect(packageIncludesOperatingAgreement(["PREMIUM"])).toBe(true);
    expect(packageIncludesOperatingAgreement(["DIY_STATE_FEE"])).toBe(false);
    expect(oaDealField({})).toBe("Operating_Agreement_Stat");
    expect(oaDealField({ OA_DEAL_STATUS_FIELD: "off" })).toBe("");
  });

  it("registers Bank-Ready and Finance-Ready as Pending Generation, File It as Not Included, and writes the Deal", async () => {
    const { pool, deps, updates, alerts } = await setup();
    await runOperatingAgreementJobOnce(deps);
    expect(await statusOf(pool, "deal-1")).toMatchObject({ status: OA_STATUS.pending, deal_synced_status: OA_STATUS.pending });
    expect(await statusOf(pool, "deal-3")).toMatchObject({ status: OA_STATUS.pending });
    expect(await statusOf(pool, "deal-2")).toMatchObject({ status: OA_STATUS.notIncluded });
    expect(updates).toContainEqual(["deal-1", { Operating_Agreement_Stat: "Pending Generation" }]);
    expect(updates).toContainEqual(["deal-2", { Operating_Agreement_Stat: "Not Included" }]);
    // The Article VI request on a File It order is flagged once.
    expect(alerts.filter((a) => a.includes("requested but not in the package"))).toHaveLength(1);
    await runOperatingAgreementJobOnce(deps);
    expect(alerts.filter((a) => a.includes("requested but not in the package"))).toHaveLength(1);
    expect(updates).toHaveLength(3); // nothing re-sent when nothing changed
  });

  it("generates after proof of filing and moves the Deal to Generated", async () => {
    const { pool, deps, updates } = await setup();
    await runOperatingAgreementJobOnce(deps);
    await pool.query(`UPDATE orders SET proof_of_filing_ref = 'L26000TEST10', proof_of_filing_at = '2026-11-30T15:00:00Z', sunbiz_filing_date = '2026-11-28' WHERE order_id = $1`, [O1]);
    const r = await runOperatingAgreementJobOnce(deps);
    expect(r.generated).toBe(1);
    expect(await statusOf(pool, "deal-1")).toMatchObject({ status: OA_STATUS.generated, deal_synced_status: OA_STATUS.generated });
    expect(updates).toContainEqual(["deal-1", { Operating_Agreement_Stat: "Generated" }]);
    const doc = (await pool.query(`SELECT kind, template, draft FROM formation_documents WHERE order_id = $1`, [O1])).rows;
    expect(doc).toEqual([{ kind: "operating_agreement", template: "operating_agreement_single_member", draft: true }]);
    expect(deps.renderBankingResolution).not.toHaveBeenCalled(); // switched off by default
  });

  it("asks ops once for the answers a manager-managed agreement needs, then generates with them", async () => {
    const { pool, deps, alerts } = await setup({ BANKING_RESOLUTION_ENABLED: "true" });
    await runOperatingAgreementJobOnce(deps);
    await pool.query(`UPDATE orders SET proof_of_filing_ref = 'L26000TEST11', proof_of_filing_at = '2026-11-30T15:00:00Z', sunbiz_filing_date = '2026-11-28' WHERE order_id = $1`, [O3]);
    await runOperatingAgreementJobOnce(deps);
    await runOperatingAgreementJobOnce(deps);
    expect(alerts.filter((a) => a.includes(O3))).toHaveLength(1);
    expect((await statusOf(pool, "deal-3")).status).toBe(OA_STATUS.pending);
    const r = await generateForOrder(deps, O3, {
      inputs: {
        members: [
          { name: "Jordan Test Rivera", address: "1 A St, Miami, FL 33131", percentage: 60 },
          { name: "Avery Test Lee", address: "2 B St, Miami, FL 33132", percentage: 40 },
        ],
        borrowing_limit: "$25,000", payment_period_months: 12, partnership_representative: "Jordan Test Rivera",
      },
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.banking_resolution).toMatchObject({ template: "banking_resolution_multi_member" });
    const br = (await pool.query(`SELECT draft FROM formation_documents WHERE order_id = $1 AND kind = 'banking_resolution'`, [O3])).rows;
    expect(br).toEqual([{ draft: false }]);
    expect((await statusOf(pool, "deal-3")).status).toBe(OA_STATUS.generated);
  });

  it("refuses a File It order and an order without proof of filing", async () => {
    const { deps } = await setup();
    expect(await generateForOrder(deps, O2)).toMatchObject({ ok: false, status: 409 });
    expect(await generateForOrder(deps, O1)).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("proof of filing") });
  });

  it("writes the newest status even after an earlier write failed", async () => {
    const { pool, deps, updates } = await setup();
    (deps.zoho.updateDeal as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: "503" });
    await runOperatingAgreementJobOnce(deps);
    await pool.query(`UPDATE orders SET proof_of_filing_ref = 'L26000TEST10', proof_of_filing_at = '2026-11-30T15:00:00Z', sunbiz_filing_date = '2026-11-28' WHERE order_id = $1`, [O1]);
    await runOperatingAgreementJobOnce(deps); // generated, but the Deal is still in its 1-hour backoff
    deps.now = () => new Date("2026-11-30T17:00:00Z");
    await runOperatingAgreementJobOnce(deps);
    const deal1 = updates.filter(([id]) => id === "deal-1").map(([, f]) => f.Operating_Agreement_Stat);
    expect(deal1[deal1.length - 1]).toBe("Generated");
    expect((await statusOf(pool, "deal-1")).deal_synced_status).toBe("Generated");
  });
});

describe("Banking Resolution context (approved wording v1)", () => {
  const filed = { filing_date: "2026-11-30", document_number: "L26000TEST10" };
  it("builds a single-member resolution with the approved wording version, not draft", () => {
    const r = buildBankingResolutionContext(sm as never, filed);
    expect(r.ok && r.template).toBe("banking_resolution_single_member");
    expect(r.ok && r.context).toMatchObject({ draft: false, wording_version: BANKING_RESOLUTION_WORDING_VERSION, llc_name: "TEST DISPATCH TEN SM LLC", adopted_by: "the sole member",
      authorized_signers: [{ name: "Jordan Test Rivera", title: "Sole Member" }], signing_rule_text: "acting alone" });
  });
  it("needs the owners of a manager-managed LLC and names the managers as signers", () => {
    expect(buildBankingResolutionContext(mgr as never, filed).ok).toBe(false);
    const r = buildBankingResolutionContext(mgr as never, filed, { members: [{ name: "A" }, { name: "B" }], signing_rule: "any_one" });
    expect(r.ok && r.context).toMatchObject({ adopted_by: "the sole manager", authorized_signers: [{ name: "Casey Test Morgan", title: "Manager" }] });
  });
  it("prints no DRAFT marks in the approved templates", () => {
    for (const t of ["banking_resolution_single_member.html.j2", "banking_resolution_multi_member.html.j2", "partials/banking_resolution_body.html.j2"]) {
      const html = readFileSync(fileURLToPath(new URL(`../../templates/${t}`, import.meta.url)), "utf8").replace(/\{#-[\s\S]*?-#\}/g, "");
      expect(html).not.toMatch(/DRAFT|draft-watermark|draft-banner|pending owner approval/);
    }
  });
  it("names every gap", () => {
    const r = buildBankingResolutionContext({}, {}, { signing_rule: "any_two" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.missingFields.join("|")).toMatch(/llc_name.*filing_date.*document_number/);
  });
});

describe("review fixes (T144 D10)", () => {
  it("survives an odd operating_agreement_requested value written by a client", async () => {
    const { pool, deps } = await setup();
    await pool.query(`UPDATE filing_sessions SET filing_data = $2 WHERE filing_session_id = $1`, [S2, JSON.stringify({ ...fileIt, operating_agreement_requested: "Yes please" })]);
    const r = await runOperatingAgreementJobOnce(deps);
    expect(r.registered).toBe(3);
  });

  it("leaves orders from before OA_JOB_START_DATE alone", async () => {
    const { pool, deps } = await setup({ OA_JOB_START_DATE: "2026-11-26" });
    await runOperatingAgreementJobOnce(deps);
    expect((await pool.query(`SELECT count(*)::int AS n FROM operating_agreement_status`)).rows[0].n).toBe(0);
  });

  it("treats an already stored agreement as generated, so the status cannot stick", async () => {
    const { pool, deps } = await setup();
    await runOperatingAgreementJobOnce(deps);
    await pool.query(`UPDATE orders SET proof_of_filing_ref = 'L26000TEST10', proof_of_filing_at = '2026-11-30T15:00:00Z', sunbiz_filing_date = '2026-11-28' WHERE order_id = $1`, [O1]);
    await pool.query(`INSERT INTO formation_documents (order_id, filing_session_id, kind, template, draft, byte_size, sha256, pdf_bytes)
                      VALUES ($1, $2, 'operating_agreement', 'operating_agreement_single_member', true, 3, 'abc', '\\x00')`, [O1, S1]);
    expect(await generateForOrder(deps, O1, { reuseExisting: true })).toMatchObject({ ok: true, operating_agreement: { sha256: "abc" } });
    // The operator route never silently returns the old PDF.
    expect(await generateForOrder(deps, O1, { inputs: { successor_name: "X" } })).toMatchObject({ ok: false, status: 409 });
    expect((await statusOf(pool, "deal-1")).status).toBe(OA_STATUS.generated);
  });

  it("backs off a Deal whose update fails permanently, with one alert", async () => {
    const { pool, deps, alerts } = await setup();
    (deps.zoho.updateDeal as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) =>
      id === "deal-2" ? { ok: false, permanent: true, error: "INVALID_DATA" } : { ok: true });
    await runOperatingAgreementJobOnce(deps);
    await runOperatingAgreementJobOnce(deps);
    expect(alerts.filter((a) => a.includes("not written to Zoho"))).toHaveLength(1);
    expect((deps.zoho.updateDeal as ReturnType<typeof vi.fn>).mock.calls.filter(([id]) => id === "deal-2")).toHaveLength(1);
  });

  it("gives refunded or released orders no agreement", async () => {
    const { pool, deps } = await setup();
    await pool.query(`UPDATE orders SET payment_status = 'refunded', proof_of_filing_ref = 'L1' WHERE order_id = $1`, [O1]);
    expect(await generateForOrder(deps, O1)).toMatchObject({ ok: false, status: 409 });
  });
});

describe("dispatcher review before 0034 (T144 D10)", () => {
  it("prints the Sunbiz filing date, not the day proof was recorded, and waits for it", async () => {
    const { pool, deps, alerts } = await setup();
    await runOperatingAgreementJobOnce(deps);
    await pool.query(`UPDATE orders SET proof_of_filing_ref = 'L26000TEST10', proof_of_filing_at = '2026-11-30T15:00:00Z' WHERE order_id = $1`, [O1]);
    await runOperatingAgreementJobOnce(deps);
    expect((await statusOf(pool, "deal-1")).status).toBe(OA_STATUS.pending);
    expect(alerts.some((a) => a.includes("Sunbiz filing date"))).toBe(true);
    await pool.query(`UPDATE orders SET sunbiz_filing_date = '2026-11-28' WHERE order_id = $1`, [O1]);
    await runOperatingAgreementJobOnce(deps);
    const ctx = (deps.renderOperatingAgreement as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(ctx).toMatchObject({ filing_date: "November 28, 2026", effective_date: "November 28, 2026" });
  });

  it("refuses a future filing date and stores a valid one given by the operator", async () => {
    const { pool, deps } = await setup();
    await pool.query(`UPDATE orders SET proof_of_filing_ref = 'L26000TEST10' WHERE order_id = $1`, [O1]);
    expect(await generateForOrder(deps, O1, { filingDate: "2027-01-01" })).toMatchObject({ ok: false, status: 422 });
    expect(await generateForOrder(deps, O1, { filingDate: "2026-11-27" })).toMatchObject({ ok: true });
    expect(await loadSunbizFilingDate(pool as never, O1)).toBe("2026-11-27");
  });

  it("never infers the members: without the customer's single-member answer it asks", async () => {
    const { pool, deps } = await setup();
    await pool.query(`UPDATE filing_sessions SET filing_data = $2 WHERE filing_session_id = $1`,
      [S1, JSON.stringify({ ...sm, management_structure: undefined, member_count: undefined })]);
    await pool.query(`UPDATE orders SET proof_of_filing_ref = 'L26000TEST10', sunbiz_filing_date = '2026-11-28' WHERE order_id = $1`, [O1]);
    expect(await generateForOrder(deps, O1)).toMatchObject({ ok: false, status: 422, error: "the members are not confirmed" });
    expect(await generateForOrder(deps, O1, { confirmMembers: true })).toMatchObject({ ok: true });
  });

  it("decides the package per Deal across all its orders, with the start date on the Deal", async () => {
    const { pool, deps } = await setup({ OA_JOB_START_DATE: "2026-11-25" });
    const O4 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
    // Bank-Ready held before the start date, EIN add-on after it, same Deal.
    await pool.query(`UPDATE orders SET authorized_at = '2026-11-24T10:00:00Z' WHERE order_id = $1`, [O1]);
    await pool.query(`INSERT INTO orders VALUES ($1, $2, $3, 'paid', '2026-11-26T10:00:00Z', NULL, 'deal-1', NULL, NULL, NULL)`, [O4, S1, JSON.stringify([{ offer_code: "EIN_FILING" }])]);
    await pool.query(`INSERT INTO crm_sync_queue (filing_session_id, order_id, sync_type, payload_snapshot, status) VALUES ($1, $2, 'order_deal', '{}'::jsonb, 'synced')`, [S1, O4]);
    await runOperatingAgreementJobOnce(deps);
    expect(await statusOf(pool, "deal-1")).toBeUndefined(); // the Deal started before the start date: left alone
    const { pool: p2, deps: d2 } = await setup();
    await p2.query(`INSERT INTO orders VALUES ($1, $2, $3, 'paid', '2026-11-26T10:00:00Z', NULL, 'deal-1', NULL, NULL, NULL)`, [O4, S1, JSON.stringify([{ offer_code: "EIN_FILING" }])]);
    await p2.query(`INSERT INTO crm_sync_queue (filing_session_id, order_id, sync_type, payload_snapshot, status) VALUES ($1, $2, 'order_deal', '{}'::jsonb, 'synced')`, [S1, O4]);
    await runOperatingAgreementJobOnce(d2);
    expect((await statusOf(p2, "deal-1")).status).toBe(OA_STATUS.pending); // the add-on does not make it Not Included
  });

  it("moves a Deal whose Bank-Ready order was released back to Not Included", async () => {
    const { pool, deps } = await setup();
    await runOperatingAgreementJobOnce(deps);
    await pool.query(`UPDATE orders SET payment_status = 'released' WHERE order_id = $1`, [O1]);
    await runOperatingAgreementJobOnce(deps);
    expect(await statusOf(pool, "deal-1")).toMatchObject({ status: OA_STATUS.notIncluded });
  });

  it("keeps Deal-write failures out of last_error", async () => {
    const { pool, deps } = await setup();
    (deps.zoho.updateDeal as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: "503" });
    await runOperatingAgreementJobOnce(deps);
    const row = (await pool.query(`SELECT last_error, deal_sync_error FROM operating_agreement_status WHERE crm_deal_id = 'deal-1'`)).rows[0];
    expect(row).toEqual({ last_error: null, deal_sync_error: "Deal update: 503" });
  });
});

