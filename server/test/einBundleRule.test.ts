import { describe, expect, it } from "vitest";
import { einLineIssue, einUpsellEligible } from "../src/offers/einBundleRule.js";
import { getEinUpsell, orderedOfferCodes, type Queryable } from "../src/offers/einUpsell.js";

const DIY = ["DIY_STATE_FEE", "DIY_SERVICE_FEE", "DIY_CERT_OF_STATUS"];

describe("EIN billing rule: the EIN is an add-on to File It only", () => {
  it("allows EIN with File It, in the same cart or later", () => {
    expect(einLineIssue([...DIY, "EIN_FILING"], [])).toBeNull();
    expect(einLineIssue(["EIN_FILING"], DIY)).toBeNull();
  });

  it("refuses EIN alongside a tier that includes it", () => {
    expect(einLineIssue(["FASTTRACK", "EIN_FILING"], [])).toBe("bundled_in_cart");
    expect(einLineIssue(["PREMIUM", "EIN_FILING_EXPRESS"], [])).toBe("bundled_in_cart");
  });

  it("refuses EIN when an earlier paid order already included it", () => {
    expect(einLineIssue(["EIN_FILING"], ["FASTTRACK"])).toBe("already_included");
    expect(einLineIssue(["EIN_FILING"], ["PREMIUM"])).toBe("already_included");
  });

  it("refuses a second EIN, in the same cart or across orders", () => {
    expect(einLineIssue(["EIN_FILING", "EIN_FILING_EXPRESS"], [])).toBe("duplicate_ein_in_cart");
    expect(einLineIssue(["EIN_FILING"], [...DIY, "EIN_FILING"])).toBe("already_ordered");
    expect(einLineIssue(["EIN_FILING_EXPRESS"], [...DIY, "EIN_FILING"])).toBe("already_ordered");
  });

  it("never touches a cart without an EIN", () => {
    expect(einLineIssue(["FASTTRACK"], ["FASTTRACK"])).toBeNull();
    expect(einLineIssue(["REGISTERED_AGENT_3YR"], ["PREMIUM"])).toBeNull();
    expect(einLineIssue(DIY, [])).toBeNull();
  });

  it("treats the same EIN code listed twice as one line, not a duplicate", () => {
    expect(einLineIssue(["EIN_FILING", "EIN_FILING"], DIY)).toBeNull();
  });
});

describe("EIN upsell eligibility", () => {
  it("is offered to a File It buyer who has no EIN", () => {
    expect(einUpsellEligible(DIY)).toBe(true);
    expect(einUpsellEligible([...DIY, "REGISTERED_AGENT_3YR", "CREDENTIALS_KIT"])).toBe(true);
  });

  it("is not offered to Bank-Ready or Premium buyers, who already have the EIN", () => {
    expect(einUpsellEligible(["FASTTRACK"])).toBe(false);
    expect(einUpsellEligible(["PREMIUM"])).toBe(false);
  });

  it("is not offered once an EIN is already on the session", () => {
    expect(einUpsellEligible([...DIY, "EIN_FILING"])).toBe(false);
    expect(einUpsellEligible([...DIY, "EIN_FILING_EXPRESS"])).toBe(false);
  });

  it("is not offered to someone who did not buy File It at all", () => {
    expect(einUpsellEligible([])).toBe(false);
    expect(einUpsellEligible(["REGISTERED_AGENT_3YR"])).toBe(false);
  });
});

/** A fake database answering only the two queries the upsell makes. */
function fakeDb(orderLineItems: Array<Array<{ offer_code: string }>>, einOffer: Record<string, unknown> | null): Queryable {
  return {
    query: async (sql: string) => {
      if (/FROM orders/i.test(sql)) return { rows: orderLineItems.map((line_items) => ({ line_items })) };
      if (/FROM offers/i.test(sql)) return { rows: einOffer ? [einOffer] : [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as Queryable;
}

const EIN_OFFER = {
  id: 7,
  offer_code: "EIN_FILING",
  offer_version: "v1",
  display_name: "EIN Filing Service (Standard)",
  crm_intent: "EIN_FILING",
  stripe_product_id: "prod_x",
  stripe_price_id: "price_x",
  unit_amount_cents: 29900,
  currency: "usd",
  status: "active",
};

describe("getEinUpsell", () => {
  const diyOrder = DIY.map((offer_code) => ({ offer_code }));

  it("returns the catalog offer for a File It order whose card is held", async () => {
    const upsell = await getEinUpsell(fakeDb([diyOrder], EIN_OFFER), { filing_session_id: "s1", payment_status: "authorized" });
    expect(upsell).toEqual({
      offer_code: "EIN_FILING",
      display_name: "EIN Filing Service (Standard)",
      unit_amount_cents: 29900,
      currency: "usd",
    });
  });

  it("never exposes a Stripe id", async () => {
    const upsell = await getEinUpsell(fakeDb([diyOrder], EIN_OFFER), { filing_session_id: "s1", payment_status: "paid" });
    expect(JSON.stringify(upsell)).not.toMatch(/price_|prod_/);
  });

  it("offers nothing before money is held or taken", async () => {
    for (const payment_status of ["pending", "failed", "released", "refunded"]) {
      expect(await getEinUpsell(fakeDb([diyOrder], EIN_OFFER), { filing_session_id: "s1", payment_status })).toBeNull();
    }
  });

  it("offers nothing when the session already has an EIN or bought a bundle", async () => {
    const withEin = [...diyOrder, { offer_code: "EIN_FILING" }];
    expect(await getEinUpsell(fakeDb([withEin], EIN_OFFER), { filing_session_id: "s1", payment_status: "paid" })).toBeNull();
    expect(
      await getEinUpsell(fakeDb([[{ offer_code: "FASTTRACK" }]], EIN_OFFER), { filing_session_id: "s1", payment_status: "paid" }),
    ).toBeNull();
  });

  it("counts an EIN bought on a separate order of the same session", async () => {
    const db = fakeDb([diyOrder, [{ offer_code: "EIN_FILING" }]], EIN_OFFER);
    expect(await getEinUpsell(db, { filing_session_id: "s1", payment_status: "paid" })).toBeNull();
  });

  it("offers nothing when the EIN is not currently sellable", async () => {
    expect(await getEinUpsell(fakeDb([diyOrder], null), { filing_session_id: "s1", payment_status: "paid" })).toBeNull();
  });
});

describe("orderedOfferCodes", () => {
  it("flattens line items across orders and ignores malformed entries", async () => {
    const db = {
      query: async () => ({ rows: [{ line_items: [{ offer_code: "A" }, { offer_code: 5 }, {}] }, { line_items: null }, { line_items: [{ offer_code: "B" }] }] }),
    } as unknown as Queryable;
    expect(await orderedOfferCodes(db, "s1")).toEqual(["A", "B"]);
  });
});
