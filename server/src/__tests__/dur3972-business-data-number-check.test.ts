import { describe, expect, it } from "vitest";
import {
  applyBusinessDataNumberCheck,
  extractQuantities,
  findUngroundedNumbers,
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
