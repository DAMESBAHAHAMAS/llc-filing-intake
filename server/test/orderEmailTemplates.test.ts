import { describe, expect, it } from "vitest";
import { buildOrderEmail, DISCLAIMER, type OrderEmailRow, type OrderEmailType } from "../src/orderEmails/templates.js";

const row = (over: Partial<OrderEmailRow> = {}): OrderEmailRow => ({
  order_id: "0f6c1d3e-1111-4a2b-9c3d-000000000001",
  line_items: [
    { offer_code: "FASTTRACK", display_name: "FastTrack LLC Filing", unit_amount_cents: 19900, quantity: 1 },
    { offer_code: "REGISTERED_AGENT_3YR", display_name: "Registered Agent, 3 years", unit_amount_cents: 5000, quantity: 1 },
  ],
  total_cents: 24900,
  proof_of_filing_ref: "L26000123456",
  email: "ana@example.com",
  full_name: "Ana Sol",
  phone: "+1 954 555 0100",
  country: "Brazil",
  entity_name_primary: "Sol Ventures LLC",
  entity_name_backup: "Sol Holdings LLC",
  filing_data: {
    llc_name: "Sol Ventures LLC",
    principal_address: "100 Main St, Miami, FL, 33101-1234",
    mailing_address: "100 Main St, Miami, FL, 33101-1234",
    registered_agent_path: "house",
    authorized_persons: [{ name: "Ana Sol", article_iv_title: "AMBR", address: "100 Main St, Miami, FL" }],
    effective_date_option: "Immediate",
    other_provisions: "None",
  },
  registered_agent_status: "accepted",
  ...over,
});

const ALL: OrderEmailType[] = ["welcome", "order_confirmation", "intake_summary", "filing_confirmation"];

describe("every order email", () => {
  it.each(ALL)("%s carries the approved disclaimer in text and html, and has no selling content", (type) => {
    const email = buildOrderEmail(type, row(), "hold");
    expect(email.text).toContain(DISCLAIMER);
    expect(email.html).toContain("not a law firm or attorney");
    expect(`${email.text} ${email.html}`).not.toMatch(/unsubscribe|https?:\/\/|% off|upgrade|special offer/i);
  });

  it.each(ALL)("%s never carries a tax ID, card number or secret", (type) => {
    const email = buildOrderEmail(
      type,
      row({
        full_name: "Ana 123-45-6789 Sol",
        filing_data: {
          ...row().filing_data,
          ssn: "111-22-3333",
          itin: "912-70-1234",
          tax_id: "987654321",
          card_number: "4242424242424242",
          api_key: "sk_live_should_never_appear",
          other_provisions: "My SSN is 123-45-6789, ITIN 912 70 1234, card 4242 4242 4242 4242, id 123456789.",
        },
      }),
      "hold"
    );
    const all = `${email.subject} ${email.text} ${email.html}`;
    for (const secret of ["123-45-6789", "111-22-3333", "912-70-1234", "912 70 1234", "987654321", "123456789", "4242", "sk_live"]) {
      expect(all).not.toContain(secret);
    }
  });

  it("escapes customer text in html and keeps the subject on one line", () => {
    const email = buildOrderEmail("welcome", row({ filing_data: { llc_name: "<b>Sol</b>\r\nBcc: x@example.com LLC" } }), "hold");
    expect(email.html).not.toContain("<b>Sol</b>");
    expect(email.html).toContain("&lt;b&gt;Sol&lt;/b&gt;");
    expect(email.subject).not.toMatch(/[\r\n]/);
  });
});

describe("welcome", () => {
  it("names the company and the steps ahead", () => {
    const email = buildOrderEmail("welcome", row(), "hold");
    expect(email.subject).toBe("Welcome. We have your order for Sol Ventures LLC");
    expect(email.text).toContain("Hi Ana,");
    expect(email.text).toContain("We email your filing confirmation with your Sunbiz document number.");
    expect(email.text).not.toContain("must accept");
  });

  it("tells the customer when their own agent must accept first", () => {
    const email = buildOrderEmail(
      "welcome",
      row({ filing_data: { llc_name: "Sol", registered_agent_path: "customer", registered_agent_name: "Rae Agent" }, registered_agent_status: "pending" }),
      "hold"
    );
    expect(email.text).toContain("Rae Agent must accept the registered agent role. We cannot file until they do.");
  });
});

describe("order confirmation", () => {
  it("says a hold is not a charge and repeats the published payment terms", () => {
    const { subject, text } = buildOrderEmail("order_confirmation", row(), "hold");
    expect(subject).toBe("Order confirmation for Sol Ventures LLC");
    expect(text).toContain("We placed a hold of $249.00 on your card. A hold is not a charge: no money leaves your account.");
    expect(text).toContain("after the Florida Division of Corporations has filed your Articles of Organization");
    expect(text).toContain("A card hold lasts about 7 days.");
    expect(text).toContain("To cancel, reply to this email.");
    expect(text).toContain("FastTrack LLC Filing: $199.00");
    expect(text).toContain("Total: $249.00");
  });

  it("states a charge, not a hold, when the card was charged at checkout", () => {
    const { text } = buildOrderEmail("order_confirmation", row(), "paid");
    expect(text).toContain("We charged $249.00 to your card at checkout.");
    expect(text).not.toMatch(/hold/i);
  });

  it("does not promise a state filing on an EIN-only hold", () => {
    const { text } = buildOrderEmail(
      "order_confirmation",
      row({ line_items: [{ offer_code: "EIN_FILING", display_name: "EIN Filing", unit_amount_cents: 7500, quantity: 1 }], total_cents: 7500 }),
      "hold"
    );
    expect(text).toContain("We charge your card only after your filing is complete.");
    expect(text).not.toContain("Division of Corporations");
  });
});

describe("intake summary", () => {
  it("lists what the customer submitted, with the server-stamped agent", () => {
    const { text } = buildOrderEmail("intake_summary", row(), "hold");
    expect(text).toContain("Company name: Sol Ventures LLC");
    expect(text).toContain("Backup name: Sol Holdings LLC");
    expect(text).toContain("Principal address: 100 Main St, Miami, FL, 33101-1234");
    expect(text).toContain("Name: Damian Knowles");
    expect(text).toContain("Florida address: 3850 South University Drive, Unit #291921, Davie, Florida 33329");
    expect(text).toContain("Ana Sol (Member): 100 Main St, Miami, FL");
    expect(text).toContain("Effective date: When filed");
    expect(text).toContain("Phone: +1 954 555 0100");
  });

  it("shows the customer's own agent and that acceptance is outstanding", () => {
    const { text } = buildOrderEmail(
      "intake_summary",
      row({
        filing_data: {
          registered_agent_path: "customer",
          registered_agent_name: "Rae Agent",
          registered_agent_florida_address: "5 Bay Rd, Tampa, FL 33601",
          registered_agent_email: "rae@example.com",
        },
        registered_agent_status: "acceptance_requested",
      }),
      "hold"
    );
    expect(text).toContain("Name: Rae Agent");
    expect(text).toContain("Status: Waiting for their acceptance");
    expect(text).not.toContain("rae@example.com");
    expect(text).not.toContain("Damian Knowles\n");
  });

  it("leaves out sections with nothing in them", () => {
    const { text } = buildOrderEmail("intake_summary", row({ filing_data: null, entity_name_primary: null, entity_name_backup: null }), "paid");
    expect(text).not.toContain("Registered agent");
    expect(text).not.toContain("Company name");
    expect(text).not.toContain("People on the filing");
  });
});

describe("filing confirmation", () => {
  it("gives the Sunbiz document number and says payment is now being collected", () => {
    const { subject, text, html } = buildOrderEmail("filing_confirmation", row(), "hold");
    expect(subject).toBe("Your LLC is filed: Sol Ventures LLC");
    expect(text).toContain("Sunbiz document number: L26000123456");
    expect(html).toContain("L26000123456");
    expect(text).toContain("We are now collecting payment");
  });

  it("says nothing is being collected when the order was paid at checkout", () => {
    const { text } = buildOrderEmail("filing_confirmation", row(), "paid");
    expect(text).toContain("You paid for this order at checkout.");
    expect(text).not.toContain("now collecting");
  });

  it("keeps an EIN out of the email on an EIN-only order", () => {
    const { text, subject } = buildOrderEmail(
      "filing_confirmation",
      row({ line_items: [{ offer_code: "EIN_FILING", display_name: "EIN Filing", unit_amount_cents: 7500, quantity: 1 }], proof_of_filing_ref: "12-3456789" }),
      "hold"
    );
    expect(subject).toBe("Your filing is complete");
    expect(text).not.toContain("3456789");
    expect(text).not.toContain("Sunbiz");
  });
});
