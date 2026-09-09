import { createHash } from "node:crypto";

export interface PdfGenerationSuccess {
  ok: true;
  pdfBytes: Buffer;
  sha256: string;
}
export interface PdfGenerationFailure {
  ok: false;
  httpStatus?: number;
  missingFields?: string[];
  error: string;
}
export type PdfGenerationResult = PdfGenerationSuccess | PdfGenerationFailure;

/**
 * Calls the existing llc-pdf-generator Flask/WeasyPrint service
 * (render_pdf.py — not replaced, only hardened: StrictUndefined +
 * shared-secret auth, see DECISIONS.md). context must already be
 * validated complete by pdf/context.ts's buildPdfContext() before this
 * is ever called — a 422 here (missing_required_template_variable) would
 * mean that validation has a gap, not that this is the intended way to
 * discover missing fields.
 */
export async function generateArticlesOfOrganizationPdf(context: Record<string, unknown>): Promise<PdfGenerationResult> {
  const baseUrl = process.env.PDF_SERVICE_URL;
  const apiKey = process.env.PDF_SERVICE_API_KEY;
  if (!baseUrl) {
    return { ok: false, error: "server misconfigured: PDF_SERVICE_URL not set" };
  }

  try {
    const res = await fetch(`${baseUrl}/generate-pdf`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "X-PDF-Service-Key": apiKey } : {}),
      },
      body: JSON.stringify({ template: "articles_of_organization", context }),
    });

    if (!res.ok) {
      if (res.status === 422) {
        const body = (await res.json().catch(() => ({}))) as { detail?: string };
        return { ok: false, httpStatus: 422, error: body.detail ?? "missing required template variable" };
      }
      const text = await res.text().catch(() => "");
      return { ok: false, httpStatus: res.status, error: `PDF service returned ${res.status}: ${text.slice(0, 500)}` };
    }

    const arrayBuffer = await res.arrayBuffer();
    const pdfBytes = Buffer.from(arrayBuffer);
    const sha256 = createHash("sha256").update(pdfBytes).digest("hex");
    return { ok: true, pdfBytes, sha256 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
