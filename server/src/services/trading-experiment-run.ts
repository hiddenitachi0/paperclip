import { createHash } from "node:crypto";
import {
  TRADING_EXPERIMENT_LIMITS,
  TRADING_EXPERIMENT_MAX_COMBINATIONS,
  TRADING_EXPERIMENT_RECOMMEND,
  canonicalExperimentGrid,
  canonicalTradingJson,
  experimentGridSize,
  tradingSpecRequiredBars,
  tradingStrategySpecSchema,
  type TradingExperimentAxis,
  type TradingExperimentRecommendation,
  type TradingStrategySpec,
} from "@paperclipai/shared";
import {
  BacktestRefusal,
  buildVariants,
  executeBacktest,
  specVariantDigest,
  type BacktestInputs,
  type BacktestOutcome,
  type BacktestRunParams,
  type BacktestVariant,
  type VariantStat,
} from "./trading-backtest-run.js";

/**
 * DUR-5018: the experiment runner's pure core. An experiment is the walk-forward
 * past-data test (DUR-5008) run on a small, capped grid of indicator settings of
 * ONE version, as an exploration: it never reads the holdout and can never pass
 * the start gate. It writes nothing and never reads the clock (the as-of time is
 * part of the experiment's parameters), so the same experiment twice gives the
 * same bytes.
 *
 * What comes out is a recommendation, never a change: either one variant that
 * cleared every check below, or "no change". Nothing here applies it.
 *
 * Only indicator settings (period / lookback / stdDev) are varied. Risk limits,
 * stops, sizing and the entry/exit logic are never part of a grid, so an
 * experiment cannot recommend loosening a risk limit.
 */

export interface ExperimentParams extends BacktestRunParams {
  /** The canonical grid, or null for the automatic neighbours. */
  grid: TradingExperimentAxis[] | null;
}

export interface ExperimentVariant extends BacktestVariant {
  /** The value of every varied setting in this variant, keyed `indicator.param`. */
  coords: Record<string, number>;
}

const axisKey = (axis: Pick<TradingExperimentAxis, "indicator" | "param">) => `${axis.indicator}.${axis.param}`;

/** Every axis the automatic neighbours may touch (the same ones buildVariants nudges). */
export function autoAxes(base: TradingStrategySpec): Array<Pick<TradingExperimentAxis, "indicator" | "param">> {
  const axes: Array<Pick<TradingExperimentAxis, "indicator" | "param">> = [];
  for (const name of Object.keys(base.indicators).sort()) {
    const def = base.indicators[name]! as unknown as Record<string, unknown>;
    const kind = def.kind as string;
    const param = "period" in def ? "period" : kind === "vwap" ? (def.anchor === "swing" ? "lookback" : null) : kind === "swing_high" || kind === "swing_low" ? "lookback" : null;
    if (param === "period" || param === "lookback") axes.push({ indicator: name, param });
  }
  return axes;
}

function readCoord(spec: TradingStrategySpec, axis: Pick<TradingExperimentAxis, "indicator" | "param">): number | null {
  const def = spec.indicators[axis.indicator] as unknown as Record<string, unknown> | undefined;
  const value = def?.[axis.param];
  return typeof value === "number" ? value : null;
}

/** Refuses a grid that names an indicator or setting the version does not have, or that is too big. Throws BacktestRefusal with a plain reason. */
export function validateExperimentGrid(base: TradingStrategySpec, grid: readonly TradingExperimentAxis[]): void {
  const seen = new Set<string>();
  for (const axis of grid) {
    const key = axisKey(axis);
    if (seen.has(key)) throw new BacktestRefusal(`The grid names ${key} twice.`);
    seen.add(key);
    const current = readCoord(base, axis);
    if (current === null) throw new BacktestRefusal(`These rules have no setting "${axis.param}" on an indicator called "${axis.indicator}", so it cannot be varied.`);
    for (const value of axis.values) {
      if (axis.param !== "stdDev" && !Number.isInteger(value)) throw new BacktestRefusal(`${key} must be a whole number; ${value} is not.`);
    }
  }
  const size = experimentGridSize(grid);
  if (size > TRADING_EXPERIMENT_MAX_COMBINATIONS) {
    throw new BacktestRefusal(`That grid has ${size} combinations; at most ${TRADING_EXPERIMENT_MAX_COMBINATIONS} are allowed (the rules as written always run too, ${TRADING_EXPERIMENT_LIMITS.maxVariants} variants in all).`);
  }
}

function patchSpec(base: TradingStrategySpec, assignments: Array<{ axis: TradingExperimentAxis; value: number }>): TradingStrategySpec | null {
  const patched = JSON.parse(JSON.stringify(base)) as TradingStrategySpec;
  for (const { axis, value } of assignments) (patched.indicators[axis.indicator] as unknown as Record<string, number>)[axis.param] = value;
  // A longer indicator needs more history before it can decide: widen an explicit warm-up with it.
  if (patched.universe.warmupBars !== undefined) patched.universe.warmupBars = Math.max(patched.universe.warmupBars, tradingSpecRequiredBars(patched));
  const parsed = tradingStrategySpecSchema.safeParse(patched);
  return parsed.success ? parsed.data : null;
}

/** Variant 0 is the rules as written; then every grid combination (or, with no grid, the automatic neighbours). Deterministic order. */
export function buildExperimentVariants(base: TradingStrategySpec, grid: readonly TradingExperimentAxis[] | null): ExperimentVariant[] {
  const axes = grid ? [...grid] : autoAxes(base).map((a) => ({ ...a, values: [] as number[] }));
  const coordsOf = (spec: TradingStrategySpec): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const axis of axes) {
      const v = readCoord(spec, axis);
      if (v !== null) out[axisKey(axis)] = v;
    }
    return out;
  };
  const baseVariant: ExperimentVariant = { index: 0, label: "your rules as written", digest: specVariantDigest(base), spec: base, coords: coordsOf(base) };
  if (!grid) {
    return buildVariants(base, TRADING_EXPERIMENT_LIMITS.maxVariants).map((v) => (v.index === 0 ? baseVariant : { ...v, coords: coordsOf(v.spec) }));
  }
  const variants: ExperimentVariant[] = [baseVariant];
  const seen = new Set([baseVariant.digest]);
  const walk = (depth: number, chosen: Array<{ axis: TradingExperimentAxis; value: number }>) => {
    if (depth === axes.length) {
      const spec = patchSpec(base, chosen);
      if (!spec) return;
      const digest = specVariantDigest(spec);
      if (seen.has(digest)) return;
      seen.add(digest);
      variants.push({ index: variants.length, label: chosen.map(({ axis, value }) => `${axisKey(axis)} ${readCoord(base, axis)} -> ${value}`).join(", "), digest, spec, coords: coordsOf(spec) });
      return;
    }
    for (const value of axes[depth]!.values) walk(depth + 1, [...chosen, { axis: axes[depth]!, value }]);
  };
  walk(0, []);
  return variants;
}

// ─── The recommendation ──────────────────────────────────────────────────────

export interface PlateauCheck {
  applicable: boolean;
  /** The recommended (or, with no recommendation, the best) variant the check is about. */
  variant: string | null;
  neighbours: Array<{ label: string; trades: number; positive: boolean }>;
  positive: number;
  share: number | null;
  passed: boolean | null;
}

function plateauFor(variants: readonly ExperimentVariant[], stats: readonly VariantStat[], pick: number | null): PlateauCheck {
  if (pick === null) return { applicable: false, variant: null, neighbours: [], positive: 0, share: null, passed: null };
  const chosen = variants[pick]!;
  // A neighbour is one step away: it differs from the chosen variant in exactly one varied setting.
  const neighbours = variants
    .filter((v) => v.index !== pick && Object.keys(chosen.coords).filter((k) => v.coords[k] !== chosen.coords[k]).length === 1)
    .map((v) => ({ label: v.label, trades: stats[v.index]!.trades, positive: stats[v.index]!.positive }));
  const positive = neighbours.filter((n) => n.positive).length;
  const applicable = neighbours.length >= TRADING_EXPERIMENT_RECOMMEND.minPlateauNeighbours;
  const share = neighbours.length === 0 ? null : positive / neighbours.length;
  return { applicable, variant: chosen.label, neighbours, positive, share, passed: applicable ? (share ?? 0) >= TRADING_EXPERIMENT_RECOMMEND.minPlateauShare : null };
}

export interface ExperimentDecision {
  recommendation: TradingExperimentRecommendation;
  plateau: PlateauCheck;
  /** The variant the Deflated Sharpe figure belongs to: the recommended one, else the best candidate. */
  focusIndex: number | null;
  recommendedIndex: number | null;
}

/**
 * One variant is recommended only if it beats the rules as written, is
 * positive after 2x fees out of sample with enough trades, is not just the
 * luckiest of the variants tried (Deflated Sharpe over the whole lineage's
 * trial count), and sits on a plateau (its neighbours work too). Any miss
 * means "no change"; the checks that missed are listed.
 */
export function decideExperiment(variants: readonly ExperimentVariant[], stats: readonly VariantStat[]): ExperimentDecision {
  const t = TRADING_EXPERIMENT_RECOMMEND;
  const base = stats[0]!;
  const baseSharpe = base.oosSharpe ?? Number.NEGATIVE_INFINITY;
  // The best other variant by out-of-sample Sharpe; ties go to the earlier one so the choice is deterministic.
  let focus: number | null = null;
  for (let k = 1; k < stats.length; k++) {
    const sharpe = stats[k]!.oosSharpe;
    if (sharpe === null) continue;
    if (focus === null || sharpe > stats[focus]!.oosSharpe!) focus = k;
  }
  const checks: TradingExperimentRecommendation["checks"] = [];
  const plateau = plateauFor(variants, stats, focus);
  if (focus === null) {
    checks.push({ key: "candidate", label: "At least one other variant could be measured", passed: false, detail: "No other variant produced enough out-of-sample data to compare." });
  } else {
    const c = stats[focus]!;
    checks.push({ key: "beats_base", label: "Beats the rules as written", passed: c.oosSharpe! > baseSharpe, detail: `Per-bar out-of-sample Sharpe ${fmt(c.oosSharpe)} against ${fmt(base.oosSharpe)} for the rules as written.` });
    checks.push({ key: "positive_after_fees", label: "Positive out of sample at double fees", passed: c.positive, detail: c.positive ? "Average trade is positive at 2x fees." : "Average trade is not positive at 2x fees." });
    checks.push({ key: "enough_trades", label: `At least ${t.minOutOfSampleTrades} out-of-sample trades`, passed: c.trades >= t.minOutOfSampleTrades, detail: `${c.trades} trades.` });
    checks.push({ key: "deflated_sharpe", label: `Deflated Sharpe at least ${t.minDeflatedSharpe}`, passed: c.deflatedSharpeProbability !== null && c.deflatedSharpeProbability >= t.minDeflatedSharpe, detail: `Deflated Sharpe ${fmt(c.deflatedSharpeProbability)}, counting every variant ever tried for this strategy's lineage.` });
    checks.push({
      key: "plateau",
      label: `At least ${Math.round(t.minPlateauShare * 100)}% of its neighbours are positive too`,
      passed: plateau.passed === true,
      detail: plateau.applicable ? `${plateau.positive} of ${plateau.neighbours.length} neighbours are positive.` : `Only ${plateau.neighbours.length} neighbour${plateau.neighbours.length === 1 ? "" : "s"} in the grid; at least ${t.minPlateauNeighbours} are needed to call it a plateau.`,
    });
  }
  const failed = checks.filter((c) => !c.passed);
  const recommended = focus !== null && failed.length === 0 ? focus : null;
  const chosen = recommended === null ? null : variants[recommended]!;
  return {
    recommendation: {
      decision: recommended === null ? "no_change" : "recommend",
      variantDigest: chosen?.digest ?? null,
      variantLabel: chosen?.label ?? null,
      checks,
      summary: recommended === null ? `No change: ${failed.length === 0 ? "nothing to compare." : failed[0]!.detail}` : `Recommended: ${chosen!.label}. Every check passed. This is a suggestion only; nothing was changed.`,
      thresholds: t,
    },
    plateau,
    focusIndex: focus,
    recommendedIndex: recommended,
  };
}

function fmt(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "n/a" : value.toFixed(4);
}

// ─── The run ─────────────────────────────────────────────────────────────────

export interface ExperimentOutcome {
  report: Record<string, unknown>;
  resultDigest: string;
  trials: Array<{ digest: string; label: string; oosSharpe: number | null; observations: number }>;
  trialCount: number;
  registryTrialCount: number;
  deflatedSharpe: number | null;
  plateau: PlateauCheck;
  holdoutReadsLineage: number;
  recommendation: TradingExperimentRecommendation;
  recommendedSpec: TradingStrategySpec | null;
  backtest: BacktestOutcome;
}

export async function executeExperiment(input: Omit<BacktestInputs, "params" | "variants"> & { params: ExperimentParams }): Promise<ExperimentOutcome> {
  const { params, spec } = input;
  if (params.purpose !== "explore" || params.selection !== "base") {
    throw new BacktestRefusal("An experiment is an exploration of the rules as written; it never reads the holdout.");
  }
  if (params.grid) validateExperimentGrid(spec, params.grid);
  const variants = buildExperimentVariants(spec, params.grid);
  if (variants.length < 2) throw new BacktestRefusal("This grid has no combination that differs from the rules as written, so there is nothing to compare.");
  const { grid: _grid, ...backtestParams } = params;
  const backtest = await executeBacktest({ ...input, params: backtestParams, variants });
  const decision = decideExperiment(variants, backtest.variantStats);
  const focusStat = decision.focusIndex === null ? null : backtest.variantStats[decision.focusIndex]!;
  const trials = backtest.variantStats.map((s) => ({ digest: s.digest, label: s.label, oosSharpe: s.oosSharpe, observations: s.observations }));
  const recommendedSpec = decision.recommendedIndex === null ? null : variants[decision.recommendedIndex]!.spec;
  const report = {
    schema: 1,
    kind: "experiment",
    asOf: params.asOf,
    source: params.source,
    grid: params.grid ?? "automatic neighbours",
    costs: params.costs,
    trialCount: variants.length,
    registryTrialCount: backtest.registrySize,
    holdoutReads: { lineageBefore: backtest.priorHoldoutReads, madeByThisExperiment: 0 },
    deflatedSharpe: { variant: focusStat?.label ?? null, probability: focusStat?.deflatedSharpeProbability ?? null, trialsCounted: backtest.registrySize },
    plateau: decision.plateau,
    variants: backtest.variantStats.map((s, k) => ({ ...s, coords: variants[k]!.coords })),
    recommendation: decision.recommendation,
    walkForward: (backtest.report as { walkForward?: unknown }).walkForward ?? null,
    note: "A suggestion only. Nothing here changes any strategy; a change still needs a proposal that cites this experiment, and a person's approval.",
  };
  const clean = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
  return {
    report: clean,
    resultDigest: createHash("sha256").update(canonicalTradingJson(clean)).digest("hex"),
    trials,
    trialCount: variants.length,
    registryTrialCount: backtest.registrySize,
    deflatedSharpe: focusStat?.deflatedSharpeProbability ?? null,
    plateau: decision.plateau,
    holdoutReadsLineage: backtest.priorHoldoutReads,
    recommendation: decision.recommendation,
    recommendedSpec,
    backtest,
  };
}

export { canonicalExperimentGrid };
