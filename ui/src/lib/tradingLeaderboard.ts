import { findTradingTemplate, TRADING_ASSETS, TRADING_SELECTOR_RULES_V1, type TradingAsset } from "@paperclipai/shared";

/**
 * Leaderboard words and ranking. Pure functions over what the server already
 * stored (the latest monthly check and the shadow trades), so what is on the
 * screen is exactly what the API said. Nothing here invents a number.
 *
 * Wording rule: neutral on purpose. Never "ready", never "promising".
 */

export const LUCK_WARNING = "The best of many tests is often luck: look at the range, not just the top number.";
export const PAPER_ONLY_NOTE = "Paper only, not investment advice.";
export const RESULT_EXPLAINER = "A result of 1.0 means a trade made as much as the amount it risked. −1.0 means it lost all of it.";

const FAMILY_WORDS: Record<string, string> = {
  trend: "Follows a trend",
  breakout: "Trades a breakout",
  mean_reversion: "Bets on a return to normal",
  reversal: "Bets on a turn",
  control: "Yardstick",
};

export function familyWords(family: string): string {
  return FAMILY_WORDS[family] ?? "Other";
}

const WEATHER_WORDS: Record<string, string> = {
  up: "Going up",
  range: "Moving sideways",
  down: "Going down",
  squeeze: "Unusually quiet",
  high_volatility: "Big swings",
};

export function weatherWords(weather: string): string {
  return WEATHER_WORDS[weather] ?? weather;
}

/** Turns "pullback_trend" into "Pullback trend" for a style the library no longer lists. */
function humanizeKey(key: string): string {
  const text = key.replace(/_/g, " ").trim();
  return text.length === 0 ? key : text[0]!.toUpperCase() + text.slice(1);
}

export interface ParsedCellKey {
  templateKey: string;
  templateVersion: number;
  weather: string;
  asset: string;
}

/** A cell key is `template@version|weather|coin`. Returns null for anything else. */
export function parseCellKey(key: string): ParsedCellKey | null {
  const [head, weather, asset, ...rest] = key.split("|");
  if (!head || !weather || !asset || rest.length > 0) return null;
  const at = head.lastIndexOf("@");
  if (at <= 0) return null;
  const templateVersion = Number(head.slice(at + 1));
  if (!Number.isInteger(templateVersion)) return null;
  return { templateKey: head.slice(0, at), templateVersion, weather, asset };
}

export function templateName(templateKey: string): string {
  return findTradingTemplate(templateKey)?.spec.meta.name ?? humanizeKey(templateKey);
}

// ─── What the server sends ──────────────────────────────────────────────────

export interface CellEstimateView {
  trades: number;
  tested: boolean;
  rawMeanR: number | null;
  shrunkMeanR: number | null;
  bootstrapLow: number | null;
  bootstrapHigh: number | null;
  pValue: number;
}

export interface SelectorCellView {
  key: string;
  family: string;
  estimate: CellEstimateView;
  passedTest: boolean;
  action: string;
  note: string;
  windowTrades: number;
  windowMeanR: number | null;
}

export interface SelectorDecisionOutputView {
  checkpointAt?: string;
  trials: number;
  tested: number;
  discoveries: number;
  cells: SelectorCellView[];
  promoted: string[];
  choice: "cash" | "cells";
  reason: string;
}

export interface ShadowCellView {
  cellKey: string;
  family: string;
  templateKey: string;
  templateVersion: number;
  weather: string;
  asset: string;
  open: number;
  closed: number;
  voided: number;
  meanR1x: number | null;
  meanR2x: number | null;
}

export interface LeaderboardRow {
  key: string;
  name: string;
  family: string;
  familyWords: string;
  asset: string;
  weatherWords: string;
  /** Closed trades behind the estimate. */
  trades: number;
  tested: boolean;
  /** Typical result per trade, with the pull towards the family average already applied (the server's number). */
  typical: number | null;
  low: number | null;
  high: number | null;
  passedTest: boolean;
  holdsPaperCash: boolean;
  statusWords: string;
  /** How far along it is, in numbers ("12 of 30 trades"), or null when there is nothing to count. */
  progress: string | null;
  /** Live shadow figures, when the server has them. */
  shadow: { open: number; closed: number; voided: number; meanR1x: number | null; meanR2x: number | null } | null;
}

const ACTION_WORDS: Record<string, string> = {
  not_tested: "Not enough trades yet",
  failed_test: "Did not pass the test",
  passed_test_confirmation_started: "Passed the test, now in a fresh check",
  passed_test_confirmation_blocked: "Passed the test, on hold",
  confirmation_running: "In a fresh check",
  confirmation_expired: "Fresh check ran out of time",
  confirmation_failed: "Did not pass the fresh check",
  confirmed_promoted: "Passed the fresh check, holds paper cash",
  confirmed_deferred_after_drawdown: "Passed the fresh check, on hold after a safety stop",
  kept_promoted: "Still holds paper cash",
  confirmation_lapsed: "Fresh check lapsed",
  demoted: "No longer holds paper cash",
};

export function actionWords(action: string): string {
  return ACTION_WORDS[action] ?? "In progress";
}

const FRESH_CHECK_ACTIONS = new Set(["passed_test_confirmation_started", "confirmation_running", "confirmation_expired", "confirmation_failed", "confirmed_promoted", "kept_promoted"]);

function progressWords(cell: SelectorCellView): string | null {
  const { minTradesPerCell, confirmationTrades } = TRADING_SELECTOR_RULES_V1;
  if (!cell.estimate.tested) return `${cell.estimate.trades} of ${minTradesPerCell} trades needed before it can be tested`;
  if (FRESH_CHECK_ACTIONS.has(cell.action) && cell.action !== "kept_promoted") return `${cell.windowTrades} of ${confirmationTrades} trades in the fresh check`;
  return null;
}

/** One plain line about what the last monthly check decided. */
export function choiceWords(output: Pick<SelectorDecisionOutputView, "choice" | "promoted">): string {
  if (output.choice === "cash" || output.promoted.length === 0) return "The check kept everything in cash.";
  return output.promoted.length === 1 ? "The check let 1 strategy hold paper cash." : `The check let ${output.promoted.length} strategies hold paper cash.`;
}

export function buildLeaderboard(output: SelectorDecisionOutputView, shadow: readonly ShadowCellView[]): { ranked: LeaderboardRow[]; unranked: LeaderboardRow[] } {
  const shadowByKey = new Map(shadow.map((s) => [s.cellKey, s]));
  const promoted = new Set(output.promoted);
  const rows: LeaderboardRow[] = output.cells.map((cell) => {
    const parsed = parseCellKey(cell.key);
    const live = shadowByKey.get(cell.key);
    return {
      key: cell.key,
      name: parsed ? templateName(parsed.templateKey) : cell.key,
      family: cell.family,
      familyWords: familyWords(cell.family),
      asset: parsed?.asset ?? "",
      weatherWords: parsed ? weatherWords(parsed.weather) : "",
      trades: cell.estimate.trades,
      tested: cell.estimate.tested,
      typical: cell.estimate.shrunkMeanR,
      low: cell.estimate.bootstrapLow,
      high: cell.estimate.bootstrapHigh,
      passedTest: cell.passedTest,
      holdsPaperCash: promoted.has(cell.key),
      statusWords: actionWords(cell.action),
      progress: progressWords(cell),
      shadow: live ? { open: live.open, closed: live.closed, voided: live.voided, meanR1x: live.meanR1x, meanR2x: live.meanR2x } : null,
    };
  });
  // Only cells that have enough trades to be tested are ranked, and only by that evidence.
  // Ties keep the server's order (stable sort), so the list never reshuffles by itself.
  const ranked = rows.filter((r) => r.tested && r.typical !== null).sort((a, b) => (b.typical ?? 0) - (a.typical ?? 0));
  const unranked = rows.filter((r) => !(r.tested && r.typical !== null)).sort((a, b) => b.trades - a.trades);
  return { ranked, unranked };
}

/** "+0.12", "−0.20", "0.00". */
export function formatResult(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 100) / 100;
  if (rounded === 0) return "0.00";
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded).toFixed(2)}`;
}

export function formatRange(low: number | null, high: number | null): string {
  if (low === null || high === null) return "No range yet";
  return `${formatResult(low)} to ${formatResult(high)}`;
}

export function isTradingAsset(value: string): value is TradingAsset {
  return (TRADING_ASSETS as readonly string[]).includes(value);
}
