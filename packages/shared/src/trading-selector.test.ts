import { describe, expect, it } from "vitest";
import { seededRandom } from "./trading-scoring.js";
import {
  TRADING_SELECTOR_RULES_V1,
  benjaminiHochberg,
  betaPosterior,
  estimateCell,
  latestSelectorCheckpoint,
  runSelector,
  tradingWeatherKey,
  walkForwardSelector,
  type SelectorConfirmationState,
  type ShadowTradeFact,
} from "./trading-selector.js";

const RULES = TRADING_SELECTOR_RULES_V1;
const DAY = 86_400_000;

/** Standard normal draws from the seeded generator (Box-Muller). */
function normals(seed: number, count: number, mean: number, sd = 1): number[] {
  const rand = seededRandom(seed);
  const out: number[] = [];
  while (out.length < count) {
    const u = Math.max(1e-12, rand());
    const v = rand();
    out.push(mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
  }
  return out;
}

describe("benjaminiHochberg", () => {
  it("rejects up to the largest rank under its line and nothing above it", () => {
    // m = 5, q = 0.1: lines are 0.02, 0.04, 0.06, 0.08, 0.10.
    expect(benjaminiHochberg([0.001, 0.03, 0.2, 0.5, 0.9], 0.1)).toEqual([true, true, false, false, false]);
    // The step-up rule: rank 3 is under its line, so ranks 1 and 2 go through even though 0.05 > 0.04.
    expect(benjaminiHochberg([0.01, 0.05, 0.055, 0.9, 0.95], 0.1)).toEqual([true, true, true, false, false]);
    expect(benjaminiHochberg([0.5, 0.6], 0.1)).toEqual([false, false]);
  });
  it("counts every cell in m: more cells make the same p-value fail", () => {
    expect(benjaminiHochberg([0.004], 0.1)).toEqual([true]);
    const many = [0.004, ...new Array(99).fill(0.9)];
    expect(benjaminiHochberg(many, 0.1)[0]).toBe(false);
  });
});

describe("cell estimates", () => {
  it("a Beta posterior is pulled toward the family hit rate when the cell is small", () => {
    const small = betaPosterior(4, 5, 0.4, 20);
    const big = betaPosterior(400, 500, 0.4, 20);
    expect(small.mean).toBeLessThan(0.6);
    expect(big.mean).toBeGreaterThan(0.77);
    expect(small.sd).toBeGreaterThan(big.sd);
  });
  it("does not test a cell with too few trades and counts it as p = 1", () => {
    const e = estimateCell(normals(1, 10, 2), { meanR: 0, hitRate: 0.5 }, RULES, 7);
    expect(e.tested).toBe(false);
    expect(e.pValue).toBe(1);
  });
  it("shrinks a small cell toward the family mean and is deterministic for a seed", () => {
    const results = normals(2, 31, 0.5);
    const a = estimateCell(results, { meanR: 0, hitRate: 0.5 }, RULES, 11);
    const b = estimateCell(results, { meanR: 0, hitRate: 0.5 }, RULES, 11);
    expect(a).toEqual(b);
    expect(a.shrunkMeanR!).toBeLessThan(a.rawMeanR!);
    expect(a.shrunkMeanR!).toBeGreaterThan(0);
  });
  it("gives a strong cell a tiny p-value and a null cell an unremarkable one", () => {
    expect(estimateCell(normals(3, 200, 0.4), { meanR: 0, hitRate: 0.5 }, RULES, 1).pValue).toBeLessThan(1e-4);
    expect(estimateCell(normals(4, 200, 0), { meanR: 0, hitRate: 0.5 }, RULES, 1).pValue).toBeGreaterThan(0.01);
  });
});

describe("weather keys", () => {
  it("squeeze beats high volatility beats the trend", () => {
    expect(tradingWeatherKey({ trend: "uptrend", volatility: "high", squeeze: true })).toBe("squeeze");
    expect(tradingWeatherKey({ trend: "uptrend", volatility: "high", squeeze: false })).toBe("high_volatility");
    expect(tradingWeatherKey({ trend: "ranging", volatility: "normal", squeeze: false })).toBe("range");
    expect(tradingWeatherKey({ trend: "downtrend", volatility: "low", squeeze: false })).toBe("down");
  });
  it("the checkpoint is the 1st of the month, 00:00 UTC", () => {
    expect(latestSelectorCheckpoint(new Date("2026-11-17T13:00:00Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("runSelector", () => {
  const cp = "2026-11-01T00:00:00.000Z";
  const noConfirmations: SelectorConfirmationState[] = [];

  it("chooses cash and says why when nothing has enough trades", () => {
    const out = runSelector({ rules: RULES, checkpointAt: cp, cells: [{ key: "a|up|BTC", family: "trend", results: normals(5, 10, 1) }], confirmations: noConfirmations, lastDrawdownAt: null });
    expect(out.choice).toBe("cash");
    expect(out.promoted).toEqual([]);
    expect(out.reason).toMatch(/no cell has enough closed trades/);
    expect(out.riskCaps).toBe("unchanged");
  });

  it("a cell that passes the test starts a confirmation and gets no cash yet", () => {
    const out = runSelector({ rules: RULES, checkpointAt: cp, cells: [{ key: "a|up|BTC", family: "trend", results: normals(6, 120, 0.5) }], confirmations: noConfirmations, lastDrawdownAt: null });
    expect(out.cells[0]!.action).toBe("passed_test_confirmation_started");
    expect(out.startedConfirmations).toEqual(["a|up|BTC"]);
    expect(out.promoted).toEqual([]);
    expect(out.choice).toBe("cash");
  });

  it("promotes only after the fresh window is full and positive on its own", () => {
    const cell = { key: "a|up|BTC", family: "trend", results: normals(7, 150, 0.5) };
    const half: SelectorConfirmationState = { cellKey: cell.key, status: "running", checkpointsElapsed: 1, checkpointsSinceEnd: null, promoted: false, windowResults: normals(8, 60, 0.5) };
    const early = runSelector({ rules: RULES, checkpointAt: cp, cells: [cell], confirmations: [half], lastDrawdownAt: null });
    expect(early.cells[0]!.action).toBe("confirmation_running");
    expect(early.promoted).toEqual([]);
    const full: SelectorConfirmationState = { ...half, windowResults: normals(8, 100, 0.5) };
    const done = runSelector({ rules: RULES, checkpointAt: cp, cells: [cell], confirmations: [full], lastDrawdownAt: null });
    expect(done.cells[0]!.action).toBe("confirmed_promoted");
    expect(done.promoted).toEqual([cell.key]);
    expect(done.choice).toBe("cells");
  });

  it("refuses a promotion within 7 days after a drawdown, and allows it after", () => {
    const cell = { key: "a|up|BTC", family: "trend", results: normals(7, 150, 0.5) };
    const full: SelectorConfirmationState = { cellKey: cell.key, status: "running", checkpointsElapsed: 1, checkpointsSinceEnd: null, promoted: false, windowResults: normals(8, 100, 0.5) };
    const recent = new Date(Date.parse(cp) - 3 * DAY).toISOString();
    const blocked = runSelector({ rules: RULES, checkpointAt: cp, cells: [cell], confirmations: [full], lastDrawdownAt: recent });
    expect(blocked.cells[0]!.action).toBe("confirmed_deferred_after_drawdown");
    expect(blocked.promoted).toEqual([]);
    const old = new Date(Date.parse(cp) - 8 * DAY).toISOString();
    expect(runSelector({ rules: RULES, checkpointAt: cp, cells: [cell], confirmations: [full], lastDrawdownAt: old }).promoted).toEqual([cell.key]);
    // A deferred cell waits for the cooldown and then is promoted without a new window.
    const deferred: SelectorConfirmationState = { ...full, status: "passed" };
    expect(runSelector({ rules: RULES, checkpointAt: cp, cells: [cell], confirmations: [deferred], lastDrawdownAt: recent }).promoted).toEqual([]);
    expect(runSelector({ rules: RULES, checkpointAt: cp, cells: [cell], confirmations: [deferred], lastDrawdownAt: null }).promoted).toEqual([cell.key]);
  });

  it("a promoted cell that stops passing is demoted back to cash", () => {
    const cell = { key: "a|up|BTC", family: "trend", results: normals(9, 150, 0) };
    const held: SelectorConfirmationState = { cellKey: cell.key, status: "passed", checkpointsElapsed: 3, checkpointsSinceEnd: null, promoted: true, windowResults: [] };
    const out = runSelector({ rules: RULES, checkpointAt: cp, cells: [cell], confirmations: [held], lastDrawdownAt: null });
    expect(out.cells[0]!.action).toBe("demoted");
    expect(out.choice).toBe("cash");
  });

  it("a failed confirmation cannot restart right away", () => {
    const cell = { key: "a|up|BTC", family: "trend", results: normals(6, 150, 0.5) };
    const failed: SelectorConfirmationState = { cellKey: cell.key, status: "failed", checkpointsElapsed: 2, checkpointsSinceEnd: 1, promoted: false, windowResults: [] };
    const out = runSelector({ rules: RULES, checkpointAt: cp, cells: [cell], confirmations: [failed], lastDrawdownAt: null });
    expect(out.cells[0]!.action).toBe("passed_test_confirmation_blocked");
    expect(out.startedConfirmations).toEqual([]);
  });

  it("is reproducible: the same input gives the same output", () => {
    const cells = Array.from({ length: 30 }, (_, i) => ({ key: `t${i}|up|BTC`, family: i % 2 ? "trend" : "breakout", results: normals(100 + i, 80, i === 3 ? 0.6 : 0) }));
    const input = { rules: RULES, checkpointAt: cp, cells, confirmations: noConfirmations, lastDrawdownAt: null };
    expect(runSelector(input)).toEqual(runSelector(input));
  });
});

describe("a cell that passes only by luck fails at the confirmation window (synthetic)", () => {
  /**
   * 60 cells, none with any edge. After a discovery month one cell is given a
   * lucky run (the kind of streak that gets through the first test); its fresh
   * trades then come from the same no-edge process as everyone else's.
   */
  function world(seed: number) {
    const keys = Array.from({ length: 60 }, (_, i) => `t${i % 10}|${i % 5 === 0 ? "up" : "range"}|C${i}`);
    const start = Date.parse("2026-01-01T00:00:00Z");
    const trades: ShadowTradeFact[] = [];
    keys.forEach((key, c) => {
      const lucky = c === 0;
      // 60 trades before the first checkpoint (a lucky run for cell 0), 150 after it.
      const before = normals(seed * 1000 + c, 60, lucky ? 0.9 : 0);
      const after = normals(seed * 1000 + 500 + c, 150, 0);
      [...before, ...after].forEach((r, i) => {
        const at = start + i * (i < 60 ? 0.4 : 0.5) * DAY;
        trades.push({ cellKey: key, family: "trend", entryAt: new Date(at), exitAt: new Date(at + 0.2 * DAY), r });
      });
    });
    const checkpoints = [new Date(start + 26 * DAY), new Date(start + 56 * DAY), new Date(start + 86 * DAY), new Date(start + 116 * DAY)];
    return { keys, trades, checkpoints };
  }

  it("the lucky cell passes the first test, then does not get paper cash", () => {
    const { keys, trades, checkpoints } = world(1);
    const first = walkForwardSelector({ rules: RULES, trades, cellKeys: keys, checkpoints: checkpoints.slice(0, 1) });
    expect(first.checkpoints[0]!.startedConfirmations).toContain(keys[0]);
    expect(first.checkpoints[0]!.choice).toBe("cash");
    // The picking-by-eye contrast really does pick it.
    expect(first.checkpoints[0]!.naiveCellKey).toBe(keys[0]);
    const full = walkForwardSelector({ rules: RULES, trades, cellKeys: keys, checkpoints });
    // 100 fresh trades take until the third or fourth checkpoint; the lucky cell never ends up with cash in most worlds.
    expect(full.checkpoints.every((c) => c.choice === "cash")).toBe(true);
  });

  it("across 40 worlds with no edge anywhere (one hot streak each), paper cash is rarely given", () => {
    let worldsWithCash = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const { keys, trades, checkpoints } = world(seed);
      const report = walkForwardSelector({ rules: RULES, trades, cellKeys: keys, checkpoints });
      if (report.checkpoints.some((c) => c.choice === "cells")) worldsWithCash++;
    }
    // The hot-streak cell always passes the first test (it is the whole point of the setup), so the only thing
    // between it and paper cash is the fresh window: a one-sided 5% test on null data, about 2 worlds in 40.
    // Picking by eye would have promoted it in all 40.
    expect(worldsWithCash).toBeLessThanOrEqual(6);
  }, 60_000);

  it("a real edge survives: the walk-forward selector earns cash for a cell that keeps its edge", () => {
    const keys = ["real|up|BTC", ...Array.from({ length: 40 }, (_, i) => `n${i}|range|ETH`)];
    const start = Date.parse("2026-01-01T00:00:00Z");
    const trades: ShadowTradeFact[] = [];
    keys.forEach((key, c) => {
      normals(900 + c, 400, key.startsWith("real") ? 0.45 : 0).forEach((r, i) => {
        const at = start + i * 0.3 * DAY;
        trades.push({ cellKey: key, family: "trend", entryAt: new Date(at), exitAt: new Date(at + 0.1 * DAY), r });
      });
    });
    const checkpoints = Array.from({ length: 6 }, (_, i) => new Date(start + (30 + 30 * i) * DAY));
    const report = walkForwardSelector({ rules: RULES, trades, cellKeys: keys, checkpoints });
    const promotedAt = report.checkpoints.find((c) => c.promoted.includes("real|up|BTC"));
    expect(promotedAt).toBeDefined();
    expect(report.selectorR).toBeGreaterThan(0);
    expect(report.checkpoints.flatMap((c) => c.promoted).every((k) => k === "real|up|BTC")).toBe(true);
  });
});
