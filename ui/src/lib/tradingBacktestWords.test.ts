import { describe, expect, it } from "vitest";
import { sampleRun } from "./tradingBacktestFixtures";
import { PAPER_ONLY_LABEL, coverageLine, headlineSentence, holdoutSentence, plainGateDetail, plainGateLabel, readReport, signedPercent, startGateRefusal, startStateWords } from "./tradingBacktestWords";
import { ApiError } from "../api/client";
import type { TradingStartGate } from "../api/trading";

const gate = (over: Partial<TradingStartGate>): TradingStartGate => ({ cleared: false, basis: null, versionId: "v1", versionNumber: 2, latestRun: null, queuedRunId: null, overrides: [], variantsTried: 0, holdoutReads: 0, ...over });

describe("past-data report words", () => {
  it("reads a stored run and writes the headline sentence in plain words", () => {
    const report = readReport(sampleRun("pass"))!;
    const sentence = headlineSentence(report);
    expect(sentence).toBe("In periods it had not seen: 312 trades, 54% won, the average win was 1.6 times the average loss, +0.21% per trade after double fees, did better than random entries in 98% of tries, 17 of 24 test periods made money, worst drop -14%.");
  });

  it("reads a missing or empty report as no report", () => {
    expect(readReport({ report: null, gate: null, gatePassed: null })).toBeNull();
    const empty = readReport({ report: {}, gate: null, gatePassed: null })!;
    expect(empty.coins).toEqual([]);
    expect(headlineSentence(empty)).toBe("This test did not produce a result for the main coins.");
  });

  it("gives every checklist row a plain label with no developer words", () => {
    const report = readReport(sampleRun("fail"))!;
    const text = report.items.map((i) => `${plainGateLabel(i)} ${plainGateDetail(i, report)}`).join(" ");
    for (const banned of ["out-of-sample", "holdout", "expectancy", "drawdown", "R per trade", "neighbouring parameter", "regime", "walk-forward", "Sharpe"]) {
      expect(text.toLowerCase()).not.toContain(banned.toLowerCase());
    }
    expect(text).toContain("8 of 24 test periods ended in profit");
    expect(text).toContain("already been looked at 2 times");
  });

  it("says which market states a coin was never tested in", () => {
    const report = readReport(sampleRun("fail"))!;
    expect(coverageLine(report.coins.find((c) => c.coin === "BTC")!)).toBe("BTC was never tested in a rising market.");
    expect(coverageLine(report.coins.find((c) => c.coin === "SOL")!)).toBe("SOL was never tested in a rising market or a falling market.");
  });

  it("flags every coin other than BTC and ETH", () => {
    const report = readReport(sampleRun("pass"))!;
    expect(report.coins.map((c) => [c.coin, c.headline, c.flag])).toEqual([["BTC", true, null], ["ETH", true, null], ["SOL", false, "coin chosen with hindsight"]]);
  });

  it("explains a hidden stretch that was already looked at", () => {
    expect(holdoutSentence({ read: true, seenCount: 1, fresh: false, trades: 5, positive: true, label: null })).toContain("looked at 1 time,");
    expect(holdoutSentence({ read: false, seenCount: null, fresh: false, trades: null, positive: null, label: null })).toContain("not looked at");
  });

  it("formats signed percents", () => {
    expect(signedPercent(0.214)).toBe("+0.21%");
    expect(signedPercent(-14, 0)).toBe("-14%");
    expect(signedPercent(null)).toBe("not known");
  });

  it("describes the Start state from what the server says", () => {
    expect(startStateWords(gate({ cleared: true, basis: "passed" })).title).toBe(PAPER_ONLY_LABEL);
    expect(startStateWords(gate({})).tone).toBe("blocked");
    const override = startStateWords(gate({ cleared: true, basis: "override", overrides: [{ versionId: "v1", reason: "I want to watch it on paper for a week", overriddenByUserId: "u", createdAt: "" }] }));
    expect(override.title).toContain("owner's choice");
    expect(override.detail).toContain("I want to watch it on paper for a week");
  });

  it("recognises the server's start refusal", () => {
    const refused = new ApiError("Strategy \"X\" has not passed the past-data test yet.", 422, { error: "x", code: "trading_start_gate_not_passed" });
    expect(startGateRefusal(refused)).toEqual({ reason: "Strategy \"X\" has not passed the past-data test yet." });
    expect(startGateRefusal(new ApiError("nope", 500, null))).toBeNull();
  });
});
