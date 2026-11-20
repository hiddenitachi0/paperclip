import type { TradingScoreboard, TradingScoreboardForecaster } from "../api/trading";

/**
 * Plain-language words for the prediction scoreboard (DUR-5012).
 *
 * The server decides everything: the sample counts, the running time, the
 * written pass/fail checks and the stored verdict. This file only turns what
 * the server sent into the sentences the operator reads. It never computes a
 * hit rate, a threshold or a verdict of its own, and while the server says
 * "collecting" it produces no result words at all.
 */

export const SCOREBOARD_DISCLAIMER =
  "Paper trading only. This is not investment advice and not a recommendation to use real money. Real money stays locked.";

export const VERDICT_WORDS = {
  noBetter: "No better than simple guesses",
  negativeAfterFees: "Better than guesses but negative after fees",
  passed: "Passed the checks so far: paper only, not a recommendation",
  /** Better than guesses and not losing after fees, yet at least one written check is not met or could not be judged. */
  betterButChecksOpen: "Better than guesses, but not every written check is met",
  /** The sample is complete but the server has not stored its one verdict yet. */
  beingWorkedOut: "Enough predictions are in. The result is being worked out.",
} as const;

export type ScoreboardHeadlineKind = "collecting" | "being_worked_out" | "no_better" | "negative_after_fees" | "passed" | "better_but_checks_open";

export interface ScoreboardHeadline {
  kind: ScoreboardHeadlineKind;
  text: string;
  /** One short sentence under the headline. */
  detail: string;
}

export function collectingWords(samples: number, target: number): string {
  return `Collecting: ${samples} of ${target}, no verdict yet`;
}

/** The one headline for the page. Before the fixed sample is reached it can only ever be "Collecting". */
export function scoreboardHeadline(board: TradingScoreboard): ScoreboardHeadline {
  const status = board.status;
  if (status.status !== "ready") {
    return {
      kind: "collecting",
      text: collectingWords(status.samples, status.targetSamples),
      detail: "No verdict is shown until both the number of predictions and the running time are reached. Early numbers are not a result.",
    };
  }
  const verdict = board.verdict;
  if (!verdict) {
    return { kind: "being_worked_out", text: VERDICT_WORDS.beingWorkedOut, detail: "The verdict is worked out once and then kept. Check back shortly." };
  }
  if (verdict.result === "no_edge") {
    return { kind: "no_better", text: VERDICT_WORDS.noBetter, detail: "The hit rate is not clearly above what plain guessing from the recent past would give. This is a normal, useful result." };
  }
  if (board.criteria?.state === "criteria_met") {
    return { kind: "passed", text: VERDICT_WORDS.passed, detail: "Every written check is met on this sample. That does not predict future results." };
  }
  const tradeCheck = board.criteria?.items.find((item) => item.key === "trade_results");
  const losingAfterFees = tradeCheck?.state === "not_met" || (board.trades ? board.trades.netPnlUsd <= 0 : false);
  if (losingAfterFees) {
    return { kind: "negative_after_fees", text: VERDICT_WORDS.negativeAfterFees, detail: "The calls beat plain guessing, but the trades do not make money once fees are paid." };
  }
  return { kind: "better_but_checks_open", text: VERDICT_WORDS.betterButChecksOpen, detail: "See the written checks for which one is open." };
}

const FORECASTER_WORDS: Record<string, { name: string; short: string }> = {
  rule: { name: "The strategy's rules", short: "The rules" },
  "baseline:always_up": { name: "Always guess up", short: "Always up" },
  "baseline:persistence": { name: "Repeat the last move", short: "Repeat last move" },
  "baseline:coin_flip": { name: "Coin flip", short: "Coin flip" },
};

export function forecasterName(key: string): string {
  return FORECASTER_WORDS[key]?.name ?? "Another forecaster";
}

export function forecasterShortName(key: string): string {
  return FORECASTER_WORDS[key]?.short ?? "Another forecaster";
}

export function isRuleForecaster(key: string): boolean {
  return key === "rule";
}

/** The rules first, then the simple guesses in a fixed order, so the colours and rows never jump around. */
export function orderForecasters(list: readonly TradingScoreboardForecaster[]): TradingScoreboardForecaster[] {
  const order = Object.keys(FORECASTER_WORDS);
  const rank = (key: string) => {
    const i = order.indexOf(key);
    return i === -1 ? order.length : i;
  };
  return [...list].sort((a, b) => rank(a.forecasterKey) - rank(b.forecasterKey) || a.forecasterKey.localeCompare(b.forecasterKey));
}

const WEATHER_WORDS: Record<string, string> = {
  uptrend: "Going up",
  downtrend: "Going down",
  ranging: "Moving sideways",
  unlabelled: "Not labelled yet",
};

export function weatherLabel(regime: string): string {
  return WEATHER_WORDS[regime] ?? regime;
}

export function percent(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

/** "54.2% (between 50.1% and 58.3%)". */
export function percentWithRange(value: number | null, lower: number | null | undefined, upper: number | null | undefined): string {
  if (value === null) return "—";
  if (lower === null || lower === undefined || upper === null || upper === undefined) return percent(value);
  return `${percent(value)} (between ${percent(lower)} and ${percent(upper)})`;
}

export function days(ms: number): string {
  const d = ms / 86_400_000;
  return `${d >= 10 ? Math.round(d) : Math.round(d * 10) / 10} days`;
}

export function usd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function wholeNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** Few separate stretches of one kind of weather say very little, however many calls fall in them. */
export const FEW_SPELLS = 3;

export function spellsWords(spells: number): string {
  return `${spells} ${spells === 1 ? "stretch" : "stretches"}`;
}
