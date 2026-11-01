import type { TradingBacktestRun } from "../api/trading";

/** Realistic stored runs (the shape the server writes), for the report tests and screenshots. Not used by the app itself. */

function metrics(trades: number, wins: number, meanReturn: number, dd = 6) {
  return { trades, wins, losses: trades - wins, hitRate: trades === 0 ? null : wins / trades, avgWinPct: 3.2, avgLossPct: -2.0, meanTradeReturn: meanReturn, maxDrawdownPct: dd };
}

function windows(returns: Array<number | null>) {
  return returns.map((r, index) => ({
    index,
    testStart: new Date(Date.UTC(2023, index * 3, 1)).toISOString(),
    testEnd: new Date(Date.UTC(2023, index * 3 + 3, 1)).toISOString(),
    fees2x: r === null ? metrics(0, 0, 0, 0) : metrics(26, r > 0 ? 15 : 9, r, 4 + index),
    fees1x: metrics(26, 14, (r ?? 0) + 0.004),
  }));
}

function coin(name: string, headline: boolean, returns: Array<number | null>, missing: string[], mean: number) {
  return {
    coin: name,
    headline,
    flag: headline ? null : "coin chosen with hindsight",
    windows: windows(returns),
    outOfSample: { fees2x: metrics(156, 84, mean), fees1x: metrics(156, 90, mean + 0.004), byRegime2x: {} },
    regimeCoverage: { days: { bull: 120, bear: 90, range: 200, unclear: 5 }, minDays: 30, missing },
    baselines: { randomEntry: { runs: 300, meanTradeReturnP05: -0.012, meanTradeReturnMedian: -0.004, meanTradeReturnP95: 0.0012, strategyMeanTradeReturn: mean, beatShare: mean > 0.002 ? 0.98 : 0.4 } },
  };
}

const items = (passed: boolean) => [
  { key: "gate_run", label: "A full gate run on the live price source", passed: true, detail: "Tested on kraken, the same source the live signals use." },
  { key: "headline_coins", label: "Tested on the headline coins (BTC and ETH)", passed: true, detail: "Headline coins tested: BTC, ETH." },
  { key: "expectancy", label: "Out-of-sample expectancy above 0 at 2x fees", passed, detail: "Expectancy 0.21 R per trade." },
  { key: "trades", label: "At least 100 out-of-sample trades", passed: true, detail: "312 out-of-sample trades." },
  { key: "windows", label: "Positive in at least 60% of windows", passed, detail: "9 of 12 windows were positive at double fees (a window with no trades is not positive)." },
  { key: "random_entry", label: "Beats random entry with the same exposure", passed, detail: "Beat 98% of the random-entry runs; 95% is needed." },
  { key: "drawdown", label: "Drawdown within the strategy's own cap", passed: true, detail: "Worst window drawdown 14% against a cap of 20%." },
  { key: "plateau", label: "Neighbouring parameters are also positive", passed, detail: "7 of 8 neighbouring parameter sets were positive out of sample." },
  { key: "regimes", label: "Tested across bull, bear and range, per coin", passed, detail: "ok" },
  { key: "look_ahead", label: "Look-ahead check: signals on truncated data are identical", passed: true, detail: "ok" },
  { key: "point_in_time", label: "Point in time", passed: true, detail: "ok" },
  { key: "holdout", label: "A clean holdout read (or confirmation on paper)", passed, detail: "clean holdout: the first read" },
];

export function sampleRun(kind: "pass" | "fail"): TradingBacktestRun {
  const pass = kind === "pass";
  const btc = pass ? [0.011, 0.006, -0.004, 0.009, 0.013, null, 0.004, 0.008, -0.002, 0.007, 0.01, 0.005] : [-0.012, 0.004, -0.008, -0.003, 0.002, null, -0.011, -0.006, 0.001, -0.009, -0.004, -0.007];
  const eth = pass ? [0.009, 0.004, 0.002, -0.006, 0.01, 0.004, 0.003, 0.006, -0.001, 0.005, 0.008, 0.003] : [-0.01, 0.003, -0.007, -0.002, 0.001, -0.004, -0.009, -0.005, 0.002, -0.008, -0.003, -0.006];
  const mean = pass ? 0.0021 : -0.0034;
  const gate = { passed: pass, items: items(pass), summary: pass ? "Passed every check of the start gate." : "Did not pass." };
  return {
    id: pass ? "run-pass" : "run-fail",
    strategyId: "s1",
    versionId: "v1",
    purpose: "gate",
    status: "succeeded",
    gatePassed: pass,
    gate,
    variantsTried: 9,
    error: null,
    createdAt: "2026-11-01T10:00:00.000Z",
    startedAt: "2026-11-01T10:01:00.000Z",
    finishedAt: "2026-11-01T10:09:00.000Z",
    report: {
      asOf: "2026-11-01T10:00:00.000Z",
      timeframe: "4h",
      skippedCoins: [],
      headline: {
        coins: ["BTC", "ETH"],
        outOfSample: { fees2x: metrics(312, pass ? 168 : 141, mean) },
        windows: { total: 24, positive: pass ? 17 : 8 },
        worstWindowDrawdownPct: pass ? 14 : 27,
        drawdownCapPct: 20,
        beatRandomShare: pass ? 0.98 : 0.31,
      },
      coins: [coin("BTC", true, btc, pass ? [] : ["bull"], mean), coin("ETH", true, eth, [], mean), coin("SOL", false, eth, ["bull", "bear"], mean)],
      holdout: { read: true, seenCount: pass ? 0 : 2, fresh: false, label: pass ? "clean holdout: the first read" : "holdout already seen 2 times", headline: { fees2x: metrics(88, 49, pass ? 0.003 : -0.001), positive: pass } },
      trials: { variantsInThisRun: 9, variantsInRegistry: 9, plateau: { applicable: true, neighbours: [{ positive: true }, { positive: true }, { positive: !pass }] } },
      gate,
    },
  };
}
