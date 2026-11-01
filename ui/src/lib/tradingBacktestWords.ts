import type { TradingBacktestGateItem, TradingBacktestRun, TradingStartGate } from "../api/trading";

/**
 * The past-data test report, in plain words.
 *
 * The server stores a big report (numbers per coin, per test period, per
 * market state). This file reads it defensively -- every number may be
 * missing -- and turns it into the sentences and rows the page shows. Nothing
 * here decides whether a strategy passed: the server's checklist does. These
 * functions only choose words.
 */

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// ─── Number words ────────────────────────────────────────────────────────────

export function percentWords(fraction: number | null, digits = 0): string {
  if (fraction === null) return "not known";
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** A signed percent such as "+0.21%" or "-14%". Takes a value already in percent (0.21 means 0.21%). */
export function signedPercent(percent: number | null, digits = 2): string {
  if (percent === null) return "not known";
  const rounded = Number(percent.toFixed(digits));
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

export const MARKET_STATE_WORDS = { bull: "a rising market", bear: "a falling market", range: "a sideways market" } as const;
type MarketState = keyof typeof MARKET_STATE_WORDS;
const MARKET_STATES: readonly MarketState[] = ["bull", "bear", "range"];

// ─── Reading the report ──────────────────────────────────────────────────────

export interface TradeNumbers {
  trades: number;
  /** Share that won, 0..1. */
  hitRate: number | null;
  /** Average win divided by the size of the average loss. */
  winToLoss: number | null;
  /** Average result per trade after fees, in percent. */
  perTradePercent: number | null;
}

function tradeNumbers(metrics: unknown): TradeNumbers | null {
  const m = obj(metrics);
  if (!m) return null;
  const trades = num(m.trades) ?? 0;
  const avgWin = num(m.avgWinPct);
  const avgLoss = num(m.avgLossPct);
  const mean = num(m.meanTradeReturn);
  return {
    trades,
    hitRate: num(m.hitRate),
    winToLoss: avgWin !== null && avgLoss !== null && avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : null,
    perTradePercent: mean === null ? null : mean * 100,
  };
}

export interface WindowResult {
  index: number;
  testStart: string;
  testEnd: string;
  trades: number;
  /** Average result per trade at double fees, in percent; null when the period had no trades. */
  perTradePercent: number | null;
  /** Worst drop inside the period, in percent (positive number). */
  worstDropPercent: number | null;
}

export interface CoinReport {
  coin: string;
  headline: boolean;
  flag: string | null;
  doubleFees: TradeNumbers | null;
  normalFees: TradeNumbers | null;
  windows: WindowResult[];
  /** Market states this coin's test periods never covered (at least 30 days each are needed). */
  missingStates: MarketState[];
  minDays: number | null;
  random: { runs: number; typicalPercent: number | null; topFivePercent: number | null; beatShare: number | null } | null;
}

export interface HoldoutWords {
  read: boolean;
  seenCount: number | null;
  fresh: boolean;
  trades: number | null;
  positive: boolean | null;
  label: string | null;
}

export interface ReadReport {
  headline: {
    coins: string[];
    doubleFees: TradeNumbers | null;
    windowsTotal: number | null;
    windowsPositive: number | null;
    worstDropPercent: number | null;
    dropLimitPercent: number | null;
    beatRandomShare: number | null;
  };
  coins: CoinReport[];
  holdout: HoldoutWords;
  variantsInRun: number | null;
  variantsInHistory: number | null;
  plateau: { applicable: boolean; neighbours: number; positive: number } | null;
  skippedCoins: string[];
  asOf: string | null;
  timeframe: string | null;
  items: TradingBacktestGateItem[];
  summary: string | null;
  passed: boolean | null;
}

/** Reads a stored run. Returns null when the run has no report (still waiting, failed or withdrawn). */
export function readReport(run: Pick<TradingBacktestRun, "report" | "gate" | "gatePassed">): ReadReport | null {
  const r = obj(run.report);
  if (!r) return null;
  const headline = obj(r.headline) ?? {};
  const hOos = obj(headline.outOfSample);
  const hWindows = obj(headline.windows);
  const holdout = obj(r.holdout) ?? {};
  const trials = obj(r.trials) ?? {};
  const plateau = obj(trials.plateau);
  const gate = obj(run.gate) ?? obj(r.gate) ?? {};

  const coins: CoinReport[] = arr(r.coins).flatMap((raw) => {
    const c = obj(raw);
    const coin = c ? str(c.coin) : null;
    if (!c || !coin) return [];
    const oos = obj(c.outOfSample);
    const coverage = obj(c.regimeCoverage);
    const baselines = obj(c.baselines);
    const randomEntry = obj(baselines?.randomEntry);
    const missing = arr(coverage?.missing).filter((m): m is MarketState => MARKET_STATES.includes(m as MarketState));
    return [
      {
        coin,
        headline: c.headline === true,
        flag: str(c.flag),
        doubleFees: tradeNumbers(obj(oos)?.fees2x),
        normalFees: tradeNumbers(obj(oos)?.fees1x),
        windows: arr(c.windows).flatMap((rawWindow) => {
          const w = obj(rawWindow);
          if (!w) return [];
          const m = obj(w.fees2x);
          const trades = num(m?.trades) ?? 0;
          const mean = num(m?.meanTradeReturn);
          return [
            {
              index: num(w.index) ?? 0,
              testStart: str(w.testStart) ?? "",
              testEnd: str(w.testEnd) ?? "",
              trades,
              perTradePercent: trades > 0 && mean !== null ? mean * 100 : null,
              worstDropPercent: num(m?.maxDrawdownPct),
            },
          ];
        }),
        missingStates: missing,
        minDays: num(coverage?.minDays),
        random: randomEntry
          ? {
              runs: num(randomEntry.runs) ?? 0,
              typicalPercent: num(randomEntry.meanTradeReturnMedian) === null ? null : num(randomEntry.meanTradeReturnMedian)! * 100,
              topFivePercent: num(randomEntry.meanTradeReturnP95) === null ? null : num(randomEntry.meanTradeReturnP95)! * 100,
              beatShare: num(randomEntry.beatShare),
            }
          : null,
      },
    ];
  });

  const items: TradingBacktestGateItem[] = arr(gate.items).flatMap((raw) => {
    const item = obj(raw);
    const key = item ? str(item.key) : null;
    if (!item || !key) return [];
    return [{ key, label: str(item.label) ?? key, passed: typeof item.passed === "boolean" ? item.passed : null, detail: str(item.detail) ?? "" }];
  });

  return {
    headline: {
      coins: arr(headline.coins).filter((c): c is string => typeof c === "string"),
      doubleFees: tradeNumbers(hOos?.fees2x),
      windowsTotal: num(hWindows?.total),
      windowsPositive: num(hWindows?.positive),
      worstDropPercent: num(headline.worstWindowDrawdownPct),
      dropLimitPercent: num(headline.drawdownCapPct),
      beatRandomShare: num(headline.beatRandomShare),
    },
    coins,
    holdout: {
      read: holdout.read === true,
      seenCount: num(holdout.seenCount),
      fresh: holdout.fresh === true,
      trades: num(obj(obj(holdout.headline)?.fees2x)?.trades),
      positive: typeof obj(holdout.headline)?.positive === "boolean" ? (obj(holdout.headline)!.positive as boolean) : null,
      label: str(holdout.label),
    },
    variantsInRun: num(trials.variantsInThisRun),
    variantsInHistory: num(trials.variantsInRegistry),
    plateau: plateau ? { applicable: plateau.applicable === true, neighbours: arr(plateau.neighbours).length, positive: arr(plateau.neighbours).filter((n) => obj(n)?.positive === true).length } : null,
    skippedCoins: arr(r.skippedCoins).flatMap((c) => (typeof c === "string" ? [c] : str(obj(c)?.coin) ? [str(obj(c)!.coin)!] : [])),
    asOf: str(r.asOf),
    timeframe: str(r.timeframe),
    items,
    summary: str(gate.summary),
    passed: typeof gate.passed === "boolean" ? gate.passed : run.gatePassed,
  };
}

// ─── The headline sentence ───────────────────────────────────────────────────

/**
 * "In periods it had not seen: 312 trades, 54% won, average win 1.6 times the
 * average loss, +0.21% per trade after double fees, beat random entries in 95%
 * of 300 tries, 9 of 12 test periods made money, worst drop -14%."
 */
export function headlineSentence(report: ReadReport): string {
  const h = report.headline;
  const t = h.doubleFees;
  if (!t) return "This test did not produce a result for the main coins.";
  const parts: string[] = [`${t.trades} ${t.trades === 1 ? "trade" : "trades"}`];
  if (t.hitRate !== null) parts.push(`${percentWords(t.hitRate)} won`);
  if (t.winToLoss !== null) parts.push(`the average win was ${t.winToLoss.toFixed(1)} times the average loss`);
  if (t.perTradePercent !== null) parts.push(`${signedPercent(t.perTradePercent)} per trade after double fees`);
  if (h.beatRandomShare !== null) parts.push(`did better than random entries in ${percentWords(h.beatRandomShare)} of tries`);
  if (h.windowsTotal !== null && h.windowsPositive !== null) parts.push(`${h.windowsPositive} of ${h.windowsTotal} test periods made money`);
  if (h.worstDropPercent !== null) parts.push(`worst drop ${signedPercent(-h.worstDropPercent, 0)}`);
  return `In periods it had not seen: ${parts.join(", ")}.`;
}

// ─── The checklist, in plain words ───────────────────────────────────────────

const PLAIN_LABELS: Record<string, string> = {
  gate_run: "A full test on the real price source",
  headline_coins: "Judged on the two big coins (BTC and ETH)",
  expectancy: "Makes money per trade, even with double fees",
  trades: "Enough trades to mean something",
  windows: "Made money in most test periods",
  random_entry: "Beats random guessing",
  drawdown: "Never dropped more than its own limit",
  plateau: "Still works when its numbers are nudged a little",
  regimes: "Tested in rising, falling and sideways markets",
  look_ahead: "Does not peek into the future",
  point_in_time: "Only used information that existed at the time",
  holdout: "Confirmed on a stretch kept hidden until the end",
  selection: "The rules were tested exactly as written",
};

export function plainGateLabel(item: TradingBacktestGateItem): string {
  return PLAIN_LABELS[item.key] ?? item.label;
}

/** A plain-language line for one checklist row. Falls back to the server's own sentence when a number is missing. */
export function plainGateDetail(item: TradingBacktestGateItem, report: ReadReport, gateRules: { minTrades: number; minWindowShare: number; randomQuantile: number; plateauShare: number } = { minTrades: 100, minWindowShare: 0.6, randomQuantile: 0.95, plateauShare: 0.75 }): string {
  const h = report.headline;
  const t = h.doubleFees;
  switch (item.key) {
    case "expectancy":
      if (t?.perTradePercent != null) return `Average result per trade after double fees: ${signedPercent(t.perTradePercent)}. It has to be above zero.`;
      break;
    case "trades":
      if (t) return `${t.trades} trades in periods it had not seen. It needs at least ${gateRules.minTrades}.`;
      break;
    case "windows":
      if (h.windowsTotal !== null && h.windowsPositive !== null) {
        return h.windowsTotal === 0
          ? "There was not enough history for even one test period."
          : `${h.windowsPositive} of ${h.windowsTotal} test periods ended in profit. It needs at least ${percentWords(gateRules.minWindowShare)}. A period with no trades does not count.`;
      }
      break;
    case "random_entry":
      if (h.beatRandomShare !== null) return `It did better than ${percentWords(h.beatRandomShare)} of the random tries. It needs to beat ${percentWords(gateRules.randomQuantile)}.`;
      break;
    case "drawdown":
      if (h.worstDropPercent !== null && h.dropLimitPercent !== null) return `Worst drop in a test period: ${signedPercent(-h.worstDropPercent, 1)}. Its own limit is ${signedPercent(-h.dropLimitPercent, 1)}.`;
      break;
    case "plateau":
      if (report.plateau?.applicable) return `${report.plateau.positive} of ${report.plateau.neighbours} slightly changed versions of the rules also made money. It needs at least ${percentWords(gateRules.plateauShare)}.`;
      if (report.plateau && !report.plateau.applicable) return "The rules have no number to nudge, so there was nothing to check.";
      break;
    case "regimes": {
      const lines = report.coins.filter((c) => c.headline && c.missingStates.length > 0).map(coverageLine);
      if (lines.length > 0) return lines.join(" ");
      if (report.coins.some((c) => c.headline)) return "Both big coins were tested in rising, falling and sideways markets.";
      break;
    }
    case "look_ahead":
      return item.passed ? "The rules gave the same signals when the latest prices were hidden, so they do not peek into the future." : item.passed === false ? "The rules gave different signals once the latest prices were hidden, so they look into the future." : "This check did not run.";
    case "point_in_time":
      return item.passed ? "Every piece of outside information was already known at the moment of each decision." : item.passed === false ? "Some information was used before it was available." : "This check did not run.";
    case "holdout":
      return holdoutSentence(report.holdout);
    default:
      break;
  }
  return item.detail;
}

/** "BTC was never tested in a rising market." */
export function coverageLine(coin: CoinReport): string {
  if (coin.missingStates.length === 0) return `${coin.coin} was tested in rising, falling and sideways markets.`;
  return `${coin.coin} was never tested in ${coin.missingStates.map((m) => MARKET_STATE_WORDS[m]).join(" or ")}.`;
}

// ─── The hidden final stretch ────────────────────────────────────────────────

export function holdoutSentence(h: HoldoutWords): string {
  if (!h.read) return "The hidden final stretch was not looked at.";
  if (h.seenCount !== null && h.seenCount > 0) {
    return `This hidden stretch of the past has already been looked at ${h.seenCount} ${h.seenCount === 1 ? "time" : "times"}, so it is no longer a fair, fresh test. Waiting for new live paper results is the only way to confirm it now.`;
  }
  const where = h.fresh ? "A newer stretch that nothing had looked at before" : "The last 12 months, kept hidden until the very end";
  if (h.positive === true) return `${where}: it made money, even with double fees, over ${h.trades ?? 0} trades.`;
  return `${where}: it did not make money with double fees (${h.trades ?? 0} trades).`;
}

export function triedWords(variants: number): string {
  return `${variants} ${variants === 1 ? "version" : "versions"} of the rules ${variants === 1 ? "has" : "have"} been tried on this past data`;
}

export function lookedAtWords(count: number): string {
  if (count === 0) return "Nobody has looked at the hidden final stretch yet";
  return `The hidden final stretch has been looked at ${count} ${count === 1 ? "time" : "times"}`;
}

// ─── Start state ─────────────────────────────────────────────────────────────

export const PAPER_ONLY_LABEL = "Passed the past-data checks: paper only, not a recommendation";

export interface StartStateWords {
  tone: "good" | "neutral" | "blocked";
  title: string;
  detail: string | null;
}

/** What the strategy's Start state is, in words, read from the server's start-gate answer. */
export function startStateWords(gate: TradingStartGate): StartStateWords {
  switch (gate.basis) {
    case "passed":
      return { tone: "good", title: PAPER_ONLY_LABEL, detail: "It does not mean the strategy will make money later. Nothing here uses real money." };
    case "override": {
      const reason = gate.overrides.find((o) => o.versionId === gate.versionId)?.reason ?? gate.overrides[0]?.reason ?? null;
      return { tone: "neutral", title: "Allowed to start by the owner's choice, without a passed past-data test", detail: reason ? `The owner's reason: "${reason}"` : null };
    }
    case "inherited":
      return { tone: "neutral", title: "Allowed to start: the only change from the version before was safer limits", detail: "The earlier version had already been cleared." };
    case "grandfathered":
      return { tone: "neutral", title: "Allowed to start: this strategy was set up before past-data tests existed", detail: "You can still run a past-data test on it any time." };
    default:
      return { tone: "blocked", title: "Not allowed to start yet: these rules have not passed a past-data test", detail: null };
  }
}

/** The server's refusal to start because of the check, if that is what an error is. */
export function startGateRefusal(error: unknown): { reason: string } | null {
  if (!(error instanceof Error)) return null;
  const body = (error as { body?: unknown }).body;
  const details = obj(obj(body)?.details);
  const code = str(details?.code) ?? str(obj(body)?.code);
  if (code === "trading_start_gate_not_passed") return { reason: error.message };
  return null;
}
