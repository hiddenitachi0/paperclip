// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { TradingScoreboard, TradingScoreboardForecaster } from "../api/trading";
import { TradingScoreboardSection } from "./TradingScoreboard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = 86_400_000;

function forecaster(key: string, overrides: Partial<TradingScoreboardForecaster> = {}): TradingScoreboardForecaster {
  return {
    forecasterKey: key,
    calls: 700,
    resolved: 650,
    pending: 4,
    flats: 20,
    voids: 0,
    independentResolved: 620,
    effectiveSampleSize: 410,
    coverage: 0.98,
    hitRate: null,
    hitRateInterval: null,
    hitRateOnRuleBars: null,
    expectedHitRateFromBaseRate: null,
    realizedUpShare: null,
    probability: null,
    byRegime: null,
    ...overrides,
  };
}

const collecting: TradingScoreboard = {
  strategyId: "s1",
  version: 2,
  status: { status: "collecting", samples: 41, targetSamples: 620, runningMs: 12 * DAY, minRunningMs: 90 * DAY, calendarMs: 14 * DAY },
  time: { runningMs: 12 * DAY, calendarMs: 14 * DAY, gapMs: 2 * DAY },
  forecasters: [forecaster("rule", { calls: 55, independentResolved: 41 }), forecaster("baseline:always_up", { calls: 55 })],
  verdict: null,
};

const ready: TradingScoreboard = {
  strategyId: "s1",
  version: 2,
  status: { status: "ready", samples: 620, targetSamples: 620, runningMs: 91 * DAY, minRunningMs: 90 * DAY, calendarMs: 94 * DAY },
  time: { runningMs: 91 * DAY, calendarMs: 94 * DAY, gapMs: 3 * DAY },
  criteria: { state: "criteria_not_met", label: "Criteria not met", note: "", items: [{ key: "trade_results", label: "x", state: "not_met", detail: "" }] },
  verdict: { computedAt: "2026-11-19T00:00:00Z", samplesCounted: 620, result: "edge_in_direction", hitRate: 0.542, expectedHitRate: 0.5, excessLower: 0.01, excessUpper: 0.07, bestBaselineKey: "baseline:always_up", bestBaselineHitRate: 0.51, beatsBaselines: true },
  trades: { trades: 38, winRate: 0.45, averageWinUsd: 6.5, averageLossUsd: -4.2, netPnlUsd: -14.8, feesUsd: 21.3, grossPnlUsd: 6.5, maxDrawdownPct: 4.1 },
  forecasters: [
    forecaster("rule", {
      hitRate: 0.542,
      hitRateInterval: { lower: 0.501, upper: 0.583, blocks: 30, blockLength: 3 },
      expectedHitRateFromBaseRate: 0.512,
      byRegime: [
        { regime: "uptrend", hitRate: 0.58, scored: 300, spells: 4 },
        { regime: "ranging", hitRate: 0.49, scored: 200, spells: 1 },
      ],
    }),
    forecaster("baseline:always_up", { hitRateOnRuleBars: 0.51, byRegime: [{ regime: "uptrend", hitRate: 0.6, scored: 300, spells: 4 }] }),
    forecaster("baseline:persistence", { hitRateOnRuleBars: 0.49 }),
    forecaster("baseline:coin_flip", { hitRateOnRuleBars: 0.5 }),
  ],
};

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

async function render(board: TradingScoreboard) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<TradingScoreboardSection board={board} />);
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("TradingScoreboardSection", () => {
  it("shows only 'Collecting: x of N' and counts before the sample is reached: no hit rate, no verdict, no charts", async () => {
    const el = await render(collecting);
    expect(el.querySelector("[data-testid=scoreboard-headline]")?.textContent).toContain("Collecting: 41 of 620, no verdict yet");
    expect(el.querySelector("[data-testid=scoreboard-headline]")?.getAttribute("data-kind")).toBe("collecting");
    expect(el.querySelector("[data-testid=hit-rate-chart]")).toBeNull();
    expect(el.querySelector("[data-testid=win-loss-chart]")).toBeNull();
    expect(el.querySelector("[data-testid^=weather-table]")).toBeNull();
    expect(el.textContent).not.toContain("No better than simple guesses");
    expect(el.textContent).not.toContain("Passed the checks");
    expect(el.textContent).not.toMatch(/\d+(\.\d+)?%\s*(of calls|right)/);
  });

  it("shows running time next to calendar time and the standing disclaimer, even while collecting", async () => {
    const el = await render(collecting);
    expect(el.querySelector("[data-testid=scoreboard-time]")?.textContent).toContain("Running time: 12 days");
    expect(el.querySelector("[data-testid=scoreboard-time]")?.textContent).toContain("Calendar time: 14 days");
    expect(el.querySelector("[data-testid=scoreboard-disclaimer]")?.textContent).toContain("not investment advice");
  });

  it("once ready, shows the server's verdict wording, the hit rate with its range and the baselines side by side", async () => {
    const el = await render(ready);
    expect(el.querySelector("[data-testid=scoreboard-headline]")?.textContent).toContain("Better than guesses but negative after fees");
    const aria = el.querySelector("[data-testid=hit-rate-chart]")?.getAttribute("aria-label") ?? "";
    expect(aria).toContain("hit rate");
    const labels = Array.from(el.querySelectorAll("[data-testid=hit-rate-chart] g[role=img]")).map((g) => g.getAttribute("aria-label"));
    expect(labels).toHaveLength(4);
    expect(labels[0]).toContain("54.2% (between 50.1% and 58.3%)");
    expect(labels[1]).toContain("Always guess up: 51.0%");
  });

  it("shows average win and loss after fees from the server numbers", async () => {
    const el = await render(ready);
    const label = el.querySelector("[data-testid=win-loss-chart]")?.getAttribute("aria-label") ?? "";
    expect(label).toContain("$6.50");
    expect(label).toContain("-$4.20");
  });

  it("explains why there is no calibration chart for a forecaster that gives a direction, not a probability", async () => {
    const el = await render(ready);
    expect(el.querySelector("[data-testid=calibration-chart]")).toBeNull();
    expect(el.querySelector("[data-testid=no-calibration-note]")?.textContent).toContain("direction");
  });

  it("draws the calibration chart when a forecaster carries real probabilities", async () => {
    const withProbability: TradingScoreboard = {
      ...ready,
      forecasters: [
        forecaster("rule", {
          hitRate: 0.54,
          probability: { n: 620, brier: 0.24, brierReference: 0.25, brierSkill: 0.04, logLoss: 0.68, calibration: [{ bucket: 5, from: 0.5, to: 0.6, count: 120, meanForecast: 0.55, observedUpShare: 0.53 }] },
        }),
      ],
    };
    const el = await render(withProbability);
    expect(el.querySelector("[data-testid=calibration-chart]")).not.toBeNull();
    expect(el.querySelector("[data-testid=no-calibration-note]")).toBeNull();
  });

  it("shows hit rate per market weather with the number of separate stretches, and warns when there are very few", async () => {
    const el = await render(ready);
    const table = el.querySelector("[data-testid=weather-table-rule]");
    expect(table?.textContent).toContain("Going up");
    expect(table?.textContent).toContain("4 stretches");
    expect(table?.textContent).toContain("1 stretch");
    expect(table?.textContent).toContain("Too few to say much");
  });

  it("shows the effective number of independent observations", async () => {
    const el = await render(ready);
    expect(el.textContent).toContain("Effective observations");
    expect(el.textContent).toContain("410");
  });
});
