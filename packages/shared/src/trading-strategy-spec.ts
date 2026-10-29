import { z } from "zod";
import {
  TRADING_ASSETS,
  TRADING_HARD_CEILING,
  TRADING_TIMEFRAMES,
  smaCrossoverConfigSchema,
  tradingRiskConfigSchema,
  type SmaCrossoverConfig,
  type TradingRiskConfig,
  type TradingTimeframe,
} from "./trading.js";

/**
 * DUR-5002: StrategySpec v2, the strategy rule book (plan section 3 of the
 * trading rebuild, DUR-4889).
 *
 * A strategy's rules are a strict, versioned document. The engine
 * (trading-engine.ts) reads the ENGINE part of it; the free-text
 * `guidelines` sit beside it, are stored with the version and are never
 * passed to evaluate(). Each stored version is immutable once approved, and
 * `rule_config` / `risk_config` on the strategy row are only a cache of the
 * active version (see server/src/services/trading-strategy-versions.ts).
 *
 * Tightening only: the schema bounds every risk number by
 * TRADING_HARD_CEILING and refuses a `neverDo` limit above the spec's own
 * risk limit, so a document can never ask for more than the entry gate would
 * allow. describeStrategyLoosening() compares two versions for the places an
 * agent proposal is not allowed to loosen.
 */

export const STRATEGY_SPEC_VERSION = 2 as const;

export const STRATEGY_FAMILIES = ["trend", "breakout", "mean_reversion", "reversal", "control"] as const;
export type StrategyFamily = (typeof STRATEGY_FAMILIES)[number];

/** The indicator allow-list. funding / open_interest / fear_greed join later, by publication time. */
export const STRATEGY_INDICATOR_KINDS = ["sma", "ema", "rsi", "atr", "adx", "bb_width", "donchian", "vwap", "rvol", "roc", "swing_high", "swing_low"] as const;
export type StrategyIndicatorKind = (typeof STRATEGY_INDICATOR_KINDS)[number];

const closedNumber = z.number().finite();
const indicatorNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,23}$/, "Indicator names are lower-case letters, digits and underscores, starting with a letter (24 characters at most).")
  .refine((name) => name !== "price", { message: '"price" is reserved for the closing price.' });

export const strategyIndicatorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sma"), period: z.number().int().min(2).max(400) }).strict(),
  z.object({ kind: z.literal("ema"), period: z.number().int().min(2).max(400) }).strict(),
  z.object({ kind: z.literal("rsi"), period: z.number().int().min(2).max(100) }).strict(),
  z.object({ kind: z.literal("atr"), period: z.number().int().min(2).max(100) }).strict(),
  z.object({ kind: z.literal("adx"), period: z.number().int().min(2).max(100) }).strict(),
  z.object({ kind: z.literal("bb_width"), period: z.number().int().min(5).max(200), stdDev: z.number().min(0.5).max(4) }).strict(),
  z.object({ kind: z.literal("donchian"), period: z.number().int().min(2).max(400), band: z.enum(["upper", "lower", "mid"]) }).strict(),
  z.object({ kind: z.literal("vwap"), anchor: z.enum(["utc_day", "swing"]) }).strict(),
  z.object({ kind: z.literal("rvol"), period: z.number().int().min(2).max(200) }).strict(),
  z.object({ kind: z.literal("roc"), period: z.number().int().min(1).max(400) }).strict(),
  z.object({ kind: z.literal("swing_high"), lookback: z.number().int().min(2).max(400) }).strict(),
  z.object({ kind: z.literal("swing_low"), lookback: z.number().int().min(2).max(400) }).strict(),
]);
export type StrategyIndicator = z.infer<typeof strategyIndicatorSchema>;

/** A condition operand: the literal "price" (the closing price), an indicator name, or a number. */
const operandSchema = z.union([closedNumber, z.string().min(1).max(24)]);
export type StrategyOperand = z.infer<typeof operandSchema>;

export const STRATEGY_CONDITION_OPS = [">", "<", "crosses_above", "crosses_below", "between"] as const;

export const strategyConditionSchema = z.union([
  z.object({ left: z.string().min(1).max(24), op: z.enum([">", "<", "crosses_above", "crosses_below"]), right: operandSchema }).strict(),
  z.object({ left: z.string().min(1).max(24), op: z.literal("between"), right: z.tuple([operandSchema, operandSchema]) }).strict(),
]);
export type StrategyCondition = z.infer<typeof strategyConditionSchema>;

const conditionGroupBase = z
  .object({
    all: z.array(strategyConditionSchema).max(8).optional(),
    any: z.array(strategyConditionSchema).max(8).optional(),
  })
  .strict();
export const strategyConditionGroupSchema = conditionGroupBase.refine((g) => (g.all?.length ?? 0) + (g.any?.length ?? 0) > 0, {
  message: "A condition group needs at least one condition in all or any.",
});
export type StrategyConditionGroup = z.infer<typeof strategyConditionGroupSchema>;

export const strategyStopSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pct"), pct: z.number().min(0.1).max(50) }).strict(),
  z.object({ kind: z.literal("atr"), indicator: indicatorNameSchema, multiple: z.number().min(0.5).max(10) }).strict(),
  z.object({ kind: z.literal("below_swing"), indicator: indicatorNameSchema, bufferPct: z.number().min(0).max(10).default(0) }).strict(),
]);
export type StrategyStop = z.infer<typeof strategyStopSchema>;

export const strategyTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("r_multiple"), r: z.number().min(0.5).max(20) }).strict(),
  z.object({ kind: z.literal("pct"), pct: z.number().min(0.1).max(500) }).strict(),
  z.object({ kind: z.literal("level"), price: z.number().positive() }).strict(),
]);
export type StrategyTarget = z.infer<typeof strategyTargetSchema>;

export const strategyTrailingSchema = z
  .object({ activateAtPct: z.number().min(0).max(100), distancePct: z.number().min(0.1).max(50) })
  .strict();

export const strategyExitSchema = z
  .object({
    stop: strategyStopSchema.optional(),
    target: strategyTargetSchema.optional(),
    trailing: strategyTrailingSchema.optional(),
    timeStopBars: z.number().int().min(1).max(1000).optional(),
    conditions: strategyConditionGroupSchema.optional(),
  })
  .strict();

export const strategySizingSchema = z.discriminatedUnion("mode", [
  /** Fraction of the strategy's paper cash per entry. */
  z.object({ mode: z.literal("fraction_of_cash"), fraction: z.number().positive().max(1) }).strict(),
  /** Risk this % of equity between entry and stop; never more than maxFractionOfCash of cash. */
  z
    .object({ mode: z.literal("risk_per_trade"), riskPerTradePct: z.number().positive().max(5), maxFractionOfCash: z.number().positive().max(1) })
    .strict(),
]);
export type StrategySizing = z.infer<typeof strategySizingSchema>;

export const strategyRegimeGateSchema = z
  .object({
    trend: z.enum(["up", "down", "range", "any"]).default("any"),
    volatility: z.enum(["low", "normal", "high", "any"]).default("any"),
    squeeze: z.enum(["yes", "no", "any"]).default("any"),
  })
  .strict();
export type StrategyRegimeGate = z.infer<typeof strategyRegimeGateSchema>;

export const strategyBlackoutWindowSchema = z
  .object({
    startHourUtc: z.number().int().min(0).max(23),
    endHourUtc: z.number().int().min(1).max(24),
    /** 0 = Sunday ... 6 = Saturday, UTC. Omitted = every day. */
    daysUtc: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  })
  .strict()
  .refine((w) => w.startHourUtc < w.endHourUtc, { message: "A blackout window ends after it starts (within one UTC day).", path: ["endHourUtc"] });

export const strategyStayOutSchema = z
  .object({
    blackoutWindowsUtc: z.array(strategyBlackoutWindowSchema).max(8).optional(),
    cooldownAfterLosses: z.object({ losses: z.number().int().min(1).max(10), bars: z.number().int().min(1).max(500) }).strict().optional(),
    /** Enter only when this relative-volume indicator is at least `min`. */
    minRelativeVolume: z.object({ indicator: indicatorNameSchema, min: z.number().min(0).max(10) }).strict().optional(),
    /** Checked by the tick against the live bid/ask, not by evaluate(). */
    maxSpreadPct: z.number().min(0.01).max(5).optional(),
    noEntryAfterJump: z.object({ jumpPct: z.number().min(1).max(100), bars: z.number().int().min(1).max(100) }).strict().optional(),
  })
  .strict();
export type StrategyStayOut = z.infer<typeof strategyStayOutSchema>;

/** Prohibitions that only TIGHTEN the entry gate: each is bounded by the hard ceiling and by the spec's own risk limit. */
export const strategyNeverDoSchema = z
  .object({
    maxPositionNok: z.number().int().positive().max(TRADING_HARD_CEILING.maxPositionNok).optional(),
    maxTotalExposureNok: z.number().int().positive().max(TRADING_HARD_CEILING.maxTotalExposureNok).optional(),
    maxOrdersPerDay: z.number().int().positive().max(TRADING_HARD_CEILING.maxOrdersPerDay).optional(),
    dailyLossLimitNok: z.number().int().positive().max(TRADING_HARD_CEILING.dailyLossLimitNok).optional(),
    maxDrawdownPct: z.number().positive().max(TRADING_HARD_CEILING.maxDrawdownPct).optional(),
    priceBandPct: z.number().positive().max(TRADING_HARD_CEILING.priceBandPct).optional(),
  })
  .strict();
export type StrategyNeverDo = z.infer<typeof strategyNeverDoSchema>;

export const STRATEGY_PREDICTION_KINDS = ["direction", "target_before_stop"] as const;
export const strategyPredictionSchema = z
  .object({
    horizonBars: z.number().int().min(1).max(200),
    kind: z.enum(STRATEGY_PREDICTION_KINDS),
    flatBandPct: z.number().min(0).max(10),
    /** What 1R means when scoring a call. "none" is only for plain direction calls. */
    rUnit: z.enum(["stop_distance", "atr_at_entry", "none"]),
  })
  .strict();
export type StrategyPrediction = z.infer<typeof strategyPredictionSchema>;

export const STRATEGY_GUIDELINES_MAX = 8_000;

const metaSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    family: z.enum(STRATEGY_FAMILIES),
    /** Why it should work, and when it should fail. Read by people, ignored by evaluate(). */
    thesis: z.string().trim().min(1).max(2_000),
    commonMistakes: z.array(z.string().trim().min(1).max(300)).max(10),
  })
  .strict();

const universeSchema = z
  .object({
    assets: z.array(z.enum(TRADING_ASSETS)).min(1).max(TRADING_ASSETS.length),
    decisionTimeframe: z.enum(TRADING_TIMEFRAMES),
  })
  .strict();

const engineSpecShape = {
  specVersion: z.literal(STRATEGY_SPEC_VERSION),
  meta: metaSchema,
  universe: universeSchema,
  indicators: z.record(indicatorNameSchema, strategyIndicatorSchema).refine((r) => Object.keys(r).length <= 16, { message: "At most 16 indicators." }),
  regimeGate: strategyRegimeGateSchema,
  entry: strategyConditionGroupSchema,
  exit: strategyExitSchema,
  sizing: strategySizingSchema,
  /** The entry-gate limits this version runs under (the hard ceiling bounds every one). */
  risk: tradingRiskConfigSchema,
  stayOut: strategyStayOutSchema,
  neverDo: strategyNeverDoSchema,
  prediction: strategyPredictionSchema,
} as const;

function operandRefs(op: StrategyOperand | readonly [StrategyOperand, StrategyOperand]): string[] {
  if (Array.isArray(op)) return (op as readonly StrategyOperand[]).filter((v): v is string => typeof v === "string");
  return typeof op === "string" ? [op as string] : [];
}

function groupConditions(group: StrategyConditionGroup | undefined): StrategyCondition[] {
  return group ? [...(group.all ?? []), ...(group.any ?? [])] : [];
}

type EngineSpecShape = { [K in keyof typeof engineSpecShape]: z.infer<(typeof engineSpecShape)[K]> };

function crossChecks(spec: EngineSpecShape, ctx: z.RefinementCtx) {
  const add = (message: string, path: Array<string | number>) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
  const indicators = spec.indicators;
  const kindOf = (name: string): StrategyIndicatorKind | null => indicators[name]?.kind ?? null;
  const knownRef = (ref: string) => ref === "price" || ref in indicators;

  const checkConditions = (group: StrategyConditionGroup | undefined, path: Array<string | number>) => {
    for (const key of ["all", "any"] as const) {
      (group?.[key] ?? []).forEach((c, i) => {
        const here = [...path, key, i];
        if (!knownRef(c.left)) add(`"${c.left}" is not price or a declared indicator.`, [...here, "left"]);
        for (const ref of operandRefs(c.right as StrategyOperand | [StrategyOperand, StrategyOperand])) {
          if (!knownRef(ref)) add(`"${ref}" is not price or a declared indicator.`, [...here, "right"]);
        }
        if (c.op === "between") {
          const [lo, hi] = c.right;
          if (typeof lo === "number" && typeof hi === "number" && lo > hi) add("between needs the lower bound first.", [...here, "right"]);
        }
      });
    }
  };
  checkConditions(spec.entry, ["entry"]);
  checkConditions(spec.exit.conditions, ["exit", "conditions"]);

  const { stop, target, trailing, timeStopBars, conditions } = spec.exit;
  if (!stop && !target && !trailing && timeStopBars === undefined && !conditions) {
    add("A strategy needs a way out: a stop, a target, a trailing stop, a time stop or exit conditions.", ["exit"]);
  }
  if (stop?.kind === "atr" && kindOf(stop.indicator) !== "atr") add("An ATR stop must point at an atr indicator.", ["exit", "stop", "indicator"]);
  if (stop?.kind === "below_swing" && kindOf(stop.indicator) !== "swing_low") add("A swing stop must point at a swing_low indicator.", ["exit", "stop", "indicator"]);
  if (target?.kind === "r_multiple" && !stop) add("An R-multiple target needs a stop (R is the stop distance).", ["exit", "target"]);
  if (spec.sizing.mode === "risk_per_trade" && !stop) add("Sizing by risk per trade needs a stop.", ["sizing"]);
  if (spec.prediction.kind === "target_before_stop" && (!stop || !target)) add("A target-before-stop prediction needs both a stop and a target.", ["prediction", "kind"]);
  if (spec.prediction.rUnit === "none" && spec.prediction.kind !== "direction") add("Only a direction prediction can go without an R unit.", ["prediction", "rUnit"]);
  if (spec.prediction.rUnit === "stop_distance" && !stop) add("An R unit of stop distance needs a stop.", ["prediction", "rUnit"]);
  if (spec.prediction.rUnit === "atr_at_entry" && !Object.values(indicators).some((i) => i.kind === "atr")) {
    add("An R unit of ATR at entry needs an atr indicator.", ["prediction", "rUnit"]);
  }
  const rv = spec.stayOut.minRelativeVolume;
  if (rv && kindOf(rv.indicator) !== "rvol") add("The minimum relative volume must point at an rvol indicator.", ["stayOut", "minRelativeVolume", "indicator"]);
  if (new Set(spec.universe.assets).size !== spec.universe.assets.length) add("Each asset only once.", ["universe", "assets"]);

  // neverDo only tightens: never above this version's own risk limit.
  for (const key of Object.keys(spec.neverDo) as Array<keyof StrategyNeverDo>) {
    const limit = spec.neverDo[key];
    if (limit !== undefined && limit > spec.risk[key]) add(`neverDo.${key} (${limit}) is above the version's own ${key} (${spec.risk[key]}); it can only tighten.`, ["neverDo", key]);
  }
}

/** What evaluate() reads. No guidelines: they cannot reach the engine by construction. */
export const strategyEngineSpecSchema = z.object(engineSpecShape).strict().superRefine(crossChecks);
export type StrategyEngineSpec = z.infer<typeof strategyEngineSpecSchema>;

/** The full document a person or agent proposes: engine spec + guidelines. */
export const strategyDocumentSchema = z
  .object({ ...engineSpecShape, guidelines: z.string().max(STRATEGY_GUIDELINES_MAX) })
  .strict()
  .superRefine(crossChecks);
export type StrategyDocument = z.infer<typeof strategyDocumentSchema>;

/** Splits a document into what the engine reads and what is stored beside it. */
export function splitStrategyDocument(doc: StrategyDocument): { spec: StrategyEngineSpec; guidelines: string } {
  const { guidelines, ...spec } = doc;
  return { spec, guidelines };
}

// ─── Canonical form and digest input ───────────────────────────────────────

/** JSON with sorted keys and no whitespace, so the same document always hashes the same (the server SHA-256s this). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** The exact text the digest covers: the engine spec AND the guidelines. */
export function strategyDigestInput(spec: StrategyEngineSpec, guidelines: string): string {
  return canonicalJson({ spec, guidelines });
}

// ─── Warm-up ───────────────────────────────────────────────────────────────

function indicatorMinBars(def: StrategyIndicator): number {
  switch (def.kind) {
    case "sma":
    case "bb_width":
    case "donchian":
      return def.period;
    case "ema":
    case "atr":
    case "adx":
      return def.period * 5;
    case "rsi":
      return def.period * 5 + 1;
    case "rvol":
    case "roc":
      return def.period + 1;
    case "swing_high":
    case "swing_low":
      return def.lookback + 1;
    case "vwap":
      return def.anchor === "swing" ? 50 : 1;
    default: {
      const exhaustive: never = def;
      throw new Error(`Unknown indicator: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Bars the regime gate needs when it is not "any" (trend: ADX(14) + SMA(50); volatility: ATR(14) vs its last 100; squeeze: width rank over 120). */
export const REGIME_TREND_BARS = 70;
export const REGIME_VOLATILITY_BARS = 114;
export const REGIME_SQUEEZE_BARS = 120;

/**
 * Closed bars the engine needs, and the size of the trailing window it
 * evaluates over: the longest indicator (3-5x for the smoothed ones) plus one
 * bar for crossovers to see a previous value. Fewer bars -> evaluate() holds
 * with reason "warmup". Same history window, same answer: backtests and the
 * live tick agree.
 */
export function strategyWarmupBars(spec: StrategyEngineSpec): number {
  let bars = 2;
  for (const def of Object.values(spec.indicators)) bars = Math.max(bars, indicatorMinBars(def));
  if (spec.regimeGate.trend !== "any") bars = Math.max(bars, REGIME_TREND_BARS);
  if (spec.regimeGate.volatility !== "any") bars = Math.max(bars, REGIME_VOLATILITY_BARS);
  if (spec.regimeGate.squeeze !== "any") bars = Math.max(bars, REGIME_SQUEEZE_BARS);
  return bars + 1;
}

// ─── Cache projection ──────────────────────────────────────────────────────

/** The rule_config cache for a spec that is not a plain SMA crossover. */
export const strategySpecRuleConfigSchema = z
  .object({ type: z.literal("strategy_spec"), version: z.literal(2), specDigest: z.string().regex(/^[0-9a-f]{64}$/), versionNo: z.number().int().positive() })
  .strict();
export type StrategySpecRuleConfig = z.infer<typeof strategySpecRuleConfigSchema>;

/** Everything the rule_config cache column can hold: a plain SMA crossover (legacy rows) or a pointer to the active spec version. */
export const tradingStoredRuleConfigSchema = z.union([smaCrossoverConfigSchema, strategySpecRuleConfigSchema]);
export type TradingStoredRuleConfig = z.infer<typeof tradingStoredRuleConfigSchema>;

/** Entry-gate limits this version runs under: its risk limits with every neverDo tightening applied. */
export function effectiveRiskConfig(spec: StrategyEngineSpec): TradingRiskConfig {
  const r = spec.risk;
  const n = spec.neverDo;
  const lower = <T extends number>(a: T, b: T | undefined): T => (b === undefined ? a : (Math.min(a, b) as T));
  return {
    ...r,
    maxPositionNok: lower(r.maxPositionNok, n.maxPositionNok),
    maxTotalExposureNok: lower(r.maxTotalExposureNok, n.maxTotalExposureNok),
    maxOrdersPerDay: lower(r.maxOrdersPerDay, n.maxOrdersPerDay),
    dailyLossLimitNok: lower(r.dailyLossLimitNok, n.dailyLossLimitNok),
    maxDrawdownPct: lower(r.maxDrawdownPct, n.maxDrawdownPct),
    priceBandPct: lower(r.priceBandPct, n.priceBandPct),
  };
}

// ─── Legacy sma_crossover@1 as a spec ──────────────────────────────────────

export const LEGACY_SMA_FAST = "sma_fast";
export const LEGACY_SMA_SLOW = "sma_slow";

/** The StrategySpec v2 that decides exactly like an sma_crossover@1 rule_config (golden-tested on closed bars). */
export function legacySmaCrossoverDocument(input: {
  name: string;
  asset: (typeof TRADING_ASSETS)[number];
  timeframe: TradingTimeframe;
  rule: SmaCrossoverConfig;
  risk: TradingRiskConfig;
}): StrategyDocument {
  const { rule } = input;
  return {
    specVersion: STRATEGY_SPEC_VERSION,
    meta: {
      name: input.name.slice(0, 120) || "Legacy SMA crossover",
      family: "trend",
      thesis: `Legacy rule converted from sma_crossover@1: buy when the ${rule.fastPeriod}-bar average crosses above the ${rule.slowPeriod}-bar average, sell everything when it crosses back below. It should fail in sideways markets, where the averages keep crossing without a trend.`,
      commonMistakes: ["Trading crossovers in a flat market: every false cross costs two fees."],
    },
    universe: { assets: [input.asset], decisionTimeframe: input.timeframe },
    indicators: { [LEGACY_SMA_FAST]: { kind: "sma", period: rule.fastPeriod }, [LEGACY_SMA_SLOW]: { kind: "sma", period: rule.slowPeriod } },
    regimeGate: { trend: "any", volatility: "any", squeeze: "any" },
    entry: { all: [{ left: LEGACY_SMA_FAST, op: "crosses_above", right: LEGACY_SMA_SLOW }] },
    exit: { conditions: { all: [{ left: LEGACY_SMA_FAST, op: "crosses_below", right: LEGACY_SMA_SLOW }] } },
    sizing: { mode: "fraction_of_cash", fraction: rule.orderSizeFraction },
    risk: input.risk,
    stayOut: {},
    neverDo: {},
    prediction: { horizonBars: 6, kind: "direction", flatBandPct: 0.5, rUnit: "none" },
    guidelines: "",
  } as StrategyDocument;
}

/** If the spec is exactly a converted SMA crossover, the sma_crossover@1 config it stands for; otherwise null. */
export function smaCrossoverConfigFromSpec(spec: StrategyEngineSpec): SmaCrossoverConfig | null {
  const fast = spec.indicators[LEGACY_SMA_FAST];
  const slow = spec.indicators[LEGACY_SMA_SLOW];
  if (Object.keys(spec.indicators).length !== 2 || fast?.kind !== "sma" || slow?.kind !== "sma") return null;
  if (spec.sizing.mode !== "fraction_of_cash") return null;
  const g = spec.regimeGate;
  if (g.trend !== "any" || g.volatility !== "any" || g.squeeze !== "any") return null;
  if (Object.keys(spec.stayOut).length > 0 || Object.keys(spec.neverDo).length > 0) return null;
  const cond = (c: StrategyCondition | undefined, op: string) => c !== undefined && c.left === LEGACY_SMA_FAST && c.op === op && c.right === LEGACY_SMA_SLOW;
  const entryAll = spec.entry.all ?? [];
  const exitAll = spec.exit.conditions?.all ?? [];
  if (entryAll.length !== 1 || (spec.entry.any?.length ?? 0) > 0 || !cond(entryAll[0], "crosses_above")) return null;
  const exit = spec.exit;
  if (exit.stop || exit.target || exit.trailing || exit.timeStopBars !== undefined || (exit.conditions?.any?.length ?? 0) > 0) return null;
  if (exitAll.length !== 1 || !cond(exitAll[0], "crosses_below")) return null;
  if (fast.period >= slow.period) return null;
  return { type: "sma_crossover", version: 1, fastPeriod: fast.period, slowPeriod: slow.period, orderSizeFraction: spec.sizing.fraction };
}

// ─── Entry quantity ────────────────────────────────────────────────────────

/** Order size for an entry, in units of the asset. Pure; the entry gate still decides whether it may go ahead. */
export function strategyEntryQuantity(input: {
  sizing: StrategySizing;
  cashNok: number;
  equityNok: number;
  priceNok: number;
  /** Entry price minus stop price, in NOK per unit; required for risk_per_trade. */
  stopDistanceNok: number | null;
}): number {
  const { sizing, cashNok, equityNok, priceNok, stopDistanceNok } = input;
  if (!(priceNok > 0) || !(cashNok > 0)) return 0;
  if (sizing.mode === "fraction_of_cash") return (sizing.fraction * cashNok) / priceNok;
  if (stopDistanceNok === null || !(stopDistanceNok > 0)) return 0;
  const byRisk = (equityNok * (sizing.riskPerTradePct / 100)) / stopDistanceNok;
  const byCash = (sizing.maxFractionOfCash * cashNok) / priceNok;
  return Math.max(0, Math.min(byRisk, byCash));
}

// ─── Loosening ─────────────────────────────────────────────────────────────

/**
 * Where `next` is looser than `prev`, in plain words (empty = nothing loosened).
 * Agent proposals must come back empty; a person may loosen within the hard
 * ceiling because they approve the card. Covers the entry-gate limits, neverDo,
 * sizing, the stop and the regime gate.
 */
export function describeStrategyLoosening(prev: StrategyEngineSpec, next: StrategyEngineSpec): string[] {
  const out: string[] = [];
  const pe = effectiveRiskConfig(prev);
  const ne = effectiveRiskConfig(next);
  const labels: Record<string, string> = {
    maxPositionNok: "largest position",
    maxTotalExposureNok: "total exposure limit",
    maxOrdersPerDay: "orders per day",
    dailyLossLimitNok: "daily loss limit",
    maxDrawdownPct: "drawdown limit",
    priceBandPct: "price band",
  };
  for (const key of Object.keys(labels) as Array<keyof typeof labels & keyof TradingRiskConfig>) {
    if ((ne[key] as number) > (pe[key] as number)) out.push(`The ${labels[key]} goes up from ${pe[key]} to ${ne[key]}.`);
  }
  if (pe.approvalAboveNok !== null && (ne.approvalAboveNok === null ? false : ne.approvalAboveNok > pe.approvalAboveNok)) {
    out.push(`The approval threshold goes up from ${pe.approvalAboveNok} to ${ne.approvalAboveNok}.`);
  }
  if (pe.approvalAboveNok === null && ne.approvalAboveNok !== null) out.push("Trades no longer all need approval.");
  if (ne.feeRatePct < pe.feeRatePct) out.push(`The assumed fee goes down from ${pe.feeRatePct}% to ${ne.feeRatePct}%.`);
  const sizeOf = (s: StrategySizing) => (s.mode === "fraction_of_cash" ? s.fraction : s.maxFractionOfCash);
  if (sizeOf(next.sizing) > sizeOf(prev.sizing)) out.push("Each entry uses a larger share of cash.");
  if (next.sizing.mode === "risk_per_trade" && prev.sizing.mode === "risk_per_trade" && next.sizing.riskPerTradePct > prev.sizing.riskPerTradePct) {
    out.push("More equity is risked per trade.");
  }
  if (prev.sizing.mode === "fraction_of_cash" && next.sizing.mode === "risk_per_trade") out.push("Sizing switches to risk-per-trade; review the new share of cash.");
  const stopWidth = (s: StrategyStop | undefined) => (s === undefined ? Infinity : s.kind === "pct" ? s.pct : s.kind === "atr" ? s.multiple : Math.max(1, s.bufferPct + 1));
  if (prev.exit.stop && (!next.exit.stop || (next.exit.stop.kind === prev.exit.stop.kind && stopWidth(next.exit.stop) > stopWidth(prev.exit.stop)))) {
    out.push(next.exit.stop ? "The stop is wider." : "The stop is removed.");
  }
  const gateLoosened = (a: string, b: string) => a !== "any" && b === "any";
  if (gateLoosened(prev.regimeGate.trend, next.regimeGate.trend) || gateLoosened(prev.regimeGate.volatility, next.regimeGate.volatility) || gateLoosened(prev.regimeGate.squeeze, next.regimeGate.squeeze)) {
    out.push("A market-condition filter is removed.");
  }
  return out;
}

// ─── Plain-language card text ──────────────────────────────────────────────

function operandText(op: StrategyOperand): string {
  return typeof op === "number" ? String(op) : op === "price" ? "the price" : op;
}

export function describeStrategyCondition(c: StrategyCondition): string {
  const left = operandText(c.left);
  if (c.op === "between") return `${left} is between ${operandText(c.right[0])} and ${operandText(c.right[1])}`;
  const verb = { ">": "is above", "<": "is below", crosses_above: "crosses above", crosses_below: "crosses below" }[c.op];
  return `${left} ${verb} ${operandText(c.right)}`;
}

function groupText(group: StrategyConditionGroup | undefined): string {
  if (!group) return "";
  const parts: string[] = [];
  if (group.all?.length) parts.push(`all of: ${group.all.map(describeStrategyCondition).join("; ")}`);
  if (group.any?.length) parts.push(`at least one of: ${group.any.map(describeStrategyCondition).join("; ")}`);
  return parts.join(", and ");
}

function describeIndicator(name: string, d: StrategyIndicator): string {
  switch (d.kind) {
    case "vwap":
      return `${name}: VWAP (${d.anchor === "utc_day" ? "since UTC midnight" : "from the latest swing low"})`;
    case "swing_high":
    case "swing_low":
      return `${name}: ${d.kind === "swing_high" ? "highest high" : "lowest low"} of the previous ${d.lookback} bars`;
    case "bb_width":
      return `${name}: Bollinger band width (${d.period} bars, ${d.stdDev} deviations)`;
    case "donchian":
      return `${name}: Donchian ${d.band} (${d.period} bars)`;
    default:
      return `${name}: ${d.kind.toUpperCase()} (${d.period} bars)`;
  }
}

/**
 * The text an approval card shows for a stored version. Deterministic and built
 * only from the stored spec and guidelines, so a card whose text differs from
 * the stored draft cannot be produced; the approve step recomputes and compares.
 */
export function describeStrategyDocument(spec: StrategyEngineSpec, guidelines: string): string {
  const e = effectiveRiskConfig(spec);
  const lines: string[] = [];
  lines.push(`${spec.meta.name} (${spec.meta.family.replace("_", " ")})`);
  lines.push(`Watches ${spec.universe.assets.join(", ")} on ${spec.universe.decisionTimeframe} candles. Decisions use closed candles only.`);
  lines.push(`Why it should work: ${spec.meta.thesis}`);
  if (spec.meta.commonMistakes.length) lines.push(`Common mistakes: ${spec.meta.commonMistakes.join(" | ")}`);
  lines.push("Indicators:");
  for (const [name, def] of Object.entries(spec.indicators).sort(([a], [b]) => (a < b ? -1 : 1))) lines.push(`  ${describeIndicator(name, def)}`);
  const g = spec.regimeGate;
  const gates = [g.trend !== "any" ? `trend is ${g.trend}` : "", g.volatility !== "any" ? `volatility is ${g.volatility}` : "", g.squeeze !== "any" ? (g.squeeze === "yes" ? "the market is squeezed" : "the market is not squeezed") : ""].filter(Boolean);
  lines.push(`Only buys when: ${gates.length ? `${gates.join(" and ")}; ` : ""}${groupText(spec.entry)}.`);
  const x = spec.exit;
  const exits: string[] = [];
  if (x.stop) exits.push(x.stop.kind === "pct" ? `stop ${x.stop.pct}% below entry` : x.stop.kind === "atr" ? `stop ${x.stop.multiple} x ${x.stop.indicator} below entry` : `stop below ${x.stop.indicator}${x.stop.bufferPct ? ` minus ${x.stop.bufferPct}%` : ""}`);
  if (x.target) exits.push(x.target.kind === "r_multiple" ? `target ${x.target.r} x the stop distance above entry` : x.target.kind === "pct" ? `target ${x.target.pct}% above entry` : `target at ${x.target.price}`);
  if (x.trailing) exits.push(`trailing stop ${x.trailing.distancePct}% behind the high once up ${x.trailing.activateAtPct}%`);
  if (x.timeStopBars !== undefined) exits.push(`sells after ${x.timeStopBars} bars`);
  if (x.conditions) exits.push(`sells when ${groupText(x.conditions)}`);
  lines.push(`Sells on: ${exits.join("; ")}.`);
  lines.push(spec.sizing.mode === "fraction_of_cash" ? `Size: ${Math.round(spec.sizing.fraction * 1000) / 10}% of cash per entry.` : `Size: risks ${spec.sizing.riskPerTradePct}% of equity between entry and stop, at most ${Math.round(spec.sizing.maxFractionOfCash * 1000) / 10}% of cash.`);
  const s = spec.stayOut;
  const outs: string[] = [];
  for (const w of s.blackoutWindowsUtc ?? []) outs.push(`no entries ${w.startHourUtc}:00-${w.endHourUtc}:00 UTC${w.daysUtc ? ` on days ${w.daysUtc.join(",")}` : ""}`);
  if (s.cooldownAfterLosses) outs.push(`pauses entries for ${s.cooldownAfterLosses.bars} bars after ${s.cooldownAfterLosses.losses} losses in a row`);
  if (s.minRelativeVolume) outs.push(`needs ${s.minRelativeVolume.indicator} of at least ${s.minRelativeVolume.min}`);
  if (s.maxSpreadPct !== undefined) outs.push(`skips entries when the spread is above ${s.maxSpreadPct}%`);
  if (s.noEntryAfterJump) outs.push(`no entry for ${s.noEntryAfterJump.bars} bars after a ${s.noEntryAfterJump.jumpPct}% jump`);
  lines.push(`Stays out: ${outs.length ? outs.join("; ") : "no extra conditions"}.`);
  lines.push(`Limits (paper money): position up to ${e.maxPositionNok} kr, total exposure ${e.maxTotalExposureNok} kr, ${e.maxOrdersPerDay} orders a day, daily loss ${e.dailyLossLimitNok} kr, drawdown ${e.maxDrawdownPct}%, price band ${e.priceBandPct}%, fee ${e.feeRatePct}% a side, ${e.approvalAboveNok === null ? "every trade needs approval" : `approval above ${e.approvalAboveNok} kr`}.`);
  const p = spec.prediction;
  lines.push(`Predicts: ${p.kind === "direction" ? "direction" : "target before stop"} within ${p.horizonBars} bars (flat band ${p.flatBandPct}%, R unit ${p.rUnit === "stop_distance" ? "stop distance" : p.rUnit === "atr_at_entry" ? "1 ATR at entry" : "none"}).`);
  lines.push(`Guidelines (never read by the trading code): ${guidelines.trim() || "none"}`);
  return lines.join("\n");
}
