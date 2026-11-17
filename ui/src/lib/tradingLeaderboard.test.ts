import { describe, expect, it } from "vitest";
import { buildLeaderboard, choiceWords, formatRange, formatResult, parseCellKey, type SelectorDecisionOutputView, type ShadowCellView } from "./tradingLeaderboard";

const cell = (key: string, over: Partial<SelectorDecisionOutputView["cells"][number]["estimate"]> = {}, action = "failed_test") => ({
  key,
  family: "trend",
  estimate: { trades: 40, tested: true, rawMeanR: 0.2, shrunkMeanR: 0.1, bootstrapLow: -0.05, bootstrapHigh: 0.3, pValue: 0.2, ...over },
  passedTest: false,
  action,
  note: "internal wording that must not be shown",
  windowTrades: 0,
  windowMeanR: null,
});

const output: SelectorDecisionOutputView = {
  trials: 5,
  tested: 3,
  discoveries: 0,
  promoted: [],
  choice: "cash",
  reason: "x",
  cells: [
    cell("a@1|up|BTC", { shrunkMeanR: 0.05 }),
    cell("b@1|range|ETH", { shrunkMeanR: 0.3, bootstrapLow: 0.1, bootstrapHigh: 0.5 }),
    cell("c@1|up|BTC", { tested: false, trades: 12, shrunkMeanR: null, bootstrapLow: null, bootstrapHigh: null, rawMeanR: 0.9 }, "not_tested"),
  ],
};

describe("parseCellKey", () => {
  it("splits a cell key and rejects anything else", () => {
    expect(parseCellKey("pullback_trend@2|squeeze|SOL")).toEqual({ templateKey: "pullback_trend", templateVersion: 2, weather: "squeeze", asset: "SOL" });
    expect(parseCellKey("nonsense")).toBeNull();
    expect(parseCellKey("a|b|c")).toBeNull();
  });
});

describe("buildLeaderboard", () => {
  it("ranks only tested cells, by the server's estimate, and never ranks a cell without enough trades", () => {
    const { ranked, unranked } = buildLeaderboard(output, []);
    expect(ranked.map((r) => r.key)).toEqual(["b@1|range|ETH", "a@1|up|BTC"]);
    expect(unranked.map((r) => r.key)).toEqual(["c@1|up|BTC"]);
    expect(unranked[0]!.typical).toBeNull();
    expect(unranked[0]!.progress).toBe("12 of 30 trades needed before it can be tested");
  });

  it("carries the range and the trade count through unchanged", () => {
    const top = buildLeaderboard(output, []).ranked[0]!;
    expect([top.low, top.high, top.trades, top.typical]).toEqual([0.1, 0.5, 40, 0.3]);
  });

  it("does not show the server's internal notes", () => {
    const rows = buildLeaderboard(output, []);
    expect(JSON.stringify(rows)).not.toContain("internal wording");
  });

  it("attaches the live shadow figures by cell key", () => {
    const shadow: ShadowCellView[] = [{ cellKey: "a@1|up|BTC", family: "trend", templateKey: "a", templateVersion: 1, weather: "up", asset: "BTC", open: 2, closed: 41, voided: 0, meanR1x: 0.1, meanR2x: 0.05 }];
    const row = buildLeaderboard(output, shadow).ranked.find((r) => r.key === "a@1|up|BTC")!;
    expect(row.shadow).toEqual({ open: 2, closed: 41, voided: 0, meanR1x: 0.1, meanR2x: 0.05 });
  });

  it("marks cells that hold paper cash", () => {
    const rows = buildLeaderboard({ ...output, promoted: ["a@1|up|BTC"], choice: "cells" }, []);
    expect(rows.ranked.find((r) => r.key === "a@1|up|BTC")!.holdsPaperCash).toBe(true);
    expect(rows.ranked.find((r) => r.key === "b@1|range|ETH")!.holdsPaperCash).toBe(false);
  });

  it("never uses the words ready or promising", () => {
    const text = JSON.stringify(buildLeaderboard(output, [])).toLowerCase();
    expect(text).not.toMatch(/ready|promising/);
  });
});

describe("formatting", () => {
  it("formats results and ranges", () => {
    expect(formatResult(0.123)).toBe("+0.12");
    expect(formatResult(-0.2)).toBe("−0.20");
    expect(formatResult(0)).toBe("0.00");
    expect(formatResult(null)).toBe("—");
    expect(formatRange(-0.05, 0.3)).toBe("−0.05 to +0.30");
    expect(formatRange(null, null)).toBe("No range yet");
  });
  it("describes the choice in plain words", () => {
    expect(choiceWords({ choice: "cash", promoted: [] })).toBe("The check kept everything in cash.");
    expect(choiceWords({ choice: "cells", promoted: ["a"] })).toBe("The check let 1 strategy hold paper cash.");
  });
});
