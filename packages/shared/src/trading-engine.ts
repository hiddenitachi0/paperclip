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
  type IndicatorBar,
  type Series,
} from "./trading-indicators.js";
import {
  REGIME_SQUEEZE_BARS,
  REGIME_TREND_BARS,
  REGIME_VOLATILITY_BARS,
  strategyWarmupBars,
  type StrategyCondition,
  type StrategyConditionGroup,
  type StrategyEngineSpec,
  type StrategyIndicator,
  type StrategyOperand,
  type StrategyStop,
} from "./trading-strategy-spec.js";
import { tradingTimeframeMs } from "./trading.js";

/**
 * DUR-5002: the one engine that decides for backtests, shadow runs and paper
 * trading. evaluateStrategy() is pure and deterministic: no I/O, no clock, no
 * randomness, and it only ever looks at the trailing window of closed bars the
 * spec's indicators need (strategyWarmupBars), so the same last-N bars always
 * give the same answer wherever they come from.
 *
 * It returns what the rule decided, not how likely it is to work: an action,
 * reason codes, a direction call and an indicator snapshot. There is no
 * probability anywhere, because a fixed rule has none to give.
 *
 * Guidelines never reach it: the parameter type is the engine part of the spec
 * (no guidelines field), and a spec object that carries one is refused at runtime.
 */

export type StrategyAction = "enter" | "exit" | "hold";
export type StrategyExitTrigger = "stop" | "trailing_stop" | "target" | "time_stop" | "signal";

export interface StrategyPositionState {
  /** Units held; > 0 means in a position. */
  quantity: number;
  /** Average entry price in the candles' quote currency; null when unknown (price-based exits are then skipped). */
  entryPrice: number | null;
  /** Open time of the closed bar the position was entered after; null = entered on the latest bar. */
  entryBarOpenTime: Date | null;
  /** Losses in a row, newest trade last; for the cooldown. */
  consecutiveLosses?: number;
  /** Closed bars since the last exit; null/undefined = never exited. */
  barsSinceLastExit?: number | null;
}

export interface StrategyDecision {
  action: StrategyAction;
  reasonCodes: string[];
  /** A direction call for the prediction ledger. Never a probability. */
  directionCall: { direction: "up" | "down" | "none"; kind: StrategyEngineSpec["prediction"]["kind"]; horizonBars: number };
  /** The latest value of every declared indicator, plus the closing price. */
  indicatorSnapshot: Record<string, number | null>;
  /** Open time of the newest closed bar the decision is about (ISO), null when there were no bars. */
  barOpenTime: string | null;
  /** Set on "enter": where the stop and target would sit and the 1R distance, at the latest close. */
  entryPlan: { stopPrice: number | null; targetPrice: number | null; rDistance: number | null } | null;
  /** Set on "exit": which rule fired. */
  exitTrigger: StrategyExitTrigger | null;
}

export interface EvaluateStrategyOptions {
  /**
   * Treat crosses_above / crosses_below as the state they announce (left > right /
   * left < right). The catch-up uses it to ask "does the entry still hold now?".
   */
  crossesAsState?: boolean;
}

const FLAT_POSITION: StrategyPositionState = { quantity: 0, entryPrice: null, entryBarOpenTime: null };

function seriesFor(def: StrategyIndicator, bars: readonly IndicatorBar[]): Series {
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
    case "adx":
      return adxSeries(bars, def.period);
    case "bb_width":
      return bbWidthSeries(closes, def.period, def.stdDev);
    case "donchian":
      return donchianSeries(bars, def.period, def.band);
    case "vwap":
      return vwapSeries(bars, def.anchor);
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
      throw new Error(`Unknown indicator: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function lastDefined(series: Series): number | null {
  const v = series[series.length - 1];
  return v === undefined ? null : v;
}

/** The value of one indicator on the last of `bars`, computed over the trailing `windowBars` of them. */
function indicatorAtEnd(def: StrategyIndicator, bars: readonly IndicatorBar[], windowBars: number): number | null {
  return lastDefined(seriesFor(def, bars.slice(-windowBars)));
}

interface Evaluated {
  window: IndicatorBar[];
  series: Record<string, Series>;
}

function makeValueReader(ev: Evaluated) {
  const closes = ev.window.map((b) => b.close);
  return (operand: StrategyOperand, index: number): number | null => {
    if (typeof operand === "number") return operand;
    if (index < 0 || index >= closes.length) return null;
    if (operand === "price") return closes[index]!;
    return ev.series[operand]?.[index] ?? null;
  };
}

function conditionHolds(c: StrategyCondition, read: (o: StrategyOperand, i: number) => number | null, last: number, crossesAsState: boolean): boolean {
  const left = read(c.left, last);
  if (c.op === "between") {
    const lo = read(c.right[0], last);
    const hi = read(c.right[1], last);
    return left !== null && lo !== null && hi !== null && left >= lo && left <= hi;
  }
  const right = read(c.right, last);
  if (left === null || right === null) return false;
  switch (c.op) {
    case ">":
      return left > right;
    case "<":
      return left < right;
    case "crosses_above":
    case "crosses_below": {
      if (crossesAsState) return c.op === "crosses_above" ? left > right : left < right;
      const prevLeft = read(c.left, last - 1);
      const prevRight = read(c.right, last - 1);
      if (prevLeft === null || prevRight === null) return false;
      return c.op === "crosses_above" ? prevLeft <= prevRight && left > right : prevLeft >= prevRight && left < right;
    }
    default: {
      const exhaustive: never = c;
      throw new Error(`Unknown condition: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function groupHolds(group: StrategyConditionGroup | undefined, read: (o: StrategyOperand, i: number) => number | null, last: number, crossesAsState: boolean): boolean {
  if (!group) return false;
  const all = group.all ?? [];
  const any = group.any ?? [];
  if (all.length + any.length === 0) return false;
  return all.every((c) => conditionHolds(c, read, last, crossesAsState)) && (any.length === 0 || any.some((c) => conditionHolds(c, read, last, crossesAsState)));
}

// ─── Regime gate ───────────────────────────────────────────────────────────

type RegimeMeasure = { trend: "up" | "down" | "range" | null; volatility: "low" | "normal" | "high" | null; squeeze: boolean | null };

/**
 * The fixed, spec-independent regime definitions the gate uses:
 *   trend:      ADX(14) >= 20 and close above/below SMA(50) -> up/down; otherwise range.
 *   volatility: ATR(14) now vs the mean of the previous 100 ATR values: < 0.75 low, > 1.25 high.
 *   squeeze:    Bollinger width(20, 2) is in the lowest 20% of the last 100 widths.
 */
export function measureRegime(window: readonly IndicatorBar[]): RegimeMeasure {
  const closes = window.map((b) => b.close);
  const adx = lastDefined(adxSeries(window, 14));
  const sma50 = lastDefined(smaSeries(closes, 50));
  const close = closes[closes.length - 1];
  let trend: RegimeMeasure["trend"] = null;
  if (adx !== null && sma50 !== null && close !== undefined) trend = adx >= 20 ? (close > sma50 ? "up" : "down") : "range";

  let volatility: RegimeMeasure["volatility"] = null;
  const atr = atrSeries(window, 14);
  const atrNow = lastDefined(atr);
  const prior = atr.slice(0, -1).filter((v): v is number => v !== null).slice(-100);
  if (atrNow !== null && prior.length >= 100) {
    const mean = prior.reduce((a, b) => a + b, 0) / prior.length;
    if (mean > 0) volatility = atrNow / mean < 0.75 ? "low" : atrNow / mean > 1.25 ? "high" : "normal";
  }

  let squeeze: RegimeMeasure["squeeze"] = null;
  const widths = bbWidthSeries(closes, 20, 2).filter((v): v is number => v !== null).slice(-100);
  const widthNow = widths[widths.length - 1];
  if (widths.length >= 100 && widthNow !== undefined) squeeze = widths.filter((w) => w <= widthNow).length / widths.length <= 0.2;

  return { trend, volatility, squeeze };
}

// ─── Stops, targets ────────────────────────────────────────────────────────

function stopPriceAt(stop: StrategyStop, spec: StrategyEngineSpec, entryPrice: number, barsUpToEntry: readonly IndicatorBar[], windowBars: number): number | null {
  if (stop.kind === "pct") return entryPrice * (1 - stop.pct / 100);
  const def = spec.indicators[stop.indicator];
  if (!def) return null;
  const value = indicatorAtEnd(def, barsUpToEntry, windowBars);
  if (value === null) return null;
  if (stop.kind === "atr") return entryPrice - stop.multiple * value;
  return value * (1 - stop.bufferPct / 100);
}

function targetPriceFor(spec: StrategyEngineSpec, entryPrice: number, stopPrice: number | null): number | null {
  const t = spec.exit.target;
  if (!t) return null;
  if (t.kind === "pct") return entryPrice * (1 + t.pct / 100);
  if (t.kind === "level") return t.price;
  return stopPrice === null ? null : entryPrice + t.r * (entryPrice - stopPrice);
}

function rDistanceFor(spec: StrategyEngineSpec, entryPrice: number, stopPrice: number | null, barsUpToEntry: readonly IndicatorBar[], windowBars: number): number | null {
  if (spec.prediction.rUnit === "stop_distance") return stopPrice === null ? null : entryPrice - stopPrice;
  const atrDef = Object.values(spec.indicators).find((d) => d.kind === "atr");
  return atrDef ? indicatorAtEnd(atrDef, barsUpToEntry, windowBars) : null;
}

function scanExit(
  spec: StrategyEngineSpec,
  bars: readonly IndicatorBar[],
  position: StrategyPositionState,
  entryIdx: number,
  windowBars: number,
): { trigger: StrategyExitTrigger; code: string } | null {
  const entry = position.entryPrice;
  if (entry === null || !(entry > 0)) return null;
  const upToEntry = bars.slice(0, entryIdx + 1);
  const stopPrice = spec.exit.stop ? stopPriceAt(spec.exit.stop, spec, entry, upToEntry, windowBars) : null;
  const targetPrice = targetPriceFor(spec, entry, stopPrice);
  const trailing = spec.exit.trailing;
  let highest = entry;
  let trailingActive = trailing !== undefined && trailing.activateAtPct <= 0;
  for (let j = entryIdx + 1; j < bars.length; j++) {
    const bar = bars[j]!;
    const trailLevel = trailing && trailingActive ? highest * (1 - trailing.distancePct / 100) : null;
    const protective = Math.max(stopPrice ?? -Infinity, trailLevel ?? -Infinity);
    if (protective > -Infinity && bar.low <= protective) {
      const byTrail = trailLevel !== null && trailLevel >= (stopPrice ?? -Infinity);
      return byTrail ? { trigger: "trailing_stop", code: "trailing_stop_hit" } : { trigger: "stop", code: "stop_hit" };
    }
    if (targetPrice !== null && bar.high >= targetPrice) return { trigger: "target", code: "target_hit" };
    if (bar.high > highest) highest = bar.high;
    if (trailing && !trailingActive && highest >= entry * (1 + trailing.activateAtPct / 100)) trailingActive = true;
  }
  return null;
}

// ─── Stay-out rules ────────────────────────────────────────────────────────

function stayOutReasons(spec: StrategyEngineSpec, window: readonly IndicatorBar[], ev: Evaluated, position: StrategyPositionState): string[] {
  const s = spec.stayOut;
  const out: string[] = [];
  const latest = window[window.length - 1]!;
  const closeTime = new Date(latest.openTime.getTime() + tradingTimeframeMs(spec.universe.decisionTimeframe));
  for (const w of s.blackoutWindowsUtc ?? []) {
    const hour = closeTime.getUTCHours() + closeTime.getUTCMinutes() / 60;
    const dayOk = w.daysUtc === undefined || w.daysUtc.includes(closeTime.getUTCDay());
    if (dayOk && hour >= w.startHourUtc && hour < w.endHourUtc) {
      out.push("stay_out:blackout");
      break;
    }
  }
  if (s.cooldownAfterLosses && (position.consecutiveLosses ?? 0) >= s.cooldownAfterLosses.losses) {
    const since = position.barsSinceLastExit;
    if (since === null || since === undefined || since < s.cooldownAfterLosses.bars) out.push("stay_out:cooldown");
  }
  if (s.minRelativeVolume) {
    const v = ev.series[s.minRelativeVolume.indicator]?.[window.length - 1] ?? null;
    if (v === null || v < s.minRelativeVolume.min) out.push("stay_out:min_relative_volume");
  }
  if (s.noEntryAfterJump) {
    const { jumpPct, bars } = s.noEntryAfterJump;
    for (let i = Math.max(1, window.length - bars); i < window.length; i++) {
      const prev = window[i - 1]!.close;
      if (prev > 0 && (Math.abs(window[i]!.close - prev) / prev) * 100 >= jumpPct) {
        out.push("stay_out:after_jump");
        break;
      }
    }
  }
  return out;
}

// ─── evaluate ──────────────────────────────────────────────────────────────

function emptyDecision(spec: StrategyEngineSpec, reasonCodes: string[], snapshot: Record<string, number | null>, barOpenTime: string | null): StrategyDecision {
  return {
    action: "hold",
    reasonCodes,
    directionCall: { direction: "none", kind: spec.prediction.kind, horizonBars: spec.prediction.horizonBars },
    indicatorSnapshot: snapshot,
    barOpenTime,
    entryPlan: null,
    exitTrigger: null,
  };
}

/**
 * Decide what the spec does on the newest closed bar. `closedBars` are oldest-first,
 * closed candles only (the caller drops the forming bar). Pure and deterministic.
 */
export function evaluateStrategy(
  spec: StrategyEngineSpec,
  closedBars: readonly IndicatorBar[],
  position: StrategyPositionState = FLAT_POSITION,
  options: EvaluateStrategyOptions = {},
): StrategyDecision {
  // Guidelines are free text for people. A spec object that still carries them is a bug upstream.
  if (Object.prototype.hasOwnProperty.call(spec, "guidelines")) {
    throw new Error("evaluateStrategy was handed a spec with guidelines; guidelines never reach the engine.");
  }
  const windowBars = strategyWarmupBars(spec);
  const barOpenTime = closedBars.length ? closedBars[closedBars.length - 1]!.openTime.toISOString() : null;
  if (closedBars.length < windowBars) {
    return emptyDecision(spec, ["warmup"], {}, barOpenTime);
  }
  const window = closedBars.slice(-windowBars);
  const last = window.length - 1;
  const series: Record<string, Series> = {};
  for (const [name, def] of Object.entries(spec.indicators)) series[name] = seriesFor(def, window);
  const ev: Evaluated = { window, series };
  const read = makeValueReader(ev);
  const snapshot: Record<string, number | null> = { price: window[last]!.close };
  for (const name of Object.keys(spec.indicators).sort()) snapshot[name] = series[name]![last] ?? null;
  const crossesAsState = options.crossesAsState === true;
  const inPosition = position.quantity > 0;

  if (inPosition) {
    const reasons: string[] = ["in_position"];
    // Where in closedBars the position was entered (bars after it are the ones the exits scan).
    let entryIdx = closedBars.length - 1;
    if (position.entryBarOpenTime) {
      const t = position.entryBarOpenTime.getTime();
      const found = closedBars.findIndex((b) => b.openTime.getTime() === t);
      if (found >= 0) entryIdx = found;
      else if (closedBars[0]!.openTime.getTime() > t) {
        entryIdx = 0;
        reasons.push("entry_bar_before_history");
      }
    }
    if (position.entryPrice === null) reasons.push("entry_price_unknown");
    const hit = scanExit(spec, closedBars, position, entryIdx, windowBars);
    const barsHeld = closedBars.length - 1 - entryIdx;
    let trigger: StrategyExitTrigger | null = null;
    let code: string | null = null;
    if (hit) {
      trigger = hit.trigger;
      code = hit.code;
    } else if (spec.exit.timeStopBars !== undefined && barsHeld >= spec.exit.timeStopBars) {
      trigger = "time_stop";
      code = "time_stop";
    } else if (groupHolds(spec.exit.conditions, read, last, crossesAsState)) {
      trigger = "signal";
      code = "exit_conditions_met";
    }
    if (trigger && code) {
      return {
        action: "exit",
        reasonCodes: [...reasons, code],
        directionCall: { direction: trigger === "signal" ? "down" : "none", kind: spec.prediction.kind, horizonBars: spec.prediction.horizonBars },
        indicatorSnapshot: snapshot,
        barOpenTime,
        entryPlan: null,
        exitTrigger: trigger,
      };
    }
    return emptyDecision(spec, reasons, snapshot, barOpenTime);
  }

  if (!groupHolds(spec.entry, read, last, crossesAsState)) {
    return emptyDecision(spec, ["entry_conditions_not_met"], snapshot, barOpenTime);
  }
  const blocked: string[] = [];
  const gate = spec.regimeGate;
  if (gate.trend !== "any" || gate.volatility !== "any" || gate.squeeze !== "any") {
    // The gate looks at the fixed regime windows even when the spec's own indicators need fewer bars.
    const need = Math.max(gate.trend !== "any" ? REGIME_TREND_BARS : 0, gate.volatility !== "any" ? REGIME_VOLATILITY_BARS : 0, gate.squeeze !== "any" ? REGIME_SQUEEZE_BARS : 0);
    const regimeWindow = closedBars.slice(-Math.max(need, windowBars));
    const regime = measureRegime(regimeWindow);
    if (gate.trend !== "any" && regime.trend !== gate.trend) blocked.push("regime_gate:trend");
    if (gate.volatility !== "any" && regime.volatility !== gate.volatility) blocked.push("regime_gate:volatility");
    if (gate.squeeze !== "any" && regime.squeeze !== (gate.squeeze === "yes")) blocked.push("regime_gate:squeeze");
  }
  blocked.push(...stayOutReasons(spec, window, ev, position));
  if (blocked.length > 0) {
    return emptyDecision(spec, ["entry_conditions_met", ...blocked], snapshot, barOpenTime);
  }

  const entryPrice = window[last]!.close;
  const stopPrice = spec.exit.stop ? stopPriceAt(spec.exit.stop, spec, entryPrice, window, windowBars) : null;
  return {
    action: "enter",
    reasonCodes: ["entry_conditions_met"],
    directionCall: { direction: "up", kind: spec.prediction.kind, horizonBars: spec.prediction.horizonBars },
    indicatorSnapshot: snapshot,
    barOpenTime,
    entryPlan: {
      stopPrice,
      targetPrice: targetPriceFor(spec, entryPrice, stopPrice),
      rDistance: rDistanceFor(spec, entryPrice, stopPrice, window, windowBars),
    },
    exitTrigger: null,
  };
}
