/**
 * T144 Dispatch 10: Operating Agreement generation and its Zoho Deal status.
 *
 * Damian, 25 Nov 2026: "Review & merge it" (the generator), Bank-Ready and
 * Finance-Ready trigger generation, log to the Deal. One status row per
 * verified Zoho Deal (operating_agreement_status, migration 0034):
 *
 *   1. register: every Deal of a held or paid order (VERIFIED_DEAL_JOIN, the
 *      rule #26 and the EIN portal use) gets "Pending Generation" when one of
 *      its orders is Bank-Ready (FASTTRACK) or Finance-Ready (PREMIUM, also the
 *      $139 kickoff order), otherwise "Not Included". A Not Included Deal that
 *      later gets such an order moves to Pending Generation. A customer who
 *      asked for the agreement at Article VI (filing_data.operating_agreement_
 *      requested, the ST09 bridge to Bank-Ready) but bought a package without
 *      it is flagged to ops once.
 *   2. generate: once proof of filing is recorded on that order (the agreement
 *      cites the filing date and document number), the agreement is built and
 *      stored in formation_documents. It needs no extra answers for a
 *      member-managed LLC with one member; otherwise (owners and percentages,
 *      borrowing limit, ...) ops is alerted once and generates it with POST
 *      /api/ops/operating-agreement/:orderId. The Banking Resolution is built
 *      alongside only when BANKING_RESOLUTION_ENABLED=true (DRAFT wording).
 *   3. sync: the row's CURRENT status is written to the Deal field
 *      (Operating_Agreement_Stat by default) whenever it differs from what was
 *      last written, so retries can never write an older status.
 *
 * Nothing here sends a document to anyone. "Delivered" is not set by code
 * (delivery is not wired yet).
 */
import type { Pool } from "pg";
import { describeError } from "../db/describeError.js";
import { VERIFIED_DEAL_JOIN } from "../ein/portalJobs.js";
import { packageFromCodes } from "../ein/onboarding.js";
import {
  buildOperatingAgreementContext,
  type OperatingAgreementInputs,
  type OperatingAgreementTemplate,
} from "../pdf/operatingAgreementContext.js";
import {
  bankingResolutionEnabled,
  buildBankingResolutionContext,
  type BankingResolutionInputs,
  type BankingResolutionTemplate,
} from "../pdf/bankingResolutionContext.js";
import type { FilingSessionRecord } from "../pdf/types.js";
import type { PdfGenerationResult } from "../pdf/serviceClient.js";

export type Db = Pick<Pool, "query">;

export const OA_STATUS = {
  notIncluded: "Not Included",
  pending: "Pending Generation",
  generated: "Generated",
  delivered: "Delivered",
} as const;

/** Deals.Operating_Agreement_Stat (picklist, id 2654294000040675002), created 25 Nov 2026. */
export const DEFAULT_OA_DEAL_FIELD = "Operating_Agreement_Stat";

/** OA_DEAL_STATUS_FIELD overrides the field; "off" (or a malformed name) stops the Deal writes. */
export function oaDealField(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.OA_DEAL_STATUS_FIELD;
  if (v === undefined) return DEFAULT_OA_DEAL_FIELD;
  const t = v.trim();
  if (t.toLowerCase() === "off") return "";
  return /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(t) ? t : "";
}

/**
 * Orders held or paid before this date are left alone, so switching the job on
 * does not rewrite old Deals, generate agreements for past filings or send a
 * burst of alerts. OA_JOB_START_DATE (YYYY-MM-DD) overrides the default.
 */
export const DEFAULT_OA_JOB_START_DATE = "2026-11-25";
export function oaJobStartDate(env: NodeJS.ProcessEnv = process.env): string {
  const v = (env.OA_JOB_START_DATE ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : DEFAULT_OA_JOB_START_DATE;
}

/** Bank-Ready (FASTTRACK) and Finance-Ready (PREMIUM) include the agreement; File It does not. */
export function packageIncludesOperatingAgreement(codes: string[]): boolean {
  const pkg = packageFromCodes(codes);
  return pkg === "BANK_READY" || pkg === "PREMIUM";
}

export interface OaDeps {
  db: Db;
  zoho: { updateDeal(dealId: string, fields: Record<string, unknown>): Promise<{ ok: boolean; permanent?: boolean; error?: string }> };
  renderOperatingAgreement(template: OperatingAgreementTemplate, context: Record<string, unknown>): Promise<PdfGenerationResult>;
  renderBankingResolution(template: BankingResolutionTemplate, context: Record<string, unknown>): Promise<PdfGenerationResult>;
  alert(subject: string, body: string): Promise<unknown>;
  now(): Date;
  env: NodeJS.ProcessEnv;
}

type LineItems = Array<{ offer_code?: unknown }> | null;

function codesOf(li: LineItems): string[] {
  return Array.isArray(li) ? li.map((x) => (typeof x?.offer_code === "string" ? x.offer_code : "")).filter(Boolean) : [];
}

/** YYYY-MM-DD in Florida (Eastern) time. */
export function floridaIsoDate(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return parts; // en-CA formats as YYYY-MM-DD
}

/** Step 1. Returns the number of rows added or moved to Pending Generation. */
export async function registerOperatingAgreementDeals(deps: OaDeps): Promise<number> {
  const { rows } = await deps.db.query<{
    order_id: string;
    filing_session_id: string;
    crm_deal_id: string;
    line_items: LineItems;
    requested: boolean | null;
  }>(
    `SELECT o.order_id, o.filing_session_id, o.crm_deal_id, o.line_items,
            -- Compared as text: filing_data is client-written, and a cast to
            -- boolean would throw on any odd value and stop every tick.
            (fs.filing_data->>'operating_agreement_requested') = 'true' AS requested
     FROM orders o
     ${VERIFIED_DEAL_JOIN}
     JOIN filing_sessions fs ON fs.filing_session_id = o.filing_session_id
     WHERE o.payment_status IN ('authorized', 'paid') AND o.crm_deal_id IS NOT NULL
       AND COALESCE(o.authorized_at, o.paid_at) >= $1
     ORDER BY COALESCE(o.authorized_at, o.paid_at) ASC`,
    [oaJobStartDate(deps.env)]
  );
  const byDeal = new Map<string, { filing_session_id: string; oaOrder: string | null; requested: boolean }>();
  for (const r of rows) {
    const cur = byDeal.get(r.crm_deal_id) ?? { filing_session_id: r.filing_session_id, oaOrder: null, requested: false };
    if (!cur.oaOrder && packageIncludesOperatingAgreement(codesOf(r.line_items))) cur.oaOrder = r.order_id;
    cur.requested = cur.requested || r.requested === true;
    byDeal.set(r.crm_deal_id, cur);
  }
  let changed = 0;
  for (const [dealId, d] of byDeal) {
    const status = d.oaOrder ? OA_STATUS.pending : OA_STATUS.notIncluded;
    const note = !d.oaOrder && d.requested ? "asked for an Operating Agreement at Article VI, but the package does not include one" : null;
    const known = await deps.db.query(`SELECT 1 FROM operating_agreement_status WHERE crm_deal_id = $1`, [dealId]);
    const ins = known.rowCount ? { rows: [] as unknown[] } : await deps.db.query(
      `INSERT INTO operating_agreement_status (crm_deal_id, filing_session_id, order_id, status, last_error)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (crm_deal_id) DO NOTHING
       RETURNING crm_deal_id`,
      [dealId, d.filing_session_id, d.oaOrder, status, note]
    );
    if (ins.rows.length > 0) {
      changed++;
      if (note) {
        await deps.alert(
          "Operating Agreement requested but not in the package",
          `Filing session ${d.filing_session_id} (Deal ${dealId}) ${note}. Offer Bank-Ready, or confirm the customer does not want it.`
        ).catch(() => undefined);
      }
      continue;
    }
    if (d.oaOrder) {
      // A Deal that was Not Included and now has a Bank-Ready / Finance-Ready order.
      const up = await deps.db.query(
        `UPDATE operating_agreement_status
         SET status = $2, order_id = $3, last_error = NULL, updated_at = now()
         WHERE crm_deal_id = $1 AND status = $4`,
        [dealId, OA_STATUS.pending, d.oaOrder, OA_STATUS.notIncluded]
      );
      changed += up.rowCount ?? 0;
    }
  }
  return changed;
}

export type GenerateResult =
  | { ok: true; operating_agreement: { sha256: string; byte_size: number; template: string; draft: boolean }; banking_resolution?: { sha256: string; byte_size: number; template: string } | { missingFields: string[] } | { error: string } }
  | { ok: false; status: 404 | 409 | 422 | 502; error: string; missingFields?: string[] };

/**
 * Builds and stores the agreement for one order (the job, and the operator
 * route with the owner's answers). Requires proof of filing on the order.
 * replace=true regenerates an existing document.
 */
export async function generateForOrder(
  deps: OaDeps,
  orderId: string,
  opts: { inputs?: OperatingAgreementInputs; bankingInputs?: BankingResolutionInputs; filingDate?: string; replace?: boolean } = {}
): Promise<GenerateResult> {
  const { rows } = await deps.db.query<{
    order_id: string;
    filing_session_id: string;
    line_items: LineItems;
    proof_of_filing_ref: string | null;
    proof_of_filing_at: Date | string | null;
    payment_status: string;
    crm_deal_id: string | null;
    filing_data: Partial<FilingSessionRecord> | null;
  }>(
    `SELECT o.order_id, o.filing_session_id, o.line_items, o.proof_of_filing_ref, o.proof_of_filing_at, o.payment_status,
            o.crm_deal_id, fs.filing_data
     FROM orders o JOIN filing_sessions fs ON fs.filing_session_id = o.filing_session_id
     WHERE o.order_id = $1`,
    [orderId]
  );
  const o = rows[0];
  if (!o) return { ok: false, status: 404, error: "order not found" };
  if (!packageIncludesOperatingAgreement(codesOf(o.line_items))) {
    return { ok: false, status: 409, error: "this order's package does not include an Operating Agreement" };
  }
  if (!["authorized", "paid"].includes(o.payment_status)) {
    return { ok: false, status: 409, error: `order payment_status is ${o.payment_status}; only a held or paid order gets an agreement` };
  }
  if (!o.proof_of_filing_ref) return { ok: false, status: 409, error: "no proof of filing recorded on this order yet" };
  if (!opts.replace) {
    // Already stored (e.g. a crash between storing and updating the status):
    // that is success, so the status can never stick at Pending Generation.
    const existing = await deps.db.query<{ sha256: string; byte_size: number; template: string; draft: boolean }>(
      `SELECT sha256, byte_size, template, draft FROM formation_documents WHERE order_id = $1 AND kind = 'operating_agreement'`,
      [orderId]
    );
    if (existing.rows.length) {
      await markGenerated(deps.db, o.order_id, o.crm_deal_id);
      return { ok: true, operating_agreement: existing.rows[0] };
    }
  }

  const filed = {
    filing_date: opts.filingDate ?? (o.proof_of_filing_at ? floridaIsoDate(new Date(o.proof_of_filing_at)) : undefined),
    document_number: o.proof_of_filing_ref,
  };
  const fd = { ...(o.filing_data ?? {}) };
  if (typeof fd.llc_name === "string") fd.llc_name = fd.llc_name.trim().toUpperCase();

  const ctx = buildOperatingAgreementContext(fd, filed, opts.inputs ?? {});
  if (!ctx.ok) return { ok: false, status: 422, error: "the agreement needs more answers", missingFields: ctx.missingFields };
  const pdf = await deps.renderOperatingAgreement(ctx.template, ctx.context);
  if (!pdf.ok) return { ok: false, status: 502, error: `PDF generation failed: ${pdf.error}` };
  const draft = ctx.context.draft === true;
  await storeDocument(deps.db, o.order_id, o.filing_session_id, "operating_agreement", ctx.template, draft, pdf);

  let bankingOut: { sha256: string; byte_size: number; template: string } | { missingFields: string[] } | { error: string } | undefined;
  if (bankingResolutionEnabled(deps.env)) {
    const b = buildBankingResolutionContext(fd, filed, opts.bankingInputs ?? { members: opts.inputs?.members?.map((m) => ({ name: m.name })) });
    if (!b.ok) bankingOut = { missingFields: b.missingFields };
    else {
      const bp = await deps.renderBankingResolution(b.template, b.context);
      if (!bp.ok) bankingOut = { error: bp.error };
      else {
        await storeDocument(deps.db, o.order_id, o.filing_session_id, "banking_resolution", b.template, true, bp);
        bankingOut = { sha256: bp.sha256, byte_size: bp.pdfBytes.length, template: b.template };
      }
    }
  }

  await markGenerated(deps.db, o.order_id, o.crm_deal_id);
  return {
    ok: true,
    operating_agreement: { sha256: pdf.sha256, byte_size: pdf.pdfBytes.length, template: ctx.template, draft },
    ...(bankingOut ? { banking_resolution: bankingOut } : {}),
  };
}

/** Generated, on the status row of the order's Deal (or the order's own row). Delivered is never undone. */
async function markGenerated(db: Db, orderId: string, crmDealId: string | null): Promise<void> {
  await db.query(
    `UPDATE operating_agreement_status SET status = $3, last_error = NULL, updated_at = now()
     WHERE (order_id = $1 OR crm_deal_id = $2) AND status IN ($4, $5)`,
    [orderId, crmDealId ?? "", OA_STATUS.generated, OA_STATUS.pending, OA_STATUS.notIncluded]
  );
}

async function storeDocument(
  db: Db,
  orderId: string,
  filingSessionId: string,
  kind: "operating_agreement" | "banking_resolution",
  template: string,
  draft: boolean,
  pdf: Extract<PdfGenerationResult, { ok: true }>
): Promise<void> {
  await db.query(
    `INSERT INTO formation_documents (order_id, filing_session_id, kind, template, draft, byte_size, sha256, pdf_bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (order_id, kind) DO UPDATE
       SET template = EXCLUDED.template, draft = EXCLUDED.draft, byte_size = EXCLUDED.byte_size,
           sha256 = EXCLUDED.sha256, pdf_bytes = EXCLUDED.pdf_bytes, created_at = now()`,
    [orderId, filingSessionId, kind, template, draft, pdf.pdfBytes.length, pdf.sha256, pdf.pdfBytes]
  );
}

/** Step 2. Generates every pending agreement whose order has proof of filing. */
export async function generatePendingAgreements(deps: OaDeps): Promise<{ generated: number; needsInputs: string[] }> {
  const { rows } = await deps.db.query<{ crm_deal_id: string; order_id: string; alerted_at: Date | null; last_error: string | null }>(
    `SELECT s.crm_deal_id, s.order_id, s.alerted_at, s.last_error
     FROM operating_agreement_status s JOIN orders o ON o.order_id = s.order_id
     WHERE s.status = $1 AND o.proof_of_filing_ref IS NOT NULL
     ORDER BY s.updated_at ASC
     LIMIT 10`,
    [OA_STATUS.pending]
  );
  let generated = 0;
  const needsInputs: string[] = [];
  for (const r of rows) {
    let res: GenerateResult;
    try {
      res = await generateForOrder(deps, r.order_id);
    } catch (err) {
      res = { ok: false, status: 502, error: describeError(err) };
    }
    if (res.ok) {
      generated++;
      continue;
    }
    const why = res.missingFields ? `${res.error}: ${res.missingFields.join("; ")}` : res.error;
    await deps.db.query(`UPDATE operating_agreement_status SET last_error = $2, updated_at = now() WHERE crm_deal_id = $1`, [r.crm_deal_id, why]);
    if (res.status === 422) needsInputs.push(r.order_id);
    // Alert once per distinct problem: a new error (e.g. answers needed after a
    // PDF-service outage) alerts again; the same error every tick does not.
    if (!r.alerted_at || r.last_error !== why) {
      await deps.alert(
        "Operating Agreement needs attention",
        `Order ${r.order_id} (Deal ${r.crm_deal_id}): ${why}. ` +
          (res.status === 422 ? "Generate it with POST /api/ops/operating-agreement/" + r.order_id + " and the missing answers." : "")
      ).catch(() => undefined);
      await deps.db.query(`UPDATE operating_agreement_status SET alerted_at = now() WHERE crm_deal_id = $1`, [r.crm_deal_id]);
    }
  }
  return { generated, needsInputs };
}

/** Step 3. Writes each Deal's current status where it differs from the last write. */
export async function syncOperatingAgreementDeals(deps: OaDeps): Promise<{ synced: number; errors: string[] }> {
  const field = oaDealField(deps.env);
  if (!field) return { synced: 0, errors: [] };
  const now = deps.now();
  const { rows } = await deps.db.query<{ crm_deal_id: string; status: string; deal_sync_alerted: boolean | null }>(
    `SELECT crm_deal_id, status, deal_sync_alerted FROM operating_agreement_status
     WHERE (deal_synced_status IS NULL OR deal_synced_status <> status)
       AND (deal_sync_retry_at IS NULL OR deal_sync_retry_at <= $1)
     ORDER BY updated_at ASC
     LIMIT 50`,
    [now]
  );
  let synced = 0;
  const errors: string[] = [];
  for (const r of rows) {
    const res = await deps.zoho.updateDeal(r.crm_deal_id, { [field]: r.status });
    if (res.ok) {
      // Only if the status did not change meanwhile; otherwise the next pass writes the newer one.
      await deps.db.query(
        `UPDATE operating_agreement_status SET deal_synced_status = $2, deal_sync_retry_at = NULL, deal_sync_alerted = false
         WHERE crm_deal_id = $1 AND status = $2`,
        [r.crm_deal_id, r.status]
      );
      synced++;
    } else {
      errors.push(`${r.crm_deal_id}: ${res.error ?? "unknown"}`);
      // Back off so failing Deals cannot hold the batch: an hour for a transient
      // error, a day for a permanent one (deleted Deal, rejected value), with one alert.
      const retryAt = new Date(now.getTime() + (res.permanent ? 24 : 1) * 3600_000);
      await deps.db.query(
        `UPDATE operating_agreement_status SET last_error = $2, deal_sync_retry_at = $3, deal_sync_alerted = $4 WHERE crm_deal_id = $1`,
        [r.crm_deal_id, `Deal update: ${res.error ?? "unknown"}`, retryAt, r.deal_sync_alerted === true || res.permanent === true]
      );
      if (res.permanent && !r.deal_sync_alerted) {
        await deps.alert("Operating Agreement status not written to Zoho", `Deal ${r.crm_deal_id}: ${res.error ?? "unknown"}. Retried daily.`).catch(() => undefined);
      }
    }
  }
  return { synced, errors };
}

/** One tick of the job: register, generate, sync. */
export async function runOperatingAgreementJobOnce(deps: OaDeps) {
  const registered = await registerOperatingAgreementDeals(deps);
  const gen = await generatePendingAgreements(deps);
  const sync = await syncOperatingAgreementDeals(deps);
  return { registered, ...gen, ...sync };
}

/** Production dependencies: the shared Zoho Deal PUT (#26) and the PDF service. */
export async function defaultOaDeps(pool: Db): Promise<OaDeps> {
  const [{ realPostFilingZohoClient }, svc, { sendOpsAlert }] = await Promise.all([
    import("../postFiling/interests.js"),
    import("../pdf/serviceClient.js"),
    import("../ops/alerts.js"),
  ]);
  return {
    db: pool,
    zoho: realPostFilingZohoClient,
    renderOperatingAgreement: svc.generateOperatingAgreementPdf,
    renderBankingResolution: svc.generateBankingResolutionPdf,
    alert: sendOpsAlert,
    now: () => new Date(),
    env: process.env,
  };
}

/** Postgres undefined_table (42P01): migration 0034 not applied yet. */
export function isMissingTable(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === "42P01" || /relation .* does not exist/i.test(e?.message ?? "");
}
