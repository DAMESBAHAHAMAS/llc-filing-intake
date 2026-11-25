/**
 * Renders the Operating Agreement from fictional sample data through the
 * real PDF service, so the wording and layout can be reviewed as PDFs.
 * Never uses customer data and never sends anything.
 *
 *   PDF_SERVICE_URL=http://localhost:5055 npx tsx src/scripts/renderOperatingAgreementSamples.ts ./oa-samples
 *
 * Output PDFs carry the "Review copy. Not for customer delivery." banner
 * until the PDF output is approved (OPERATING_AGREEMENT_WORDING_APPROVED).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildOperatingAgreementContext, type OperatingAgreementInputs } from "../pdf/operatingAgreementContext.js";
import { generateOperatingAgreementPdf } from "../pdf/serviceClient.js";
import type { FilingSessionRecord } from "../pdf/types.js";

const filed = { filing_date: "2026-10-01", document_number: "L26000000000" };

const samples: Array<{ file: string; filing: Partial<FilingSessionRecord>; inputs?: OperatingAgreementInputs }> = [
  {
    file: "sample-single-member-member-managed.pdf",
    filing: {
      llc_name: "Sample Coastal Ventures LLC",
      principal_address: "100 Sample Street, Suite 2, Miami, FL 33101",
      mailing_address: "100 Sample Street, Suite 2, Miami, FL 33101",
      registered_agent_path: "house",
      authorized_persons: [{ article_iv_title: "AMBR", name: "Jordan Sample", address: "100 Sample Street, Miami, FL 33101" }],
      effective_date_option: "Immediate",
    },
  },
  {
    file: "sample-single-member-manager-managed.pdf",
    filing: {
      llc_name: "Sample Harbor Holdings LLC",
      principal_address: "200 Example Avenue, Orlando, FL 32801",
      mailing_address: "PO Box 200, Orlando, FL 32802",
      registered_agent_path: "customer",
      registered_agent_name: "Sample Agent Services Inc.",
      registered_agent_florida_address: "300 Agent Way, Tallahassee, FL 32301",
      authorized_persons: [{ article_iv_title: "MGR", name: "Casey Example", address: "200 Example Avenue, Orlando, FL 32801" }],
      effective_date_option: "Future",
      effective_date: "2026-10-15",
      annual_report_due_date: "2027-05-01",
    },
    inputs: {
      members: [{ name: "Morgan Example", address: "200 Example Avenue, Orlando, FL 32801", contribution: "$2,500 cash" }],
      successor_name: "Riley Example",
    },
  },
  {
    file: "sample-multi-member.pdf",
    filing: {
      llc_name: "Sample Partners & Co. LLC",
      principal_address: "400 Demo Boulevard, Tampa, FL 33602",
      mailing_address: "400 Demo Boulevard, Tampa, FL 33602",
      registered_agent_path: "house",
      authorized_persons: [
        { article_iv_title: "AMBR", name: "Avery Demo", address: "400 Demo Boulevard, Tampa, FL 33602" },
        { article_iv_title: "AMBR", name: "Sam Demo", address: "12 Test Lane, St. Petersburg, FL 33701" },
      ],
      effective_date_option: "Immediate",
    },
    inputs: {
      members: [
        { name: "Avery Demo", address: "400 Demo Boulevard, Tampa, FL 33602", contribution: "$6,000 cash", percentage: 60 },
        { name: "Sam Demo", address: "12 Test Lane, St. Petersburg, FL 33701", contribution: "Equipment valued at $4,000", percentage: 40 },
      ],
      borrowing_limit: "$25,000",
      payment_period_months: 24,
      partnership_representative: "Avery Demo",
    },
  },
  {
    file: "sample-multi-member-manager-managed.pdf",
    filing: {
      llc_name: "Sample Grove Properties LLC",
      principal_address: "500 Placeholder Road, Gainesville, FL 32601",
      mailing_address: "500 Placeholder Road, Gainesville, FL 32601",
      registered_agent_path: "house",
      authorized_persons: [
        { article_iv_title: "MGR", name: "Taylor Placeholder", address: "500 Placeholder Road, Gainesville, FL 32601" },
      ],
      effective_date_option: "Immediate",
    },
    inputs: {
      members: [
        { name: "Jamie Placeholder", address: "500 Placeholder Road, Gainesville, FL 32601", contribution: "$5,000 cash", percentage: 50 },
        { name: "Robin Placeholder", address: "77 Fictional Court, Ocala, FL 34470", contribution: "$3,000 cash", percentage: 30 },
        { name: "Drew Placeholder", address: "9 Sample Circle, Jacksonville, FL 32202", percentage: 20 },
      ],
      borrowing_limit: "$50,000",
      payment_period_months: 36,
      partnership_representative: "Jamie Placeholder",
    },
  },
];

async function main() {
  const outDir = process.argv[2] ?? "./oa-samples";
  mkdirSync(outDir, { recursive: true });
  let failures = 0;

  for (const s of samples) {
    const built = buildOperatingAgreementContext(s.filing, filed, s.inputs);
    if (!built.ok) {
      console.error(`${s.file}: completeness gap: ${built.missingFields.join("; ")}`);
      failures++;
      continue;
    }
    const pdf = await generateOperatingAgreementPdf(built.template, built.context);
    if (!pdf.ok) {
      console.error(`${s.file}: PDF service error: ${pdf.error}`);
      failures++;
      continue;
    }
    writeFileSync(join(outDir, s.file), pdf.pdfBytes);
    console.log(`${s.file}: ${built.template}, ${pdf.pdfBytes.length} bytes, sha256 ${pdf.sha256.slice(0, 12)}`);
  }

  if (failures > 0) process.exit(1);
}

main();
