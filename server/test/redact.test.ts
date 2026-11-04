import { describe, expect, it } from "vitest";
import { addressText, customerText, phoneText, removeSecrets } from "../src/orderEmails/redact.js";

describe("removeSecrets: what must go", () => {
  it.each([
    ["dashed SSN", "123-45-6789"],
    ["spaced SSN", "123 45 6789"],
    ["dotted SSN", "123.45.6789"],
    ["mixed punctuation", "123-45 6789"],
    ["ITIN", "912-70-1234"],
    ["EIN", "12-3456789"],
    ["bare nine digits", "123456789"],
    ["glued to a word", "SSN123456789"],
    ["glued SSN", "ssn:123-45-6789"],
    ["card, no spaces", "4242424242424242"],
    ["card, spaced", "4242 4242 4242 4242"],
    ["card, dashed", "4242-4242-4242-4242"],
    ["card, dotted", "4242.4242.4242.4242"],
    ["card, double spaced", "4242  4242  4242  4242"],
    ["Amex", "3782 822463 10005"],
    ["13-digit Visa", "4222222222222"],
    ["four groups with a mistyped digit", "4242 4242 4242 4243"],
  ])("%s", (_name, secret) => {
    const cleaned = removeSecrets(`before ${secret} after`);
    expect(cleaned).toContain("[removed]");
    expect(cleaned).not.toMatch(/\d{4}/);
  });
});

describe("removeSecrets: what must stay", () => {
  it.each([
    ["a date", "2026-11-04"],
    ["two dates", "2026-11-04 to 2026-12-31"],
    ["ZIP+4", "33101-1234"],
    ["a list of numbers that is not a card", "10 20 30 40 50 60 70"],
    ["a thirteen digit reference that fails Luhn", "1234567890123"],
    ["a Sunbiz document number", "L26000123456"],
    ["a dollar amount", "$1,250,000.00"],
    ["ownership percentages", "50% and 50%"],
  ])("%s", (_name, value) => {
    expect(removeSecrets(value)).toBe(value);
  });
});

describe("addressText", () => {
  it("keeps a ZIP+4 written without its hyphen", () => {
    expect(addressText("100 Main St, Miami, FL 331011234")).toBe("100 Main St, Miami, FL 331011234");
    expect(addressText("100 Main St, Miami, Florida, 331011234")).toBe("100 Main St, Miami, Florida, 331011234");
  });

  it("still removes a tax ID typed into an address", () => {
    expect(addressText("100 Main St SSN 123456789")).toContain("[removed]");
    expect(addressText("100 Main St 123-45-6789")).toContain("[removed]");
    expect(addressText("4242 4242 4242 4242")).toBe("[removed]");
  });
});

describe("phoneText", () => {
  it.each(["+1 954 555 0100", "+55 11 91234 5678", "+351 912 345 678", "+44 7911 123456", "912345678", "+5511912345678"])("keeps %s whole", (phone) => {
    expect(phoneText(phone)).toBe(phone);
  });

  it("removes what cannot be a phone number", () => {
    expect(phoneText("123-45-6789")).toBe("[removed]");
    expect(phoneText("4242 4242 4242 4242")).toBe("[removed]");
  });
});

describe("customerText", () => {
  it("is empty for anything but a string", () => {
    expect(customerText(undefined)).toBe("");
    expect(customerText(123456789)).toBe("");
  });
});
