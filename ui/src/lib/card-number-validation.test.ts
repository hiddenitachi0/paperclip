import { describe, expect, it } from "vitest";
import {
  cardNumberErrorMessage,
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
