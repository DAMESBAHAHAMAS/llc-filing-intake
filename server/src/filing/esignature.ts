/**
 * T144 Dispatch 9: the e-signature audit record for the Articles of
 * Organization.
 *
 * The website (florida-business-launchpad src/lib/canonicalFilingData.ts,
 * buildEsignature) sends filing_data.esignature once the Signature step is
 * complete: the typed full legal name, the signer's title, the 18+ and
 * consent confirmations, the consent wording and its version, and signed_at
 * (the browser's clock). The browser's clock is not trusted on its own, so
 * POST /api/session/stage stamps the server's receipt time, the client IP
 * and the user agent onto the same record before it is stored.
 *
 * The IP address and user agent are audit data only. They are never printed
 * on the Articles, which become a public record at Sunbiz.
 */
import type { ESignatureRecord } from "../pdf/types.js";

const MAX_TEXT = 500;

function cleanText(v: unknown, max = MAX_TEXT): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

/**
 * Returns filing_data with its esignature record cleaned and stamped, or
 * filing_data unchanged when it carries no usable esignature record. A
 * record without a signer name or a valid signed_at is dropped rather than
 * stored half-empty.
 */
export function stampEsignature(
  filingData: unknown,
  stamp: { now: Date; ip: string | null | undefined; userAgent: string | null | undefined }
): unknown {
  if (!filingData || typeof filingData !== "object" || Array.isArray(filingData)) return filingData;
  const fd = filingData as Record<string, unknown>;
  if (!("esignature" in fd)) return filingData;

  const raw = fd.esignature;
  const { esignature: _drop, ...rest } = fd;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return rest;
  const r = raw as Record<string, unknown>;

  const signerName = cleanText(r.signer_name, 200);
  const signedAt = cleanText(r.signed_at, 40);
  if (!signerName || !signedAt || Number.isNaN(Date.parse(signedAt))) return rest;

  const record: ESignatureRecord = {
    signer_name: signerName,
    signer_title: cleanText(r.signer_title, 100),
    over_18_confirmed: r.over_18_confirmed === true,
    consent_text: cleanText(r.consent_text),
    consent_version: cleanText(r.consent_version, 60),
    method: cleanText(r.method, 40),
    signed_at: new Date(signedAt).toISOString(),
    server_received_at: stamp.now.toISOString(),
    ip: stamp.ip ?? null,
    user_agent: cleanText(stamp.userAgent ?? undefined, 300),
  };
  for (const k of Object.keys(record) as (keyof ESignatureRecord)[]) if (record[k] === undefined) delete record[k];
  return { ...rest, esignature: record };
}

/** "November 25, 2026" in Florida (Eastern) time, for the Articles' signature line. */
export function floridaLongDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(iso));
}
