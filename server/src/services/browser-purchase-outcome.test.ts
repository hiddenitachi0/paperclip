import { describe, expect, it } from "vitest";
import { classifyPurchaseOutcome, maskCardNumbers } from "./browser-purchase-outcome.js";

describe("classifyPurchaseOutcome", () => {
  const clearedDomain = "shop.example";

  it("confirms an order-reference page on the cleared domain", () => {
    const result = classifyPurchaseOutcome({
      url: "https://shop.example/checkout/confirmation?order=ABC123",
      tree: '[ref=e1] heading "Order confirmed" [ref=e2] text "Order reference: ABC123"',
      clearedDomain,
    });
    expect(result).toBe("confirmed");
  });

  it("confirms an order-reference page on a known payment-provider redirect domain", () => {
    const result = classifyPurchaseOutcome({
      url: "https://checkout.stripe.com/pay/cs_test_123/confirmation",
      tree: '[ref=e1] text "Receipt #cs_test_123"',
      clearedDomain,
    });
    expect(result).toBe("confirmed");
  });

  it("does not trust a fake confirmation page on an unrelated domain", () => {
    const result = classifyPurchaseOutcome({
      url: "https://attacker.example/looks-legit",
      tree: '[ref=e1] heading "Order confirmed" [ref=e2] text "Order reference: FAKE123"',
      clearedDomain,
    });
    expect(result).toBe("unverified");
  });

  it("classifies explicit failure wording on the cleared domain as failed", () => {
    const result = classifyPurchaseOutcome({
      url: "https://shop.example/checkout",
      tree: '[ref=e1] text "Your payment was declined"',
      clearedDomain,
    });
    expect(result).toBe("failed");
  });

  it("treats an ambiguous still-loading page as unverified, not failed or confirmed", () => {
    const result = classifyPurchaseOutcome({
      url: "https://shop.example/checkout",
      tree: '[ref=e1] text "Processing your payment..."',
      clearedDomain,
    });
    expect(result).toBe("unverified");
  });
});

describe("maskCardNumbers", () => {
  it("masks a spaced Luhn-valid card number", () => {
    expect(maskCardNumbers("Card: 4242 4242 4242 4242 approved")).toBe("Card: ******************* approved");
  });

  it("masks a dashed Luhn-valid card number", () => {
    expect(maskCardNumbers("4242-4242-4242-4242")).toBe("*******************");
  });

  it("leaves an ordinary long non-Luhn number alone", () => {
    const text = "Order number 1234567890123456";
    expect(maskCardNumbers(text)).toBe(text);
  });

  it("DUR-4049: masks extraLiterals (CVC/expiry/name) that the PAN regex alone would miss", () => {
    const text = "Security code: 123. Expires 01/2030. Cardholder: M Test.";
    const result = maskCardNumbers(text, ["123", "2030", "M Test"]);
    expect(result).not.toContain("123");
    expect(result).not.toContain("2030");
    expect(result).not.toContain("M Test");
  });

  it("DUR-4049: extraLiterals match whole tokens only, not substrings of an unrelated larger number", () => {
    const text = "Order #41234 total 300 kr";
    expect(maskCardNumbers(text, ["123"])).toBe(text);
  });

  it("DUR-4049: extraLiterals matching is case-insensitive for a cardholder name", () => {
    const result = maskCardNumbers("cardholder: m test", ["M Test"]);
    expect(result).not.toContain("m test");
  });

  it("DUR-4049: ignores empty/whitespace/1-char extraLiterals rather than mangling unrelated text", () => {
    const text = "Total: 300 kr";
    expect(maskCardNumbers(text, ["", "3"])).toBe(text);
  });

  it("DUR-4054: masks a cardholder name starting/ending with a non-ASCII Nordic letter", () => {
    const text = "Cardholder: Åse Løvenskiöld.";
    const result = maskCardNumbers(text, ["Åse Løvenskiöld"]);
    expect(result).not.toContain("Åse Løvenskiöld");
  });

  it("DUR-4054: non-ASCII literal still matches whole tokens only, not substrings of a longer word", () => {
    const text = "Åse Løvenskiöldsgate 12";
    expect(maskCardNumbers(text, ["Åse Løvenskiöld"])).toBe(text);
  });

  it("DUR-4056: masks a CVC/PAN-fragment literal immediately followed by a non-ASCII letter with no separator", () => {
    const text = "Sum: 123Østfold";
    expect(maskCardNumbers(text, ["123"])).not.toContain("123");
  });

  it("DUR-4056: masks an ASCII literal immediately preceded by a non-ASCII letter with no separator", () => {
    const text = "Beløp: Ø123 kroner";
    expect(maskCardNumbers(text, ["123"])).not.toContain("123");
  });
});
