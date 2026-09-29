import { describe, expect, it } from "vitest";
import { isAmountStillAcceptable, parseLargestPageAmount } from "./browser-amount.js";

describe("parseLargestPageAmount", () => {
  it("returns null when no currency-tagged amount is present (a free booking page)", () => {
    expect(parseLargestPageAmount("Table for two, 19:00, no deposit required")).toBeNull();
  });

  it("parses a trailing NOK-style amount", () => {
    expect(parseLargestPageAmount("Total: 450 kr")).toEqual({ valueMinor: 45000, currencyToken: "kr" });
  });

  it("parses a leading dollar amount with cents", () => {
    expect(parseLargestPageAmount("Total due: $12.50")).toEqual({ valueMinor: 1250, currencyToken: "$" });
  });

  it("parses a thousands-separated, comma-decimal NOK amount", () => {
    expect(parseLargestPageAmount("Sum: 1 234,50 kr")).toEqual({ valueMinor: 123450, currencyToken: "kr" });
  });

  it("picks the largest labelled total when several candidates are present", () => {
    expect(parseLargestPageAmount("Room: 300 kr. Cleaning fee: 50 kr. Total: 350 kr")).toEqual({
      valueMinor: 35000,
      currencyToken: "kr",
    });
  });
});

describe("isAmountStillAcceptable", () => {
  it("allows free at request time and free at confirm time", () => {
    expect(isAmountStillAcceptable(null, null)).toBe(true);
  });

  it("refuses when a price appears where the page was free before", () => {
    expect(isAmountStillAcceptable(null, { valueMinor: 100, currencyToken: "kr" })).toBe(false);
  });

  it("refuses when the page appears free now but had a price before (cannot verify it dropped)", () => {
    expect(isAmountStillAcceptable({ valueMinor: 100, currencyToken: "kr" }, null)).toBe(false);
  });

  it("allows an equal amount in the same currency", () => {
    expect(isAmountStillAcceptable({ valueMinor: 45000, currencyToken: "kr" }, { valueMinor: 45000, currencyToken: "kr" })).toBe(true);
  });

  it("allows a lower amount in the same currency", () => {
    expect(isAmountStillAcceptable({ valueMinor: 90000, currencyToken: "kr" }, { valueMinor: 45000, currencyToken: "kr" })).toBe(true);
  });

  it("refuses a higher amount in the same currency", () => {
    expect(isAmountStillAcceptable({ valueMinor: 45000, currencyToken: "kr" }, { valueMinor: 90000, currencyToken: "kr" })).toBe(false);
  });

  it("refuses when the currency token changed even if the number is lower", () => {
    expect(isAmountStillAcceptable({ valueMinor: 45000, currencyToken: "kr" }, { valueMinor: 100, currencyToken: "$" })).toBe(false);
  });
});
