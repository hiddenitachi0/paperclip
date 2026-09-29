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
});
