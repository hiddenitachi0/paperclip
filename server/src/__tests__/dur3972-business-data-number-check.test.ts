import { describe, expect, it } from "vitest";
import {
  applyBusinessDataNumberCheck,
  applyNoLookupGuard,
  extractQuantities,
  findSalesQuantityClaims,
  findUngroundedNumbers,
  NO_LOOKUP_SENTENCE,
  NO_NUMBERS_SENTENCE,
  NUMBER_CHECK_REPLACEMENT_NOTE,
} from "../services/business-data-number-check.js";
import { signedRunIdFromActor, matchProductType } from "../services/business-data.js";

/**
 * DUR-3972 S4: the number check that stands between the model and the
 * person. Every number in a reply must come from this turn's business-data
 * output; single digits included.
 */

const CARD = [
  "Salg i antall enheter for produkttype: Sofa",
  "",
  "Juli 2026 (1.–31. juli 2026, avsluttet)",
  "Solgt: 1 234 stk",
  "Returer i måneden: 3 stk (herav 1 fra tidligere måneder)",
  "Netto: 1 231 stk",
  "",
  "Endring netto fra juli 2026 til august 2026: +12 stk (+12,5 %)",
  "Kilde: Shopify (nettbutikken nordstrand-test.myshopify.com), ikke regnskap · Europe/Oslo · hentet 21.09.2026 kl. 10:14 · oppslag 3f2a9c1e-0b7d-4e21-9a55-1c2d3e4f5a6b",
].join("\n");

describe("number extraction", () => {
  it("reads Norwegian number formats the same way on both sides", () => {
    expect(extractQuantities("1 234 stk")).toEqual(["1234"]);
    expect(extractQuantities("1.234 stk")).toEqual(["1234"]);
    expect(extractQuantities("1 234 stk")).toEqual(["1234"]);
    expect(extractQuantities("12,5 %")).toEqual(["12.5"]);
    expect(extractQuantities("−12 stk")).toEqual(["12"]);
  });

  it("ignores lookup ids, shop addresses, dates, times and years next to a month", () => {
    expect(
      extractQuantities(
        "oppslag 3f2a9c1e-0b7d-4e21-9a55-1c2d3e4f5a6b i nordstrand-2.myshopify.com, hentet 21.09.2026 kl. 10:14, " +
          "perioden 1.–31. juli 2026 og 2026-08, juli 2026",
      ),
    ).toEqual([]);
  });

  it("keeps single digits", () => {
    expect(extractQuantities("5 returer")).toEqual(["5"]);
  });

  it("counts a spelled-out number next to a count word, but not ordinary words", () => {
    expect(extractQuantities("fem returer")).toEqual(["5"]);
    expect(extractQuantities("tre solgte sofaer")).toEqual(["3"]);
    expect(extractQuantities("Her er tallene for de to månedene")).toEqual([]);
  });
});

describe("the number check", () => {
  it("accepts a reply that uses only numbers from the card, in any Norwegian format", () => {
    const reply = "I juli 2026 solgte vi 1.234 sofaer, 3 returer (1 fra tidligere måneder), netto 1 231. Det er +12,5 %.";
    expect(findUngroundedNumbers(reply, [CARD])).toEqual([]);
  });

  it("flags a number that is not in the tool output", () => {
    expect(findUngroundedNumbers("Vi solgte 1 240 sofaer i juli 2026.", [CARD])).toEqual(["1240"]);
  });

  it("flags a wrong single digit ('5 returer' when the card says 3)", () => {
    expect(findUngroundedNumbers("Det var 5 returer i juli.", [CARD])).toEqual(["5"]);
  });

  it("flags a spelled-out invented number", () => {
    expect(findUngroundedNumbers("Det var fem returer i juli.", [CARD])).toEqual(["5"]);
  });

  it("replaces a failing reply with the card and the note", () => {
    const result = applyBusinessDataNumberCheck("Vi solgte 999 sofaer.", [
      { content: CARD, footer: "Tallene er antall enheter (stk), ikke kroner.", lookupId: "x" },
    ]);
    expect(result.replaced).toBe(true);
    expect(result.ungrounded).toEqual(["999"]);
    expect(result.text).toBe(`${CARD}\n\n${NUMBER_CHECK_REPLACEMENT_NOTE}`);
  });

  it("checks a turn whose lookup was cut off by the tool cap: a number with nothing behind it is refused", () => {
    const result = applyBusinessDataNumberCheck("Vi solgte 12 sofaer.", [{ content: "", footer: null, lookupId: null }]);
    expect(result).toMatchObject({ replaced: true, text: NO_NUMBERS_SENTENCE, ungrounded: ["12"] });
    expect(applyBusinessDataNumberCheck("Jeg rakk ikke å slå det opp.", [{ content: "", footer: null, lookupId: null }]).replaced).toBe(false);
  });

  it("replaces an empty reply too", () => {
    const result = applyBusinessDataNumberCheck("  ", [{ content: CARD, footer: null, lookupId: null }]);
    expect(result.replaced).toBe(true);
  });

  it("appends the platform footer to a passing paraphrase, but not to the card relayed word for word", () => {
    const footer = "Tallene er antall enheter (stk), ikke kroner. Perioder: Juli 2026 (1.–31. juli 2026, avsluttet).\nKilde: X";
    const paraphrase = applyBusinessDataNumberCheck("Netto 1 231 sofaer i juli.", [{ content: CARD, footer, lookupId: "id-1" }]);
    expect(paraphrase.replaced).toBe(false);
    expect(paraphrase.footerAdded).toBe(true);
    expect(paraphrase.text).toBe(`Netto 1 231 sofaer i juli.\n\n${footer}`);

    const verbatim = applyBusinessDataNumberCheck(`Her er tallene:\n${CARD}`, [{ content: CARD, footer, lookupId: "id-1" }]);
    expect(verbatim.footerAdded).toBe(false);
    expect(verbatim.text).toBe(`Her er tallene:\n${CARD}`);
  });

  it("checks a refusal turn too: no number may appear that the refusal did not state", () => {
    const refusal = "Kronebeløp er ikke slått på ennå. Foreløpig kan jeg bare svare i antall enheter (stk), ikke i kroner.";
    expect(applyBusinessDataNumberCheck("Omtrent 40 000 kroner.", [{ content: refusal, footer: null, lookupId: "r" }]).replaced).toBe(true);
    expect(applyBusinessDataNumberCheck(refusal, [{ content: refusal, footer: null, lookupId: "r" }]).replaced).toBe(false);
  });
});

describe("review fixes: dates, 'ingen data' and answers from memory", () => {
  const TWO_MONTHS = [
    "Salg i antall enheter for produkttype: Sofa",
    "",
    "Juli 2026 (1.–31. juli 2026, avsluttet)",
    "Solgt: 12 stk",
    "Returer i måneden: 1 stk (herav 0 fra tidligere måneder)",
    "Netto: 11 stk",
    "",
    "August 2026 (1.–31. august 2026, avsluttet)",
    "Solgt: 14 stk",
    "Returer i måneden: 2 stk (herav 1 fra tidligere måneder)",
    "Netto: 12 stk",
  ].join("\n");

  it("does not hide a wrong number that ends a sentence before a capitalised month ('netto 13. Juli: ...')", () => {
    const reply = "August: 14 solgt, 2 returer, netto 13. Juli: 12 solgt, 1 retur, netto 11.";
    expect(findUngroundedNumbers(reply, [TWO_MONTHS])).toEqual(["13"]);
    const result = applyBusinessDataNumberCheck(reply, [{ content: TWO_MONTHS, footer: "F", lookupId: "id" }]);
    expect(result.replaced).toBe(true);
  });

  it("does not hide it behind a lowercase month either, unless the card names that day", () => {
    expect(findUngroundedNumbers("August netto 13. juli netto 11.", [TWO_MONTHS])).toEqual(["13"]);
    // A day the card does name is still a date, not a number.
    expect(findUngroundedNumbers("Fra 1. juli til 31. juli: netto 11. Hele 1.–31. august: netto 12.", [TWO_MONTHS])).toEqual([]);
  });

  it("does not let the 'Ingen data' line make a zero look grounded", () => {
    const noData = [
      "Salg i antall enheter for produkttype: Sofa",
      "",
      "Oktober 2026 (ikke startet)",
      "Ingen data: Perioden har ikke startet ennå. (ikke det samme som null salg)",
    ].join("\n");
    for (const reply of ["Dere solgte 0 sofaer i oktober.", "Dere solgte null sofaer i oktober.", "Ingen salg i oktober."]) {
      const result = applyBusinessDataNumberCheck(reply, [{ content: noData, footer: null, lookupId: "id" }]);
      expect(result.replaced, reply).toBe(true);
      expect(result.text).toContain("Ingen data");
    }
    // Saying there is no data is fine.
    expect(
      applyBusinessDataNumberCheck("Det finnes ingen data for oktober ennå.", [{ content: noData, footer: null, lookupId: "id" }]).replaced,
    ).toBe(false);
  });

  it("the no-lookup guard replaces a figure given from memory, and leaves plain text alone", () => {
    expect(findSalesQuantityClaims("Totalt solgte vi 27 stk de to månedene.")).toEqual(["27"]);
    expect(findSalesQuantityClaims("Netto: 13. Totalt: 27")).toEqual(["13", "27"]);
    expect(findSalesQuantityClaims("Det var fem returer.")).toEqual(["5"]);
    expect(findSalesQuantityClaims("Salget økte med 12,5 %.")).toEqual(["12.5"]);
    const guarded = applyNoLookupGuard("Til sammen 27 sofaer solgt i juli og august.");
    expect(guarded).toMatchObject({ replaced: true, text: NO_LOOKUP_SENTENCE, claims: ["27"] });

    for (const text of [
      "Hei! Hva vil du vite om salget?",
      "Jeg kan slå opp salg for de to siste månedene.",
      "Møtet er 14. oktober kl. 10:00.",
      "Butikken er nordstrand-2.myshopify.com.",
    ]) {
      expect(applyNoLookupGuard(text).replaced, text).toBe(false);
    }
  });
});

describe("the per-run key comes from a signed token only", () => {
  it("uses actor.runId for an agent JWT, and nothing else", () => {
    expect(signedRunIdFromActor({ type: "agent", agentId: "a", source: "agent_jwt", runId: "run-1" })).toBe("run-1");
    // A header-derived run id on any other credential is not a run to count against.
    expect(signedRunIdFromActor({ type: "agent", agentId: "a", source: "agent_key", runId: "run-1" })).toBeNull();
    expect(signedRunIdFromActor({ type: "board", userId: "u", source: "board_key", runId: "run-1" })).toBeNull();
    expect(signedRunIdFromActor({ type: "service", source: "company_service_token", runId: "run-1" })).toBeNull();
    expect(signedRunIdFromActor(undefined)).toBeNull();
  });
});

describe("product-type matching", () => {
  const catalog = ["Sofa", "Hjørnesofa", "Sovesofa", "Sofabord", "Lenestol"];

  it("is ambiguous when several types contain the word, even with an exact match", () => {
    expect(matchProductType("sofa", catalog)).toEqual({
      kind: "ambiguous",
      candidates: ["Hjørnesofa", "Sofa", "Sofabord", "Sovesofa"],
    });
  });

  it("matches one type ignoring case and accents", () => {
    expect(matchProductType("HJORNESOFA", catalog)).toEqual({ kind: "one", type: "Hjørnesofa" });
  });

  it("refuses an unknown type with the nearest catalog values", () => {
    const match = matchProductType("stol", ["Lenestol", "Spisestol", "Bord"]);
    expect(match.kind).toBe("ambiguous");
    const none = matchProductType("lampe", ["Lenestol", "Bord"]);
    expect(none.kind).toBe("none");
  });
});
