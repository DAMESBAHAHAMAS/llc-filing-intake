/**
 * ST17 / A6Y2-T144: the customer's e-signature authorizing a Third-Party
 * Designee on IRS Form SS-4.
 *
 * Damian approved the wording below on 26 Nov 2026. It is used word for word:
 * do not edit it. A wording change is a new version: add a new constant, give
 * it a new SS4_DESIGNEE_STATEMENT_VERSION, and keep the old records as they
 * are (each record stores the version, the full text and its SHA-256).
 *
 * Switched off until Damian turns it on: EIN_DESIGNEE_ESIGN_ENABLED=true.
 * Off is the default, and anything other than "true" is off.
 *
 * Open with Damian (do not guess values):
 * - TODO(D11): the designee's phone and fax numbers for the SS-4 "Third Party
 *   Designee" section. ein/ss4.ts already reports them as named gaps
 *   (designee.phone, designee.fax) until the EIN step supplies them.
 * - TODO(O22): whether this designee authorization is enough, or a Form 2848
 *   (Power of Attorney) is needed instead. Nothing here decides that.
 *
 * The 25 Nov Zoho CRM Portal design for the passport upload is separate and
 * unchanged (ein/onboarding.ts, ein/portalJobs.ts).
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { einIncluded } from "./onboarding.js";
import { orderedOfferCodes } from "../offers/einUpsell.js";
import type { Db } from "../postFiling/interests.js";

export const SS4_DESIGNEE_STATEMENT_VERSION = "ss4-designee-2026-11-26";

export const SS4_DESIGNEE_STATEMENT_TITLE = "IRS Form SS-4 — Third-Party Designee Authorization";

export const SS4_DESIGNEE_STATEMENT_INTRO =
  "By typing my full legal name and clicking below, I authorize Damian Knowles (Designee) to answer questions that may arise during the completion of IRS Form SS-4 (Application for Employer Identification Number), receive the newly assigned Employer Identification Number (EIN) on behalf of the entity listed above, and answer questions regarding the completion of Form SS-4.";

export const SS4_DESIGNEE_STATEMENT_CLAUSES: readonly string[] = [
  "1. Limited Authority: Applies only to the completion of Form SS-4 and receipt of the assigned EIN, terminating upon EIN assignment or one (1) year from signing, whichever occurs first.",
  "2. No Legal or Tax Representation: Damian Knowles is acting solely as a Third-Party Designee for EIN application submission and is not acting as an attorney, CPA, or Enrolled Agent, nor providing legal or tax advice.",
  "3. Accuracy of Information: Under penalties of perjury, I declare that I am an authorized member, manager, or officer of the entity and that the information provided for this EIN application (including my SSN/ITIN or passport documentation, if applicable) is true, correct, and complete.",
];

/** The whole statement as one string: title, intro, a blank line, then the three clauses. */
export const SS4_DESIGNEE_STATEMENT_TEXT = [
  SS4_DESIGNEE_STATEMENT_TITLE,
  SS4_DESIGNEE_STATEMENT_INTRO,
  "",
  ...SS4_DESIGNEE_STATEMENT_CLAUSES,
].join("\n");

export const SS4_DESIGNEE_STATEMENT_SHA256 = createHash("sha256").update(SS4_DESIGNEE_STATEMENT_TEXT, "utf8").digest("hex");

/**
 * Clause 1: the authority ends one year after signing (or at EIN assignment, if
 * sooner; that is not tracked here, so the SS-4 step must check it). Signed on
 * 29 February, it ends on 28 February, never on 1 March.
 */
export function authorityExpiresAt(signedAt: Date): Date {
  const d = new Date(signedAt.getTime());
  const month = d.getUTCMonth();
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  if (d.getUTCMonth() !== month) d.setUTCDate(0);
  return d;
}

export interface DesigneeConfig {
  /** Off unless EIN_DESIGNEE_ESIGN_ENABLED=true. */
  enabled: boolean;
}

export function designeeConfig(env: Record<string, string | undefined> = process.env): DesigneeConfig {
  return { enabled: (env.EIN_DESIGNEE_ESIGN_ENABLED ?? "").trim().toLowerCase() === "true" };
}

const NAME_MAX = 200;
const TITLE_MAX = 100;

/**
 * A typed name made safe to store: Unicode-normalized (NFC), control and
 * invisible format characters removed, spaces collapsed, trimmed. Null when it is empty, too long, or has no letter.
 */
export function cleanSignerText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const t = value
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    // Invisible format characters (zero-width, bidirectional overrides).
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.length > max || !/\p{L}/u.test(t)) return null;
  return t;
}

export type SignatureInput =
  | { ok: true; signerName: string; signerTitle: string | null; shownEntityName: string }
  | { ok: false; status: 400 | 409; error: string };

/**
 * Checks the body of a signing request. The customer must send the version of
 * the statement they were shown (409 "statement_changed" if it is not the
 * current one, so the page reloads the new text), consent: true, and their
 * typed full legal name, and the LLC name the page showed above the statement
 * (entity_name, from the GET; the route answers 409 "entity_name_changed" if the
 * interview's LLC name has changed since). The title (member, manager, officer)
 * is optional.
 */
export function checkSignatureInput(body: Record<string, unknown>): SignatureInput {
  if (body.consent !== true) return { ok: false, status: 400, error: "consent_required" };
  const signerName = cleanSignerText(body.signer_name, NAME_MAX);
  if (!signerName) return { ok: false, status: 400, error: "signer_name_required" };
  let signerTitle: string | null = null;
  if (body.signer_title !== undefined && body.signer_title !== null && body.signer_title !== "") {
    signerTitle = cleanSignerText(body.signer_title, TITLE_MAX);
    if (!signerTitle) return { ok: false, status: 400, error: "invalid_signer_title" };
  }
  const shownEntityName = normalizeEntityName(body.entity_name);
  if (!shownEntityName) return { ok: false, status: 400, error: "entity_name_required" };
  if (typeof body.statement_version !== "string") return { ok: false, status: 400, error: "statement_version_required" };
  if (body.statement_version !== SS4_DESIGNEE_STATEMENT_VERSION) return { ok: false, status: 409, error: "statement_changed" };
  return { ok: true, signerName, signerTitle, shownEntityName };
}

/** The LLC name as SS-4 line 1 prints it: trimmed, spaces collapsed, upper case. Null when empty. */
export function normalizeEntityName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.normalize("NFC").replace(/\s+/g, " ").trim().toUpperCase();
  return t && t.length <= 300 ? t : null;
}

export interface DesigneeSession {
  /** The LLC's name as the SS-4 prints it on line 1 (upper case), or null if the interview has none yet. */
  entityName: string | null;
}

/**
 * The session, if it may sign: the order must belong to it and be held or
 * paid, and the session's held or paid orders must include the EIN. Null
 * otherwise (the route answers 404, so it never says whether a session exists).
 */
export async function designeeSession(db: Db, filingSessionId: string, orderId: string): Promise<DesigneeSession | null> {
  const { rows } = await db.query<{ llc_name: string | null }>(
    `SELECT fs.filing_data->>'llc_name' AS llc_name
     FROM orders o
     JOIN filing_sessions fs ON fs.filing_session_id = o.filing_session_id
     WHERE o.order_id = $1 AND o.filing_session_id = $2 AND o.payment_status IN ('authorized', 'paid')
     LIMIT 1`,
    [orderId, filingSessionId],
  );
  if (rows.length === 0) return null;
  if (!einIncluded(await orderedOfferCodes(db, filingSessionId))) return null;
  return { entityName: normalizeEntityName(rows[0].llc_name) };
}

export interface DesigneeSignature {
  statement_version: string;
  signer_name: string;
  signer_title: string | null;
  entity_name: string;
  signed_at: string;
  authority_expires_at: string;
}

const SIGNATURE_COLUMNS = `statement_version, signer_name, signer_title, entity_name, signed_at, authority_expires_at`;

function toSignature(row: Record<string, unknown>): DesigneeSignature {
  const iso = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();
  return {
    statement_version: String(row.statement_version),
    signer_name: String(row.signer_name),
    signer_title: row.signer_title === null || row.signer_title === undefined ? null : String(row.signer_title),
    entity_name: String(row.entity_name),
    signed_at: iso(row.signed_at),
    authority_expires_at: iso(row.authority_expires_at),
  };
}

/** The session's signature for the current statement version, or null. */
export async function readSignature(db: Db, filingSessionId: string): Promise<DesigneeSignature | null> {
  const { rows } = await db.query(
    `SELECT ${SIGNATURE_COLUMNS} FROM ein_designee_authorizations
     WHERE filing_session_id = $1 AND statement_version = $2`,
    [filingSessionId, SS4_DESIGNEE_STATEMENT_VERSION],
  );
  return rows.length ? toSignature(rows[0] as Record<string, unknown>) : null;
}

export interface SignatureAudit {
  now: Date;
  /** A valid IPv4 or IPv6 address, or null. */
  ip: string | null;
  /** The raw X-Forwarded-For chain, kept as supporting evidence. */
  forwardedFor: string | null;
  userAgent: string | null;
}

/** The value if it is an IPv4 or IPv6 address, else null: nothing else is stored as the signer's IP. */
export function validIp(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  return v.length <= 45 && isIP(v) ? v : null;
}

/**
 * Stores the signature. One per session and statement version: the first one
 * stands, and signing again returns it unchanged (created: false). The server
 * supplies the time, the IP, the statement text and its hash; none of them
 * come from the request.
 */
export async function saveSignature(
  db: Db,
  input: { filingSessionId: string; orderId: string; signerName: string; signerTitle: string | null; entityName: string },
  audit: SignatureAudit,
): Promise<{ signature: DesigneeSignature; created: boolean }> {
  // Read first: the ON CONFLICT below only covers two requests racing.
  const before = await readSignature(db, input.filingSessionId);
  if (before) return { signature: before, created: false };
  const inserted = await db.query(
    `INSERT INTO ein_designee_authorizations
       (filing_session_id, order_id, statement_version, statement_text, statement_sha256,
        signer_name, signer_title, entity_name, consent, signed_at, authority_expires_at, ip, forwarded_for, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $10, $11, $12, $13)
     ON CONFLICT (filing_session_id, statement_version) DO NOTHING
     RETURNING ${SIGNATURE_COLUMNS}`,
    [
      input.filingSessionId,
      input.orderId,
      SS4_DESIGNEE_STATEMENT_VERSION,
      SS4_DESIGNEE_STATEMENT_TEXT,
      SS4_DESIGNEE_STATEMENT_SHA256,
      input.signerName,
      input.signerTitle,
      input.entityName,
      audit.now.toISOString(),
      authorityExpiresAt(audit.now).toISOString(),
      validIp(audit.ip),
      audit.forwardedFor ? audit.forwardedFor.slice(0, 300) : null,
      audit.userAgent ? audit.userAgent.slice(0, 300) : null,
    ],
  );
  if (inserted.rows.length) return { signature: toSignature(inserted.rows[0] as Record<string, unknown>), created: true };
  const existing = await readSignature(db, input.filingSessionId);
  if (!existing) throw new Error("designee signature conflict without a stored row");
  return { signature: existing, created: false };
}

/** Merged before migration 0040 ran: the route behaves as switched off. */
export function isMissingDesigneeTable(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  const message = typeof e?.message === "string" ? e.message : "";
  return message.includes('relation "ein_designee_authorizations" does not exist') && (e?.code === undefined || e.code === "42P01");
}
