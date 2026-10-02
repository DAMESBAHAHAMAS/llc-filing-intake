import { describe, expect, it } from "vitest";
import { closedCodesIn, closedOfferCodes } from "../src/offers/closedOffers.js";

describe("closed offers", () => {
  it("closes Premium by default", () => {
    expect([...closedOfferCodes({})]).toEqual(["PREMIUM"]);
    expect(closedCodesIn(["DIY_STATE_FEE", "PREMIUM"], {})).toEqual(["PREMIUM"]);
    expect(closedCodesIn(["FASTTRACK", "EIN_FILING"], {})).toEqual([]);
  });

  it("can be overridden or reopened through CLOSED_OFFER_CODES", () => {
    expect(closedCodesIn(["PREMIUM"], { CLOSED_OFFER_CODES: "" })).toEqual([]);
    expect(closedCodesIn(["fasttrack", "PREMIUM"], { CLOSED_OFFER_CODES: " fasttrack , " })).toEqual(["fasttrack"]);
  });
});
