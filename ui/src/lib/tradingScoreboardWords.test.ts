import { describe, expect, it } from "vitest";
import type { TradingScoreboard } from "../api/trading";
import { collectingWords, orderForecasters, percentWithRange, scoreboardHeadline, VERDICT_WORDS, weatherLabel } from "./tradingScoreboardWords";

const collecting: TradingScoreboard = {
  strategyId: "s1",
  version: 1,
  status: { status: "collecting", samples: 41, targetSamples: 620, runningMs: 5 * 86_400_000, minRunningMs: 90 * 86_400_000, calendarMs: 6 * 86_400_000 },
  forecasters: [],
  verdict: null,
};

function ready(overrides: Partial<TradingScoreboard> = {}): TradingScoreboard {
  return {
    ...collecting,
    status: { status: "ready", samples: 620, targetSamples: 620, runningMs: 91 * 86_400_000, minRunningMs: 90 * 86_400_000, calendarMs: 95 * 86_400_000 },
    verdict: { computedAt: "2026-11-19T00:00:00Z", samplesCounted: 620, result: "edge_in_direction", hitRate: 0.56, expectedHitRate: 0.5, excessLower: 0.01, excessUpper: 0.08, bestBaselineKey: null, bestBaselineHitRate: null, beatsBaselines: true },
    criteria: { state: "criteria_met", label: "Criteria met", items: [], note: "" },
    trades: { trades: 40, winRate: 0.5, averageWinUsd: 5, averageLossUsd: -3, netPnlUsd: 20, feesUsd: 8, grossPnlUsd: 28, maxDrawdownPct: 3 },
    ...overrides,
  };
}

describe("scoreboardHeadline", () => {
  it("says Collecting with the counts and no result words before the sample is reached", () => {
    const h = scoreboardHeadline(collecting);
    expect(h.kind).toBe("collecting");
    expect(h.text).toBe("Collecting: 41 of 620, no verdict yet");
    expect(h.text).toBe(collectingWords(41, 620));
    for (const word of Object.values(VERDICT_WORDS)) expect(h.text).not.toBe(word);
  });

  it("stays collecting even if a stray verdict row exists while the status is still collecting", () => {
    const stray = { ...collecting, verdict: ready().verdict };
    expect(scoreboardHeadline(stray).kind).toBe("collecting");
  });

  it("says the result is being worked out when the sample is complete but no verdict is stored yet", () => {
    expect(scoreboardHeadline(ready({ verdict: null })).text).toBe(VERDICT_WORDS.beingWorkedOut);
  });

  it("uses the no-edge wording when the server found no edge", () => {
    const v = ready().verdict!;
    expect(scoreboardHeadline(ready({ verdict: { ...v, result: "no_edge" } })).text).toBe("No better than simple guesses");
  });

  it("uses the passed wording only when the server's written checks are all met", () => {
    expect(scoreboardHeadline(ready()).text).toBe("Passed the checks so far: paper only, not a recommendation");
  });

  it("says negative after fees when the trade-results check is not met", () => {
    const board = ready({
      criteria: { state: "criteria_not_met", label: "Criteria not met", note: "", items: [{ key: "trade_results", label: "x", state: "not_met", detail: "" }] },
    });
    expect(scoreboardHeadline(board).text).toBe("Better than guesses but negative after fees");
  });

  it("says negative after fees when the net result after fees is below zero", () => {
    const board = ready({
      criteria: { state: "criteria_not_met", label: "Criteria not met", note: "", items: [] },
      trades: { trades: 40, winRate: 0.4, averageWinUsd: 3, averageLossUsd: -4, netPnlUsd: -12, feesUsd: 9, grossPnlUsd: -3, maxDrawdownPct: 6 },
    });
    expect(scoreboardHeadline(board).kind).toBe("negative_after_fees");
  });

  it("does not claim negative after fees when another check is the open one", () => {
    const board = ready({ criteria: { state: "criteria_not_met", label: "Criteria not met", note: "", items: [{ key: "drawdown", label: "x", state: "not_met", detail: "" }] } });
    expect(scoreboardHeadline(board).kind).toBe("better_but_checks_open");
  });
});

describe("words and ordering", () => {
  it("puts the rules first and the simple guesses in a fixed order", () => {
    const make = (forecasterKey: string) => ({ forecasterKey }) as TradingScoreboard["forecasters"][number];
    const sorted = orderForecasters([make("baseline:coin_flip"), make("rule"), make("baseline:always_up"), make("baseline:persistence")]);
    expect(sorted.map((f) => f.forecasterKey)).toEqual(["rule", "baseline:always_up", "baseline:persistence", "baseline:coin_flip"]);
  });

  it("describes a hit rate with its range in plain words", () => {
    expect(percentWithRange(0.542, 0.501, 0.583)).toBe("54.2% (between 50.1% and 58.3%)");
    expect(percentWithRange(null, null, null)).toBe("—");
  });

  it("uses the same weather words as the market weather panel", () => {
    expect(weatherLabel("uptrend")).toBe("Going up");
    expect(weatherLabel("ranging")).toBe("Moving sideways");
  });
});
