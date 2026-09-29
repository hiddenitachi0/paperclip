import { describe, expect, it } from "vitest";
import {
  cardNumberErrorMessage,
  guessCardBrand,
  isLuhnValid,
  isValidCardNumber,
  normalizeCardNumber,
} from "./card-number-validation";

describe("normalizeCardNumber", () => {
  it("strips spaces and dashes", () => {
    expect(normalizeCardNumber("4242 4242-4242 4242")).toBe("4242424242424242");
  });
});

describe("isLuhnValid", () => {
  it("accepts a known-valid test number", () => {
    expect(isLuhnValid("4242424242424242")).toBe(true);
  });

  it("rejects a number with a broken checksum", () => {
    expect(isLuhnValid("4242424242424241")).toBe(false);
  });

  it("rejects non-digit input", () => {
    expect(isLuhnValid("4242-4242-4242-4242")).toBe(false);
  });
});

describe("isValidCardNumber", () => {
  it("accepts a valid card number with formatting", () => {
    expect(isValidCardNumber("4242 4242 4242 4242")).toBe(true);
  });

  it("rejects numbers outside the 13-19 digit range", () => {
    expect(isValidCardNumber("4242")).toBe(false);
    expect(isValidCardNumber("42424242424242424242")).toBe(false);
  });
});

describe("cardNumberErrorMessage", () => {
  it("returns null for a valid number", () => {
    expect(cardNumberErrorMessage("4242 4242 4242 4242")).toBeNull();
  });

  it("returns a plain-language message for an empty field", () => {
    expect(cardNumberErrorMessage("")).toBe("Enter the card number.");
  });

  it("returns a plain-language message for a bad checksum", () => {
    expect(cardNumberErrorMessage("4242424242424241")).toBe(
      "That card number doesn't look right. Please check it and try again."
    );
  });

  it("returns a plain-language message for letters", () => {
    expect(cardNumberErrorMessage("abcd")).toBe("Card number can only contain numbers.");
  });
});

describe("guessCardBrand", () => {
  it("recognizes Visa, Mastercard, Amex, Discover by leading digits", () => {
    expect(guessCardBrand("4242 4242 4242 4242")).toBe("Visa");
    expect(guessCardBrand("5555555555554444")).toBe("Mastercard");
    expect(guessCardBrand("2223003122003222")).toBe("Mastercard");
    expect(guessCardBrand("378282246310005")).toBe("American Express");
    expect(guessCardBrand("6011111111111117")).toBe("Discover");
  });

  it("returns null when it cannot tell", () => {
    expect(guessCardBrand("9999999999999999")).toBeNull();
    expect(guessCardBrand("")).toBeNull();
  });
});
