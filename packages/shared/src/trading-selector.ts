import { normalCdf } from "./trading-backtest.js";
import { fnv1a, seededRandom } from "./trading-scoring.js";

/**
 * DUR-5015: the shadow tournament's strategy selector, as pure functions.
 *
 * Nothing here touches a database, a clock or a random source it did not seed:
 * the same stored trades and the same rules always give the same decision,
 * which is what lets a stored decision be reproduced later.
 *
 * The rules below are version 1. They are written before any shadow result
 * exists, stored as an immutable row (trading_selector_rules) and a decision
 * names the version it used. A change is a new version, never an edit.
 *
 * What the selector does, in order, at a fixed monthly checkpoint:
 *   1. Every (template x weather x coin) cell is a trial. Each cell's
 *      shadow trades give a hit rate (Beta posterior) and an average result in
 *      R (block bootstrap), both pulled toward the cell's strategy family so a
 *      cell with few trades cannot look great on luck.
 *   2. Cells are tested against zero expectancy; the Benjamini-Hochberg
 *      procedure keeps the share of false discoveries at 10% (an assumption).
 *      The number of tests m is every registered cell, tested or not.
 *   3. A cell that passes does NOT get paper cash. It starts a confirmation
 *      window: the next 100 trades it makes after the checkpoint. Only if it
 *      stays positive there is it promoted: the window's own trades must beat
 *      zero in a one-sided test at 5% (an assumption), and the cell must still
 *      pass step 2 at the checkpoint that closes the window.
 *   4. If nothing is promoted the selector chooses cash. That is a decision.
 *   5. A promotion is refused within 7 days after a drawdown stop.
 *
 * The selector can only choose among cells; it has no input or output for a
 * risk cap, so it cannot loosen one.
 */

export const TRADING_SELECTOR_RULES_V1 = {
  version: 1,
  /** Benjamini-Hochberg false-discovery rate (assumption). */
  fdrQ: 0.1,
  /** The fresh confirmation window: the next N trades of a cell after the checkpoint that passed it (assumption). */
  confirmationTrades: 100,
  /**
   * The fresh window must be positive on its own: a one-sided test of its trades alone at this level (assumption).
   * The cell's earlier trades are not allowed to vouch for it, or the luck that got it through the first test would carry it through the second.
   */
  confirmationAlpha: 0.05,
  /** A cell with fewer closed shadow trades than this is not tested (it counts as a trial with p = 1). */
  minTradesPerCell: 30,
  /** Pseudo-trades pulled from the family: a cell's estimate is (sum + k * familyMean) / (n + k). */
  shrinkageStrength: 20,
  bootstrapResamples: 1000,
  /** Trades of one cell are ordered in time; the bootstrap resamples blocks of this many to keep neighbouring trades together. */
  bootstrapBlockLength: 3,
  /** No promotion within this many days after a drawdown stop. */
  drawdownCooldownDays: 7,
  /** A confirmation that has not collected its trades after this many checkpoints is dropped. */
  confirmationExpiresAfterCheckpoints: 6,
  /** After a failed confirmation a cell may not start another one for this many checkpoints. */
  retryAfterCheckpoints: 3,
  /** The fee multiple the tests run at: the plan's gate is the 2x run. */
  gateFeeMultiplier: 2,
  /** The weather key of a day: the first that applies. Same names as the columns of the eligibility matrix. */
  weatherPrecedence: ["squeeze", "high_volatility", "trend"] as const,
} as const;

export type TradingSelectorRules = {
  version: number;
  fdrQ: number;
  confirmationTrades: number;
  confirmationAlpha: number;
  minTradesPerCell: number;
  shrinkageStrength: number;
  bootstrapResamples: number;
  bootstrapBlockLength: number;
  drawdownCooldownDays: number;
  confirmationExpiresAfterCheckpoints: number;
  retryAfterCheckpoints: number;
  gateFeeMultiplier: number;
  weatherPrecedence: readonly string[];
};

export const TRADING_WEATHER_KEYS = ["up", "range", "down", "squeeze", "high_volatility"] as const;
export type TradingWeatherKey = (typeof TRADING_WEATHER_KEYS)[number];

/** The weather key a market label puts a day in: squeeze first, then high volatility, then the trend. */
export function tradingWeatherKey(label: { trend: "uptrend" | "downtrend" | "ranging"; volatility: "low" | "normal" | "high"; squeeze: boolean }): TradingWeatherKey {
  if (label.squeeze) return "squeeze";
  if (label.volatility === "high") return "high_volatility";
  return label.trend === "uptrend" ? "up" : label.trend === "downtrend" ? "down" : "range";
}

export function tradingCellKey(cell: { templateKey: string; weather: string; asset: string }): string {
  return `${cell.templateKey}|${cell.weather}|${cell.asset}`;
}

// ─── Estimates ──────────────────────────────────────────────────────────────

export interface BetaPosterior {
  alpha: number;
  beta: number;
  mean: number;
  /** Standard deviation of the posterior. */
  sd: number;
}

/** Hit rate of a cell: a Beta posterior whose prior is the family's hit rate worth `strength` trades. */
export function betaPosterior(hits: number, trades: number, familyHitRate: number, strength: number): BetaPosterior {
  const prior = Math.min(0.99, Math.max(0.01, familyHitRate));
  const alpha = strength * prior + hits;
  const beta = strength * (1 - prior) + (trades - hits);
  const total = alpha + beta;
  return { alpha, beta, mean: alpha / total, sd: Math.sqrt((alpha * beta) / (total * total * (total + 1))) };
}

export function shrunkMean(sum: number, n: number, familyMean: number, strength: number): number {
  return (sum + strength * familyMean) / (n + strength);
}

/**
 * Bootstrap of the shrunk mean over moving blocks of the time-ordered results.
 * Returns the standard deviation and the 5th/95th percentiles of the
 * resampled shrunk means.
 */
export function blockBootstrapShrunk(
  results: readonly number[],
  familyMean: number,
  rules: Pick<TradingSelectorRules, "bootstrapResamples" | "bootstrapBlockLength" | "shrinkageStrength">,
  seed: number,
): { sd: number; low: number; high: number } {
  const n = results.length;
  const block = Math.max(1, Math.min(rules.bootstrapBlockLength, n));
  const rand = seededRandom(seed);
  const means: number[] = [];
  const maxStart = n - block;
  for (let b = 0; b < rules.bootstrapResamples; b++) {
    let sum = 0;
    let taken = 0;
    while (taken < n) {
      const start = Math.floor(rand() * (maxStart + 1));
      for (let i = 0; i < block && taken < n; i++, taken++) sum += results[start + i]!;
    }
    means.push(shrunkMean(sum, n, familyMean, rules.shrinkageStrength));
  }
  const avg = means.reduce((a, v) => a + v, 0) / means.length;
  const variance = means.reduce((a, v) => a + (v - avg) ** 2, 0) / Math.max(1, means.length - 1);
  const sorted = [...means].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))]!;
  return { sd: Math.sqrt(variance), low: at(0.05), high: at(0.95) };
}

export interface CellEstimate {
  trades: number;
  tested: boolean;
  rawMeanR: number | null;
  shrunkMeanR: number | null;
  hitRate: BetaPosterior | null;
  bootstrapLow: number | null;
  bootstrapHigh: number | null;
  /** One-sided p-value against "expectancy is zero or worse". 1 when the cell is not tested. */
  pValue: number;
}

export interface FamilyPrior {
  meanR: number;
  hitRate: number;
}

/**
 * Results are the cell's closed shadow trades at the gate fee, in the order
 * they closed. The p-value comes from the bootstrap's standard deviation and a
 * normal tail: with hundreds of cells the Benjamini-Hochberg cut-offs are far
 * smaller than 1/resamples, so a counted p-value could never pass.
 */
export function estimateCell(results: readonly number[], family: FamilyPrior, rules: TradingSelectorRules, seed: number): CellEstimate {
  const n = results.length;
  if (n < rules.minTradesPerCell) {
    return { trades: n, tested: false, rawMeanR: n > 0 ? results.reduce((a, v) => a + v, 0) / n : null, shrunkMeanR: null, hitRate: null, bootstrapLow: null, bootstrapHigh: null, pValue: 1 };
  }
  const sum = results.reduce((a, v) => a + v, 0);
  const hits = results.filter((r) => r > 0).length;
  const mean = shrunkMean(sum, n, family.meanR, rules.shrinkageStrength);
  const boot = blockBootstrapShrunk(results, family.meanR, rules, seed);
  const pValue = boot.sd < 1e-12 ? (mean > 0 ? 1e-12 : 1) : 1 - normalCdf(mean / boot.sd);
  return {
    trades: n,
    tested: true,
    rawMeanR: sum / n,
    shrunkMeanR: mean,
    hitRate: betaPosterior(hits, n, family.hitRate, rules.shrinkageStrength),
    bootstrapLow: boot.low,
    bootstrapHigh: boot.high,
    pValue: Math.min(1, Math.max(0, pValue)),
  };
}

/** Benjamini-Hochberg step-up: which hypotheses are rejected when the false-discovery rate is held at q. */
export function benjaminiHochberg(pValues: readonly number[], q: number): boolean[] {
  const m = pValues.length;
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p || a.i - b.i);
  let cutoffRank = 0;
  order.forEach((entry, rank) => {
    if (entry.p <= ((rank + 1) / m) * q) cutoffRank = rank + 1;
  });
  const rejected = new Array<boolean>(m).fill(false);
  for (let r = 0; r < cutoffRank; r++) rejected[order[r]!.i] = true;
  return rejected;
}

// ─── The selector ───────────────────────────────────────────────────────────

export interface SelectorCellInput {
  key: string;
  family: string;
  /** Results in R at the gate fee of the cell's closed shadow trades whose exit is at or before the checkpoint, oldest exit first. */
  results: readonly number[];
}

export type SelectorConfirmationStatus = "running" | "passed" | "failed" | "expired";

export interface SelectorConfirmationState {
  cellKey: string;
  status: SelectorConfirmationStatus;
  /** Checkpoints that have happened since the window was opened (the opening checkpoint is 0). */
  checkpointsElapsed: number;
  /** Checkpoints since a failed/expired window ended. Null while running/passed. */
  checkpointsSinceEnd: number | null;
  /** The cell is currently allowed paper cash. */
  promoted: boolean;
  /** Results in R at the gate fee of the trades entered after the window opened and closed by the checkpoint, oldest first. */
  windowResults: readonly number[];
}

export interface SelectorInput {
  rules: TradingSelectorRules;
  /** ISO time of the checkpoint; also part of every bootstrap seed. */
  checkpointAt: string;
  cells: readonly SelectorCellInput[];
  confirmations: readonly SelectorConfirmationState[];
  /** The latest drawdown stop, or null. */
  lastDrawdownAt: string | null;
}

export type SelectorAction =
  | "not_tested"
  | "failed_test"
  | "passed_test_confirmation_started"
  | "passed_test_confirmation_blocked"
  | "confirmation_running"
  | "confirmation_expired"
  | "confirmation_failed"
  | "confirmed_promoted"
  | "confirmed_deferred_after_drawdown"
  | "kept_promoted"
  | "confirmation_lapsed"
  | "demoted";

export interface SelectorCellOutcome {
  key: string;
  family: string;
  estimate: CellEstimate;
  passedTest: boolean;
  action: SelectorAction;
  note: string;
  windowTrades: number;
  windowMeanR: number | null;
}

export interface SelectorOutput {
  rulesVersion: number;
  checkpointAt: string;
  trials: number;
  tested: number;
  discoveries: number;
  cells: SelectorCellOutcome[];
  /** Cells allowed paper cash after this checkpoint. Empty = cash. */
  promoted: string[];
  startedConfirmations: string[];
  choice: "cash" | "cells";
  reason: string;
  /** The selector has no way to touch a risk cap. Always "unchanged". */
  riskCaps: "unchanged";
}

function mean(values: readonly number[]): number {
  return values.reduce((a, v) => a + v, 0) / values.length;
}

export function runSelector(input: SelectorInput): SelectorOutput {
  const { rules } = input;
  const checkpointMs = Date.parse(input.checkpointAt);
  const inCooldown = input.lastDrawdownAt !== null && checkpointMs - Date.parse(input.lastDrawdownAt) < rules.drawdownCooldownDays * 86_400_000;

  // Family priors, leaving the cell itself out (a big cell must not vouch for itself).
  const byFamily = new Map<string, Array<{ key: string; results: readonly number[] }>>();
  for (const c of input.cells) {
    const list = byFamily.get(c.family) ?? [];
    list.push({ key: c.key, results: c.results });
    byFamily.set(c.family, list);
  }
  const priorFor = (cell: SelectorCellInput): FamilyPrior => {
    const others = (byFamily.get(cell.family) ?? []).filter((o) => o.key !== cell.key).flatMap((o) => o.results);
    if (others.length === 0) return { meanR: 0, hitRate: 0.5 };
    return { meanR: mean(others), hitRate: others.filter((r) => r > 0).length / others.length };
  };

  const estimates = input.cells.map((cell) => estimateCell(cell.results, priorFor(cell), rules, fnv1a(`${rules.version}|${cell.key}|${input.checkpointAt}`)));
  const rejected = benjaminiHochberg(
    estimates.map((e) => e.pValue),
    rules.fdrQ,
  );
  const confirmations = new Map(input.confirmations.map((c) => [c.cellKey, c]));

  const cells: SelectorCellOutcome[] = [];
  const promoted: string[] = [];
  const startedConfirmations: string[] = [];

  input.cells.forEach((cell, i) => {
    const estimate = estimates[i]!;
    const passedTest = rejected[i]! && (estimate.shrunkMeanR ?? 0) > 0;
    const state = confirmations.get(cell.key);
    const windowResults = state?.windowResults ?? [];
    let action: SelectorAction;
    let note: string;
    let windowMean: number | null = null;
    let windowTrades = 0;

    if (state && state.promoted) {
      if (passedTest) {
        action = "kept_promoted";
        note = "Still passes the test at this checkpoint.";
        promoted.push(cell.key);
      } else {
        action = "demoted";
        note = estimate.tested ? "No longer passes the zero-expectancy test, so it loses its paper cash." : "Too few trades to test now; cash is the default.";
      }
    } else if (state && state.status === "running") {
      windowTrades = Math.min(windowResults.length, rules.confirmationTrades);
      if (windowResults.length >= rules.confirmationTrades) {
        const window = windowResults.slice(0, rules.confirmationTrades);
        windowMean = mean(window);
        // Neutral prior: nothing outside the window may vouch for the cell.
        const windowEstimate = estimateCell(window, { meanR: 0, hitRate: 0.5 }, { ...rules, minTradesPerCell: rules.confirmationTrades }, fnv1a(`${rules.version}|confirm|${cell.key}|${input.checkpointAt}`));
        const windowPasses = windowEstimate.tested && windowMean > 0 && windowEstimate.pValue <= rules.confirmationAlpha;
        if (windowPasses && passedTest) {
          if (inCooldown) {
            action = "confirmed_deferred_after_drawdown";
            note = `Stayed positive over its ${rules.confirmationTrades}-trade window, but a drawdown stop is less than ${rules.drawdownCooldownDays} days old: no promotion that increases size now.`;
          } else {
            action = "confirmed_promoted";
            note = `Stayed positive over its ${rules.confirmationTrades}-trade window (average ${windowMean.toFixed(3)} R) and still passes the test.`;
            promoted.push(cell.key);
          }
        } else {
          action = "confirmation_failed";
          note = windowMean > 0 && windowPasses ? "Positive in its window but no longer passes the test." : windowMean > 0 ? `Positive in its fresh window (average ${windowMean.toFixed(3)} R) but not clearly better than zero. The first result was probably luck.` : `Did not stay positive in its fresh window (average ${windowMean.toFixed(3)} R). The first result was luck.`;
        }
      } else {
        windowMean = windowResults.length > 0 ? mean(windowResults) : null;
        if (state.checkpointsElapsed >= rules.confirmationExpiresAfterCheckpoints) {
          action = "confirmation_expired";
          note = `Only ${windowResults.length} of ${rules.confirmationTrades} window trades after ${state.checkpointsElapsed} checkpoints.`;
        } else {
          action = "confirmation_running";
          note = `${windowResults.length} of ${rules.confirmationTrades} window trades so far. No verdict before the window is full.`;
        }
      }
    } else if (state && state.status === "passed") {
      // Confirmed earlier but held back by the drawdown rule.
      windowMean = windowResults.length >= rules.confirmationTrades ? mean(windowResults.slice(0, rules.confirmationTrades)) : null;
      windowTrades = Math.min(windowResults.length, rules.confirmationTrades);
      if (!passedTest) {
        action = "confirmation_lapsed";
        note = "Confirmed earlier but no longer passes the test; it needs a new confirmation window.";
      } else if (inCooldown) {
        action = "confirmed_deferred_after_drawdown";
        note = `Confirmed earlier; still inside ${rules.drawdownCooldownDays} days of a drawdown stop.`;
      } else {
        action = "confirmed_promoted";
        note = "Confirmed earlier and the drawdown wait is over.";
        promoted.push(cell.key);
      }
    } else if (!estimate.tested) {
      action = "not_tested";
      note = `${estimate.trades} of the ${rules.minTradesPerCell} trades needed to test it.`;
    } else if (!passedTest) {
      action = "failed_test";
      note = "Does not beat zero expectancy once the number of cells tried is accounted for.";
    } else if (state && state.checkpointsSinceEnd !== null && state.checkpointsSinceEnd < rules.retryAfterCheckpoints) {
      action = "passed_test_confirmation_blocked";
      note = `A confirmation of this cell ended ${state.checkpointsSinceEnd} checkpoint(s) ago; it may try again after ${rules.retryAfterCheckpoints}.`;
    } else {
      action = "passed_test_confirmation_started";
      note = `Passes the test. No paper cash yet: a fresh window of the next ${rules.confirmationTrades} trades decides.`;
      startedConfirmations.push(cell.key);
    }
    cells.push({ key: cell.key, family: cell.family, estimate, passedTest, action, note, windowTrades, windowMeanR: windowMean });
  });

  const tested = estimates.filter((e) => e.tested).length;
  const discoveries = cells.filter((c) => c.passedTest).length;
  const choice: "cash" | "cells" = promoted.length > 0 ? "cells" : "cash";
  const reason =
    choice === "cells"
      ? `${promoted.length} cell(s) hold paper cash.`
      : startedConfirmations.length > 0
        ? `Cash: ${startedConfirmations.length} cell(s) passed the test and now need a fresh confirmation window.`
        : tested === 0
          ? "Cash: no cell has enough closed trades to be tested yet."
          : "Cash: no cell beats zero expectancy after fees once the number of cells tried is accounted for.";
  return { rulesVersion: rules.version, checkpointAt: input.checkpointAt, trials: input.cells.length, tested, discoveries, cells, promoted, startedConfirmations, choice, reason, riskCaps: "unchanged" };
}

/**
 * What an action does to a cell's confirmation record. null = the record does
 * not change. A demoted or lapsed cell has to earn a fresh window again (after
 * the retry wait), so both end the record the way a failed window does.
 */
export function selectorConfirmationTransition(action: SelectorAction): { status: SelectorConfirmationStatus; promoted: boolean; ends: boolean; opens: boolean } | null {
  switch (action) {
    case "passed_test_confirmation_started":
      return { status: "running", promoted: false, ends: false, opens: true };
    case "confirmed_promoted":
      return { status: "passed", promoted: true, ends: false, opens: false };
    case "confirmed_deferred_after_drawdown":
      return { status: "passed", promoted: false, ends: false, opens: false };
    case "confirmation_failed":
    case "demoted":
    case "confirmation_lapsed":
      return { status: "failed", promoted: false, ends: true, opens: false };
    case "confirmation_expired":
      return { status: "expired", promoted: false, ends: true, opens: false };
    default:
      return null;
  }
}

// ─── Checkpoints ────────────────────────────────────────────────────────────

/** The fixed checkpoint at or before `at`: 00:00 UTC on the 1st of its month. */
export function latestSelectorCheckpoint(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

export function previousSelectorCheckpoint(checkpoint: Date): Date {
  return new Date(Date.UTC(checkpoint.getUTCFullYear(), checkpoint.getUTCMonth() - 1, 1));
}

// ─── Walk-forward test of the selector itself ───────────────────────────────

export interface ShadowTradeFact {
  cellKey: string;
  family: string;
  entryAt: Date;
  exitAt: Date;
  /** R at the gate fee. */
  r: number;
}

export interface WalkForwardCheckpoint {
  checkpointAt: string;
  choice: "cash" | "cells";
  promoted: string[];
  startedConfirmations: string[];
  /** Result in R of trades entered in the month after the checkpoint in the promoted cells, and how many. */
  nextMonthR: number;
  nextMonthTrades: number;
  /** For contrast: the same month for the cell with the best raw average before the checkpoint (what picking by eye would do). */
  naiveCellKey: string | null;
  naiveNextMonthR: number;
  naiveNextMonthTrades: number;
}

export interface WalkForwardReport {
  rulesVersion: number;
  checkpoints: WalkForwardCheckpoint[];
  selectorR: number;
  selectorTrades: number;
  naiveR: number;
  naiveTrades: number;
  monthsInCash: number;
}

/**
 * Replays the selector over stored shadow trades the way it would have run:
 * at each checkpoint it sees only trades that had closed, carries its own
 * confirmation state forward, and is then scored on the trades that came
 * after. Cash scores 0.
 */
export function walkForwardSelector(input: { rules: TradingSelectorRules; trades: readonly ShadowTradeFact[]; cellKeys: readonly string[]; checkpoints: readonly Date[]; drawdownAts?: readonly Date[] }): WalkForwardReport {
  const { rules } = input;
  const familyOf = new Map<string, string>();
  for (const t of input.trades) familyOf.set(t.cellKey, t.family);
  const sorted = [...input.trades].sort((a, b) => a.exitAt.getTime() - b.exitAt.getTime());
  const state = new Map<string, { status: SelectorConfirmationStatus; openedAt: number; elapsed: number; sinceEnd: number | null; promoted: boolean }>();
  const report: WalkForwardReport = { rulesVersion: rules.version, checkpoints: [], selectorR: 0, selectorTrades: 0, naiveR: 0, naiveTrades: 0, monthsInCash: 0 };
  const checkpoints = [...input.checkpoints].sort((a, b) => a.getTime() - b.getTime());

  checkpoints.forEach((cp, idx) => {
    const cpMs = cp.getTime();
    const nextMs = checkpoints[idx + 1]?.getTime() ?? Number.POSITIVE_INFINITY;
    // Age every open window by one checkpoint (the opening checkpoint is 0).
    for (const s of state.values()) {
      if (s.status === "running") s.elapsed += 1;
      if ((s.status === "failed" || s.status === "expired") && s.sinceEnd !== null) s.sinceEnd += 1;
    }
    const closed = sorted.filter((t) => t.exitAt.getTime() <= cpMs);
    const cells: SelectorCellInput[] = input.cellKeys.map((key) => ({ key, family: familyOf.get(key) ?? "unknown", results: closed.filter((t) => t.cellKey === key).map((t) => t.r) }));
    const confirmations: SelectorConfirmationState[] = [...state.entries()].map(([cellKey, s]) => ({
      cellKey,
      status: s.status,
      checkpointsElapsed: s.elapsed,
      checkpointsSinceEnd: s.sinceEnd,
      promoted: s.promoted,
      windowResults: sorted.filter((t) => t.cellKey === cellKey && t.entryAt.getTime() >= s.openedAt && t.exitAt.getTime() <= cpMs).map((t) => t.r),
    }));
    const drawdown = (input.drawdownAts ?? []).filter((d) => d.getTime() <= cpMs).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const out = runSelector({ rules, checkpointAt: cp.toISOString(), cells, confirmations, lastDrawdownAt: drawdown ? drawdown.toISOString() : null });

    for (const c of out.cells) {
      const change = selectorConfirmationTransition(c.action);
      if (!change) continue;
      if (change.opens) state.set(c.key, { status: "running", openedAt: cpMs, elapsed: 0, sinceEnd: null, promoted: false });
      else {
        const prior = state.get(c.key);
        if (prior) Object.assign(prior, { status: change.status, promoted: change.promoted, sinceEnd: change.ends ? 0 : prior.sinceEnd });
      }
    }

    const inMonth = (t: ShadowTradeFact) => t.entryAt.getTime() > cpMs && t.entryAt.getTime() <= nextMs;
    const picked = new Set(out.promoted);
    const taken = sorted.filter((t) => picked.has(t.cellKey) && inMonth(t));
    let naive: string | null = null;
    let naiveBest = Number.NEGATIVE_INFINITY;
    for (const c of cells) {
      if (c.results.length === 0) continue;
      const avg = mean(c.results);
      if (avg > naiveBest) {
        naiveBest = avg;
        naive = c.key;
      }
    }
    const naiveTaken = naive ? sorted.filter((t) => t.cellKey === naive && inMonth(t)) : [];
    const sumR = (list: readonly ShadowTradeFact[]) => list.reduce((a, t) => a + t.r, 0);
    report.checkpoints.push({
      checkpointAt: cp.toISOString(),
      choice: out.choice,
      promoted: out.promoted,
      startedConfirmations: out.startedConfirmations,
      nextMonthR: sumR(taken),
      nextMonthTrades: taken.length,
      naiveCellKey: naive,
      naiveNextMonthR: sumR(naiveTaken),
      naiveNextMonthTrades: naiveTaken.length,
    });
    report.selectorR += sumR(taken);
    report.selectorTrades += taken.length;
    report.naiveR += sumR(naiveTaken);
    report.naiveTrades += naiveTaken.length;
    if (out.choice === "cash") report.monthsInCash += 1;
  });
  return report;
}
