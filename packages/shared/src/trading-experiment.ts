import { z } from "zod";
import { TRADING_START_GATE } from "./trading-backtest.js";

/**
 * DUR-5018: the experiment runner. An experiment is a small, capped parameter
 * grid on ONE version of a strategy's rules, run walk-forward on past data. It
 * ends in a stored result: a recommended variant, or "no change". Nothing here
 * applies a result. The only consumer is the Trader's proposal route, which
 * refuses a proposal that does not cite a finished experiment whose
 * recommended variant is exactly the rules being proposed.
 *
 * Every number a recommendation is judged by is a named constant here, and the
 * run stores the ones it used.
 */

export const TRADING_EXPERIMENT_LIMITS = {
  /** Variants in one experiment, "your rules as written" included. */
  maxVariants: 50,
  /** Parameters that may vary together in one grid. */
  maxAxes: 3,
  maxValuesPerAxis: 15,
  /** Experiments waiting or running for one company at once. */
  maxActivePerCompany: 5,
  /** Wall-clock limit for one experiment in its worker. */
  maxWallMs: 30 * 60_000,
} as const;

export const TRADING_EXPERIMENT_RECOMMEND = {
  /** A recommended variant needs at least this many out-of-sample trades (same bar as the start gate). */
  minOutOfSampleTrades: TRADING_START_GATE.minOutOfSampleTrades,
  /** Deflated Sharpe probability, counted over every variant ever tried in the lineage. */
  minDeflatedSharpe: 0.95,
  /** Share of the winner's grid neighbours (one step away) that must also be positive out of sample. */
  minPlateauShare: TRADING_START_GATE.minPlateauShare,
  /** A plateau needs at least this many neighbours to mean anything. */
  minPlateauNeighbours: 2,
} as const;

export const TRADING_EXPERIMENT_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type TradingExperimentStatus = (typeof TRADING_EXPERIMENT_STATUSES)[number];

/** The numeric indicator settings a grid may vary. Risk limits, stops and sizing are never varied by an experiment. */
export const TRADING_EXPERIMENT_PARAMS = ["period", "lookback", "stdDev"] as const;
export type TradingExperimentParam = (typeof TRADING_EXPERIMENT_PARAMS)[number];

const indicatorName = z.string().trim().min(1).max(64);

export const tradingExperimentAxisSchema = z
  .object({
    indicator: indicatorName,
    param: z.enum(TRADING_EXPERIMENT_PARAMS),
    values: z.array(z.number().finite()).min(1).max(TRADING_EXPERIMENT_LIMITS.maxValuesPerAxis),
  })
  .strict();
export type TradingExperimentAxis = z.infer<typeof tradingExperimentAxisSchema>;

export const queueTradingExperimentSchema = z
  .object({
    /** Defaults to the strategy's active version. */
    versionId: z.string().uuid().optional(),
    /** Omitted = the automatic neighbours: every indicator length nudged down and up by a quarter, one at a time. */
    grid: z.array(tradingExperimentAxisSchema).min(1).max(TRADING_EXPERIMENT_LIMITS.maxAxes).optional(),
  })
  .strict();
export type QueueTradingExperimentInput = z.infer<typeof queueTradingExperimentSchema>;

/** A canonical grid: axes sorted, values deduplicated and sorted, so the same grid always has the same digest. */
export function canonicalExperimentGrid(grid: readonly TradingExperimentAxis[]): TradingExperimentAxis[] {
  return grid
    .map((axis) => ({ indicator: axis.indicator, param: axis.param, values: [...new Set(axis.values)].sort((a, b) => a - b) }))
    .sort((a, b) => (a.indicator === b.indicator ? a.param.localeCompare(b.param) : a.indicator.localeCompare(b.indicator)));
}

/** How many combinations a grid has. */
export function experimentGridSize(grid: readonly TradingExperimentAxis[]): number {
  return grid.reduce((n, axis) => n * axis.values.length, 1);
}

/** The most combinations a grid may have: "your rules as written" always runs as well. */
export const TRADING_EXPERIMENT_MAX_COMBINATIONS = TRADING_EXPERIMENT_LIMITS.maxVariants - 1;

export interface TradingExperimentRecommendation {
  decision: "recommend" | "no_change";
  variantDigest: string | null;
  variantLabel: string | null;
  checks: Array<{ key: string; label: string; passed: boolean; detail: string }>;
  summary: string;
  thresholds: typeof TRADING_EXPERIMENT_RECOMMEND;
}
