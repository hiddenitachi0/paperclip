import { describe, expect, it } from "vitest";
import { tradingTimeframeMs } from "./trading.js";
import { sessionRangeSeries } from "./trading-indicators.js";
import { canonicalTradingJson, describeTradingSpec, evaluateTradingSpec, tradingSpecRequiredBars, tradingStrategySpecSchema, type TradingEngineBar } from "./trading-spec.js";
import {
  TRADING_ELIGIBILITY_MATRIX_V1,
  TRADING_EXCLUDED_STYLES,
  TRADING_TEMPLATE_PASSED_LABEL,
  createStrategyFromTemplateSchema,
  findTradingTemplate,
  matrixAllowedTrends,
  tradingEligibilityMatrixSchema,
  tradingTemplateLabel,
  tradingTemplateProblems,
  tradingTemplateSchema,
  tradingTemplateStartingValues,
  tradingTemplates,
} from "./trading-templates.js";

/** DUR-5014: the template library. */

const T0 = Date.UTC(2026, 0, 1);
function bars(closes: number[], tf: "1h" | "4h" = "4h"): TradingEngineBar[] {
  const step = tradingTimeframeMs(tf);
  return closes.map((c, i) => ({ openTime: new Date(T0 + i * step), open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 10 }));
}

describe("the template catalog", () => {
  const templates = tradingTemplates();

  it("ships the thirteen templates the decision lists, with unique keys", () => {
    expect(templates.map((t) => t.key).sort()).toEqual(
      [
        "breakout",
        "buy_and_hold",
        "high_volume_spike",
        "momentum",
        "opening_range",
        "opening_range_us_open",
        "pullback",
        "random_entry",
        "reversal",
        "stay_in_cash",
        "support_resistance_bounce",
        "trend_continuation",
        "vwap_reclaim",
      ].sort(),
    );
    expect(new Set(templates.map((t) => t.key)).size).toBe(templates.length);
  });

  it("puts each template in the wave the decision gave it", () => {
    const wave = (key: string) => findTradingTemplate(key)!.wave;
    for (const key of ["trend_continuation", "pullback", "breakout", "support_resistance_bounce"]) expect(wave(key)).toBe("first");
    for (const key of ["momentum", "vwap_reclaim"]) expect(wave(key)).toBe("second");
    for (const key of ["high_volume_spike", "opening_range", "opening_range_us_open", "reversal"]) expect(wave(key)).toBe("experimental");
    for (const key of ["buy_and_hold", "stay_in_cash", "random_entry"]) expect(wave(key)).toBe("control");
  });

  it.each(tradingTemplates().map((t) => [t.key, t] as const))("%s validates, round-trips as JSON and has every required note", (_key, template) => {
    expect(tradingStrategySpecSchema.safeParse(template.spec).success).toBe(true);
    // Plain JSON: nothing a JSON file could not hold.
    expect(tradingTemplateSchema.parse(JSON.parse(JSON.stringify(template)))).toEqual(template);
    expect(template.spec.meta.thesis.length).toBeGreaterThan(20);
    expect(template.worksWhen.length).toBeGreaterThan(0);
    expect(template.failsWhen.length).toBeGreaterThan(0);
    expect(template.spec.meta.commonMistakes.length).toBeGreaterThan(0);
    expect(template.allowedWeather.trend.length).toBeGreaterThan(0);
    expect(template.startingValues.length).toBeGreaterThan(0);
    expect(template.startingValues.every((v) => v.status === "to_be_tested")).toBe(true);
    expect(describeTradingSpec(template.spec).length).toBeGreaterThan(0);
  });

  it.each(tradingTemplates().map((t) => [t.key, t] as const))("%s agrees with the eligibility matrix and its own starting values", (_key, template) => {
    expect(tradingTemplateProblems(template)).toEqual([]);
    for (const v of tradingTemplateStartingValues(template)) expect(v.value, v.path).not.toBeUndefined();
  });

  it("uses 4-hour decisions (or 1-hour for the US-open variant), never 15-minute, and carries 620 predictions", () => {
    for (const t of templates) {
      expect(t.spec.universe.decisionTimeframe).not.toBe("15m");
      expect(t.spec.prediction.targetSamples).toBe(620);
    }
    expect(findTradingTemplate("opening_range_us_open")!.spec.universe.decisionTimeframe).toBe("1h");
    expect(templates.filter((t) => t.key !== "opening_range_us_open").every((t) => t.spec.universe.decisionTimeframe === "4h")).toBe(true);
  });

  it("keeps the experimental price-only template from ever earning the passed label", () => {
    const spike = findTradingTemplate("high_volume_spike")!;
    expect(spike.requiresData).toEqual(["funding", "open_interest"]);
    const label = tradingTemplateLabel({ family: spike.spec.meta.family, reportStatus: "succeeded", gatePassed: true, missingData: spike.requiresData });
    expect(label.passed).toBe(false);
    expect(label.label).not.toBe(TRADING_TEMPLATE_PASSED_LABEL);
  });

  it("never calls a template ready or promising", () => {
    for (const t of templates) {
      const text = JSON.stringify(t).toLowerCase();
      expect(text).not.toMatch(/\bready\b/);
      expect(text).not.toMatch(/\bpromising\b/);
    }
    for (const gatePassed of [true, false, null]) {
      for (const reportStatus of ["succeeded", "failed", "not_testable", null] as const) {
        const { label } = tradingTemplateLabel({ family: "trend", reportStatus, gatePassed, missingData: [] });
        expect(label.toLowerCase()).not.toMatch(/\b(ready|promising)\b/);
      }
    }
    expect(tradingTemplateLabel({ family: "trend", reportStatus: "succeeded", gatePassed: true, missingData: [] })).toEqual({ label: TRADING_TEMPLATE_PASSED_LABEL, passed: true });
    expect(TRADING_TEMPLATE_PASSED_LABEL).toBe("passed the past-data checks: paper only, not a recommendation");
    expect(tradingTemplateLabel({ family: "control", reportStatus: "succeeded", gatePassed: true, missingData: [] }).passed).toBe(false);
    expect(tradingTemplateLabel({ family: "trend", reportStatus: null, gatePassed: null, missingData: [] }).passed).toBe(false);
  });

  it("explains the excluded style", () => {
    expect(TRADING_EXCLUDED_STYLES.map((s) => s.key)).toEqual(["gap_and_go"]);
    expect(TRADING_EXCLUDED_STYLES[0]!.reason).toMatch(/no opening gap/);
    expect(templates.some((t) => t.key.includes("gap"))).toBe(false);
  });

  it("rejects a template whose gate or notes break the rules", () => {
    const base = findTradingTemplate("trend_continuation")!;
    const outOfWeather = { ...base, allowedWeather: { ...base.allowedWeather, trend: ["up", "range"] as Array<"up" | "range" | "down"> } };
    expect(tradingTemplateProblems(outOfWeather).join(" ")).toMatch(/range trend/);
    const ungated = { ...base, spec: { ...base.spec, regimeGate: { trend: "any" as const, volatility: "any" as const, squeeze: "no" as const } } };
    expect(tradingTemplateProblems(ungated).join(" ")).toMatch(/regime gate would let it trade/);
    const noSqueezeGate = { ...base, spec: { ...base.spec, regimeGate: { ...base.spec.regimeGate, squeeze: "any" as const } } };
    expect(tradingTemplateProblems(noSqueezeGate).join(" ")).toMatch(/squeeze/);
    const brokenValue = { ...base, startingValues: [{ path: "indicators.nope.period", label: "x", status: "to_be_tested" as const }] };
    expect(tradingTemplateProblems(brokenValue).join(" ")).toMatch(/does not point at anything/);
    const hype = { ...base, guidelines: "This one is ready to go." };
    expect(tradingTemplateProblems(hype).join(" ")).toMatch(/"ready"/);
    expect(tradingTemplateSchema.safeParse({ ...base, startingValues: [{ path: "a", label: "b", status: "tested" }] }).success).toBe(false);
  });

  it("derives a stable canonical form for a digest", () => {
    const a = findTradingTemplate("breakout")!;
    expect(canonicalTradingJson(a)).toBe(canonicalTradingJson(JSON.parse(JSON.stringify(a))));
  });
});

describe("the eligibility matrix", () => {
  it("is valid, versioned and has a row per family", () => {
    expect(tradingEligibilityMatrixSchema.safeParse(TRADING_ELIGIBILITY_MATRIX_V1).success).toBe(true);
    expect(TRADING_ELIGIBILITY_MATRIX_V1.version).toBe(1);
    expect(Object.keys(TRADING_ELIGIBILITY_MATRIX_V1.rows).sort()).toEqual(["breakout", "control", "mean_reversion", "reversal", "trend"]);
  });

  it("keeps trend templates out of a down trend and the range, as the plan says", () => {
    expect(matrixAllowedTrends(TRADING_ELIGIBILITY_MATRIX_V1, "trend")).toEqual(["up"]);
    expect(matrixAllowedTrends(TRADING_ELIGIBILITY_MATRIX_V1, "breakout")).toEqual(["up", "range"]);
    expect(matrixAllowedTrends(TRADING_ELIGIBILITY_MATRIX_V1, "mean_reversion")).toEqual(["up", "range"]);
    expect(matrixAllowedTrends(TRADING_ELIGIBILITY_MATRIX_V1, "reversal")).toEqual(["down"]);
    expect(matrixAllowedTrends(TRADING_ELIGIBILITY_MATRIX_V1, "control")).toEqual(["up", "range", "down"]);
  });

  it("refuses a matrix with a missing row", () => {
    const { control: _control, ...rows } = TRADING_ELIGIBILITY_MATRIX_V1.rows;
    expect(tradingEligibilityMatrixSchema.safeParse({ ...TRADING_ELIGIBILITY_MATRIX_V1, rows }).success).toBe(false);
  });
});

describe("the engine reads the templates", () => {
  it("makes the controls behave as controls", () => {
    const series = bars(Array.from({ length: 30 }, (_, i) => 100 + i));
    const cash = findTradingTemplate("stay_in_cash")!.spec;
    for (let n = 2; n <= series.length; n++) expect(evaluateTradingSpec(cash, series.slice(0, n), { kind: "flat" }).action).toBe("hold");
    const hold = findTradingTemplate("buy_and_hold")!.spec;
    expect(evaluateTradingSpec(hold, series, { kind: "flat" }).action).toBe("enter");
    const random = findTradingTemplate("random_entry")!.spec;
    expect(evaluateTradingSpec(random, series, { kind: "flat" }).action).toBe("enter");
  });

  it("has enough warm-up for every template within the engine's cap", () => {
    for (const t of tradingTemplates()) expect(tradingSpecRequiredBars(t.spec)).toBeLessThanOrEqual(500);
  });

  it("builds an opening range from closed bars of the UTC day only", () => {
    const series = bars([10, 12, 11, 13, 12, 14, 10, 11, 12, 13, 14, 15]); // 4h bars from 00:00: two days
    const high = sessionRangeSeries(series, "high", 0, 1);
    const low = sessionRangeSeries(series, "low", 0, 1);
    expect(high[0]).toBe(10.5); // first bar's own high, once it has closed
    expect(low[0]).toBe(9.5);
    expect(high[1]).toBe(10.5);
    expect(high[5]).toBe(10.5);
    expect(high[6]).toBe(10.5 + (10 - 10)); // next day's first bar (close 10) opens a new range
    expect(sessionRangeSeries(series, "high", 0, 2)[0]).toBeNull(); // two-bar session is not complete yet
    expect(sessionRangeSeries(series, "high", 0, 2)[1]).toBe(12.5);
    // A bar size with no bar opening at the anchor hour never produces a value.
    expect(sessionRangeSeries(series, "high", 14, 1).every((v) => v === null)).toBe(true);
  });
});

describe("create from template", () => {
  it("accepts a known key shape and a coin, nothing extra", () => {
    expect(createStrategyFromTemplateSchema.safeParse({ templateKey: "pullback", asset: "ETH" }).success).toBe(true);
    expect(createStrategyFromTemplateSchema.safeParse({ templateKey: "pullback", asset: "ETH", spec: {} }).success).toBe(false);
    expect(createStrategyFromTemplateSchema.safeParse({ templateKey: "Bad Key", asset: "ETH" }).success).toBe(false);
  });
});
