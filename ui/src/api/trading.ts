import type {
  CreateTradingStrategyInput,
  TradingRegimeFlipCounts,
  TradingRegimeSpell,
  TradingRegimeTrend,
  TradingRegimeVolatility,
  TradingRuleBookInput,
  UpdateTradingStrategyInput,
  TradingAsset,
  TradingDashboardSummary,
  TradingForwardCriteriaResult,
  TradingOrderSide,
  TradingOrderStatus,
  TradingPauseReason,
  TradingRiskConfig,
  TradingRuleConfig,
  TradingStrategyStatus,
} from "@paperclipai/shared";
import { api } from "./client";

// Trading agent (DUR-4153/DUR-4171/DUR-4227): paper-trading strategies. The
// server only ever returns the raw `trading_strategies`/`trading_orders` row
// shape (see server/src/services/trading.ts) -- these interfaces mirror that
// row, not a bespoke DTO.

export interface TradingStrategySummary {
  id: string;
  companyId: string;
  name: string;
  asset: TradingAsset;
  mode: "paper";
  status: TradingStrategyStatus;
  pauseReason: TradingPauseReason | null;
  checkEveryMinutes: number;
  nextCheckAt: string;
  consecutiveErrors: number;
  lastTickAt: string | null;
  lastTickError: string | null;
  ruleConfig: TradingRuleConfig;
  riskConfig: TradingRiskConfig;
  startingCashNok: number;
  startingQuoteNok: number | null;
  cashNok: number;
  positionQuantity: number;
  positionCostNok: number;
  peakEquityNok: number;
  createdAt: string;
  updatedAt: string;
}

export interface TradingOrderSummary {
  id: string;
  side: TradingOrderSide;
  status: TradingOrderStatus;
  ruleVersion: string;
  signalPriceNok: number;
  requestedQuantity: number;
  filledQuantity: number | null;
  filledPriceNok: number | null;
  feeNok: number | null;
  realizedPnlNok: number | null;
  rejectionReason: string | null;
  approvalId: string | null;
  approvalExpiresAt: string | null;
  /** The version of the rules that placed this order (null on orders from before versions existed). */
  strategyVersionId: string | null;
  createdAt: string;
}

export type TradingVersionStatus = "draft" | "approved" | "superseded";

/** One saved version of a strategy's rules (the server's version row). `spec` is validated again in the UI before use. */
export interface TradingVersionSummary {
  id: string;
  strategyId: string;
  version: number;
  spec: unknown;
  guidelines: string;
  status: TradingVersionStatus;
  proposedByType: "user" | "agent" | "system";
  proposedById: string;
  approvedAt: string | null;
  supersededAt: string | null;
  approvalId: string | null;
  createdAt: string;
}

/** What saving rules answers: a draft and its card, never a live change. */
export type ProposeVersionResult =
  | { outcome: "drafted"; version: TradingVersionSummary; approvalId: string }
  | { outcome: "already_pending"; version: TradingVersionSummary; approvalId: string | null }
  | { outcome: "unchanged"; version: TradingVersionSummary };

/** A strategy row, plus the draft that a rule change filed (the rules themselves did not change). */
export type TradingStrategyUpdateResult = TradingStrategySummary & {
  pendingVersion?: { outcome: "drafted" | "already_pending"; versionId: string; versionNumber: number; approvalId: string | null };
};

export type TradingBacktestStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** Where the strategy's current rules stand against the start check (the server decides; the page only shows it). */
export interface TradingStartGate {
  cleared: boolean;
  basis: "grandfathered" | "passed" | "override" | "inherited" | null;
  versionId: string;
  versionNumber: number;
  latestRun: { id: string; status: TradingBacktestStatus; gatePassed: boolean | null; summary: string | null; finishedAt: string | null } | null;
  queuedRunId: string | null;
  overrides: Array<{ versionId: string; reason: string; overriddenByUserId: string; createdAt: string }>;
  /** How many different versions of the rules were ever tried against the past data. */
  variantsTried: number;
  /** How many times the hidden final stretch has been looked at. */
  holdoutReads: number;
}

/** One line of the server's checklist. `passed: null` means it could not be judged. */
export interface TradingBacktestGateItem {
  key: string;
  label: string;
  passed: boolean | null;
  detail: string;
}

export interface TradingBacktestRunListItem {
  id: string;
  versionId: string;
  purpose: "explore" | "gate";
  status: TradingBacktestStatus;
  gatePassed: boolean | null;
  gate: { passed: boolean | null; summary: string | null } | null;
  variantsTried: number | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** The full stored run. `report` and `gate` are read defensively by `lib/tradingBacktestWords`. */
export interface TradingBacktestRun {
  id: string;
  strategyId: string;
  versionId: string;
  purpose: "explore" | "gate";
  status: TradingBacktestStatus;
  gatePassed: boolean | null;
  gate: { passed?: boolean; summary?: string; items?: TradingBacktestGateItem[] } | null;
  report: unknown;
  variantsTried: number | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** One coin's current market weather (the server's ready-to-show line plus the parts behind it). */
export interface MarketWeatherItem {
  asset: TradingAsset;
  name: string;
  /** Ready to show, e.g. "Bitcoin: uptrend, normal swings, since 12 Oct". */
  text: string;
  trend: TradingRegimeTrend;
  volatility: TradingRegimeVolatility;
  squeeze: boolean;
  spellNo: number;
  spellStartDay: string;
  day: string;
  availableAt: string;
  source: string;
}

export interface MarketWeatherHistory {
  asset: TradingAsset;
  name: string;
  current: MarketWeatherItem | null;
  /** Newest first, capped by the `spells` option. `flips.spells` is the true total. */
  spells: TradingRegimeSpell[];
  flips: TradingRegimeFlipCounts;
  firstDay: string | null;
}

export const tradingApi = {
  marketWeather: (companyId: string) =>
    api.get<{ items: MarketWeatherItem[] }>(`/companies/${companyId}/trading/market-weather`),
  marketWeatherHistory: (companyId: string, asset: TradingAsset, spells = 5) =>
    api.get<MarketWeatherHistory>(`/companies/${companyId}/trading/market-weather/${asset}?spells=${spells}`),
  list: (companyId: string) => api.get<TradingStrategySummary[]>(`/companies/${companyId}/trading/strategies`),
  create: (companyId: string, input: Partial<CreateTradingStrategyInput>) =>
    api.post<TradingStrategySummary>(`/companies/${companyId}/trading/strategies`, input),
  /**
   * Changes a strategy. Renaming and the check interval apply at once; a
   * change to the old-style rule or risk numbers files a draft and its card
   * instead (the answer then carries `pendingVersion`). The full editor saves
   * through `proposeVersion`, because this call cannot carry a whole rule book.
   */
  update: (companyId: string, strategyId: string, input: UpdateTradingStrategyInput) =>
    api.patch<TradingStrategyUpdateResult>(`/companies/${companyId}/trading/strategies/${strategyId}`, input),
  versions: (companyId: string, strategyId: string) =>
    api.get<TradingVersionSummary[]>(`/companies/${companyId}/trading/strategies/${strategyId}/versions`),
  /** Files the rules as a draft version and an approval card. Nothing changes for a running strategy until the card is approved. */
  proposeVersion: (companyId: string, strategyId: string, book: TradingRuleBookInput) =>
    api.post<ProposeVersionResult>(`/companies/${companyId}/trading/strategies/${strategyId}/versions`, book),
  /** `overrideReason` is the owner's written reason for starting without a passed past-data test; the server checks who may use it. */
  setStatus: (companyId: string, strategyId: string, status: "running" | "paused", overrideReason?: string) =>
    api.post<TradingStrategySummary>(`/companies/${companyId}/trading/strategies/${strategyId}/status`, overrideReason ? { status, overrideReason } : { status }),
  /** The prediction scoreboard. `criteria` is the forward paper test judged against the written pass/fail criteria (absent when the strategy has no approved version). */
  scoreboard: (companyId: string, strategyId: string) =>
    api.get<{ strategyId: string; version: number | null; criteria?: TradingForwardCriteriaResult }>(`/companies/${companyId}/trading/strategies/${strategyId}/scoreboard`),
  startGate: (companyId: string, strategyId: string) =>
    api.get<TradingStartGate>(`/companies/${companyId}/trading/strategies/${strategyId}/start-gate`),
  backtests: (companyId: string, strategyId: string) =>
    api.get<TradingBacktestRunListItem[]>(`/companies/${companyId}/trading/strategies/${strategyId}/backtests`),
  backtest: (companyId: string, strategyId: string, runId: string) =>
    api.get<TradingBacktestRun>(`/companies/${companyId}/trading/strategies/${strategyId}/backtests/${runId}`),
  /** Files a past-data test for the strategy's current rules. It runs later on the server; this only queues it. */
  queueBacktest: (companyId: string, strategyId: string) =>
    api.post<{ id: string; status: TradingBacktestStatus }>(`/companies/${companyId}/trading/strategies/${strategyId}/backtests`, {}),
  cancelBacktest: (companyId: string, strategyId: string, runId: string) =>
    api.post<TradingBacktestRun>(`/companies/${companyId}/trading/strategies/${strategyId}/backtests/${runId}/cancel`, {}),
  dashboard: (companyId: string, strategyId: string) =>
    api.get<TradingDashboardSummary>(`/companies/${companyId}/trading/strategies/${strategyId}/dashboard`),
  orders: (companyId: string, strategyId: string) =>
    api.get<TradingOrderSummary[]>(`/companies/${companyId}/trading/strategies/${strategyId}/orders`),
};
