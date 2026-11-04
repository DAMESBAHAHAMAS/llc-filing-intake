import { needsSunbizFiling } from "../offers/sunbizFiling.js";
import { HOUSE_REGISTERED_AGENT } from "../pdf/types.js";
import { escapeHtml } from "../registeredAgent/emailSender.js";

/**
 * The customer's order emails. Transactional only: no offers, no links to
 * sell anything, so they stay outside marketing consent rules. Payment
 * wording follows the published Terms (PaymentCancellationRefunds in
 * florida-business-launchpad); change it there first.
 *
 * Every email goes through render(), which always adds DISCLAIMER and
 * produces text and html from the same content, as the registered-agent
 * template does.
 */
export type OrderEmailType = "welcome" | "order_confirmation" | "intake_summary" | "filing_confirmation";

/** "hold": a card hold, collected after filing. "paid": collected at checkout. */
export type PaymentMode = "hold" | "paid";

export const DISCLAIMER = "Damian Knowles is a Business Developer, not a law firm or attorney, and does not provide legal advice.";
const REPLY_LINE = "Questions? Reply to this email.";

/** One order and its filing session, read when the email is sent. */
export interface OrderEmailRow {
  order_id: string;
  line_items: Array<{ offer_code?: string; display_name?: string; unit_amount_cents?: number; quantity?: number }> | null;
  total_cents: number;
  proof_of_filing_ref: string | null;
  email: string | null;
  full_name: string | null;
  phone: string | null;
  country: string | null;
  entity_name_primary: string | null;
  entity_name_backup: string | null;
  filing_data: Record<string, unknown> | null;
  registered_agent_status: string | null;
}

interface Person {
  name: string;
  title: string;
  address: string;
}

interface OrderEmailContext {
  orderId: string;
  paymentMode: PaymentMode;
  sunbizFiling: boolean;
  items: Array<{ name: string; quantity: number; cents: number }>;
  totalCents: number;
  documentNumber: string;
  customerName: string;
  email: string;
  phone: string;
  country: string;
  llcName: string;
  backupName: string;
  principalAddress: string;
  mailingAddress: string;
  effectiveDate: string;
  otherProvisions: string;
  people: Person[];
  agentName: string;
  agentAddress: string;
  agentAcceptancePending: boolean;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const SSN_OR_ITIN = /\b\d{3}-\d{2}-\d{4}\b|\b\d{3} \d{2} \d{4}\b|\b\d{9}\b/g;
const CARD_NUMBER = /\b\d(?:[ -]?\d){12,18}\b/g;
const ARTICLE_IV_TITLES: Record<string, string> = { AMBR: "Member", MGR: "Manager" };

/** Customer-typed text is echoed back, so a tax ID or card number typed
 *  into a free-text box must not travel by email. */
function customerText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(CARD_NUMBER, "[removed]").replace(SSN_OR_ITIN, "[removed]").trim();
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Fields are picked one by one. filing_data is never copied whole, so a
 *  key added to the intake later reaches an email only if it is added here. */
function buildContext(row: OrderEmailRow, paymentMode: PaymentMode): OrderEmailContext {
  const data = row.filing_data ?? {};
  const lineItems = row.line_items ?? [];
  const house = data.registered_agent_path === "house";
  const customerAgent = data.registered_agent_path === "customer";
  const effectiveOption = customerText(data.effective_date_option);
  const effectiveDate = customerText(data.effective_date);
  const people = Array.isArray(data.authorized_persons) ? (data.authorized_persons as Array<Record<string, unknown>>) : [];

  return {
    orderId: row.order_id,
    paymentMode,
    sunbizFiling: needsSunbizFiling(lineItems),
    items: lineItems.map((li) => ({
      name: customerText(li.display_name) || "Item",
      quantity: li.quantity ?? 1,
      cents: (li.unit_amount_cents ?? 0) * (li.quantity ?? 1),
    })),
    totalCents: row.total_cents,
    documentNumber: row.proof_of_filing_ref ?? "",
    customerName: customerText(row.full_name),
    email: row.email ?? "",
    phone: customerText(row.phone),
    country: customerText(row.country),
    llcName: customerText(data.llc_name) || customerText(row.entity_name_primary),
    backupName: customerText(row.entity_name_backup),
    principalAddress: customerText(data.principal_address),
    mailingAddress: customerText(data.mailing_address),
    effectiveDate: effectiveOption === "Immediate" ? "When filed" : [effectiveOption, effectiveDate].filter(Boolean).join(": "),
    otherProvisions: customerText(data.other_provisions),
    people: people.map((p) => ({
      name: customerText(p.name),
      title: ARTICLE_IV_TITLES[customerText(p.article_iv_title)] ?? customerText(p.article_iv_title),
      address: customerText(p.address),
    })),
    agentName: house ? HOUSE_REGISTERED_AGENT.name : customerAgent ? customerText(data.registered_agent_name) : "",
    agentAddress: house
      ? HOUSE_REGISTERED_AGENT.florida_address
      : customerAgent
        ? customerText(data.registered_agent_florida_address)
        : "",
    agentAcceptancePending: customerAgent && row.registered_agent_status !== "accepted",
  };
}

type Block =
  | { kind: "p"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "steps"; items: string[] }
  | { kind: "rows"; rows: Array<[string, string]> };

const p = (text: string): Block => ({ kind: "p", text });
const heading = (text: string): Block => ({ kind: "heading", text });
const steps = (items: string[]): Block => ({ kind: "steps", items });
/** Rows with nothing in them are left out, so an empty intake field shows no label. */
const rows = (entries: Array<[string, string]>): Block => ({ kind: "rows", rows: entries.filter(([, value]) => value) });

function renderText(blocks: Block[]): string {
  const parts = blocks.flatMap((b) => {
    if (b.kind === "p" || b.kind === "heading") return [b.text];
    if (b.kind === "steps") return [b.items.map((item, i) => `${i + 1}. ${item}`).join("\n")];
    return b.rows.length ? [b.rows.map(([label, value]) => `${label}: ${value}`).join("\n")] : [];
  });
  return parts.join("\n\n");
}

function renderHtml(blocks: Block[]): string {
  const parts = blocks.map((b) => {
    if (b.kind === "p") return `<p>${escapeHtml(b.text)}</p>`;
    if (b.kind === "heading") return `<h3 style="margin-bottom: 4px;">${escapeHtml(b.text)}</h3>`;
    if (b.kind === "steps") return `<ol>${b.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>`;
    if (!b.rows.length) return "";
    const cells = b.rows
      .map(
        ([label, value]) =>
          `<tr><td style="padding: 2px 16px 2px 0; color: #666; vertical-align: top;">${escapeHtml(label)}</td><td style="padding: 2px 0;">${escapeHtml(value)}</td></tr>`
      )
      .join("");
    return `<table style="border-collapse: collapse;">${cells}</table>`;
  });
  return `<div style="font-family: sans-serif; line-height: 1.5; color: #333;">${parts.join("")}</div>`;
}

function render(subject: string, blocks: Block[]): RenderedEmail {
  const all = [...blocks, p(DISCLAIMER)];
  return { subject: subject.replace(/[\r\n]+/g, " "), text: renderText(all), html: renderHtml(all) };
}

function greeting(ctx: OrderEmailContext): Block {
  const firstName = ctx.customerName.split(/\s+/)[0];
  return p(firstName ? `Hi ${firstName},` : "Hello,");
}

function companyLabel(ctx: OrderEmailContext): string {
  return ctx.llcName || "your LLC";
}

function welcome(ctx: OrderEmailContext): RenderedEmail {
  const company = companyLabel(ctx);
  const nextSteps = ctx.sunbizFiling
    ? [
        "We review what you submitted.",
        ...(ctx.agentAcceptancePending ? [`${ctx.agentName || "Your registered agent"} must accept the registered agent role. We cannot file until they do.`] : []),
        "We file your Articles of Organization with the State of Florida through Sunbiz.",
        "We email your filing confirmation with your Sunbiz document number.",
      ]
    : ["We review what you submitted.", "We start work on your order and email you when it is complete."];

  return render(ctx.sunbizFiling ? `Welcome. We have your order for ${company}` : "Welcome. We have your order", [
    greeting(ctx),
    p(ctx.sunbizFiling ? `Thank you for choosing us to form ${company}. Your order is in.` : "Thank you for your order. It is in."),
    heading("What happens next"),
    steps(nextSteps),
    p("Two more emails are coming: your order confirmation and a summary of what you submitted."),
    p(REPLY_LINE),
  ]);
}

function paymentTerms(ctx: OrderEmailContext): Block[] {
  const total = money(ctx.totalCents);
  if (ctx.paymentMode === "paid") {
    return [p(`We charged ${total} to your card at checkout.`), p(REPLY_LINE)];
  }
  const charged = ctx.sunbizFiling
    ? "We charge your card only after the Florida Division of Corporations has filed your Articles of Organization. We email your filing confirmation when we do."
    : "We charge your card only after your filing is complete. We email you when it is.";
  const lapse = ctx.sunbizFiling
    ? "A card hold lasts about 7 days. If your filing is not complete by then, the hold drops off and we charge the same card once your LLC is filed."
    : "A card hold lasts about 7 days. If your filing is not complete by then, the hold drops off and we charge the same card once it is complete.";
  return [
    p(`We placed a hold of ${total} on your card. A hold is not a charge: no money leaves your account.`),
    p(charged),
    p(lapse),
    p("You can cancel any time before we submit your filing. We release the hold and you are not charged. To cancel, reply to this email."),
  ];
}

function orderConfirmation(ctx: OrderEmailContext): RenderedEmail {
  return render(ctx.sunbizFiling ? `Order confirmation for ${companyLabel(ctx)}` : "Order confirmation", [
    greeting(ctx),
    rows([
      ["Order number", ctx.orderId],
      ["Company", ctx.llcName],
    ]),
    heading("Your order"),
    rows([
      ...ctx.items.map((item): [string, string] => [item.quantity > 1 ? `${item.name} x ${item.quantity}` : item.name, money(item.cents)]),
      ["Total", money(ctx.totalCents)],
    ]),
    heading("Payment"),
    ...paymentTerms(ctx),
  ]);
}

function intakeSummary(ctx: OrderEmailContext): RenderedEmail {
  const company = companyLabel(ctx);
  const agentRows = rows([
    ["Name", ctx.agentName],
    ["Florida address", ctx.agentAddress],
    ["Status", ctx.agentAcceptancePending ? "Waiting for their acceptance" : ""],
  ]);
  const companyRows = rows([
    ["Company name", ctx.llcName],
    ["Backup name", ctx.backupName],
    ["Principal address", ctx.principalAddress],
    ["Mailing address", ctx.mailingAddress],
    ["Effective date", ctx.effectiveDate],
  ]);
  const hasRows = (block: Block) => block.kind === "rows" && block.rows.length > 0;

  return render(ctx.sunbizFiling ? `Please check what you submitted for ${company}` : "Please check what you submitted", [
    greeting(ctx),
    p("This is what you gave us. Please check it now. If anything is wrong, reply to this email before we file."),
    ...(ctx.sunbizFiling ? [p("Florida does not allow a submitted filing to be withdrawn.")] : []),
    heading("Your details"),
    rows([
      ["Name", ctx.customerName],
      ["Email", ctx.email],
      ["Phone", ctx.phone],
      ["Country", ctx.country],
    ]),
    ...(hasRows(companyRows) ? [heading("Company"), companyRows] : []),
    ...(hasRows(agentRows) ? [heading("Registered agent"), agentRows] : []),
    ...(ctx.people.length
      ? [
          heading("People on the filing"),
          rows(ctx.people.map((person): [string, string] => [person.title ? `${person.name} (${person.title})` : person.name, person.address || "No address given"])),
        ]
      : []),
    ...(ctx.otherProvisions ? [heading("Other provisions"), p(ctx.otherProvisions)] : []),
  ]);
}

function filingConfirmation(ctx: OrderEmailContext): RenderedEmail {
  const payment =
    ctx.paymentMode === "paid"
      ? "You paid for this order at checkout."
      : "We are now collecting payment for this order from the card you used at checkout, as your order confirmation explained.";

  // An EIN-only order records the EIN as its proof (routes/orders.ts). That
  // number stays out of email, and it is not a Sunbiz document number.
  if (!ctx.sunbizFiling) {
    return render("Your filing is complete", [greeting(ctx), p("Your filing for this order is complete."), p(payment), p(REPLY_LINE)]);
  }

  const company = companyLabel(ctx);
  return render(`Your LLC is filed: ${company}`, [
    greeting(ctx),
    p(`The Florida Division of Corporations has filed the Articles of Organization for ${company}.`),
    rows([
      ["Sunbiz document number", ctx.documentNumber],
      ["Order number", ctx.orderId],
    ]),
    p("You can look up your company on sunbiz.org with this number."),
    p(payment),
    p(REPLY_LINE),
  ]);
}

export function buildOrderEmail(type: OrderEmailType, row: OrderEmailRow, paymentMode: PaymentMode): RenderedEmail {
  const ctx = buildContext(row, paymentMode);
  switch (type) {
    case "welcome":
      return welcome(ctx);
    case "order_confirmation":
      return orderConfirmation(ctx);
    case "intake_summary":
      return intakeSummary(ctx);
    case "filing_confirmation":
      return filingConfirmation(ctx);
  }
}
