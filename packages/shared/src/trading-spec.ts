import { z } from "zod";
import {
  DEFAULT_TRADING_RISK_CONFIG,
  TRADING_ASSETS,
  TRADING_TIMEFRAMES,
  tradingRiskConfigSchema,
  tradingTimeframeMs,
  type SmaCrossoverConfig,
  type TradingCandle,
  type TradingRiskConfig,
  type TradingTimeframe,
} from "./trading.js";
import {
  adxSeries,
  atrSeries,
  bbWidthSeries,
  donchianSeries,
  emaSeries,
  rocSeries,
  rsiSeries,
  rvolSeries,
  smaSeries,
  swingHighSeries,
  swingLowSeries,
  vwapSeries,
  type IndicatorSeries,
} from "./trading-indicators.js";

/**
 * DUR-5002: StrategySpec v2, the strategy "rule book".
 *
 * A spec is plain data (strict zod, versioned). `evaluateTradingSpec` is the
 * one pure, deterministic engine that reads it: no I/O, no clock, no random
 * numbers, and it never sees the free-text guidelines (those live next to the
 * spec in a TradingRuleBook and are stored with the version, nothing else).
 * Backtests, shadow runs and paper trading all call this same function.
 *
 * Design source: the plan document on DUR-4889, section 3. Licence rule: no
 * code here is copied from AGPL/GPL projects; the indicators are our own
 * (trading-indicators.ts).
 *
 * "Only tighten": neverDo (and so the risk config derived from it) is bounded
 * by TRADING_HARD_CEILING in the schema itself, and sizing fractions are
 * bounded to at most the whole cash; the entry gate (trading-risk-gate.ts)
 * still has the last word on every order.
 */

export const TRADING_SPEC_VERSION = 2;

// ─── Building blocks ────────────────────────────────────────────────────────

export const TRADING_PRICE_FIELDS = ["open", "high", "low", "close", "volume"] as const;
export type TradingPriceField = (typeof TRADING_PRICE_FIELDS)[number];

export const TRADING_STRATEGY_FAMILIES = ["trend", "breakout", "mean_reversion", "reversal", "control"] as const;
export type TradingStrategyFamily = (typeof TRADING_STRATEGY_FAMILIES)[number];

/** The most bars one evaluation window may need. Kraken's candle endpoint returns at most 720. */
export const TRADING_SPEC_MAX_WARMUP_BARS = 500;
export const TRADING_SPEC_MAX_INDICATORS = 16;

/** Names a spec gives its indicators. Lower-case so a name can never be confused with a price field or a keyword. */
const indicatorNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,23}$/, "Indicator names are lower-case letters, digits and underscores, starting with a letter (at most 24 characters).")
  .refine((name) => !(TRADING_PRICE_FIELDS as readonly string[]).includes(name), { message: "An indicator cannot be named like a price field." });

const period = z.number().int().min(2).max(300);

export const tradingIndicatorDefinitionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sma"), period }).strict(),
  z.object({ kind: z.literal("ema"), period }).strict(),
  z.object({ kind: z.literal("rsi"), period }).strict(),
  z.object({ kind: z.literal("atr"), period }).strict(),
  z.object({ kind: z.literal("adx"), period, output: z.enum(["adx", "plus_di", "minus_di"]).default("adx") }).strict(),
  z.object({ kind: z.literal("bb_width"), period, stdDev: z.number().min(0.5).max(5).default(2) }).strict(),
  z.object({ kind: z.literal("donchian"), period, band: z.enum(["upper", "lower", "mid"]) }).strict(),
  z.object({ kind: z.literal("vwap"), anchor: z.enum(["utc_day", "swing"]), lookback: period.default(20) }).strict(),
  z.object({ kind: z.literal("rvol"), period }).strict(),
  z.object({ kind: z.literal("roc"), period }).strict(),
  z.object({ kind: z.literal("swing_high"), lookback: period }).strict(),
  z.object({ kind: z.literal("swing_low"), lookback: period }).strict(),
]);
export type TradingIndicatorDefinition = z.infer<typeof tradingIndicatorDefinitionSchema>;

export const tradingOperandSchema = z.union([
  z.object({ ref: indicatorNameSchema }).strict(),
  z.object({ price: z.enum(TRADING_PRICE_FIELDS) }).strict(),
  z.object({ value: z.number().finite() }).strict(),
]);
export type TradingOperand = z.infer<typeof tradingOperandSchema>;

/** The left side of a condition is something measured: an indicator or a price field, never a bare number. */
const tradingMeasuredSchema = z.union([z.object({ ref: indicatorNameSchema }).strict(), z.object({ price: z.enum(TRADING_PRICE_FIELDS) }).strict()]);
export type TradingMeasured = z.infer<typeof tradingMeasuredSchema>;

export const tradingConditionSchema = z.union([
  z.object({ left: tradingMeasuredSchema, op: z.enum([">", "<", "crosses_above", "crosses_below"]), right: tradingOperandSchema }).strict(),
  z.object({ left: tradingMeasuredSchema, op: z.literal("between"), low: tradingOperandSchema, high: tradingOperandSchema }).strict(),
]);
export type TradingCondition = z.infer<typeof tradingConditionSchema>;

export const tradingConditionGroupSchema = z
  .object({
    match: z.enum(["all", "any"]),
    conditions: z.array(tradingConditionSchema).min(1).max(12),
  })
  .strict();
export type TradingConditionGroup = z.infer<typeof tradingConditionGroupSchema>;

export const tradingStopSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pct"), pct: z.number().gt(0).max(50) }).strict(),
  z.object({ kind: z.literal("atr"), period: z.number().int().min(2).max(100), multiple: z.number().gt(0).max(10) }).strict(),
  z.object({ kind: z.literal("below_swing"), lookback: z.number().int().min(2).max(200), bufferPct: z.number().min(0).max(10).default(0) }).strict(),
]);
export type TradingStop = z.infer<typeof tradingStopSchema>;

export const tradingTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("r_multiple"), multiple: z.number().gt(0).max(20) }).strict(),
  z.object({ kind: z.literal("pct"), pct: z.number().gt(0).max(500) }).strict(),
  /** Sell when the bar's high reaches the CURRENT value of this indicator (for example the upper Donchian band or a VWAP). */
  z.object({ kind: z.literal("level"), ref: indicatorNameSchema }).strict(),
]);
export type TradingTarget = z.infer<typeof tradingTargetSchema>;

export const tradingTrailingSchema = z
  .object({ activateAtPct: z.number().min(0).max(100), distancePct: z.number().gt(0).max(50) })
  .strict();

const blackoutWindowSchema = z
  .object({
    /** 0 = Sunday ... 6 = Saturday, UTC. Empty = every day. */
    days: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    startHourUtc: z.number().int().min(0).max(23),
    /** Exclusive. A window that ends before it starts wraps over midnight. */
    endHourUtc: z.number().int().min(0).max(24),
  })
  .strict();

/**
 * neverDo: the risk limits of this version. Every value is bounded by
 * TRADING_HARD_CEILING (a spec can only tighten it) and anything left out
 * falls back to DEFAULT_TRADING_RISK_CONFIG, which sits well inside the
 * ceiling. They are mapped straight into the entry gate (deriveTradingRiskConfig).
 */
export const tradingNeverDoSchema = tradingRiskConfigSchema.partial().strict();
export type TradingNeverDo = z.infer<typeof tradingNeverDoSchema>;

export const tradingSizingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fraction_of_cash"), fraction: z.number().gt(0).max(1) }).strict(),
  /** Risk this share of cash if the stop is hit: position = riskPerTradePct / stop distance %, never more than all cash. Needs a stop. */
  z.object({ kind: z.literal("risk_per_trade"), riskPerTradePct: z.number().gt(0).max(5) }).strict(),
]);
export type TradingSizing = z.infer<typeof tradingSizingSchema>;

export const tradingStayOutSchema = z
  .object({
    blackoutWindows: z.array(blackoutWindowSchema).max(8).default([]),
    cooldownAfterLosses: z.object({ losses: z.number().int().min(1).max(20), bars: z.number().int().min(1).max(1000) }).strict().optional(),
    minRelativeVolume: z.number().min(0).max(20).optional(),
    /** Checked by the tick against the live quote: bid/ask spread as % of the mid price. */
    maxSpreadPct: z.number().gt(0).max(10).optional(),
    noEntryAfterJump: z.object({ jumpPct: z.number().gt(0).max(100), bars: z.number().int().min(1).max(50) }).strict().optional(),
  })
  .strict();

export const tradingPredictionSchema = z
  .object({
    horizonBars: z.number().int().min(1).max(200),
    kind: z.enum(["direction", "target_before_stop"]),
    /** A move smaller than this % either way counts as "flat" when scoring a direction call. */
    flatBandPct: z.number().min(0).max(5),
    rUnit: z.enum(["stop_distance", "atr_at_entry"]),
  })
  .strict();

export const tradingRegimeGateSchema = z
  .object({
    trend: z.enum(["up", "down", "range", "any"]).default("any"),
    volatility: z.enum(["low", "normal", "high", "any"]).default("any"),
    squeeze: z.enum(["yes", "no", "any"]).default("any"),
  })
  .strict();
export type TradingRegimeGate = z.infer<typeof tradingRegimeGateSchema>;

/**
 * The spec cross-checks (references exist, a stop exists where something needs
 * one, there is a way out of a position). Pure function of the parsed spec.
 */
function specProblems(spec: RawSpec): Array<{ path: Array<string | number>; message: string }> {
  const problems: Array<{ path: Array<string | number>; message: string }> = [];
  const names = new Set(Object.keys(spec.indicators));
  const checkRef = (name: string, path: Array<string | number>) => {
    if (!names.has(name)) problems.push({ path, message: `"${name}" is not one of the indicators defined in this spec.` });
  };
  const checkOperand = (operand: { ref?: string; price?: string; value?: number }, path: Array<string | number>) => {
    if (operand.ref !== undefined) checkRef(operand.ref, [...path, "ref"]);
  };
  const checkGroup = (group: TradingConditionGroup | undefined, path: Array<string | number>) => {
    group?.conditions.forEach((condition, index) => {
      const at = [...path, "conditions", index];
      checkOperand(condition.left, [...at, "left"]);
      if (condition.op === "between") {
        checkOperand(condition.low, [...at, "low"]);
        checkOperand(condition.high, [...at, "high"]);
      } else {
        checkOperand(condition.right, [...at, "right"]);
      }
    });
  };
  checkGroup(spec.entry.conditions, ["entry", "conditions"]);
  checkGroup(spec.exit.conditions, ["exit", "conditions"]);
  if (spec.exit.target?.kind === "level") checkRef(spec.exit.target.ref, ["exit", "target", "ref"]);

  if (!spec.universe.assets.every((asset, index, all) => all.indexOf(asset) === index)) {
    problems.push({ path: ["universe", "assets"], message: "List each coin once." });
  }
  const hasExit = spec.exit.stop || spec.exit.target || spec.exit.trailing || spec.exit.timeStopBars !== undefined || spec.exit.conditions;
  if (!hasExit) problems.push({ path: ["exit"], message: "A rule book needs at least one way out of a position (a stop, a target, a trailing stop, a time stop or exit conditions)." });
  if (spec.sizing.kind === "risk_per_trade" && !spec.exit.stop) {
    problems.push({ path: ["sizing"], message: "Sizing by risk per trade needs a stop to measure the risk against." });
  }
  if (spec.exit.target?.kind === "r_multiple" && !spec.exit.stop) {
    problems.push({ path: ["exit", "target"], message: "A target in R multiples needs a stop (1 R is the stop distance)." });
  }
  if (spec.prediction.rUnit === "stop_distance" && !spec.exit.stop) {
    problems.push({ path: ["prediction", "rUnit"], message: "Measuring in stop distances needs a stop." });
  }
  if (spec.prediction.kind === "target_before_stop" && !(spec.exit.stop && spec.exit.target)) {
    problems.push({ path: ["prediction", "kind"], message: "Predicting whether the target comes before the stop needs both a stop and a target." });
  }
  if (spec.universe.warmupBars !== undefined) {
    const need = tradingSpecRequiredBars(spec);
    if (spec.universe.warmupBars < need) {
      problems.push({ path: ["universe", "warmupBars"], message: `The slowest indicator needs at least ${need} bars before it can decide.` });
    }
  }
  if (tradingSpecWarmupBars(spec) > TRADING_SPEC_MAX_WARMUP_BARS) {
    problems.push({ path: ["indicators"], message: `The longest indicator needs more than ${TRADING_SPEC_MAX_WARMUP_BARS} bars of history.` });
  }
  return problems;
}

const specObjectSchema = z
  .object({
    specVersion: z.literal(TRADING_SPEC_VERSION),
    meta: z
      .object({
        name: z.string().trim().min(1).max(120),
        family: z.enum(TRADING_STRATEGY_FAMILIES),
        /** Why it should work, and when it should fail. */
        thesis: z.string().trim().min(1).max(2000),
        commonMistakes: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
      })
      .strict(),
    universe: z
      .object({
        assets: z.array(z.enum(TRADING_ASSETS)).min(1).max(TRADING_ASSETS.length),
        decisionTimeframe: z.enum(TRADING_TIMEFRAMES),
        warmupBars: z.number().int().min(2).max(TRADING_SPEC_MAX_WARMUP_BARS).optional(),
      })
      .strict(),
    indicators: z.record(indicatorNameSchema, tradingIndicatorDefinitionSchema).refine((value) => Object.keys(value).length <= TRADING_SPEC_MAX_INDICATORS, {
      message: `At most ${TRADING_SPEC_MAX_INDICATORS} indicators.`,
    }),
    regimeGate: tradingRegimeGateSchema.default({}),
    entry: z.object({ conditions: tradingConditionGroupSchema }).strict(),
    exit: z
      .object({
        stop: tradingStopSchema.optional(),
        target: tradingTargetSchema.optional(),
        trailing: tradingTrailingSchema.optional(),
        timeStopBars: z.number().int().min(1).max(1000).optional(),
        conditions: tradingConditionGroupSchema.optional(),
      })
      .strict(),
    sizing: tradingSizingSchema,
    stayOut: tradingStayOutSchema.default({}),
    neverDo: tradingNeverDoSchema.default({}),
    prediction: tradingPredictionSchema,
  })
  .strict();

type RawSpec = z.infer<typeof specObjectSchema>;

export const tradingStrategySpecSchema = specObjectSchema.superRefine((spec, ctx) => {
  for (const problem of specProblems(spec)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: problem.path, message: problem.message });
});
export type TradingStrategySpec = z.infer<typeof tradingStrategySpecSchema>;
export type TradingStrategySpecInput = z.input<typeof tradingStrategySpecSchema>;

export const TRADING_GUIDELINES_MAX = 8_000;

/**
 * A rule book is the spec plus the owner's free-text guidelines. The
 * guidelines are stored (and digested) with the version but are NEVER passed
 * to the engine: `evaluateTradingSpec` takes the spec alone.
 */
export const tradingRuleBookSchema = z
  .object({
    spec: tradingStrategySpecSchema,
    guidelines: z.string().max(TRADING_GUIDELINES_MAX).default(""),
  })
  .strict();
export type TradingRuleBook = z.infer<typeof tradingRuleBookSchema>;
export type TradingRuleBookInput = z.input<typeof tradingRuleBookSchema>;

// ─── Warm-up ────────────────────────────────────────────────────────────────

/** Regime look-backs (see computeRegime). */
const REGIME_ADX_PERIOD = 14;
const REGIME_ATR_PERIOD = 14;
const REGIME_VOL_WINDOW = 50;
const REGIME_BBW_PERIOD = 20;
const REGIME_SQUEEZE_WINDOW = 100;
const RVOL_PERIOD = 20;

function indicatorMinBars(def: TradingIndicatorDefinition): number {
  switch (def.kind) {
    case "sma":
    case "ema":
    case "bb_width":
      return def.period;
    case "rsi":
    case "roc":
    case "rvol":
    case "donchian":
      return def.period + 1;
    case "atr":
      return def.period;
    case "adx":
      return def.output === "adx" ? 2 * def.period : def.period + 1;
    case "vwap":
      return def.anchor === "swing" ? def.lookback : 1;
    case "swing_high":
    case "swing_low":
      return def.lookback;
    default: {
      const exhaustive: never = def;
      return exhaustive;
    }
  }
}

function indicatorPeriod(def: TradingIndicatorDefinition): number {
  return def.kind === "vwap" ? (def.anchor === "swing" ? def.lookback : 1) : "period" in def ? def.period : def.lookback;
}

function isRecursive(def: TradingIndicatorDefinition): boolean {
  return def.kind === "ema" || def.kind === "rsi" || def.kind === "atr" || def.kind === "adx";
}

/**
 * The fewest closed bars at which every indicator the spec uses has a value
 * AND has a previous value (a crossover compares two bars), plus whatever the
 * regime gate, stop and stay-out rules look back over.
 */
export function tradingSpecRequiredBars(spec: Pick<RawSpec, "indicators" | "regimeGate" | "exit" | "stayOut">): number {
  let need = 2;
  for (const def of Object.values(spec.indicators)) need = Math.max(need, indicatorMinBars(def) + 1);
  if (spec.regimeGate.trend !== "any") need = Math.max(need, 2 * REGIME_ADX_PERIOD + 1);
  if (spec.regimeGate.volatility !== "any") need = Math.max(need, REGIME_ATR_PERIOD + REGIME_VOL_WINDOW);
  if (spec.regimeGate.squeeze !== "any") need = Math.max(need, REGIME_BBW_PERIOD + REGIME_SQUEEZE_WINDOW);
  const stop = spec.exit.stop;
  if (stop?.kind === "atr") need = Math.max(need, stop.period + 1);
  if (stop?.kind === "below_swing") need = Math.max(need, stop.lookback);
  if (spec.stayOut.minRelativeVolume !== undefined) need = Math.max(need, RVOL_PERIOD + 1);
  if (spec.stayOut.noEntryAfterJump) need = Math.max(need, spec.stayOut.noEntryAfterJump.bars + 1);
  return need;
}

/**
 * The bars the engine waits for before it decides anything: the explicit
 * `universe.warmupBars`, else the required minimum, widened to 3x the longest
 * period when a recursive indicator (EMA, RSI, ATR, ADX) is used so its first
 * values have settled. Always at least the required minimum.
 */
export function tradingSpecWarmupBars(spec: Pick<RawSpec, "indicators" | "regimeGate" | "exit" | "stayOut" | "universe">): number {
  const need = tradingSpecRequiredBars(spec);
  if (spec.universe.warmupBars !== undefined) return Math.max(spec.universe.warmupBars, need);
  let settled = need;
  for (const def of Object.values(spec.indicators)) {
    if (isRecursive(def)) settled = Math.max(settled, 3 * indicatorPeriod(def) + 1);
  }
  return settled;
}

// ─── The engine ─────────────────────────────────────────────────────────────

export type TradingEngineBar = Pick<TradingCandle, "openTime" | "open" | "high" | "low" | "close" | "volume">;

export interface TradingPositionLevels {
  stopPrice: number | null;
  targetPrice: number | null;
}

export type TradingPositionState =
  | {
      kind: "flat";
      /** Losing round trips in a row, most recent first (for the cooldown). */
      consecutiveLosses?: number;
      /** Whole bars since the last exit, null if there never was one. */
      barsSinceExit?: number | null;
    }
  | {
      kind: "long";
      entryPrice: number;
      /** When the position was opened. */
      entryAt: Date;
      stopPrice: number | null;
      targetPrice: number | null;
      /** Highest price seen since entry (the engine takes the max with the latest bar's high). */
      highestPrice: number;
    };

export type TradingDirectionCall = "up" | "down" | "none";
export type TradingAction = "enter" | "exit" | "hold";

export interface TradingRegimeLabels {
  trend: "up" | "down" | "range" | "unclear" | null;
  volatility: "low" | "normal" | "high" | null;
  squeeze: boolean | null;
}

export interface TradingDecision {
  action: TradingAction;
  /** Machine-readable reasons, most important first. */
  reasonCodes: string[];
  /** A direction call, never a probability: a fixed rule says "up" on an entry and "down" on an exit. */
  directionCall: TradingDirectionCall;
  /** Latest value of every indicator the spec defines, plus the bar's close. */
  indicatorSnapshot: Record<string, number | null>;
  regime: TradingRegimeLabels;
  /** Entry only: how much of the available cash to invest (0..1), before the entry gate. */
  sizeFractionOfCash?: number;
  /** Entry only: protective levels measured from the entry bar's close. */
  levels?: TradingPositionLevels;
  /** Position only: the highest price to carry forward. */
  highestPrice?: number;
}

type SeriesMap = Map<string, IndicatorSeries>;

function valueAt(series: IndicatorSeries, index: number): number | null {
  return index >= 0 && index < series.length ? series[index]! : null;
}

function indicatorSeries(def: TradingIndicatorDefinition, bars: readonly TradingEngineBar[]): IndicatorSeries {
  const closes = bars.map((b) => b.close);
  switch (def.kind) {
    case "sma":
      return smaSeries(closes, def.period);
    case "ema":
      return emaSeries(closes, def.period);
    case "rsi":
      return rsiSeries(closes, def.period);
    case "atr":
      return atrSeries(bars, def.period);
    case "adx": {
      const all = adxSeries(bars, def.period);
      return def.output === "adx" ? all.adx : def.output === "plus_di" ? all.plusDi : all.minusDi;
    }
    case "bb_width":
      return bbWidthSeries(closes, def.period, def.stdDev);
    case "donchian":
      return donchianSeries(bars, def.period, def.band);
    case "vwap":
      return vwapSeries(bars, def.anchor, def.lookback);
    case "rvol":
      return rvolSeries(
        bars.map((b) => b.volume),
        def.period,
      );
    case "roc":
      return rocSeries(closes, def.period);
    case "swing_high":
      return swingHighSeries(bars, def.lookback);
    case "swing_low":
      return swingLowSeries(bars, def.lookback);
    default: {
      const exhaustive: never = def;
      return exhaustive;
    }
  }
}

function buildSeries(spec: TradingStrategySpec, bars: readonly TradingEngineBar[]): SeriesMap {
  const map: SeriesMap = new Map();
  for (const [name, def] of Object.entries(spec.indicators)) map.set(name, indicatorSeries(def, bars));
  return map;
}

function priceAt(bars: readonly TradingEngineBar[], field: TradingPriceField, index: number): number | null {
  const bar = bars[index];
  return bar ? bar[field] : null;
}

function measuredAt(bars: readonly TradingEngineBar[], series: SeriesMap, operand: TradingOperand, index: number): number | null {
  if ("ref" in operand) return valueAt(series.get(operand.ref) ?? [], index);
  if ("price" in operand) return priceAt(bars, operand.price, index);
  return operand.value;
}

/** A condition on bar `index`. A missing value (still warming up) makes it false, never an error. */
function conditionHolds(condition: TradingCondition, bars: readonly TradingEngineBar[], series: SeriesMap, index: number, stateForm: boolean): boolean {
  const left = measuredAt(bars, series, condition.left, index);
  if (left === null) return false;
  if (condition.op === "between") {
    const low = measuredAt(bars, series, condition.low, index);
    const high = measuredAt(bars, series, condition.high, index);
    return low !== null && high !== null && left >= Math.min(low, high) && left <= Math.max(low, high);
  }
  const right = measuredAt(bars, series, condition.right, index);
  if (right === null) return false;
  const op = condition.op;
  if (op === ">") return left > right;
  if (op === "<") return left < right;
  // Events compare this bar with the previous one. The state form (used when a
  // catch-up asks "does what the event announced still hold?") is the plain comparison.
  if (stateForm) return op === "crosses_above" ? left > right : left < right;
  const prevLeft = measuredAt(bars, series, condition.left, index - 1);
  const prevRight = measuredAt(bars, series, condition.right, index - 1);
  if (prevLeft === null || prevRight === null) return false;
  return op === "crosses_above" ? prevLeft <= prevRight && left > right : prevLeft >= prevRight && left < right;
}

function groupHolds(group: TradingConditionGroup, bars: readonly TradingEngineBar[], series: SeriesMap, index: number, stateForm: boolean): boolean {
  return group.match === "all"
    ? group.conditions.every((c) => conditionHolds(c, bars, series, index, stateForm))
    : group.conditions.some((c) => conditionHolds(c, bars, series, index, stateForm));
}

/**
 * Market-regime labels from the bars alone (no outside data):
 *  - trend: ADX(14) >= 25 with +DI above -DI is "up", below is "down"; ADX < 20 is "range";
 *    in between is "unclear" (matches only a gate set to "any").
 *  - volatility: ATR(14) against its own mean over the last 50 bars; < 0.8x "low", > 1.25x "high".
 *  - squeeze: Bollinger band width (20, 2) at or below the 20th percentile of its last 100 values.
 * A label is null while there are too few bars; a gate that asks for a
 * specific label then does not pass.
 */
export function computeTradingRegime(bars: readonly TradingEngineBar[]): TradingRegimeLabels {
  const last = bars.length - 1;
  let trend: TradingRegimeLabels["trend"] = null;
  let volatility: TradingRegimeLabels["volatility"] = null;
  let squeeze: TradingRegimeLabels["squeeze"] = null;

  if (bars.length >= 2 * REGIME_ADX_PERIOD + 1) {
    const all = adxSeries(bars, REGIME_ADX_PERIOD);
    const adx = all.adx[last];
    const plus = all.plusDi[last];
    const minus = all.minusDi[last];
    if (adx !== null && adx !== undefined && plus !== null && plus !== undefined && minus !== null && minus !== undefined) {
      trend = adx >= 25 ? (plus > minus ? "up" : minus > plus ? "down" : "unclear") : adx < 20 ? "range" : "unclear";
    }
  }
  if (bars.length >= REGIME_ATR_PERIOD + REGIME_VOL_WINDOW) {
    const atr = atrSeries(bars, REGIME_ATR_PERIOD);
    const window = atr.slice(last - REGIME_VOL_WINDOW + 1, last + 1);
    if (window.every((v) => v !== null)) {
      const mean = (window as number[]).reduce((sum, v) => sum + v, 0) / window.length;
      const current = atr[last]!;
      volatility = mean === 0 ? "normal" : current < 0.8 * mean ? "low" : current > 1.25 * mean ? "high" : "normal";
    }
  }
  if (bars.length >= REGIME_BBW_PERIOD + REGIME_SQUEEZE_WINDOW) {
    const width = bbWidthSeries(
      bars.map((b) => b.close),
      REGIME_BBW_PERIOD,
      2,
    );
    const window = width.slice(last - REGIME_SQUEEZE_WINDOW + 1, last + 1);
    if (window.every((v) => v !== null)) {
      const sorted = [...(window as number[])].sort((a, b) => a - b);
      const threshold = sorted[Math.floor(0.2 * (sorted.length - 1))]!;
      squeeze = width[last]! <= threshold;
    }
  }
  return { trend, volatility, squeeze };
}

function regimeAllows(gate: TradingRegimeGate, regime: TradingRegimeLabels): boolean {
  if (gate.trend !== "any" && regime.trend !== gate.trend) return false;
  if (gate.volatility !== "any" && regime.volatility !== gate.volatility) return false;
  if (gate.squeeze !== "any" && regime.squeeze !== (gate.squeeze === "yes")) return false;
  return true;
}

function inBlackout(spec: TradingStrategySpec, closeTime: Date): boolean {
  const hour = closeTime.getUTCHours();
  const day = closeTime.getUTCDay();
  return spec.stayOut.blackoutWindows.some((w) => {
    if (w.days.length > 0 && !w.days.includes(day)) return false;
    return w.startHourUtc <= w.endHourUtc ? hour >= w.startHourUtc && hour < w.endHourUtc : hour >= w.startHourUtc || hour < w.endHourUtc;
  });
}

/** Protective levels for an entry made on the close of bars[index]. Pure; the caller stores them with the position. */
export function computeTradingEntryLevels(
  spec: TradingStrategySpec,
  bars: readonly TradingEngineBar[],
  index: number,
  /** The price the levels are measured from. Defaults to the close of bars[index]; a position opened earlier passes its own entry price. */
  referencePrice?: number,
): TradingPositionLevels & { stopDistance: number | null } {
  const reference = referencePrice ?? bars[index]!.close;
  let stopPrice: number | null = null;
  const stop = spec.exit.stop;
  if (stop?.kind === "pct") stopPrice = reference * (1 - stop.pct / 100);
  else if (stop?.kind === "atr") {
    const atr = valueAt(atrSeries(bars.slice(0, index + 1), stop.period), index);
    if (atr !== null) stopPrice = reference - stop.multiple * atr;
  } else if (stop?.kind === "below_swing") {
    const low = valueAt(swingLowSeries(bars.slice(0, index + 1), stop.lookback), index);
    if (low !== null) stopPrice = low * (1 - stop.bufferPct / 100);
  }
  if (stopPrice !== null && !(stopPrice > 0 && stopPrice < reference)) stopPrice = null;
  const stopDistance = stopPrice === null ? null : reference - stopPrice;
  let targetPrice: number | null = null;
  const target = spec.exit.target;
  if (target?.kind === "pct") targetPrice = reference * (1 + target.pct / 100);
  else if (target?.kind === "r_multiple" && stopDistance !== null) targetPrice = reference + target.multiple * stopDistance;
  return { stopPrice, targetPrice, stopDistance };
}

function snapshot(spec: TradingStrategySpec, bars: readonly TradingEngineBar[], series: SeriesMap): Record<string, number | null> {
  const last = bars.length - 1;
  const out: Record<string, number | null> = {};
  for (const name of Object.keys(spec.indicators).sort()) out[name] = valueAt(series.get(name) ?? [], last);
  out.close = bars[last]?.close ?? null;
  return out;
}

const NO_REGIME: TradingRegimeLabels = { trend: null, volatility: null, squeeze: null };

function hold(reasonCodes: string[], snap: Record<string, number | null>, regime: TradingRegimeLabels, highestPrice?: number): TradingDecision {
  return { action: "hold", reasonCodes, directionCall: "none", indicatorSnapshot: snap, regime, ...(highestPrice !== undefined ? { highestPrice } : {}) };
}

/**
 * Decide what to do on the newest closed bar. `closedBars` are oldest-first
 * and contain ONLY closed bars (the caller drops the forming one). Pure and
 * deterministic: the same inputs always give the same decision. The decision
 * is a direction call plus reason codes; there is no invented probability.
 */
export function evaluateTradingSpec(spec: TradingStrategySpec, closedBars: readonly TradingEngineBar[], position: TradingPositionState): TradingDecision {
  const last = closedBars.length - 1;
  const timeframeMs = tradingTimeframeMs(spec.universe.decisionTimeframe);
  const series = buildSeries(spec, closedBars);
  const snap = snapshot(spec, closedBars, series);
  const warmup = tradingSpecWarmupBars(spec);
  if (closedBars.length < warmup) {
    return hold(["warming_up"], snap, NO_REGIME, position.kind === "long" ? position.highestPrice : undefined);
  }
  const bar = closedBars[last]!;
  const closeTime = new Date(bar.openTime.getTime() + timeframeMs);

  if (position.kind === "long") {
    const highest = Math.max(position.highestPrice, bar.high);
    const reasons: string[] = [];
    if (position.stopPrice !== null && bar.low <= position.stopPrice) reasons.push("stop_hit");
    const trailing = spec.exit.trailing;
    if (trailing && highest >= position.entryPrice * (1 + trailing.activateAtPct / 100) && bar.low <= highest * (1 - trailing.distancePct / 100)) {
      reasons.push("trailing_stop_hit");
    }
    const target = spec.exit.target;
    if (target) {
      const level = target.kind === "level" ? valueAt(series.get(target.ref) ?? [], last) : position.targetPrice;
      if (level !== null && bar.high >= level) reasons.push("target_hit");
    }
    if (spec.exit.timeStopBars !== undefined) {
      const held = Math.floor((closeTime.getTime() - position.entryAt.getTime()) / timeframeMs);
      if (held >= spec.exit.timeStopBars) reasons.push("time_stop");
    }
    if (spec.exit.conditions && groupHolds(spec.exit.conditions, closedBars, series, last, false)) reasons.push("exit_rule");
    if (reasons.length > 0) {
      return { action: "exit", reasonCodes: reasons, directionCall: "down", indicatorSnapshot: snap, regime: computeTradingRegime(closedBars), highestPrice: highest };
    }
    return hold(["holding"], snap, NO_REGIME, highest);
  }

  if (!groupHolds(spec.entry.conditions, closedBars, series, last, false)) {
    return hold(["entry_conditions_not_met"], snap, NO_REGIME);
  }
  // The entry fired; now every stay-out rule and the regime gate get a veto.
  const regime = computeTradingRegime(closedBars);
  const vetoes: string[] = [];
  if (inBlackout(spec, closeTime)) vetoes.push("blackout_window");
  const cooldown = spec.stayOut.cooldownAfterLosses;
  if (cooldown && (position.consecutiveLosses ?? 0) >= cooldown.losses && position.barsSinceExit !== null && position.barsSinceExit !== undefined && position.barsSinceExit < cooldown.bars) {
    vetoes.push("cooldown_after_losses");
  }
  if (spec.stayOut.minRelativeVolume !== undefined) {
    const rvol = valueAt(rvolSeries(closedBars.map((b) => b.volume), RVOL_PERIOD), last);
    if (rvol === null || rvol < spec.stayOut.minRelativeVolume) vetoes.push("low_relative_volume");
  }
  const jump = spec.stayOut.noEntryAfterJump;
  if (jump) {
    for (let i = Math.max(1, last - jump.bars + 1); i <= last; i++) {
      const prev = closedBars[i - 1]!.close;
      if (prev > 0 && (Math.abs(closedBars[i]!.close / prev - 1) * 100) >= jump.jumpPct) {
        vetoes.push("recent_big_jump");
        break;
      }
    }
  }
  if (!regimeAllows(spec.regimeGate, regime)) vetoes.push("regime_gate_closed");
  if (vetoes.length > 0) return hold(["entry_vetoed", ...vetoes], snap, regime);

  const levels = computeTradingEntryLevels(spec, closedBars, last);
  let sizeFractionOfCash: number;
  if (spec.sizing.kind === "fraction_of_cash") {
    sizeFractionOfCash = spec.sizing.fraction;
  } else {
    if (levels.stopDistance === null || levels.stopDistance <= 0) return hold(["entry_vetoed", "stop_not_computable"], snap, regime);
    const stopPct = (levels.stopDistance / bar.close) * 100;
    sizeFractionOfCash = Math.min(1, spec.sizing.riskPerTradePct / stopPct);
  }
  return {
    action: "enter",
    reasonCodes: ["entry_conditions_met"],
    directionCall: "up",
    indicatorSnapshot: snap,
    regime,
    sizeFractionOfCash,
    levels: { stopPrice: levels.stopPrice, targetPrice: levels.targetPrice },
    highestPrice: bar.high,
  };
}

/**
 * Catch-up over the bars a strategy has not looked at yet (a tick after a
 * gap). Every new bar is evaluated in order, each with its own history, with
 * a virtual position that follows the decisions. An old bar's decision acts
 * only if the state it announced still holds on the latest bar (an entry
 * crossover only if the entry is still true; a rule exit only if the exit
 * condition is still true); a stop, target, trailing or time exit always
 * acts, because the position was still open. Of the decisions that hold, only
 * the newest acts; the rest are reported so the caller can log them.
 */
export interface TradingCatchUpDecision {
  index: number;
  decision: TradingDecision;
  stillHolds: boolean;
}

export interface TradingCatchUpResult {
  decisions: TradingCatchUpDecision[];
  acting: TradingCatchUpDecision | null;
}

export function evaluateTradingCatchUp(
  spec: TradingStrategySpec,
  closedBars: readonly TradingEngineBar[],
  firstNewIndex: number,
  initial: TradingPositionState,
): TradingCatchUpResult {
  const latest = closedBars.length - 1;
  const timeframeMs = tradingTimeframeMs(spec.universe.decisionTimeframe);
  let state: TradingPositionState = initial;
  const decisions: TradingCatchUpDecision[] = [];
  for (let i = firstNewIndex; i <= latest; i++) {
    const window = closedBars.slice(0, i + 1);
    const decision = evaluateTradingSpec(spec, window, state);
    if (decision.action === "hold") {
      if (state.kind === "long" && decision.highestPrice !== undefined) state = { ...state, highestPrice: decision.highestPrice };
      else if (state.kind === "flat" && state.barsSinceExit !== null && state.barsSinceExit !== undefined) state = { ...state, barsSinceExit: state.barsSinceExit + 1 };
      continue;
    }
    let stillHolds = i === latest;
    if (!stillHolds) {
      if (decision.action === "enter") {
        const series = buildSeries(spec, closedBars);
        stillHolds = groupHolds(spec.entry.conditions, closedBars, series, latest, true);
      } else if (decision.reasonCodes.some((r) => r !== "exit_rule")) {
        stillHolds = true;
      } else {
        const series = buildSeries(spec, closedBars);
        stillHolds = spec.exit.conditions ? groupHolds(spec.exit.conditions, closedBars, series, latest, true) : false;
      }
    }
    decisions.push({ index: i, decision, stillHolds });
    if (decision.action === "enter") {
      const bar = closedBars[i]!;
      state = {
        kind: "long",
        entryPrice: bar.close,
        entryAt: new Date(bar.openTime.getTime() + timeframeMs),
        stopPrice: decision.levels?.stopPrice ?? null,
        targetPrice: decision.levels?.targetPrice ?? null,
        highestPrice: decision.highestPrice ?? bar.high,
      };
    } else {
      state = { kind: "flat", consecutiveLosses: initial.kind === "flat" ? initial.consecutiveLosses : 0, barsSinceExit: 0 };
    }
  }
  const held = decisions.filter((d) => d.stillHolds);
  const newestHeld = held[held.length - 1] ?? null;
  let acting: TradingCatchUpDecision | null = null;
  if (initial.kind === "flat") {
    // Flat: only an entry that is the newest standing decision acts; a later exit means the virtual position is closed again.
    acting = newestHeld?.decision.action === "enter" ? newestHeld : null;
  } else {
    // Long: the position must leave if any exit stands (a stop always does), even if the virtual run re-entered afterwards.
    const exits = held.filter((d) => d.decision.action === "exit");
    acting = exits[exits.length - 1] ?? null;
  }
  return { decisions, acting };
}

// ─── Risk: only ever tighten ─────────────────────────────────────────────────

/** The risk config this spec stands for: the defaults overlaid with its neverDo limits, re-validated against the hard ceiling. */
export function deriveTradingRiskConfig(spec: Pick<TradingStrategySpec, "neverDo">): TradingRiskConfig {
  return tradingRiskConfigSchema.parse({ ...DEFAULT_TRADING_RISK_CONFIG, ...spec.neverDo });
}

/**
 * Which limits would `next` loosen compared with `previous`? A bigger cap, a
 * card threshold raised (or removed), or a lower fee assumption. Used on
 * every change an AGENT proposes: limits are never loosened by an agent.
 */
export function tradingRiskLoosenings(previous: TradingRiskConfig, next: TradingRiskConfig): string[] {
  const loosened: string[] = [];
  const caps = ["maxPositionNok", "maxTotalExposureNok", "maxOrdersPerDay", "dailyLossLimitNok", "maxDrawdownPct", "priceBandPct"] as const;
  for (const key of caps) if (next[key] > previous[key]) loosened.push(key);
  // null means "a card for every order": the tightest setting, so only moving away from it (or raising the threshold) loosens.
  if (next.approvalAboveNok !== null && (previous.approvalAboveNok === null || next.approvalAboveNok > previous.approvalAboveNok)) loosened.push("approvalAboveNok");
  if (next.feeRatePct < previous.feeRatePct) loosened.push("feeRatePct");
  return loosened;
}

/** True if the spec's own limits are all within the hard ceiling (always true for a parsed spec; kept as an explicit check for stored rows). */
export function tradingSpecWithinCeiling(spec: Pick<TradingStrategySpec, "neverDo">): boolean {
  return tradingRiskConfigSchema.safeParse({ ...DEFAULT_TRADING_RISK_CONFIG, ...spec.neverDo }).success;
}

// ─── Canonical form (for the digest) ─────────────────────────────────────────

/** JSON with every object's keys sorted, so the same spec always produces the same text. The server hashes this. */
export function canonicalTradingJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalTradingJson(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalTradingJson(v)}`).join(",")}}`;
}

/** The exact text a version's digest is taken over: the spec AND the guidelines. */
export function tradingRuleBookDigestInput(book: Pick<TradingRuleBook, "spec" | "guidelines">): string {
  return canonicalTradingJson({ spec: book.spec, guidelines: book.guidelines });
}

// ─── Legacy sma_crossover@1 conversion ───────────────────────────────────────

const LEGACY_THESIS =
  "Converted from the original moving-average crossover rule: buy when the fast average crosses above the slow one, sell the whole position when it crosses back below. It works in steady trends and fails in sideways markets, where the averages keep crossing.";

/**
 * The spec an `sma_crossover@1` strategy stands for. The engine's decisions on
 * closed bars are the same as the old evaluator's (golden test in
 * trading-spec.test.ts). One deliberate difference: the old tick bought again
 * on a second cross-up while already holding; a spec holds an open position
 * until it exits.
 */
export function legacySmaCrossoverSpec(input: { name: string; asset: (typeof TRADING_ASSETS)[number]; timeframe: TradingTimeframe; rule: SmaCrossoverConfig; risk: TradingRiskConfig }): TradingStrategySpec {
  return tradingStrategySpecSchema.parse({
    specVersion: TRADING_SPEC_VERSION,
    meta: { name: input.name, family: "trend", thesis: LEGACY_THESIS, commonMistakes: [] },
    universe: { assets: [input.asset], decisionTimeframe: input.timeframe, warmupBars: input.rule.slowPeriod + 1 },
    indicators: { fast: { kind: "sma", period: input.rule.fastPeriod }, slow: { kind: "sma", period: input.rule.slowPeriod } },
    entry: { conditions: { match: "all", conditions: [{ left: { ref: "fast" }, op: "crosses_above", right: { ref: "slow" } }] } },
    exit: { conditions: { match: "all", conditions: [{ left: { ref: "fast" }, op: "crosses_below", right: { ref: "slow" } }] } },
    sizing: { kind: "fraction_of_cash", fraction: input.rule.orderSizeFraction },
    neverDo: input.risk,
    prediction: { horizonBars: 6, kind: "direction", flatBandPct: 0.25, rUnit: "atr_at_entry" },
  });
}

/** The sma_crossover@1 config a spec is exactly equivalent to, or null if it is anything else. */
export function legacySmaConfigFromSpec(spec: TradingStrategySpec): SmaCrossoverConfig | null {
  const fast = spec.indicators.fast;
  const slow = spec.indicators.slow;
  if (fast?.kind !== "sma" || slow?.kind !== "sma" || spec.sizing.kind !== "fraction_of_cash") return null;
  if (spec.universe.assets.length !== 1) return null;
  const rule: SmaCrossoverConfig = { type: "sma_crossover", version: 1, fastPeriod: fast.period, slowPeriod: slow.period, orderSizeFraction: spec.sizing.fraction };
  try {
    const rebuilt = legacySmaCrossoverSpec({ name: spec.meta.name, asset: spec.universe.assets[0]!, timeframe: spec.universe.decisionTimeframe, rule, risk: deriveTradingRiskConfig(spec) });
    return canonicalTradingJson(rebuilt) === canonicalTradingJson(spec) ? rule : null;
  } catch {
    return null;
  }
}

// ─── The approval card and the cache columns ──────────────────────────────────

/** The card-only approval kind that switches a strategy to a new version (services/approvals.ts, isApprovalCardOnlyKind). */
export const TRADING_STRATEGY_VERSION_APPROVAL_KIND = "trading_strategy_version";

/** What trading_strategies.rule_config holds when the active version is not a plain sma_crossover@1 rule. */
export interface TradingSpecRuleCache {
  type: "strategy_spec";
  specVersion: typeof TRADING_SPEC_VERSION;
  versionId: string;
  versionNumber: number;
  specDigest: string;
}

/**
 * The values of the two cache columns for a version: the old sma_crossover@1
 * config for a legacy rule (so old readers keep working), else a pointer to
 * the version; and the risk config derived from the spec. Written ONLY inside
 * the activation transaction; a test asserts the columns always equal this.
 */
export function tradingCacheForVersion(input: { spec: TradingStrategySpec; versionId: string; versionNumber: number; specDigest: string }): {
  ruleConfig: SmaCrossoverConfig | TradingSpecRuleCache;
  riskConfig: TradingRiskConfig;
} {
  return {
    ruleConfig:
      legacySmaConfigFromSpec(input.spec) ??
      ({ type: "strategy_spec", specVersion: TRADING_SPEC_VERSION, versionId: input.versionId, versionNumber: input.versionNumber, specDigest: input.specDigest } satisfies TradingSpecRuleCache),
    riskConfig: deriveTradingRiskConfig(input.spec),
  };
}

// ─── Plain-words read-back (what the approval card shows) ────────────────────

function describeOperand(operand: TradingOperand): string {
  if ("ref" in operand) return operand.ref;
  if ("price" in operand) return operand.price;
  return String(operand.value);
}

function describeCondition(condition: TradingCondition): string {
  const left = describeOperand(condition.left);
  if (condition.op === "between") return `${left} is between ${describeOperand(condition.low)} and ${describeOperand(condition.high)}`;
  const word = condition.op === ">" ? "is above" : condition.op === "<" ? "is below" : condition.op === "crosses_above" ? "crosses above" : "crosses below";
  return `${left} ${word} ${describeOperand(condition.right)}`;
}

function describeGroup(group: TradingConditionGroup): string {
  return group.conditions.map(describeCondition).join(group.match === "all" ? " AND " : " OR ");
}

function describeIndicator(name: string, def: TradingIndicatorDefinition): string {
  switch (def.kind) {
    case "sma":
    case "ema":
    case "rsi":
    case "atr":
    case "rvol":
    case "roc":
      return `${name} = ${def.kind.toUpperCase()}(${def.period})`;
    case "adx":
      return `${name} = ${def.output === "adx" ? "ADX" : def.output === "plus_di" ? "+DI" : "-DI"}(${def.period})`;
    case "bb_width":
      return `${name} = Bollinger band width (${def.period}, ${def.stdDev})`;
    case "donchian":
      return `${name} = ${def.band} Donchian band over the previous ${def.period} bars`;
    case "vwap":
      return `${name} = VWAP anchored to ${def.anchor === "utc_day" ? "the UTC day" : `the lowest low of the last ${def.lookback} bars`}`;
    case "swing_high":
      return `${name} = highest high of the last ${def.lookback} bars`;
    case "swing_low":
      return `${name} = lowest low of the last ${def.lookback} bars`;
    default: {
      const exhaustive: never = def;
      return exhaustive;
    }
  }
}

/**
 * The spec in plain words, one line per section. Deterministic: the approval
 * card text is generated from the STORED spec with this function, and the
 * server refuses to approve a card whose text differs from it.
 */
export function describeTradingSpec(spec: TradingStrategySpec): string[] {
  const lines: string[] = [];
  lines.push(`What it watches: ${spec.universe.assets.join(", ")} on ${spec.universe.decisionTimeframe} candles. ${Object.entries(spec.indicators).map(([n, d]) => describeIndicator(n, d)).join("; ") || "No indicators."}`);
  lines.push(`When it buys: ${describeGroup(spec.entry.conditions)}.`);
  const exits: string[] = [];
  const stop = spec.exit.stop;
  if (stop?.kind === "pct") exits.push(`stop ${stop.pct}% below the entry`);
  if (stop?.kind === "atr") exits.push(`stop ${stop.multiple} x ATR(${stop.period}) below the entry`);
  if (stop?.kind === "below_swing") exits.push(`stop below the lowest low of the last ${stop.lookback} bars (${stop.bufferPct}% buffer)`);
  const target = spec.exit.target;
  if (target?.kind === "r_multiple") exits.push(`target ${target.multiple} R`);
  if (target?.kind === "pct") exits.push(`target ${target.pct}% above the entry`);
  if (target?.kind === "level") exits.push(`target at ${target.ref}`);
  if (spec.exit.trailing) exits.push(`trailing stop ${spec.exit.trailing.distancePct}% below the high once up ${spec.exit.trailing.activateAtPct}%`);
  if (spec.exit.timeStopBars !== undefined) exits.push(`time stop after ${spec.exit.timeStopBars} bars`);
  if (spec.exit.conditions) exits.push(`exit when ${describeGroup(spec.exit.conditions)}`);
  lines.push(`When it sells: ${exits.join("; ")}.`);
  const stay: string[] = [];
  const gate = spec.regimeGate;
  if (gate.trend !== "any") stay.push(`only in a ${gate.trend} trend`);
  if (gate.volatility !== "any") stay.push(`only when volatility is ${gate.volatility}`);
  if (gate.squeeze !== "any") stay.push(gate.squeeze === "yes" ? "only in a squeeze" : "never in a squeeze");
  for (const w of spec.stayOut.blackoutWindows) stay.push(`no entries ${w.days.length ? `on days ${w.days.join(",")} ` : ""}${w.startHourUtc}:00-${w.endHourUtc}:00 UTC`);
  if (spec.stayOut.cooldownAfterLosses) stay.push(`pause ${spec.stayOut.cooldownAfterLosses.bars} bars after ${spec.stayOut.cooldownAfterLosses.losses} losses in a row`);
  if (spec.stayOut.minRelativeVolume !== undefined) stay.push(`needs relative volume of at least ${spec.stayOut.minRelativeVolume}`);
  if (spec.stayOut.maxSpreadPct !== undefined) stay.push(`skips when the spread is above ${spec.stayOut.maxSpreadPct}%`);
  if (spec.stayOut.noEntryAfterJump) stay.push(`no entry within ${spec.stayOut.noEntryAfterJump.bars} bars of a ${spec.stayOut.noEntryAfterJump.jumpPct}% jump`);
  lines.push(`When it stays out: ${stay.length ? stay.join("; ") : "no extra rules"}.`);
  const risk = deriveTradingRiskConfig(spec);
  lines.push(
    `Never do: more than ${risk.maxPositionNok} NOK in one position, ${risk.maxTotalExposureNok} NOK in total, ${risk.maxOrdersPerDay} orders a day; stop buying after a ${risk.dailyLossLimitNok} NOK daily loss or a ${risk.maxDrawdownPct}% drawdown; price band ${risk.priceBandPct}%; fee assumed ${risk.feeRatePct}% per side; ${risk.approvalAboveNok === null ? "every buy needs a card" : `buys of ${risk.approvalAboveNok} NOK or more need a card`}.`,
  );
  lines.push(
    spec.sizing.kind === "fraction_of_cash" ? `How much: ${Math.round(spec.sizing.fraction * 1000) / 10}% of available cash per buy.` : `How much: sized so a stop-out loses ${spec.sizing.riskPerTradePct}% of cash.`,
  );
  const p = spec.prediction;
  lines.push(`What it predicts: ${p.kind === "direction" ? "direction" : "target before stop"} over ${p.horizonBars} bars (flat band ${p.flatBandPct}%, measured in ${p.rUnit === "stop_distance" ? "stop distances" : "1 ATR at entry"}).`);
  return lines;
}
