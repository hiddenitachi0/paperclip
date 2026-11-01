import { z } from "zod";
import { TRADING_ASSETS } from "./trading.js";
import { TRADING_STRATEGY_FAMILIES, tradingStrategySpecSchema, type TradingStrategySpec, type TradingStrategySpecInput } from "./trading-spec.js";

/**
 * DUR-5014: the strategy template library. Crypto-adapted versions of the
 * daytradelab styles, plus the three controls.
 *
 * A template is a spec v2 rule book (unchanged, so its digest and the engine
 * stay exactly as DUR-5002 made them) wrapped in the things a spec has no room
 * for: when it works and fails, the weather it may trade in, and which of its
 * numbers are only starting values. The numbers are STARTING VALUES TO BE
 * TESTED, not findings: the plan (DUR-4889, section 7) says the page they come
 * from gives prose only, no numbers and no hit rates.
 *
 * Wording rule: a template that passes the past-data checks is labelled
 * "passed the past-data checks: paper only, not a recommendation". Nothing in
 * this file, and nothing built from it, may call a template "ready" or
 * "promising" (see tradingTemplateLabel and its test).
 *
 * Nothing here reaches client companies: the API serving it is instance-admin
 * only until the legal check of decision 19 is done.
 */

export const TRADING_TEMPLATE_LIBRARY_VERSION = 1;

// ─── Eligibility matrix ─────────────────────────────────────────────────────

export const TRADING_MATRIX_COLUMNS = ["up", "range", "down", "squeeze", "high_volatility"] as const;
export type TradingMatrixColumn = (typeof TRADING_MATRIX_COLUMNS)[number];

export const TRADING_MATRIX_CELL_VALUES = ["yes", "no", "cash_only", "half_size", "only_on_squeeze", "pullback_to_vwap_only", "experimental", "always"] as const;
export type TradingMatrixCellValue = (typeof TRADING_MATRIX_CELL_VALUES)[number];

export const tradingEligibilityMatrixSchema = z
  .object({
    version: z.number().int().min(1),
    /** Plain-words note on what changed in this version (shown next to the matrix). */
    note: z.string().trim().min(1).max(500),
    rows: z.record(
      z.enum(TRADING_STRATEGY_FAMILIES),
      z.object({
        label: z.string().min(1).max(200),
        cells: z.record(z.enum(TRADING_MATRIX_COLUMNS), z.enum(TRADING_MATRIX_CELL_VALUES)),
      }),
    ),
  })
  .strict()
  .superRefine((matrix, ctx) => {
    for (const family of TRADING_STRATEGY_FAMILIES) {
      const row = matrix.rows[family];
      if (!row) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rows", family], message: `The matrix needs a row for ${family}.` });
        continue;
      }
      for (const column of TRADING_MATRIX_COLUMNS) {
        if (!row.cells[column]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rows", family, "cells", column], message: `The ${family} row needs a ${column} cell.` });
      }
    }
  });
export type TradingEligibilityMatrix = z.infer<typeof tradingEligibilityMatrixSchema>;

/** Written in advance, versioned: the plan's section 7. In a down trend nothing is traded (spot is long-only) but predictions keep being logged and scored. */
export const TRADING_ELIGIBILITY_MATRIX_V1: TradingEligibilityMatrix = tradingEligibilityMatrixSchema.parse({
  version: 1,
  note: "First matrix, from the plan (section 7). Written before any past-data result was seen.",
  rows: {
    trend: { label: "Trend (continuation, pullback, momentum)", cells: { up: "yes", range: "no", down: "cash_only", squeeze: "no", high_volatility: "half_size" } },
    breakout: { label: "Breakout", cells: { up: "yes", range: "only_on_squeeze", down: "no", squeeze: "yes", high_volatility: "no" } },
    mean_reversion: { label: "Mean reversion (support/resistance bounce, VWAP reclaim)", cells: { up: "pullback_to_vwap_only", range: "yes", down: "no", squeeze: "no", high_volatility: "no" } },
    reversal: { label: "Reversal (long-only)", cells: { up: "no", range: "no", down: "experimental", squeeze: "no", high_volatility: "experimental" } },
    control: { label: "Controls (buy-and-hold, cash, random entry)", cells: { up: "always", range: "always", down: "always", squeeze: "always", high_volatility: "always" } },
  },
});

const NOT_ALLOWED_CELLS: readonly TradingMatrixCellValue[] = ["no", "cash_only"];

/** The market trends a family may trade in, according to a matrix. */
export function matrixAllowedTrends(matrix: TradingEligibilityMatrix, family: (typeof TRADING_STRATEGY_FAMILIES)[number]): Array<"up" | "range" | "down"> {
  const cells = matrix.rows[family]!.cells;
  return (["up", "range", "down"] as const).filter((trend) => !NOT_ALLOWED_CELLS.includes(cells[trend]));
}

// ─── Wording ────────────────────────────────────────────────────────────────

export const TRADING_TEMPLATE_PASSED_LABEL = "passed the past-data checks: paper only, not a recommendation";
export const TRADING_TEMPLATE_NOT_PASSED_LABEL = "did not pass the past-data checks";
export const TRADING_TEMPLATE_NOT_TESTED_LABEL = "not yet tested on past data";
export const TRADING_TEMPLATE_PRICE_ONLY_LABEL = "tested on price and volume only: the funding and open-interest part is not tested yet, so it cannot pass";
export const TRADING_TEMPLATE_CONTROL_LABEL = "control: a yardstick to beat, not a strategy to run for profit";

export type TradingTemplateLabelInput = {
  family: (typeof TRADING_STRATEGY_FAMILIES)[number];
  /** The report status, or null when there is no report yet. */
  reportStatus: "succeeded" | "failed" | "not_testable" | null;
  gatePassed: boolean | null;
  /** Data the thesis needs that is not recorded yet. */
  missingData: readonly string[];
};

/** The one place a template's status wording is chosen. Never "ready", never "promising". */
export function tradingTemplateLabel(input: TradingTemplateLabelInput): { label: string; passed: boolean } {
  if (input.family === "control") return { label: TRADING_TEMPLATE_CONTROL_LABEL, passed: false };
  if (input.reportStatus === null) return { label: TRADING_TEMPLATE_NOT_TESTED_LABEL, passed: false };
  if (input.reportStatus === "not_testable" || input.reportStatus === "failed") return { label: TRADING_TEMPLATE_NOT_TESTED_LABEL, passed: false };
  if (input.missingData.length > 0) return { label: TRADING_TEMPLATE_PRICE_ONLY_LABEL, passed: false };
  if (input.gatePassed === true) return { label: TRADING_TEMPLATE_PASSED_LABEL, passed: true };
  return { label: TRADING_TEMPLATE_NOT_PASSED_LABEL, passed: false };
}

// ─── The template shape ─────────────────────────────────────────────────────

export const TRADING_TEMPLATE_WAVES = ["first", "second", "experimental", "control"] as const;
export type TradingTemplateWave = (typeof TRADING_TEMPLATE_WAVES)[number];

export const TRADING_TEMPLATE_DATA_NEEDS = ["funding", "open_interest"] as const;

export const TRADING_CONTROL_KINDS = ["buy_and_hold", "stay_in_cash", "random_entry"] as const;

const templateKeySchema = z.string().regex(/^[a-z][a-z0-9_]{1,47}$/, "A template key is lower-case letters, digits and underscores.");

const startingValueSchema = z
  .object({
    /** Dotted path into the spec, for example indicators.ema_fast.period. */
    path: z.string().min(1).max(120),
    label: z.string().trim().min(1).max(160),
    /** Always this: every number is a guess until the past-data test has seen it. */
    status: z.literal("to_be_tested"),
  })
  .strict();

const notesSchema = z.array(z.string().trim().min(1).max(400)).min(1).max(8);

export const tradingTemplateSchema = z
  .object({
    key: templateKeySchema,
    templateVersion: z.number().int().min(1),
    wave: z.enum(TRADING_TEMPLATE_WAVES),
    /** The daytradelab style this adapts (several templates may share one). */
    style: z.string().min(1).max(60),
    spec: tradingStrategySpecSchema,
    /** The owner-facing do/don't text stored with a strategy's rule book (never read by the engine). */
    guidelines: z.string().trim().min(1).max(4000),
    worksWhen: notesSchema,
    failsWhen: notesSchema,
    /** The weather the template may trade in. The spec's own regime gate must sit inside it, and it must sit inside the matrix row of the family. */
    allowedWeather: z
      .object({
        trend: z.array(z.enum(["up", "range", "down"])).min(1).max(3),
        squeeze: z.enum(["yes", "no", "any"]),
        note: z.string().trim().min(1).max(400),
      })
      .strict(),
    startingValues: z.array(startingValueSchema).min(1).max(20),
    /** Data the thesis needs but we do not hold yet. While any is missing the template can be tested on price and volume only and can never earn the passed label. */
    requiresData: z.array(z.enum(TRADING_TEMPLATE_DATA_NEEDS)).max(2).default([]),
    /** Controls only. */
    controlKind: z.enum(TRADING_CONTROL_KINDS).optional(),
    /** What this adaptation leaves out of the original style, so nobody reads more into it than is there. */
    simplifications: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
  })
  .strict();
export type TradingTemplate = z.infer<typeof tradingTemplateSchema>;
type TradingTemplateInput = Omit<z.input<typeof tradingTemplateSchema>, "spec"> & { spec: TradingStrategySpecInput };

function valueAtPath(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  for (const part of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || !(part in (cursor as Record<string, unknown>))) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** The starting values with their current numbers read out of the spec. */
export function tradingTemplateStartingValues(template: Pick<TradingTemplate, "spec" | "startingValues">): Array<{ path: string; label: string; value: unknown; status: "to_be_tested" }> {
  return template.startingValues.map((v) => ({ ...v, value: valueAtPath(template.spec, v.path) }));
}

/** Cross-checks between a template, its spec and a matrix. Empty = fine. */
export function tradingTemplateProblems(template: TradingTemplate, matrix: TradingEligibilityMatrix = TRADING_ELIGIBILITY_MATRIX_V1): string[] {
  const problems: string[] = [];
  const family = template.spec.meta.family;
  const gate = template.spec.regimeGate;
  const matrixTrends = matrixAllowedTrends(matrix, family);
  for (const trend of template.allowedWeather.trend) {
    if (!matrixTrends.includes(trend)) problems.push(`Allowed weather lists a ${trend} trend, but the matrix does not let ${family} templates trade in it.`);
  }
  const gateTrends = gate.trend === "any" ? (["up", "range", "down"] as const) : ([gate.trend] as const);
  for (const trend of gateTrends) {
    if (!template.allowedWeather.trend.includes(trend)) problems.push(`The regime gate would let it trade in a ${trend} trend, which its allowed weather does not.`);
  }
  const matrixSqueeze = matrix.rows[family]!.cells.squeeze;
  if (matrixSqueeze === "no" && gate.squeeze !== "no") problems.push("The matrix keeps this family out of a squeeze, so the regime gate must say squeeze: no.");
  if (template.allowedWeather.squeeze === "yes" && gate.squeeze === "no") problems.push("Allowed weather needs a squeeze but the regime gate forbids one.");
  if (template.allowedWeather.squeeze === "no" && gate.squeeze !== "no") problems.push("Allowed weather says no squeeze but the regime gate does not forbid one.");
  for (const v of template.startingValues) {
    if (valueAtPath(template.spec, v.path) === undefined) problems.push(`Starting value "${v.path}" does not point at anything in the spec.`);
  }
  if (template.wave === "control" !== (family === "control")) problems.push("Controls, and only controls, are in the control wave with the control family.");
  if (family === "control" && !template.controlKind) problems.push("A control needs a control kind.");
  if (family !== "control" && template.controlKind) problems.push("Only a control has a control kind.");
  if (template.spec.universe.decisionTimeframe === "15m") problems.push("15-minute candles are for research only (decision 4).");
  const text = JSON.stringify([template.guidelines, template.worksWhen, template.failsWhen, template.spec.meta]).toLowerCase();
  for (const word of ["ready", "promising", "guaranteed", "profitable"]) {
    if (new RegExp(`\\b${word}\\b`).test(text)) problems.push(`The word "${word}" is not allowed in a template.`);
  }
  return problems;
}

// ─── Building blocks for the catalog ────────────────────────────────────────

const ASSETS = ["BTC", "ETH"] as const;
const PREDICTION = { horizonBars: 6, kind: "direction", flatBandPct: 0.25, rUnit: "atr_at_entry", targetSamples: 620, minRunningDays: 90 } as const;
const STAY_OUT = { cooldownAfterLosses: { losses: 3, bars: 12 } } as const;

function meta(name: string, family: (typeof TRADING_STRATEGY_FAMILIES)[number], thesis: string, commonMistakes: string[]) {
  return { name, family, thesis, commonMistakes } as const;
}

const all = (...conditions: unknown[]) => ({ match: "all", conditions }) as never;
const close = { price: "close" } as const;

// ─── The catalog ────────────────────────────────────────────────────────────

const TREND_CONTINUATION: TradingTemplateInput = {
  key: "trend_continuation",
  templateVersion: 1,
  wave: "first",
  style: "Trend continuation",
  spec: {
    specVersion: 2,
    meta: meta(
      "Trend continuation",
      "trend",
      "When a coin is already in an up trend with real trend strength, a break above its recent high usually continues for a while. The idea is to join a trend that is already running, not to guess its start.",
      [
        "Buying after the price is already stretched far above its average.",
        "Trading it in a sideways market, where every break fails.",
        "Moving the stop further away after the trade goes against you.",
        "Taking it in a squeeze, where a break is a different trade.",
      ],
    ),
    universe: { assets: [...ASSETS], decisionTimeframe: "4h" },
    indicators: {
      ema20: { kind: "ema", period: 20 },
      ema50: { kind: "ema", period: 50 },
      adx14: { kind: "adx", period: 14 },
      rsi14: { kind: "rsi", period: 14 },
      high10: { kind: "donchian", period: 10, band: "upper" },
    },
    regimeGate: { trend: "up", volatility: "any", squeeze: "no" },
    entry: {
      conditions: all(
        { left: { ref: "adx14" }, op: ">", right: { value: 20 } },
        { left: close, op: ">", right: { ref: "ema50" } },
        { left: { ref: "rsi14" }, op: "<", right: { value: 70 } },
        { left: close, op: "crosses_above", right: { ref: "high10" } },
      ),
    },
    exit: {
      stop: { kind: "atr", period: 14, multiple: 2 },
      trailing: { activateAtPct: 3, distancePct: 4 },
      timeStopBars: 60,
      conditions: all({ left: close, op: "crosses_below", right: { ref: "ema20" } }),
    },
    sizing: { kind: "fraction_of_cash", fraction: 0.25 },
    stayOut: STAY_OUT,
    prediction: PREDICTION,
  },
  guidelines:
    "Do: trade only when the market weather says up trend and the trend strength is above 20. Do: take the break of the last 10 candles' high, not the first green candle.\nDon't: buy when strength is already above 70 (stretched). Don't: trade it in a sideways market or a squeeze. Don't: move the stop away once in.",
  worksWhen: ["A clean up trend with steady buyers and rising trend strength.", "Pauses of a few candles that then break upward."],
  failsWhen: ["The market is sideways: breaks reverse and the stop is hit repeatedly.", "Right after a big spike, when the price is stretched and a pullback is likelier than a break."],
  allowedWeather: { trend: ["up"], squeeze: "no", note: "Up trend only, never in a squeeze. In a down trend it stays in cash (spot is long-only)." },
  startingValues: [
    { path: "indicators.adx14.period", label: "Trend-strength length", status: "to_be_tested" },
    { path: "entry.conditions.conditions.0.right.value", label: "Trend strength must be above", status: "to_be_tested" },
    { path: "entry.conditions.conditions.2.right.value", label: "Not stretched: strength meter below", status: "to_be_tested" },
    { path: "indicators.high10.period", label: "Break of the high of the last N candles", status: "to_be_tested" },
    { path: "exit.stop.multiple", label: "Stop distance in average candle sizes", status: "to_be_tested" },
    { path: "exit.trailing.distancePct", label: "Trailing stop distance %", status: "to_be_tested" },
  ],
  simplifications: ["'Not extended' is measured with the strength meter (RSI), not with the distance from the average.", "A flag pattern is approximated by a break of the last 10 candles' high."],
};

const PULLBACK: TradingTemplateInput = {
  key: "pullback",
  templateVersion: 1,
  wave: "first",
  style: "Pullback",
  spec: {
    specVersion: 2,
    meta: meta(
      "Pullback",
      "trend",
      "In an established up trend, a short dip back to the average tends to be bought again. The idea is a better entry price inside a trend that is already there, with a close stop under the dip.",
      [
        "Buying a dip that is really the start of a down trend.",
        "Entering while the price is still falling instead of waiting for it to turn back up.",
        "Setting the stop so close that normal noise hits it.",
        "Trading it when the long average is not clearly below the shorter one.",
      ],
    ),
    universe: { assets: [...ASSETS], decisionTimeframe: "4h" },
    indicators: {
      ema20: { kind: "ema", period: 20 },
      ema50: { kind: "ema", period: 50 },
      ema100: { kind: "ema", period: 100 },
      rsi14: { kind: "rsi", period: 14 },
    },
    regimeGate: { trend: "up", volatility: "any", squeeze: "no" },
    entry: {
      conditions: all(
        { left: { ref: "ema50" }, op: ">", right: { ref: "ema100" } },
        { left: close, op: "crosses_above", right: { ref: "ema20" } },
        { left: { ref: "rsi14" }, op: "<", right: { value: 60 } },
      ),
    },
    exit: {
      stop: { kind: "below_swing", lookback: 10, bufferPct: 0.5 },
      target: { kind: "r_multiple", multiple: 2 },
      timeStopBars: 30,
      conditions: all({ left: close, op: "crosses_below", right: { ref: "ema50" } }),
    },
    sizing: { kind: "fraction_of_cash", fraction: 0.25 },
    stayOut: STAY_OUT,
    prediction: PREDICTION,
  },
  guidelines:
    "Do: wait for the price to dip to its 20-candle average and turn back up through it. Do: put the stop just under the recent low.\nDon't: buy while it is still falling. Don't: trade it when the 50-candle average is not above the 100-candle average. Don't: trade it in a sideways market.",
  worksWhen: ["A trend with orderly dips that stop at the short average.", "Falling activity on the dip and rising activity on the turn."],
  failsWhen: ["The dip is the first leg of a reversal: the price slices through the averages.", "Choppy markets where the price crosses the average back and forth."],
  allowedWeather: { trend: ["up"], squeeze: "no", note: "Up trend only, never in a squeeze." },
  startingValues: [
    { path: "indicators.ema20.period", label: "Short average length (the dip target)", status: "to_be_tested" },
    { path: "indicators.ema50.period", label: "Middle average length", status: "to_be_tested" },
    { path: "indicators.ema100.period", label: "Long average length", status: "to_be_tested" },
    { path: "entry.conditions.conditions.2.right.value", label: "Strength meter must be below", status: "to_be_tested" },
    { path: "exit.stop.lookback", label: "Stop under the low of the last N candles", status: "to_be_tested" },
    { path: "exit.target.multiple", label: "Target in stop distances", status: "to_be_tested" },
  ],
  simplifications: [
    "The 50/100 averages are on 4-hour candles (the engine caps its look-back at 500 candles, so the plan's 200-day-style long average does not fit).",
    "The 'under half of the last swing retraced' and 'falling volume' tests are not in this version (they need rules the engine does not have yet).",
    "'Enter on a close above the prior high' is approximated by a close back up through the 20-candle average.",
  ],
};

const BREAKOUT: TradingTemplateInput = {
  key: "breakout",
  templateVersion: 1,
  wave: "first",
  style: "Breakout",
  spec: {
    specVersion: 2,
    meta: meta(
      "Breakout (Donchian + squeeze + volume)",
      "breakout",
      "After a quiet, narrow stretch, a close above the highest price of the last 20 candles on clearly higher activity often starts a bigger move. Quiet markets store energy; activity shows it is real.",
      [
        "Taking a break on thin activity, which is usually a false break.",
        "Chasing a break that has already gone far.",
        "Putting the stop far under the level instead of just under it.",
        "Trading every break instead of only the ones that follow a quiet stretch.",
      ],
    ),
    universe: { assets: [...ASSETS], decisionTimeframe: "4h" },
    indicators: {
      high20: { kind: "donchian", period: 20, band: "upper" },
      rvol20: { kind: "rvol", period: 20 },
      width20: { kind: "bb_width", period: 20, stdDev: 2 },
    },
    regimeGate: { trend: "up", volatility: "any", squeeze: "any" },
    entry: {
      conditions: all(
        { left: close, op: "crosses_above", right: { ref: "high20" } },
        { left: { ref: "rvol20" }, op: ">", right: { value: 1.5 } },
        { left: { ref: "width20" }, op: "<", right: { value: 0.12 } },
      ),
    },
    exit: {
      stop: { kind: "atr", period: 14, multiple: 1.5 },
      target: { kind: "r_multiple", multiple: 3 },
      trailing: { activateAtPct: 4, distancePct: 4 },
      timeStopBars: 36,
    },
    sizing: { kind: "fraction_of_cash", fraction: 0.25 },
    stayOut: STAY_OUT,
    prediction: PREDICTION,
  },
  guidelines:
    "Do: take a close above the highest price of the last 20 candles, only on activity at least 1.5 times normal, and only after a narrow quiet stretch.\nDon't: take it on thin activity. Don't: chase a break that has already run. Don't: trade it in a down trend.",
  worksWhen: ["A narrow, quiet range that breaks with a burst of activity.", "An up trend resuming after a pause."],
  failsWhen: ["False breaks in a sideways market: the price pops above the level and falls back.", "Thin weekends and holidays, when activity is low and breaks do not hold."],
  allowedWeather: { trend: ["up"], squeeze: "any", note: "Up trend. The squeeze is part of the entry rule (narrow channel), so the gate leaves it open. Range breaks after a squeeze are a later variant." },
  startingValues: [
    { path: "indicators.high20.period", label: "Break of the high of the last N candles", status: "to_be_tested" },
    { path: "entry.conditions.conditions.1.right.value", label: "Activity must be above normal by", status: "to_be_tested" },
    { path: "entry.conditions.conditions.2.right.value", label: "Channel narrower than", status: "to_be_tested" },
    { path: "exit.stop.multiple", label: "Stop distance in average candle sizes", status: "to_be_tested" },
    { path: "exit.target.multiple", label: "Target in stop distances", status: "to_be_tested" },
  ],
  simplifications: [
    "'A level tested twice' is not in this version; the level is the 20-candle high.",
    "The quiet stretch is a fixed channel width, not a percentile of the coin's own history.",
    "Range breaks that follow a squeeze are not traded in this version.",
  ],
};

const SUPPORT_RESISTANCE_BOUNCE: TradingTemplateInput = {
  key: "support_resistance_bounce",
  templateVersion: 1,
  wave: "first",
  style: "Support/resistance bounce",
  spec: {
    specVersion: 2,
    meta: meta(
      "Support/resistance bounce",
      "mean_reversion",
      "In a sideways market a coin tends to turn back near the bottom of its range. Buy near the bottom after the price turns up, aim for the middle of the range, and keep the stop just under the floor.",
      [
        "Trading it when the market is trending: the floor breaks and the stop is hit.",
        "Buying the floor before it turns up (catching a falling knife).",
        "Using a floor that was tested many times: the more it is tested, the weaker it gets.",
        "Aiming for the far side of the range instead of the middle.",
      ],
    ),
    universe: { assets: [...ASSETS], decisionTimeframe: "4h" },
    indicators: {
      floor: { kind: "donchian", period: 40, band: "lower" },
      middle: { kind: "donchian", period: 40, band: "mid" },
      rsi14: { kind: "rsi", period: 14 },
    },
    regimeGate: { trend: "range", volatility: "any", squeeze: "no" },
    entry: {
      conditions: all(
        { left: close, op: "between", low: { ref: "floor" }, high: { ref: "middle" } },
        { left: { ref: "rsi14" }, op: "crosses_above", right: { value: 35 } },
      ),
    },
    exit: {
      stop: { kind: "below_swing", lookback: 20, bufferPct: 0.5 },
      target: { kind: "level", ref: "middle" },
      timeStopBars: 24,
    },
    sizing: { kind: "fraction_of_cash", fraction: 0.25 },
    stayOut: STAY_OUT,
    prediction: PREDICTION,
  },
  guidelines:
    "Do: trade only when the market weather says sideways. Do: buy after the price turns up off the bottom of its range, aim for the middle.\nDon't: trade it in a trend. Don't: buy a floor that has been tested again and again.",
  worksWhen: ["A well-defined sideways range with repeated turns at the same area.", "Low trend strength and calm activity."],
  failsWhen: ["The range breaks down: the floor gives way and a trend begins.", "News-driven moves that ignore the range."],
  allowedWeather: { trend: ["range"], squeeze: "no", note: "Sideways markets only, never in a squeeze." },
  startingValues: [
    { path: "indicators.floor.period", label: "Range length in candles", status: "to_be_tested" },
    { path: "entry.conditions.conditions.1.right.value", label: "Strength meter turns up through", status: "to_be_tested" },
    { path: "exit.stop.lookback", label: "Stop under the low of the last N candles", status: "to_be_tested" },
    { path: "exit.stop.bufferPct", label: "Stop buffer %", status: "to_be_tested" },
  ],
  simplifications: [
    "The floor is the lowest price of the last 40 candles; 'two or more reactions' and 'rejection wick' are not in this version.",
    "'Skip if tested more than 3 times recently' is not in this version.",
  ],
};

const MOMENTUM: TradingTemplateInput = {
  key: "momentum",
  templateVersion: 1,
  wave: "second",
  style: "Momentum",
  spec: {
    specVersion: 2,
    meta: meta(
      "Momentum",
      "trend",
      "A coin that has risen strongly on rising activity, and sits above its average, tends to keep going for a while. Strength attracts more buyers in the short run.",
      [
        "Judging momentum on the coins that happen to have done well (survivorship).",
        "Buying after the move is already very large.",
        "Holding on after the momentum fades because the last trade was a winner.",
      ],
    ),
    universe: { assets: [...ASSETS], decisionTimeframe: "4h" },
    indicators: {
      change30: { kind: "roc", period: 30 },
      rvol20: { kind: "rvol", period: 20 },
      ema20: { kind: "ema", period: 20 },
      vwap: { kind: "vwap", anchor: "utc_day", lookback: 20 },
    },
    regimeGate: { trend: "up", volatility: "any", squeeze: "no" },
    entry: {
      conditions: all(
        { left: { ref: "change30" }, op: ">", right: { value: 8 } },
        { left: { ref: "rvol20" }, op: ">", right: { value: 1.5 } },
        { left: close, op: ">", right: { ref: "ema20" } },
        { left: close, op: ">", right: { ref: "vwap" } },
      ),
    },
    exit: {
      stop: { kind: "atr", period: 14, multiple: 2 },
      timeStopBars: 30,
      conditions: all({ left: close, op: "crosses_below", right: { ref: "ema20" } }),
    },
    sizing: { kind: "fraction_of_cash", fraction: 0.25 },
    stayOut: STAY_OUT,
    prediction: PREDICTION,
  },
  guidelines:
    "Do: buy strength that comes with higher activity and sits above the average. Do: leave when the price falls back under the average.\nDon't: buy a move that is already huge. Don't: read the past results of the coins that did well as proof.",
  worksWhen: ["Broad, risk-on markets where strong coins keep getting bought.", "A new theme or flow pulling activity into one coin."],
  failsWhen: ["Sharp reversals after a vertical run.", "Sideways markets where each burst is sold into."],
  allowedWeather: { trend: ["up"], squeeze: "no", note: "Up trend only, never in a squeeze." },
  startingValues: [
    { path: "indicators.change30.period", label: "Price change measured over N candles", status: "to_be_tested" },
    { path: "entry.conditions.conditions.0.right.value", label: "Price change must be above (%)", status: "to_be_tested" },
    { path: "entry.conditions.conditions.1.right.value", label: "Activity must be above normal by", status: "to_be_tested" },
    { path: "exit.stop.multiple", label: "Stop distance in average candle sizes", status: "to_be_tested" },
  ],
  simplifications: ["'In the top 3 of our coins' needs a ranking across coins, which a single-coin rule cannot do; this version uses an absolute price change instead.", "Survivorship caution applies to any result."],
};

const VWAP_RECLAIM: TradingTemplateInput = {
  key: "vwap_reclaim",
  templateVersion: 1,
  wave: "second",
  style: "VWAP reclaim",
  spec: {
    specVersion: 2,
    meta: meta(
      "VWAP reclaim (anchored to the UTC day)",
      "mean_reversion",
      "The volume-weighted average price of the day is a fair-price line many traders watch. After the price dips under it and then closes back above, it often returns toward the day's high. Here the line restarts at 00:00 UTC every day.",
      [
        "Treating one exchange's volume as the whole market (it is only a proxy).",
        "Trading it against a falling market, where the line keeps getting lost.",
        "Using the line early in the UTC day, when it has almost no volume behind it.",
      ],
    ),
    universe: { assets: [...ASSETS], decisionTimeframe: "4h" },
    indicators: {
      vwap: { kind: "vwap", anchor: "utc_day", lookback: 20 },
      ema50: { kind: "ema", period: 50 },
    },
    regimeGate: { trend: "up", volatility: "any", squeeze: "no" },
    entry: {
      conditions: all(
        { left: close, op: "crosses_above", right: { ref: "vwap" } },
        { left: close, op: ">", right: { ref: "ema50" } },
      ),
    },
    exit: {
      stop: { kind: "pct", pct: 2 },
      target: { kind: "r_multiple", multiple: 1.5 },
      timeStopBars: 6,
      conditions: all({ left: close, op: "crosses_below", right: { ref: "vwap" } }),
    },
    sizing: { kind: "fraction_of_cash", fraction: 0.25 },
    stayOut: STAY_OUT,
    prediction: PREDICTION,
  },
  guidelines:
    "Do: buy after the price closes back above the day's average price while the bigger trend is up. Do: leave if it falls back under the line.\nDon't: use it in a down trend. Don't: treat one exchange's volume as the whole market.",
  worksWhen: ["Up trends with intraday dips that are bought at the day's average.", "Days with ordinary activity on the exchange we read."],
  failsWhen: ["Down or falling days: the price keeps losing the line.", "Very quiet days when the line is only a few candles of volume."],
  allowedWeather: { trend: ["up"], squeeze: "no", note: "Only as a pullback inside an up trend (the matrix allows mean reversion in an up trend as a pullback to the VWAP only)." },
  startingValues: [
    { path: "indicators.ema50.period", label: "Bigger-trend average length", status: "to_be_tested" },
    { path: "exit.stop.pct", label: "Stop distance %", status: "to_be_tested" },
    { path: "exit.target.multiple", label: "Target in stop distances", status: "to_be_tested" },
    { path: "exit.timeStopBars", label: "Leave after N candles", status: "to_be_tested" },
  ],
  simplifications: ["On 4-hour candles the daily VWAP has only six points; a 1-hour version is a later variant.", "Volume is one exchange's, so it is a proxy for the whole market."],
};

const HIGH_VOLUME_SPIKE: TradingTemplateInput = {
  key: "high_volume_spike",
  templateVersion: 1,
  wave: "experimental",
  style: "High-volume spike",
  spec: {
    specVersion: 2,
    meta: meta(
      "High-volume spike",
      "breakout",
      "A burst of activity that also breaks a level can start a larger move, but only if the money is new. Without funding and open interest we cannot tell new buyers from forced liquidations, so this stays experimental.",
      [
        "Buying a spike caused by liquidations: it looks the same on a price chart.",
        "Entering at the top of the spike instead of on the pullback.",
        "Reading a price-and-volume-only result as if funding and open interest had been tested.",
      ],
    ),
    universe: { assets: [...ASSETS], decisionTimeframe: "4h" },
    indicators: {
      high20: { kind: "donchian", period: 20, band: "upper" },
      rvol20: { kind: "rvol", period: 20 },
      rsi14: { kind: "rsi", period: 14 },
    },
    regimeGate: { trend: "up", volatility: "any", squeeze: "any" },
    entry: {
      conditions: all(
        { left: { ref: "rvol20" }, op: ">", right: { value: 3 } },
        { left: close, op: "crosses_above", right: { ref: "high20" } },
        { left: { ref: "rsi14" }, op: "<", right: { value: 75 } },
      ),
    },
    exit: {
      stop: { kind: "atr", period: 14, multiple: 2 },
      target: { kind: "r_multiple", multiple: 2 },
      timeStopBars: 18,
    },
    sizing: { kind: "fraction_of_cash", fraction: 0.15 },
    stayOut: { ...STAY_OUT, noEntryAfterJump: { jumpPct: 8, bars: 3 } },
    prediction: PREDICTION,
  },
  guidelines:
    "Do: treat any result as a price-and-volume-only test until funding and open interest are recorded. Do: keep the position small.\nDon't: read a good number here as a finding. Don't: buy a spike driven by liquidations.",
  worksWhen: ["New money enters on a level break (open interest rising with the price).", "Calm markets where a burst of activity is unusual."],
  failsWhen: ["Liquidation spikes, where the move reverses as soon as the forced selling or buying ends.", "Thin markets where one large order makes the spike."],
  allowedWeather: { trend: ["up"], squeeze: "any", note: "Up trend. Experimental until funding and open interest are recorded." },
  startingValues: [
    { path: "entry.conditions.conditions.0.right.value", label: "Activity must be above normal by", status: "to_be_tested" },
    { path: "indicators.high20.period", label: "Level: the high of the last N candles", status: "to_be_tested" },
    { path: "sizing.fraction", label: "Share of cash (kept small on purpose)", status: "to_be_tested" },
    { path: "stayOut.noEntryAfterJump.jumpPct", label: "Skip after a jump of (%)", status: "to_be_tested" },
  ],
  requiresData: ["funding", "open_interest"],
  simplifications: ["'Enter on the pullback' is not in this version; it enters on the break itself.", "The funding and open-interest part of the thesis is not in the rule yet."],
};

function openingRange(input: { key: string; name: string; style: string; timeframe: "1h" | "4h"; anchorHourUtc: number; sessionBars: number; timeStopBars: number; anchorNote: string }): TradingTemplateInput {
  return {
    key: input.key,
    templateVersion: 1,
    wave: "experimental",
    style: input.style,
    spec: {
      specVersion: 2,
      meta: meta(
        input.name,
        "breakout",
        `Crypto has no opening bell, so the "opening" is a chosen anchor: ${input.anchorNote}. A close above the high of that first stretch, with the bigger trend up, may set the tone for the rest of the day.`,
        [
          "Treating a made-up opening as if it were a real one: the edge may not exist.",
          "Trading it when the first stretch is unusually wide (the stop is then far away).",
          "Holding past the end of the UTC day, when the idea no longer applies.",
        ],
      ),
      universe: { assets: [...ASSETS], decisionTimeframe: input.timeframe },
      indicators: {
        range_high: { kind: "session_range", band: "high", anchorHourUtc: input.anchorHourUtc, sessionBars: input.sessionBars },
        range_low: { kind: "session_range", band: "low", anchorHourUtc: input.anchorHourUtc, sessionBars: input.sessionBars },
        ema50: { kind: "ema", period: 50 },
      },
      regimeGate: { trend: "up", volatility: "any", squeeze: "any" },
      entry: {
        conditions: all(
          { left: close, op: "crosses_above", right: { ref: "range_high" } },
          { left: close, op: ">", right: { ref: "ema50" } },
        ),
      },
      exit: {
        stop: { kind: "below_swing", lookback: 6, bufferPct: 0.25 },
        target: { kind: "r_multiple", multiple: 2 },
        timeStopBars: input.timeStopBars,
        conditions: all({ left: close, op: "crosses_below", right: { ref: "range_low" } }),
      },
      sizing: { kind: "fraction_of_cash", fraction: 0.2 },
      stayOut: STAY_OUT,
      prediction: PREDICTION,
    },
    guidelines: "Do: treat this as a cheap test of an idea that may not exist in crypto. Do: be flat by the end of the UTC day.\nDon't: expect a stock-market opening effect. Don't: carry the trade over the day boundary.",
    worksWhen: ["Days with a clear first stretch and a trend that carries on from it.", "Active days when a lot of traders watch the same hours."],
    failsWhen: ["Quiet days and weekends where the first stretch means nothing.", "Days when the first stretch is already the high of the day."],
    allowedWeather: { trend: ["up"], squeeze: "any", note: "Up trend. Experimental." },
    startingValues: [
      { path: "indicators.range_high.anchorHourUtc", label: "Hour (UTC) the 'opening' starts", status: "to_be_tested" },
      { path: "indicators.range_high.sessionBars", label: "Length of the opening, in candles", status: "to_be_tested" },
      { path: "exit.target.multiple", label: "Target in stop distances", status: "to_be_tested" },
      { path: "exit.timeStopBars", label: "Leave after N candles", status: "to_be_tested" },
    ],
    simplifications: input.anchorHourUtc === 0 ? [] : ["The US stock open moves by an hour with daylight saving time; this version uses a fixed UTC hour."],
  };
}

const OPENING_RANGE: TradingTemplateInput = openingRange({
  key: "opening_range",
  name: "Opening range (anchored to 00:00 UTC)",
  style: "Opening range",
  timeframe: "4h",
  anchorHourUtc: 0,
  sessionBars: 1,
  timeStopBars: 5,
  anchorNote: "the first 4-hour candle of the UTC day",
});

const OPENING_RANGE_US: TradingTemplateInput = openingRange({
  key: "opening_range_us_open",
  name: "Opening range (anchored to the US stock open)",
  style: "Opening range",
  timeframe: "1h",
  anchorHourUtc: 14,
  sessionBars: 1,
  timeStopBars: 8,
  anchorNote: "the first hour after the US stock market opens (14:00 UTC, an approximation that ignores daylight saving)",
});

const REVERSAL: TradingTemplateInput = {
  key: "reversal",
  templateVersion: 1,
  wave: "experimental",
  style: "Reversal",
  spec: {
    specVersion: 2,
    meta: meta(
      "Reversal (long-only)",
      "reversal",
      "After a sharp fall that ends in a burst of selling activity, the price sometimes turns. Spot cannot short, so only the turn up is traded. This is the riskiest style and goes last.",
      [
        "Buying the first bounce in a down trend: most are sold again.",
        "Using no stop because 'it has fallen enough'.",
        "Averaging down into a falling price.",
      ],
    ),
    universe: { assets: [...ASSETS], decisionTimeframe: "4h" },
    indicators: {
      rsi14: { kind: "rsi", period: 14 },
      rvol20: { kind: "rvol", period: 20 },
    },
    regimeGate: { trend: "down", volatility: "any", squeeze: "no" },
    entry: {
      conditions: all(
        { left: { ref: "rsi14" }, op: "crosses_above", right: { value: 30 } },
        { left: { ref: "rvol20" }, op: ">", right: { value: 2 } },
      ),
    },
    exit: {
      stop: { kind: "below_swing", lookback: 12, bufferPct: 0.5 },
      target: { kind: "r_multiple", multiple: 2 },
      timeStopBars: 18,
    },
    sizing: { kind: "fraction_of_cash", fraction: 0.1 },
    stayOut: STAY_OUT,
    prediction: PREDICTION,
  },
  guidelines: "Do: keep it small and always use the stop. Do: treat it as experimental.\nDon't: buy a falling price before it turns. Don't: add to a losing position.",
  worksWhen: ["A capitulation: heavy selling activity, then the strength meter turns up from very low.", "Sharp, news-free selloffs inside a bigger range."],
  failsWhen: ["A real down trend, where each bounce is sold again.", "Thin markets where the selling activity does not mean the sellers are done."],
  allowedWeather: { trend: ["down"], squeeze: "no", note: "Down trend only, experimental (matrix)." },
  startingValues: [
    { path: "entry.conditions.conditions.0.right.value", label: "Strength meter turns up through", status: "to_be_tested" },
    { path: "entry.conditions.conditions.1.right.value", label: "Selling activity above normal by", status: "to_be_tested" },
    { path: "sizing.fraction", label: "Share of cash (kept small on purpose)", status: "to_be_tested" },
    { path: "exit.stop.lookback", label: "Stop under the low of the last N candles", status: "to_be_tested" },
  ],
  simplifications: ["'More than 2.5 average candle sizes under the average' and 'a higher low' are approximated by the strength meter and the stop; the exact rules need arithmetic on indicators the engine does not have."],
};

function control(input: { key: string; name: string; kind: (typeof TRADING_CONTROL_KINDS)[number]; thesis: string; entry: unknown; exit: Record<string, unknown>; fraction: number; guidelines: string; simplifications?: string[] }): TradingTemplateInput {
  return {
    key: input.key,
    templateVersion: 1,
    wave: "control",
    style: "Control",
    controlKind: input.kind,
    spec: {
      specVersion: 2,
      meta: meta(input.name, "control", input.thesis, ["Reading a control as a strategy to copy.", "Comparing a strategy with a control that was measured on different dates."]),
      universe: { assets: [...ASSETS], decisionTimeframe: "4h" },
      indicators: {},
      regimeGate: { trend: "any", volatility: "any", squeeze: "any" },
      entry: { conditions: input.entry as never },
      exit: input.exit as never,
      sizing: { kind: "fraction_of_cash", fraction: input.fraction },
      stayOut: {},
      prediction: { ...PREDICTION, rUnit: "atr_at_entry" },
    },
    guidelines: input.guidelines,
    worksWhen: ["Always: a control is a yardstick for scoring, not a bet."],
    failsWhen: ["Never fails; it is only worth something next to the real strategies on the same dates."],
    allowedWeather: { trend: ["up", "range", "down"], squeeze: "any", note: "Always on, for scoring only." },
    startingValues: [{ path: "sizing.fraction", label: "Share of cash", status: "to_be_tested" }],
    simplifications: input.simplifications ?? [],
  };
}

const ALWAYS_TRUE = all({ left: close, op: ">", right: { value: 0 } });
const NEVER_TRUE = all({ left: close, op: "<", right: { value: 0 } });

const BUY_AND_HOLD: TradingTemplateInput = control({
  key: "buy_and_hold",
  name: "Buy and hold",
  kind: "buy_and_hold",
  thesis: "Buy once and keep it. Every other strategy has to beat this after fees, or it was not worth the trading.",
  entry: ALWAYS_TRUE,
  exit: { timeStopBars: 1000 },
  fraction: 1,
  guidelines: "A control. Do: compare real strategies with it over the same dates. Don't: run it as a strategy.",
  simplifications: ["Held for at most 1,000 candles at a time, then bought again, so a very long test pays a few extra fees."],
});

const STAY_IN_CASH: TradingTemplateInput = control({
  key: "stay_in_cash",
  name: "Stay in cash",
  kind: "stay_in_cash",
  thesis: "Do nothing. If a strategy cannot beat sitting in cash after fees, 'no edge found' is the correct answer.",
  entry: NEVER_TRUE,
  exit: { timeStopBars: 1 },
  fraction: 0.25,
  guidelines: "A control. Do: treat 'stay in cash' as a valid decision. Don't: run it as a strategy.",
});

const RANDOM_ENTRY: TradingTemplateInput = control({
  key: "random_entry",
  name: "Random entry",
  kind: "random_entry",
  thesis: "Enter at no particular moment and hold a fixed time. A strategy that cannot beat entering at random has no timing skill.",
  entry: ALWAYS_TRUE,
  exit: { timeStopBars: 6 },
  fraction: 0.25,
  guidelines: "A control. Do: compare strategies' per-trade results with it. Don't: run it as a strategy.",
  simplifications: ["The rule enters at every chance and holds 6 candles (the average over all start times). The seeded random replay with the same exposure is part of every past-data report and is the sharper check."],
});

const RAW_TEMPLATES: readonly TradingTemplateInput[] = [
  TREND_CONTINUATION,
  PULLBACK,
  BREAKOUT,
  SUPPORT_RESISTANCE_BOUNCE,
  MOMENTUM,
  VWAP_RECLAIM,
  HIGH_VOLUME_SPIKE,
  OPENING_RANGE,
  OPENING_RANGE_US,
  REVERSAL,
  BUY_AND_HOLD,
  STAY_IN_CASH,
  RANDOM_ENTRY,
];

let cachedTemplates: readonly TradingTemplate[] | null = null;

/** The catalog, parsed through the schema (so a template that stops validating fails loudly in its test, not silently in a UI). */
export function tradingTemplates(): readonly TradingTemplate[] {
  if (!cachedTemplates) cachedTemplates = RAW_TEMPLATES.map((raw) => tradingTemplateSchema.parse(raw));
  return cachedTemplates;
}

export function findTradingTemplate(key: string): TradingTemplate | null {
  return tradingTemplates().find((t) => t.key === key) ?? null;
}

export type TradingTemplateSpec = TradingStrategySpec;

// ─── Excluded styles ────────────────────────────────────────────────────────

export const TRADING_EXCLUDED_STYLES = [
  {
    key: "gap_and_go",
    name: "Gap-and-go",
    reason: "Crypto trades around the clock and has no opening gap, so there is nothing for this style to act on. It is left out on purpose, not forgotten.",
    decidedIn: "DUR-4890 decision 8",
  },
] as const;
export type TradingExcludedStyle = (typeof TRADING_EXCLUDED_STYLES)[number];

/** Strategies created from a template remember its key; holdout reads and trials count against the template too. */
export const createStrategyFromTemplateSchema = z
  .object({
    templateKey: templateKeySchema,
    name: z.string().trim().min(1).max(120).optional(),
    asset: z.enum(TRADING_ASSETS),
  })
  .strict();
export type CreateStrategyFromTemplateInput = z.infer<typeof createStrategyFromTemplateSchema>;
