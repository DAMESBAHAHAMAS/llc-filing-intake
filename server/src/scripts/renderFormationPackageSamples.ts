/**
 * Assembles two complete formation packages from fictional sample data
 * through the real PDF service (render + merge), so the package can be
 * reviewed end to end. Never uses customer data and never sends anything.
 * The state's filing confirmation is a labelled placeholder page here;
 * a real package requires the real document.
 *
 *   PDF_SERVICE_URL=http://localhost:5055 npx tsx src/scripts/renderFormationPackageSamples.ts ./package-samples
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPdfContext } from "../pdf/context.js";
import {
  buildCoverLetterContext,
  buildNextStepsContext,
  includesOperatingAgreement,
  orderPackageParts,
  type FormationPackageOrder,
} from "../pdf/formationPackage.js";
import { buildOperatingAgreementContext } from "../pdf/operatingAgreementContext.js";
import {
  generateArticlesOfOrganizationPdf,
  generateFormationPagePdf,
  generateOperatingAgreementPdf,
  mergePdfs,
  type PdfGenerationResult,
} from "../pdf/serviceClient.js";
import type { FilingSessionRecord } from "../pdf/types.js";

const filed = { filing_date: "2026-10-01", document_number: "L26000000000" };
const BOOKING_LINK = "bookings.damianknowles.com/3848045000008383019";

const samples: Array<{ file: string; filing: Partial<FilingSessionRecord>; order: FormationPackageOrder }> = [
  {
    file: "sample-package-premium-with-ein.pdf",
    filing: {
      llc_name: "Sample Coastal Ventures LLC",
      principal_address: "100 Sample Street, Suite 2, Miami, FL 33101",
      mailing_address: "100 Sample Street, Suite 2, Miami, FL 33101",
      registered_agent_path: "house",
      authorized_persons: [{ article_iv_title: "AMBR", name: "Jordan Sample", address: "100 Sample Street, Miami, FL 33101" }],
      effective_date_option: "Immediate",
    },
    order: { customer_first_name: "Jordan", order_total_cents: 129800, package: "premium", ein_ordered: true, booking_link: BOOKING_LINK },
  },
  {
    file: "sample-package-fasttrack.pdf",
    filing: {
      llc_name: "Sample Harbor Holdings LLC",
      principal_address: "200 Example Avenue, Orlando, FL 32801",
      mailing_address: "PO Box 200, Orlando, FL 32802",
      registered_agent_path: "house",
      authorized_persons: [{ article_iv_title: "AMBR", name: "Casey Example", address: "200 Example Avenue, Orlando, FL 32801" }],
      effective_date_option: "Future",
      effective_date: "2026-10-15",
      annual_report_due_date: "2027-05-01",
    },
    order: { customer_first_name: "Casey", order_total_cents: 49900, package: "fasttrack", ein_ordered: false, booking_link: BOOKING_LINK },
  },
];

function need(label: string, r: PdfGenerationResult): Buffer {
  if (!r.ok) throw new Error(`${label}: ${r.error}`);
  return r.pdfBytes;
}

function gaps(label: string, r: { ok: true } | { ok: false; missingFields: string[] }): void {
  if (!r.ok) throw new Error(`${label}: completeness gap: ${r.missingFields.join("; ")}`);
}

async function main() {
  const outDir = process.argv[2] ?? "./package-samples";
  mkdirSync(outDir, { recursive: true });

  for (const s of samples) {
    const letter = buildCoverLetterContext(s.filing, filed, s.order);
    gaps("cover letter", letter);
    const steps = buildNextStepsContext(s.order);
    gaps("next steps", steps);
    const articlesCtx = buildPdfContext(s.filing, null);
    gaps("articles", articlesCtx);

    const parts = {
      coverLetter: need("cover letter", await generateFormationPagePdf("formation_cover_letter", (letter as { context: Record<string, unknown> }).context)),
      articles: need("articles", await generateArticlesOfOrganizationPdf((articlesCtx as { context: Record<string, unknown> }).context)),
      filingConfirmation: need(
        "placeholder",
        await generateFormationPagePdf("formation_placeholder_page", {
          title: "State filing confirmation",
          note: "In a real package, the filing confirmation received from the Florida Division of Corporations goes here.",
        })
      ),
      nextSteps: need("next steps", await generateFormationPagePdf("formation_next_steps", (steps as { context: Record<string, unknown> }).context)),
      operatingAgreement: undefined as Buffer | undefined,
    };

    if (includesOperatingAgreement(s.order.package!)) {
      const oa = buildOperatingAgreementContext(s.filing, filed);
      gaps("operating agreement", oa);
      if (oa.ok) parts.operatingAgreement = need("operating agreement", await generateOperatingAgreementPdf(oa.template, oa.context));
    }

    const ordered = orderPackageParts(s.order.package!, parts);
    gaps("package", ordered);
    if (!ordered.ok) continue;
    const merged = need("merge", await mergePdfs(ordered.parts, s.file.replace(/\.pdf$/, "")));
    writeFileSync(join(outDir, s.file), merged);
    console.log(`${s.file}: ${ordered.parts.length} parts, ${merged.length} bytes`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
