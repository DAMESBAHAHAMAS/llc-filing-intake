import type { ArticlesOfOrganizationContext } from "./composeArticlesOfOrganizationContext.js";

/**
 * Calls the EXISTING /generate-pdf service (render_pdf.py, Flask +
 * WeasyPrint — a separately-managed Render dashboard service per
 * render.yaml's own comment) with this composer's output. This file adds
 * no PDF generation of its own and creates no new endpoint — it is
 * strictly the HTTP client for the {template, context} contract
 * render_pdf.py already exposes.
 *
 * PDF_SERVICE_URL is the base URL only (e.g. https://<service>.onrender.com
 * in production, http://localhost:5000 for local testing) — not
 * documented in .env.example yet since nothing calls this function from
 * a live route today (see types.ts's note on why: the `filing_sessions`
 * table doesn't yet store the fields this composer needs).
 */
export async function generateArticlesOfOrganizationPdf(
  context: ArticlesOfOrganizationContext,
  baseUrl: string | undefined = process.env.PDF_SERVICE_URL
): Promise<Buffer> {
  if (!baseUrl) {
    throw new Error("PDF_SERVICE_URL is not set.");
  }

  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/generate-pdf`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template: "articles_of_organization", context }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`PDF generation failed (${res.status}): ${body}`);
  }

  return Buffer.from(await res.arrayBuffer());
}
