import { describe, expect, it } from "vitest";
import { describeSpecChanges, describeStrategyInWords } from "./tradingSpecWords";
import { checkRuleBook, plainProblem, starterSpec } from "./tradingRuleBook";

const JARGON = /\b(ATR|EMA|SMA|RSI|ADX|VWAP|DUR-\d+|PR #\d+|sma_crossover|specVersion|bars?)\b/;

describe("describeStrategyInWords", () => {
  it("reads the starter rules back in plain words, without jargon", () => {
    const text = describeStrategyInWords(starterSpec("Test", "BTC", "4h"));
    expect(text).toContain("This strategy watches BTC and decides on 4-hour candles.");
    expect(text).toContain("It buys when the 10-candle average price moves up past the 30-candle average price.");
    expect(text).toContain("It sells when the 10-candle average price moves down past the 30-candle average price.");
    expect(text).toContain("It puts 10% of its available play money into each buy.");
    expect(text.endsWith("It uses play money only.")).toBe(true);
    expect(text).not.toMatch(JARGON);
  });

  it("mentions the safety stop and what it stays out of", () => {
    const spec = starterSpec("Test", "ETH", "1h");
    spec.exit.stop = { kind: "pct", pct: 3 };
    spec.regimeGate.trend = "up";
    const text = describeStrategyInWords(spec);
    expect(text).toContain("the price falls 3% below what it paid");
    expect(text).toContain("It only buys in a market that is going up.");
  });
});

describe("describeSpecChanges", () => {
  it("is empty for identical rules", () => {
    const spec = starterSpec("Test", "BTC", "4h");
    expect(describeSpecChanges({ spec, guidelines: "" }, { spec: structuredClone(spec), guidelines: "" })).toEqual([]);
  });

  it("names the section and the numbers that changed", () => {
    const before = starterSpec("Test", "BTC", "4h");
    const after = structuredClone(before);
    after.sizing = { kind: "fraction_of_cash", fraction: 0.25 };
    after.neverDo = { maxPositionNok: 800 };
    const changes = describeSpecChanges({ spec: before, guidelines: "" }, { spec: after, guidelines: "be careful" });
    expect(changes).toContain("How much changed. Now: Puts 25% of its available play money into each buy. Before: Puts 10% of its available play money into each buy.");
    expect(changes).toContain("The most in one buy: 1 000 NOK → 800 NOK.");
    expect(changes).toContain("Your notes for the analyst changed.");
  });
});

describe("checkRuleBook", () => {
  it("accepts the starter rules once they have a name and an idea", () => {
    const spec = starterSpec("My strategy", "BTC", "4h");
    spec.meta.thesis = "Trends tend to continue.";
    expect(checkRuleBook(spec, "").ok).toBe(true);
  });

  it("explains problems in plain words, by section", () => {
    const spec = starterSpec("", "BTC", "4h");
    spec.sizing = { kind: "risk_per_trade", riskPerTradePct: 1 };
    const result = checkRuleBook(spec, "");
    expect(result.ok).toBe(false);
    expect(result.problems).toContain("About this strategy: Give the strategy a name.");
    expect(result.problems).toContain("How much: Sizing by what it is willing to lose needs a safety stop. Add one under “When it sells”.");
    for (const problem of result.problems) expect(problem).not.toMatch(/Number must|Invalid input|R multiple/);
  });

  it("does not show raw validation wording", () => {
    expect(plainProblem(["spec", "exit", "stop", "pct"], "Number must be greater than 0")).toBe("When it sells: A value is missing or outside what is allowed.");
  });
});
