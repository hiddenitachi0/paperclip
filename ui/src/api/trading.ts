import type {
  CreateTradingStrategyInput,
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
  createdAt: string;
}

export const tradingApi = {
  list: (companyId: string) => api.get<TradingStrategySummary[]>(`/companies/${companyId}/trading/strategies`),
  create: (companyId: string, input: Partial<CreateTradingStrategyInput>) =>
    api.post<TradingStrategySummary>(`/companies/${companyId}/trading/strategies`, input),
  setStatus: (companyId: string, strategyId: string, status: "running" | "paused") =>
    api.post<TradingStrategySummary>(`/companies/${companyId}/trading/strategies/${strategyId}/status`, { status }),
  dashboard: (companyId: string, strategyId: string) =>
    api.get<TradingDashboardSummary>(`/companies/${companyId}/trading/strategies/${strategyId}/dashboard`),
  orders: (companyId: string, strategyId: string) =>
    api.get<TradingOrderSummary[]>(`/companies/${companyId}/trading/strategies/${strategyId}/orders`),
};
