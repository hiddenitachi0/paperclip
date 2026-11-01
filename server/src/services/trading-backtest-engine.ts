import {
  TRADING_BACKTEST_COSTS,
  TRADING_ESTIMATED_USD_NOK_RATE,
  TRADING_MAX_CATCH_UP_BARS,
  adxSeries,
  atrSeries,
  backtestRegimeOfTrend,
  deriveTradingRiskConfig,
  evaluateTradingSpec,
  seededRandom,
  tradingSpecWarmupBars,
  tradingTimeframeMs,
  type BacktestTrade,
  type TradingBacktestRegime,
  type TradingDecision,
  type TradingEngineBar,
  type TradingPositionState,
  type TradingRiskConfig,
  type TradingStrategySpec,
} from "@paperclipai/shared";
import { evaluateTradingEntryGate, evaluateTradingExitGate, tradingFeeNok } from "./trading-risk-gate.js";

/**
 * DUR-5008: the simulation core of the past-data test. Pure and deterministic:
 * no I/O, no clock, no unseeded randomness. It runs the SAME decision function
 * as live trading (`evaluateTradingSpec`), the SAME entry and exit gates
 * (trading-risk-gate.ts) and the same fee formula, and replaces only the part
 * that cannot be shared: where a fill happens.
 *
 * Fills and costs (plan section 5):
 *   - a signal at a bar's close fills at the NEXT bar's open, plus half the
 *     spread and a slippage allowance against us; fees are charged per side;
 *   - a stop, trailing stop or fixed target is checked on the 5-minute bars
 *     inside each decision bar when all of them are present; a stop that is
 *     gapped through fills at the 5-minute bar's open, and when a stop and a
 *     target are both touched in one 5-minute bar the stop wins (the cautious
 *     order). Without complete 5-minute data that bar falls back to the
 *     engine's own close-of-bar check, which exits at the next open;
 *   - a position still open at the end of a window is closed at that last
 *     close, with costs, so a window never ends with unrealised profit.
 *
 * Orders the gate would send to a person for approval (`needs_approval`) are
 * assumed approved: a past-data test cannot wait for a human, and the report
 * counts how many there were.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SimulationCosts {
  feeRatePct: number;
  spreadPct: number;
  slippagePct: number;
}

export interface PointInTimeRead {
  name: string;
  decisionTime: string;
  availableAt: string;
}

/** A joined outside input (funding, open interest, Fear & Greed...). The provider decides which point a decision time maps to; the engine audits the answer. */
export interface JoinedInputs {
  read(name: string, decisionTime: Date): { availableAt: Date; value: number } | null;
}

/** The honest join: the latest point whose availableAt is at or before the decision time. */
export function latestKnownJoin(series: Record<string, ReadonlyArray<{ availableAt: Date; value: number }>>): JoinedInputs {
  return {
    read(name, decisionTime) {
      const points = series[name];
      if (!points) return null;
      let best: { availableAt: Date; value: number } | null = null;
      for (const point of points) {
        if (point.availableAt.getTime() <= decisionTime.getTime() && (best === null || point.availableAt.getTime() >= best.availableAt.getTime())) best = point;
      }
      return best;
    },
  };
}

export interface DecideContext {
  /** The value of a joined input as known at the decision time, or null. Every call is audited. */
  join(name: string): number | null;
}

/**
 * Decides on the bar at `index`. It is handed the WHOLE bar array and the
 * index (as in most backtest tools), so a careless rule could read bars after
 * `index`: that is exactly what the look-ahead check exists to catch. The
 * default decider only ever slices up to `index`.
 */
export type BacktestDecider = (bars: readonly TradingEngineBar[], index: number, position: TradingPositionState, ctx: DecideContext) => TradingDecision;

export interface SignalEvent {
  /** Close time of the decision bar (or the open time of the 5-minute bar for an intrabar exit). */
  at: string;
  action: "enter" | "exit";
  source: "bar" | "intrabar";
  reasonCodes: string[];
}

export interface BlockedOrder {
  at: string;
  side: "buy";
  reason: string;
}

export interface SimulateInput {
  spec: TradingStrategySpec;
  coin: string;
  /** Closed decision-timeframe bars, oldest first, including history before `start` for the indicators. */
  bars: readonly TradingEngineBar[];
  /** Closed 5-minute bars, oldest first (any range); null or empty when not available. */
  fineBars?: readonly TradingEngineBar[] | null;
  /** First bar index of the window (inclusive) and the end (exclusive). Decisions start at `start`. */
  start: number;
  end: number;
  costs: SimulationCosts;
  startingCashUsd: number;
  /** Market state at each bar, aligned with `bars`. */
  regimeAt?: (index: number) => TradingBacktestRegime | null;
  decide?: BacktestDecider;
  joined?: JoinedInputs;
  /** Called once per decision bar; a deadline can abort the run by throwing. */
  checkpoint?: () => void;
}

export interface SimulationResult {
  trades: BacktestTrade[];
  signals: SignalEvent[];
  /** Equity at each bar close of the window, USD. */
  equity: number[];
  /** True for the bars during which a position was held. */
  inPosition: boolean[];
  blocked: BlockedOrder[];
  blockedCount: number;
  /** Entries the gate would have sent to a person, assumed approved. */
  approvalAssumed: number;
  /** Decision bars whose stops were checked on complete 5-minute data. */
  intrabarBars: number;
  barsTotal: number;
  pointInTimeReads: number;
  /** A sample of the violations (capped); the count is exact. */
  pointInTimeViolations: PointInTimeRead[];
  pointInTimeViolationCount: number;
}

const FIVE_MIN_MS = 5 * 60_000;
const MAX_LOGGED = 50;

// ─── Warm-up and the default decider ─────────────────────────────────────────

function longestPeriod(spec: TradingStrategySpec): number {
  let longest = 1;
  for (const def of Object.values(spec.indicators)) {
    const period = "period" in def ? def.period : def.kind === "vwap" ? (def.anchor === "swing" ? def.lookback : 1) : def.lookback;
    if (period > longest) longest = period;
  }
  return longest;
}

/** Warm-up for a past-data test: the engine's own minimum, or 5x the longest indicator, whichever is more (plan: 3-5x). */
export function backtestWarmupBars(spec: TradingStrategySpec): number {
  return Math.max(tradingSpecWarmupBars(spec), 5 * longestPeriod(spec));
}

/** The decision function live trading uses, handed only the bars up to the decision bar. */
export function specDecider(spec: TradingStrategySpec): BacktestDecider {
  const window = backtestWarmupBars(spec) + TRADING_MAX_CATCH_UP_BARS;
  return (bars, index, position) => evaluateTradingSpec(spec, bars.slice(Math.max(0, index + 1 - window), index + 1), position);
}

/** Market state per bar from the bars alone: ADX(14) >= 25 is a trend (up = bull, down = bear), ADX < 20 is a range, in between is unclear (the engine's own thresholds). */
export function regimeLabels(bars: readonly TradingEngineBar[]): Array<TradingBacktestRegime | null> {
  const all = adxSeries(bars, 14);
  return bars.map((_, i) => {
    const adx = all.adx[i];
    const plus = all.plusDi[i];
    const minus = all.minusDi[i];
    if (adx === null || adx === undefined || plus === null || plus === undefined || minus === null || minus === undefined) return null;
    const trend = adx >= 25 ? (plus > minus ? "up" : minus > plus ? "down" : "unclear") : adx < 20 ? "range" : "unclear";
    return backtestRegimeOfTrend(trend);
  });
}

// ─── The simulation ──────────────────────────────────────────────────────────

interface OpenPosition {
  quantity: number;
  entryFill: number;
  entryAt: Date;
  entryIndex: number;
  entryFeeUsd: number;
  stopPrice: number | null;
  targetPrice: number | null;
  highest: number;
  riskPerUnit: number | null;
  regime: TradingBacktestRegime | null;
}

type Pending = { side: "buy"; sizeFraction: number; stopPrice: number | null; targetPrice: number | null; signalClose: number; signalIndex: number; riskPerUnit: number | null; highest: number } | { side: "sell"; reason: string };

function utcDay(ms: number): number {
  return Math.floor(ms / 86_400_000);
}

function lowerBound(bars: readonly TradingEngineBar[], timeMs: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid]!.openTime.getTime() < timeMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function simulateWindow(input: SimulateInput): SimulationResult {
  const { spec, bars, costs } = input;
  const tfMs = tradingTimeframeMs(spec.universe.decisionTimeframe);
  const decide = input.decide ?? specDecider(spec);
  const risk: TradingRiskConfig = deriveTradingRiskConfig(spec);
  const fx = TRADING_ESTIMATED_USD_NOK_RATE;
  const halfSpread = costs.spreadPct / 200;
  const slip = costs.slippagePct / 100;
  const buyFactor = 1 + halfSpread + slip;
  const sellFactor = 1 - halfSpread - slip;
  const finePerBar = tfMs / FIVE_MIN_MS;
  const fine = input.fineBars && input.fineBars.length > 0 ? input.fineBars : null;

  const result: SimulationResult = {
    trades: [],
    signals: [],
    equity: [],
    inPosition: [],
    blocked: [],
    blockedCount: 0,
    approvalAssumed: 0,
    intrabarBars: 0,
    barsTotal: Math.max(0, input.end - input.start),
    pointInTimeReads: 0,
    pointInTimeViolations: [],
    pointInTimeViolationCount: 0,
  };

  let cash = input.startingCashUsd;
  let peakEquity = cash;
  let position = null as OpenPosition | null;
  let pending = null as Pending | null;
  let consecutiveLosses = 0;
  let barsSinceExit = null as number | null;
  let ordersToday = 0;
  let realizedTodayUsd = 0;
  let todayKey = -1;

  const rollDay = (ms: number) => {
    const key = utcDay(ms);
    if (key !== todayKey) {
      todayKey = key;
      ordersToday = 0;
      realizedTodayUsd = 0;
    }
  };

  const closePosition = (basePrice: number, at: Date, index: number, reason: string, noSlippage = false) => {
    const p = position!;
    const exitFill = noSlippage ? basePrice : basePrice * sellFactor;
    const proceeds = p.quantity * exitFill;
    const exitFee = tradingFeeNok(proceeds, costs.feeRatePct);
    const cost = p.quantity * p.entryFill;
    const gross = proceeds - cost;
    const fees = p.entryFeeUsd + exitFee;
    const net = gross - fees;
    cash += proceeds - exitFee;
    ordersToday += 1;
    realizedTodayUsd += net;
    result.trades.push({
      coin: input.coin,
      entryAt: p.entryAt.toISOString(),
      exitAt: at.toISOString(),
      entryPrice: p.entryFill,
      exitPrice: exitFill,
      quantity: p.quantity,
      bars: Math.max(1, index - p.entryIndex),
      grossPnlUsd: gross,
      feesUsd: fees,
      netPnlUsd: net,
      netReturn: cost + p.entryFeeUsd > 0 ? net / (cost + p.entryFeeUsd) : 0,
      r: p.riskPerUnit !== null && p.riskPerUnit > 0 ? net / (p.riskPerUnit * p.quantity) : null,
      exitReason: reason,
      regime: p.regime,
    });
    consecutiveLosses = net <= 0 ? consecutiveLosses + 1 : 0;
    barsSinceExit = 0;
    position = null;
  };

  const joinContext = (decisionTime: Date): DecideContext => ({
    join: (name) => {
      if (!input.joined) return null;
      const point = input.joined.read(name, decisionTime);
      result.pointInTimeReads += 1;
      if (!point) return null;
      if (point.availableAt.getTime() > decisionTime.getTime()) {
        result.pointInTimeViolationCount += 1;
        if (result.pointInTimeViolations.length < MAX_LOGGED) {
          result.pointInTimeViolations.push({ name, decisionTime: decisionTime.toISOString(), availableAt: point.availableAt.toISOString() });
        }
      }
      return point.value;
    },
  });

  for (let i = input.start; i < input.end; i++) {
    input.checkpoint?.();
    const bar = bars[i]!;
    const openMs = bar.openTime.getTime();
    const closeTime = new Date(openMs + tfMs);
    rollDay(openMs);

    // 1. Fill what the previous bar's close decided, at this bar's open.
    if (pending) {
      const order: Pending = pending;
      pending = null;
      if (order.side === "buy" && position === null) {
        const fillPrice = bar.open * buyFactor;
        const equityNow = cash;
        const requested = (order.sizeFraction * cash) / fillPrice;
        const affordable = cash / (fillPrice * (1 + costs.feeRatePct / 100));
        const quantity = Math.min(requested, affordable);
        const spreadBlock = spec.stayOut.maxSpreadPct !== undefined && costs.spreadPct > spec.stayOut.maxSpreadPct;
        const verdict = spreadBlock
          ? ({ kind: "block", reason: `The spread (${costs.spreadPct.toFixed(2)}%) is wider than this strategy's limit (${spec.stayOut.maxSpreadPct}%).` } as const)
          : quantity > 0
            ? evaluateTradingEntryGate({
                side: "buy",
                signalPriceNok: order.signalClose * fx,
                quotePriceNok: fillPrice * fx,
                requestedQuantity: quantity,
                riskConfig: risk,
                cashNok: cash * fx,
                positionQuantity: 0,
                positionCostNok: 0,
                ordersToday,
                realizedPnlTodayNok: realizedTodayUsd * fx,
                peakEquity,
                currentEquity: equityNow,
                entriesHaltedReason: null,
              })
            : ({ kind: "block", reason: "Nothing to buy with the cash available." } as const);
        if (verdict.kind === "block") {
          result.blockedCount += 1;
          if (result.blocked.length < MAX_LOGGED) result.blocked.push({ at: bar.openTime.toISOString(), side: "buy", reason: verdict.reason });
        } else {
          if (verdict.kind === "needs_approval") result.approvalAssumed += 1;
          const value = quantity * fillPrice;
          const fee = tradingFeeNok(value, costs.feeRatePct);
          cash -= value + fee;
          ordersToday += 1;
          position = {
            quantity,
            entryFill: fillPrice,
            entryAt: bar.openTime,
            entryIndex: i,
            entryFeeUsd: fee,
            stopPrice: order.stopPrice,
            targetPrice: order.targetPrice,
            highest: Math.max(fillPrice, order.highest),
            riskPerUnit: order.riskPerUnit,
            regime: input.regimeAt?.(order.signalIndex) ?? null,
          };
        }
      } else if (order.side === "sell" && position !== null) {
        const verdict = evaluateTradingExitGate({ requestedQuantity: position.quantity, positionQuantity: position.quantity, quotePriceNok: bar.open * sellFactor * fx });
        if (verdict.kind === "allow") closePosition(bar.open, bar.openTime, i, order.reason);
      }
    }

    const heldAtOpen = position !== null;

    // 2. Stops and fixed targets inside this bar, on 5-minute data when it is complete.
    if (position !== null) {
      const p: OpenPosition = position;
      let complete = false;
      let f0 = 0;
      if (fine) {
        f0 = lowerBound(fine, openMs);
        const last = fine[f0 + finePerBar - 1];
        complete = fine[f0]?.openTime.getTime() === openMs && last !== undefined && last.openTime.getTime() === openMs + (finePerBar - 1) * FIVE_MIN_MS;
      }
      if (complete) {
        result.intrabarBars += 1;
        const trailing = spec.exit.trailing;
        for (let f = f0; f < f0 + finePerBar && position !== null; f++) {
          const sub = fine![f]!;
          p.highest = Math.max(p.highest, sub.high);
          let stopLevel: number | null = null;
          let reason = "";
          if (p.stopPrice !== null && sub.low <= p.stopPrice) {
            stopLevel = Math.min(p.stopPrice, sub.open);
            reason = "stop_hit";
          }
          if (trailing && p.highest >= p.entryFill * (1 + trailing.activateAtPct / 100)) {
            const trailLevel = p.highest * (1 - trailing.distancePct / 100);
            if (sub.low <= trailLevel) {
              const level = Math.min(trailLevel, sub.open);
              if (stopLevel === null || level < stopLevel) {
                stopLevel = level;
                reason = "trailing_stop_hit";
              }
            }
          }
          const at = new Date(sub.openTime.getTime());
          if (stopLevel !== null) {
            result.signals.push({ at: at.toISOString(), action: "exit", source: "intrabar", reasonCodes: [reason] });
            closePosition(stopLevel, at, i, reason);
            break;
          }
          if (p.targetPrice !== null && sub.high >= p.targetPrice) {
            result.signals.push({ at: at.toISOString(), action: "exit", source: "intrabar", reasonCodes: ["target_hit"] });
            closePosition(p.targetPrice, at, i, "target_hit");
            break;
          }
        }
      }
    }

    // 3. Mark the account at this bar's close (before any forced close at the window's end).
    const lastBar = i === input.end - 1;
    const held = position !== null || heldAtOpen;
    let equity = cash + (position ? position.quantity * bar.close : 0);
    if (equity > peakEquity) peakEquity = equity;

    // 4. Decide on this bar's close; the order fills at the next open.
    const state: TradingPositionState = position
      ? { kind: "long", entryPrice: position.entryFill, entryAt: position.entryAt, stopPrice: position.stopPrice, targetPrice: position.targetPrice, highestPrice: Math.max(position.highest, bar.high) }
      : { kind: "flat", consecutiveLosses, barsSinceExit };
    const decision = decide(bars, i, state, joinContext(closeTime));
    if (position !== null) position.highest = Math.max(position.highest, decision.highestPrice ?? bar.high);
    if (decision.action === "enter" && position === null) {
      result.signals.push({ at: closeTime.toISOString(), action: "enter", source: "bar", reasonCodes: decision.reasonCodes });
      const stopPrice = decision.levels?.stopPrice ?? null;
      let riskPerUnit: number | null = null;
      if (spec.prediction.rUnit === "stop_distance") {
        if (stopPrice !== null) riskPerUnit = bar.close - stopPrice;
      } else {
        const atr = atrSeries(bars.slice(Math.max(0, i - 200), i + 1), 14);
        riskPerUnit = atr[atr.length - 1] ?? null;
      }
      pending = { side: "buy", sizeFraction: decision.sizeFractionOfCash ?? 0, stopPrice, targetPrice: decision.levels?.targetPrice ?? null, signalClose: bar.close, signalIndex: i, riskPerUnit, highest: decision.highestPrice ?? bar.high };
    } else if (decision.action === "exit" && position !== null) {
      result.signals.push({ at: closeTime.toISOString(), action: "exit", source: "bar", reasonCodes: decision.reasonCodes });
      pending = { side: "sell", reason: decision.reasonCodes[0] ?? "exit_rule" };
    }
    if (position === null && barsSinceExit !== null) barsSinceExit += 1;

    // 5. The window's last bar: close what is left, with costs.
    if (lastBar && position !== null) {
      pending = null;
      closePosition(bar.close, closeTime, i, "window_end");
      equity = cash;
    } else if (lastBar) {
      equity = cash;
    }
    result.equity.push(equity);
    result.inPosition.push(held);
  }
  return result;
}

// ─── Baselines ───────────────────────────────────────────────────────────────

/** Buy at the window's first open and sell at its last close, with the same costs. A fraction (0.05 = +5%). */
export function buyAndHoldReturn(bars: readonly TradingEngineBar[], start: number, end: number, costs: SimulationCosts): number | null {
  if (end - start < 1) return null;
  const buy = bars[start]!.open * (1 + costs.spreadPct / 200 + costs.slippagePct / 100);
  const sell = bars[end - 1]!.close * (1 - costs.spreadPct / 200 - costs.slippagePct / 100);
  const fee = costs.feeRatePct / 100;
  const quantity = 1 / (buy * (1 + fee));
  return quantity * sell * (1 - fee) - 1;
}

/**
 * Random entry with the same exposure: every real trade is replayed at a
 * random place in the same window with the same holding time and the same
 * costs. Returns, for each of `runs` random replays, the mean net return per
 * trade (null when the window cannot hold any of them). Seeded, so the same
 * run gives the same answer.
 */
export function randomEntryReplay(input: {
  bars: readonly TradingEngineBar[];
  start: number;
  end: number;
  heldBars: readonly number[];
  costs: SimulationCosts;
  runs: number;
  seed: number;
}): Array<{ sum: number; count: number }> {
  const { bars, start, end, heldBars, costs, runs } = input;
  const random = seededRandom(input.seed);
  const c = costs.spreadPct / 200 + costs.slippagePct / 100;
  const fee = costs.feeRatePct / 100;
  const out: Array<{ sum: number; count: number }> = [];
  for (let r = 0; r < runs; r++) {
    let sum = 0;
    let count = 0;
    for (const held of heldBars) {
      const span = end - 1 - held - start;
      if (span < 0) continue;
      const s = start + Math.floor(random() * (span + 1));
      const entry = bars[s]!.open * (1 + c);
      const exit = bars[s + held]!.open * (1 - c);
      sum += (exit * (1 - fee)) / (entry * (1 + fee)) - 1;
      count += 1;
    }
    out.push({ sum, count });
  }
  return out;
}

export const BACKTEST_DEFAULT_COSTS: SimulationCosts = {
  feeRatePct: TRADING_BACKTEST_COSTS.feeRatePct,
  spreadPct: TRADING_BACKTEST_COSTS.spreadPct,
  slippagePct: TRADING_BACKTEST_COSTS.slippagePct,
};
