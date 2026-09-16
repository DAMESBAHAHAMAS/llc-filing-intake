import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { hashToken } from "../registeredAgent/token.js";

/**
 * Persists the exact PDF bytes generated for one fulfillment attempt —
 * the authoritative retained artifact (migration 0011's own comment on
 * filing_documents: "prove precisely what was transmitted"). Called
 * once per attempt, right after generateArticlesOfOrganizationPdf
 * succeeds and before any transmission is attempted, so a document
 * always exists before fulfillment_transmissions ever references one.
 */
export async function storeFilingDocument(
  pool: Pool,
  input: { filingSessionId: string; orderId: string; pdfBytes: Buffer }
): Promise<{ documentId: number; sha256: string; byteSize: number }> {
  const sha256 = createHash("sha256").update(input.pdfBytes).digest("hex");
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO filing_documents (filing_session_id, order_id, document_type, content_type, byte_size, sha256, pdf_bytes)
     VALUES ($1, $2, 'articles_of_organization', 'application/pdf', $3, $4, $5)
     RETURNING id`,
    [input.filingSessionId, input.orderId, input.pdfBytes.length, sha256, input.pdfBytes]
  );
  return { documentId: Number(rows[0].id), sha256, byteSize: input.pdfBytes.length };
}

/**
 * Mints a one-time-use capability URL token for a fax provider to fetch
 * one document. Same discipline as registeredAgent/token.ts (which this
 * reuses directly, not a parallel copy): the raw secret is returned to
 * the caller to embed in the media_url handed to the provider, and only
 * its sha256 hash is ever persisted (fulfillment_transmissions.media_access_token_id).
 */
export function mintMediaAccessToken(): { raw: string; tokenId: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, tokenId: hashToken(raw) };
}

export interface MediaDocument {
  pdfBytes: Buffer;
  contentType: string;
  byteSize: number;
}

/**
 * The ONLY lookup path routes/faxMedia.ts uses. Validates the token hash
 * and expiry together in one query — an expired or unknown token returns
 * null indistinguishably (never reveals which case it was, matching
 * registeredAgent's acceptance-token lookup posture). Does not consume
 * the token (a fax provider may retry the GET a few times while
 * transmitting) — expiry alone bounds its lifetime.
 */
export async function getDocumentByMediaToken(pool: Pool, rawToken: string): Promise<MediaDocument | null> {
  const tokenId = hashToken(rawToken);
  const { rows } = await pool.query<{ pdf_bytes: Buffer; content_type: string; byte_size: number }>(
    `SELECT d.pdf_bytes, d.content_type, d.byte_size
     FROM fulfillment_transmissions t
     JOIN filing_documents d ON d.id = t.document_id
     WHERE t.media_access_token_id = $1
       AND t.media_access_expires_at > now()`,
    [tokenId]
  );
  const row = rows[0];
  if (!row) return null;
  return { pdfBytes: row.pdf_bytes, contentType: row.content_type, byteSize: row.byte_size };
}
