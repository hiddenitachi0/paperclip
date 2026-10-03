import { describe, expect, it } from "vitest";
import { evaluateFinalActionRisk, matchFinalActionWording } from "./final-action-matcher.js";

describe("matchFinalActionWording", () => {
  it("matches Norwegian final-action wording, diacritics included", () => {
    expect(matchFinalActionWording("Bekreft kjøp")?.term.language).toBe("no");
    expect(matchFinalActionWording("Betal nå")?.term.language).toBe("no");
    expect(matchFinalActionWording("Fullfør bestilling")?.term.language).toBe("no");
  });

  it("matches Swedish, Danish and German final-action wording", () => {
    expect(matchFinalActionWording("Boka nu")?.term.language).toBe("sv");
    expect(matchFinalActionWording("Bekräfta")?.term.language).toBe("sv");
    expect(matchFinalActionWording("Bestil nu")?.term.language).toBe("da");
    expect(matchFinalActionWording("Jetzt kaufen")?.term.language).toBe("de");
    expect(matchFinalActionWording("Jetzt bezahlen")?.term.language).toBe("de");
  });

  it("matches English single words and multi-word phrases", () => {
    expect(matchFinalActionWording("Confirm")?.term.language).toBe("en");
    expect(matchFinalActionWording("Place Order")?.term.language).toBe("en");
    expect(matchFinalActionWording("Complete your purchase")?.term.language).toBe("en");
    expect(matchFinalActionWording("Book now")?.term.language).toBe("en");
  });

  it("classifies invoice/pay-later wording separately", () => {
    expect(matchFinalActionWording("Faktura")?.kind).toBe("invoice");
    expect(matchFinalActionWording("Pay later")?.kind).toBe("invoice");
    expect(matchFinalActionWording("Buy now pay later")?.kind).toBe("invoice");
    expect(matchFinalActionWording("Confirm")?.kind).toBe("final_action");
  });

  it("does not match a substring inside an unrelated word", () => {
    // "bok" (sv: book-ish stem is "boka") must not fire inside "bokstav" (letter),
    // and "pay" must not fire inside "display".
    expect(matchFinalActionWording("Bokstav")).toBeNull();
    expect(matchFinalActionWording("Display settings")).toBeNull();
    expect(matchFinalActionWording("Cookie preferences")).toBeNull();
  });

  it("does not match ordinary navigation wording", () => {
    expect(matchFinalActionWording("Next")).toBeNull();
    expect(matchFinalActionWording("Continue")).toBeNull();
    expect(matchFinalActionWording("Cancel")).toBeNull();
    expect(matchFinalActionWording("Back")).toBeNull();
    expect(matchFinalActionWording("")).toBeNull();
  });
});

describe("evaluateFinalActionRisk", () => {
  it("refuses on final-action wording", () => {
    const verdict = evaluateFinalActionRisk({ text: "Confirm and pay" });
    expect(verdict?.reason).toBe("final_action_wording");
  });

  it("refuses on invoice wording even without other signals", () => {
    const verdict = evaluateFinalActionRisk({ text: "Send me an invoice" });
    expect(verdict?.reason).toBe("invoice_wording");
  });

  it("refuses a generically labelled submit inside a payment form", () => {
    const verdict = evaluateFinalActionRisk({
      text: "Next",
      isFormSubmit: true,
      formHasPaymentField: true,
    });
    expect(verdict?.reason).toBe("submit_in_payment_form");
  });

  it("allows a generic submit when the form has no payment field", () => {
    const verdict = evaluateFinalActionRisk({
      text: "Next",
      isFormSubmit: true,
      formHasPaymentField: false,
    });
    expect(verdict).toBeNull();
  });

  it("allows ordinary navigation with no risky signal", () => {
    expect(evaluateFinalActionRisk({ text: "Continue" })).toBeNull();
    expect(evaluateFinalActionRisk({})).toBeNull();
  });

  it("wording takes precedence even on a non-submit element", () => {
    const verdict = evaluateFinalActionRisk({ text: "Bekreft", isFormSubmit: false });
    expect(verdict?.reason).toBe("final_action_wording");
  });
});
