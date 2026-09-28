import { describe, expect, it } from "vitest";
import {
  containsCardNumber,
  evaluateTypeSafety,
  findLuhnValidRuns,
  isLuhnValid,
  looksLikePaymentField,
} from "./payment-detection.js";

describe("isLuhnValid", () => {
  it("validates known test card numbers", () => {
    expect(isLuhnValid("4242424242424242")).toBe(true); // Stripe test Visa
    expect(isLuhnValid("4111111111111111")).toBe(true); // common test Visa
    expect(isLuhnValid("5555555555554444")).toBe(true); // Mastercard test
    expect(isLuhnValid("378282246310005")).toBe(true); // Amex test
  });

  it("rejects an invalid checksum", () => {
    expect(isLuhnValid("4242424242424241")).toBe(false);
  });

  it("rejects non-digit input", () => {
    expect(isLuhnValid("4242-4242-4242-4242")).toBe(false);
    expect(isLuhnValid("")).toBe(false);
  });
});

describe("findLuhnValidRuns / containsCardNumber", () => {
  it("finds an unspaced card number", () => {
    expect(findLuhnValidRuns("card: 4242424242424242")).toEqual(["4242424242424242"]);
    expect(containsCardNumber("4242424242424242")).toBe(true);
  });

  it("finds a card number typed with spaces or dashes", () => {
    expect(containsCardNumber("4242 4242 4242 4242")).toBe(true);
    expect(containsCardNumber("4242-4242-4242-4242")).toBe(true);
  });

  it("does not flag an ordinary long number that fails Luhn", () => {
    expect(containsCardNumber("order number 1234567890123")).toBe(false);
  });

  it("does not flag short numbers below 13 digits", () => {
    expect(containsCardNumber("phone 12345678901")).toBe(false); // 11 digits
  });

  it("does not flag plain prose with no digit run", () => {
    expect(containsCardNumber("Please confirm your booking for two nights")).toBe(false);
  });
});

describe("looksLikePaymentField", () => {
  it("matches standard autocomplete tokens", () => {
    expect(looksLikePaymentField({ autocomplete: "cc-number" })).toBe(true);
    expect(looksLikePaymentField({ autocomplete: "cc-csc" })).toBe(true);
    expect(looksLikePaymentField({ autocomplete: "cc-exp" })).toBe(true);
    expect(looksLikePaymentField({ autocomplete: "shipping cc-name" })).toBe(true);
  });

  it("matches on name/id/placeholder/label keywords when autocomplete is absent", () => {
    expect(looksLikePaymentField({ name: "cardNumber" })).toBe(true);
    expect(looksLikePaymentField({ id: "card-number-input" })).toBe(true);
    expect(looksLikePaymentField({ placeholder: "CVV" })).toBe(true);
    expect(looksLikePaymentField({ label: "Security code" })).toBe(true);
    expect(looksLikePaymentField({ label: "Expiration date" })).toBe(true);
    expect(looksLikePaymentField({ name: "cardholder-name" })).toBe(true);
  });

  it("does not match an ordinary field", () => {
    expect(looksLikePaymentField({ name: "email", autocomplete: "email" })).toBe(false);
    expect(looksLikePaymentField({ label: "First name" })).toBe(false);
    expect(looksLikePaymentField({})).toBe(false);
  });
});

describe("evaluateTypeSafety", () => {
  it("refuses text containing a card number even into an unlabeled field", () => {
    const verdict = evaluateTypeSafety("4242424242424242", {});
    expect(verdict?.reason).toBe("card_number_in_text");
  });

  it("refuses typing into a payment field even with safe-looking text", () => {
    const verdict = evaluateTypeSafety("123", { autocomplete: "cc-csc" });
    expect(verdict?.reason).toBe("payment_field");
  });

  it("allows ordinary text into an ordinary field", () => {
    expect(evaluateTypeSafety("Oslo", { name: "city" })).toBeNull();
  });
});
