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
    // The one link allowed: the published payment terms (order confirmation,
    // Damian's hold wording of 24 Nov 2026). No other link of any kind.
    const body = `${email.text} ${email.html}`.split("https://damianknowles.com/refund-policy").join("");
    expect(body).not.toMatch(/unsubscribe|https?:\/\/|% off|upgrade|special offer/i);
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
    const { subject, text, html } = buildOrderEmail("order_confirmation", row(), "hold");
    expect(subject).toBe("Order confirmation for Sol Ventures LLC");
    expect(text).toContain("We placed a temporary hold of $249.00 on your card. A hold is not a charge\u2014no money leaves your account.");
    expect(text).toContain("When You Are Actually Charged");
    expect(text).toContain(
      "We charge your card only after the Florida Division of Corporations officially files your Articles of Organization. As soon as your LLC is filed, we will email your filing confirmation and process the payment."
    );
    expect(text).toContain("- Duration: A card hold may last up to 7 days.");
    expect(text).toContain(
      "- If Filing Takes Longer: If your filing is not complete within 5 days, we release the hold, so nothing is charged, and email you a secure payment link for the same amount."
    );
    expect(text).toContain("To cancel, simply reply to this email.");
    expect(text).toContain("review our Payment Protection Promise (https://damianknowles.com/refund-policy).");
    expect(text).toContain("FastTrack LLC Filing: $199.00");
    expect(text).toContain("Total: $249.00");
    expect(text).toContain("---\nDamian Knowles is a Business Developer");

    expect(html).toContain("<strong>A hold is not a charge</strong>");
    expect(html).toContain("<strong>only after</strong>");
    expect(html).toContain("<li><strong>Duration:</strong> A card hold <strong>may last up to 7 days</strong>.</li>");
    expect(html).toContain('<a href="https://damianknowles.com/refund-policy" style="color: #1a5fb4;">Payment Protection Promise</a>');
    expect(html).toMatch(/<hr [^>]*><p style="font-style: italic; color: #666;">Damian Knowles is a Business Developer/);
  });

  it("keeps the plain footer on the other emails", () => {
    const { html } = buildOrderEmail("welcome", row(), "hold");
    expect(html).not.toContain("<hr");
    expect(html).toContain("<p>Damian Knowles is a Business Developer");
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
    expect(text).toContain("We charge your card only after your filing is complete. As soon as it is complete, we will email you and process the payment.");
    expect(text).toContain("- If Filing Takes Longer: If your filing is not complete within 5 days, we release the hold, so nothing is charged, and email you a secure payment link for the same amount.");
    // Owner's final hold rule (25 Nov 2026): a lapsed hold is never charged.
    expect(text).not.toMatch(/charge the same card/);
    expect(text).not.toContain("Division of Corporations");
    expect(text).not.toContain("LLC is");
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

describe("Article IV titles in the intake summary (website ST07)", () => {
  it("spells out AR as Authorized Representative and keeps older AMBR sessions readable", () => {
    const ar = buildOrderEmail("intake_summary", row({
      filing_data: { ...row().filing_data, authorized_persons: [{ name: "Ana Sol", article_iv_title: "AR", address: "100 Main St, Miami, FL" }] },
    }), "hold");
    expect(ar.text).toContain("Authorized Representative");
    const ambr = buildOrderEmail("intake_summary", row(), "hold");
    expect(ambr.text).toContain("Member");
  });
});

describe("Day-5 hold release (owner's final hold rule, 25 Nov 2026)", () => {
  const LINK = "https://buy.stripe.com/test_abc123";

  it("says nothing was charged and gives the one-time payment link for the same amount", () => {
    const { subject, text, html } = buildOrderEmail("hold_released", row(), "released", { paymentLinkUrl: LINK });
    expect(subject).toBe("Action needed: approve your payment for Sol Ventures LLC");
    expect(text).toContain("We released the temporary hold of $249.00 on your card. Nothing was charged.");
    expect(text).toContain(`Pay $249.00 securely (${LINK})`);
    expect(text).toContain("your card is charged $249.00, the same amount as your original hold. The link works once.");
    expect(text).toContain("Order number: 0f6c1d3e-1111-4a2b-9c3d-000000000001");
    expect(text).toContain("reply to this email and we will close your order");
    expect(text).toContain(DISCLAIMER);
    expect(html).toContain(`<a href="${LINK}" style="color: #1a5fb4;">Pay $249.00 securely</a>`);
    // No selling content: only the payment link and the published terms.
    const body = `${text} ${html}`.split(LINK).join("").split("https://damianknowles.com/refund-policy").join("");
    expect(body).not.toMatch(/https?:\/\/|% off|upgrade|special offer/i);
  });

  it("refuses to build without the link", () => {
    expect(() => buildOrderEmail("hold_released", row(), "released")).toThrow(/payment link/);
  });

  it("a filing confirmation for a released hold says nothing was charged", () => {
    const { text } = buildOrderEmail("filing_confirmation", row(), "released");
    expect(text).toContain("Your card hold was released before it could be collected, so nothing has been charged.");
    expect(text).not.toContain("We are now collecting payment");
  });
});
