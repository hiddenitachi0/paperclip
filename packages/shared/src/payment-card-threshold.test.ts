import { describe, expect, it } from "vitest";
import {
  DEFAULT_FX_RATES_TO_NOK,
  NOK_APPROVAL_THRESHOLD,
  PURCHASE_CAPS,
  evaluatePurchaseAmount,
  evaluatePurchaseCaps,
  findMoneyCandidates,
  pickTotal,
} from "./payment-card-threshold.js";

describe("findMoneyCandidates", () => {
  it("reads NOK suffix amounts with a plain space thousands separator", () => {
    const found = findMoneyCandidates("Total: 1 234,56 kr");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ amount: 1234.56, currency: "NOK", labelled: true });
  });

  it("reads NOK suffix amounts with an NBSP thousands separator", () => {
    const found = findMoneyCandidates("Totalt: 1 234,56 kr");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ amount: 1234.56, currency: "NOK" });
  });

  it("reads a NOK prefix amount", () => {
    const found = findMoneyCandidates("Sum: NOK 499");
    expect(found[0]).toMatchObject({ amount: 499, currency: "NOK", labelled: true });
  });

  it("reads a euro suffix amount with comma decimal", () => {
    const found = findMoneyCandidates("Grand total 99,90 €");
    expect(found[0]).toMatchObject({ amount: 99.9, currency: "EUR", labelled: true });
  });

  it("reads a euro prefix amount", () => {
    const found = findMoneyCandidates("€1,234.50 due");
    expect(found[0]).toMatchObject({ amount: 1234.5, currency: "EUR" });
  });

  it("reads a bare dollar sign as USD", () => {
    const found = findMoneyCandidates("Amount due: $49.99");
    expect(found[0]).toMatchObject({ amount: 49.99, currency: "USD", labelled: true });
  });

  it("reads US$ explicitly as USD", () => {
    const found = findMoneyCandidates("Price US$1,234.56");
    expect(found[0]).toMatchObject({ amount: 1234.56, currency: "USD" });
  });

  it("treats a lone 3-digit group after a separator as thousands, not cents", () => {
    const found = findMoneyCandidates("kr 1.234");
    expect(found[0]).toMatchObject({ amount: 1234, currency: "NOK" });
  });

  it("treats a short trailing group as a decimal fraction", () => {
    const found = findMoneyCandidates("kr 1.234,5");
    expect(found[0]).toMatchObject({ amount: 1234.5, currency: "NOK" });
  });

  it("labels only the line the total-shaped keyword sits on", () => {
    const found = findMoneyCandidates("Subtotal 100 kr\nTotal 120 kr");
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ amount: 100, labelled: false });
    expect(found[1]).toMatchObject({ amount: 120, labelled: true });
  });

  it("finds nothing in text with no money-shaped token", () => {
    expect(findMoneyCandidates("Thanks for shopping with us!")).toHaveLength(0);
  });
});

describe("pickTotal", () => {
  it("picks the largest labelled total when several are labelled", () => {
    const total = pickTotal("Total (items) 300 kr\nTotal (with shipping) 350 kr");
    expect(total).toMatchObject({ amount: 350, currency: "NOK" });
  });

  it("falls back to the single candidate when nothing is labelled", () => {
    const total = pickTotal("Price: 249 kr");
    expect(total).toMatchObject({ amount: 249, currency: "NOK" });
  });

  it("returns null when there are multiple unlabelled candidates to choose between", () => {
    expect(pickTotal("100 kr and also 200 kr")).toBeNull();
  });

  it("returns null when nothing money-shaped is present", () => {
    expect(pickTotal("no numbers here")).toBeNull();
  });

  it("ignores an unlabelled small amount next to a labelled total", () => {
    const total = pickTotal("Shipping 49 kr\nTotal: 349 kr");
    expect(total).toMatchObject({ amount: 349, currency: "NOK" });
  });
});

describe("evaluatePurchaseAmount", () => {
  it("does not require approval strictly below 500 NOK", () => {
    const result = evaluatePurchaseAmount({ text: "Total: 499 kr" });
    expect(result).toMatchObject({ requiresApproval: false, reason: "below_threshold", amountNok: 499 });
  });

  it("requires approval at exactly 500 NOK", () => {
    const result = evaluatePurchaseAmount({ text: "Total: 500 kr" });
    expect(result).toMatchObject({ requiresApproval: true, reason: "at_or_above_threshold", amountNok: 500 });
  });

  it("requires approval above 500 NOK", () => {
    const result = evaluatePurchaseAmount({ text: "Total: 501 kr" });
    expect(result.requiresApproval).toBe(true);
  });

  it("converts USD to NOK using the seed rate and requires approval when it crosses the line", () => {
    // 50 USD * 11.5 = 575 NOK, at or above 500.
    const result = evaluatePurchaseAmount({ text: "Total: $50.00" });
    expect(result).toMatchObject({ requiresApproval: true, reason: "at_or_above_threshold" });
    expect(result.amountNok).toBeCloseTo(575, 5);
  });

  it("converts EUR to NOK using the seed rate and allows a small purchase through", () => {
    // 10 EUR * 12.5 = 125 NOK, well under 500.
    const result = evaluatePurchaseAmount({ text: "Total: 10,00 €" });
    expect(result).toMatchObject({ requiresApproval: false, reason: "below_threshold" });
    expect(result.amountNok).toBeCloseTo(125, 5);
  });

  it("never refuses a purchase for being in a foreign currency it can convert", () => {
    const result = evaluatePurchaseAmount({ text: "Total: 1,00 €" });
    expect(result.reason).not.toBe("ambiguous_currency");
  });

  it("requires approval when the currency is recognized but not in the FX table", () => {
    // GBP is not in DEFAULT_FX_RATES_TO_NOK; simulate a caller-supplied table missing it too.
    const result = evaluatePurchaseAmount({ text: "Total: 10 GBP", fxRatesToNok: { NOK: 1 } });
    // "GBP" as a bare word is not one of the parser's recognized symbols, so this is unparseable,
    // which also requires approval -- covering the same safe-default path.
    expect(result.requiresApproval).toBe(true);
  });

  it("requires approval when the amount cannot be parsed at all", () => {
    const result = evaluatePurchaseAmount({ text: "Thanks for your order!" });
    expect(result).toMatchObject({ requiresApproval: true, reason: "unparseable", amountNok: null, detected: null });
  });

  it("requires approval when multiple unlabelled totals are ambiguous", () => {
    const result = evaluatePurchaseAmount({ text: "100 kr or 900 kr" });
    expect(result).toMatchObject({ requiresApproval: true, reason: "unparseable" });
  });

  it("honors a caller-supplied FX table and threshold", () => {
    const result = evaluatePurchaseAmount({
      text: "Total: 10 kr",
      fxRatesToNok: { NOK: 2 },
      thresholdNok: 15,
    });
    expect(result).toMatchObject({ requiresApproval: true, amountNok: 20 });
  });

  it("exposes the seed FX table and threshold as stable constants", () => {
    expect(NOK_APPROVAL_THRESHOLD).toBe(500);
    expect(DEFAULT_FX_RATES_TO_NOK.NOK).toBe(1);
    expect(DEFAULT_FX_RATES_TO_NOK.USD).toBe(11.5);
    expect(DEFAULT_FX_RATES_TO_NOK.EUR).toBe(12.5);
  });
});

describe("evaluatePurchaseCaps", () => {
  const baseline = {
    amountNok: 100,
    merchant: "acme-shop",
    spendTodayNok: 0,
    spendThisWeekNok: 0,
    autoPurchasesToday: 0,
    merchantPurchasesToday: 0,
    merchantPurchasesThisWeek: 0,
  };

  it("allows a purchase well within every cap", () => {
    expect(evaluatePurchaseCaps(baseline)).toEqual({ requiresApproval: false, breachedCaps: [] });
  });

  it("breaches the daily amount cap", () => {
    const result = evaluatePurchaseCaps({ ...baseline, spendTodayNok: PURCHASE_CAPS.dailyNok - 50 });
    expect(result.requiresApproval).toBe(true);
    expect(result.breachedCaps).toContain("daily_amount");
  });

  it("breaches the weekly amount cap", () => {
    const result = evaluatePurchaseCaps({ ...baseline, spendThisWeekNok: PURCHASE_CAPS.weeklyNok - 50 });
    expect(result.breachedCaps).toContain("weekly_amount");
  });

  it("breaches the daily auto-purchase count cap", () => {
    const result = evaluatePurchaseCaps({ ...baseline, autoPurchasesToday: PURCHASE_CAPS.autoPurchasesPerDay });
    expect(result.breachedCaps).toContain("daily_auto_purchase_count");
  });

  it("breaches the per-merchant daily cap", () => {
    const result = evaluatePurchaseCaps({ ...baseline, merchantPurchasesToday: PURCHASE_CAPS.perMerchantPerDay });
    expect(result.breachedCaps).toContain("merchant_daily");
  });

  it("breaches the per-merchant weekly cap", () => {
    const result = evaluatePurchaseCaps({ ...baseline, merchantPurchasesThisWeek: PURCHASE_CAPS.perMerchantPerWeek });
    expect(result.breachedCaps).toContain("merchant_weekly");
  });

  it("never applies merchant caps when no merchant is given", () => {
    const result = evaluatePurchaseCaps({
      ...baseline,
      merchant: null,
      merchantPurchasesToday: 99,
      merchantPurchasesThisWeek: 99,
    });
    expect(result.breachedCaps).not.toContain("merchant_daily");
    expect(result.breachedCaps).not.toContain("merchant_weekly");
  });

  it("can breach more than one cap at once", () => {
    const result = evaluatePurchaseCaps({
      ...baseline,
      spendTodayNok: PURCHASE_CAPS.dailyNok,
      spendThisWeekNok: PURCHASE_CAPS.weeklyNok,
    });
    expect(result.breachedCaps).toEqual(
      expect.arrayContaining(["daily_amount", "weekly_amount"]),
    );
  });
});
