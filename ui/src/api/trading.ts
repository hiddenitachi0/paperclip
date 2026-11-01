import type {
  CreateTradingStrategyInput,
  TradingRuleBookInput,
  UpdateTradingStrategyInput,
  TradingAsset,
  TradingDashboardSummary,
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

export const tradingApi = {
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
  setStatus: (companyId: string, strategyId: string, status: "running" | "paused") =>
    api.post<TradingStrategySummary>(`/companies/${companyId}/trading/strategies/${strategyId}/status`, { status }),
  dashboard: (companyId: string, strategyId: string) =>
    api.get<TradingDashboardSummary>(`/companies/${companyId}/trading/strategies/${strategyId}/dashboard`),
  orders: (companyId: string, strategyId: string) =>
    api.get<TradingOrderSummary[]>(`/companies/${companyId}/trading/strategies/${strategyId}/orders`),
};
