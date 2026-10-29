import {
  createTradingStrategySchema,
  tradingRiskConfigSchema,
  tradingRuleConfigSchema,
  updateTradingStrategySchema,
  type CreateTradingStrategyInput,
  type UpdateTradingStrategyInput,
} from "./trading.js";
import { strategyDocumentSchema, type StrategyDocument } from "./trading-strategy-spec.js";

/**
 * DUR-5002: the stored, versioned rule book. See packages/db/src/schema/trading.ts
 * (trading_strategy_versions) and server/src/services/trading-strategy-versions.ts.
 */

export const TRADING_STRATEGY_VERSION_STATUSES = ["draft", "approved", "superseded"] as const;
export type TradingStrategyVersionStatus = (typeof TRADING_STRATEGY_VERSION_STATUSES)[number];

/** "system" is only the automatic conversion of a pre-existing sma_crossover@1 strategy. */
export const TRADING_STRATEGY_VERSION_PROPOSER_TYPES = ["user", "agent", "system"] as const;
export type TradingStrategyVersionProposerType = (typeof TRADING_STRATEGY_VERSION_PROPOSER_TYPES)[number];

/**
 * The approval card kind for a proposed version. Card-only, like
 * crypto_wallet_tx and report_script_version: it is filed only by the
 * strategy-version service from the stored draft, and decided only on the card
 * itself by an owner or admin.
 */
export const TRADING_STRATEGY_VERSION_APPROVAL_KIND = "trading_strategy_version";

/** PATCH: name and check interval are direct edits; ruleConfig / riskConfig / document become a draft plus a card. */
export const updateTradingStrategyRequestSchema = updateTradingStrategySchema.extend({ document: strategyDocumentSchema.optional() }).strict();
export type UpdateTradingStrategyRequest = UpdateTradingStrategyInput & { document?: StrategyDocument };

/**
 * Create: the legacy SMA fields (defaults applied by the service), or a full v2
 * document instead; giving both is refused. ruleConfig / riskConfig carry no
 * schema default here precisely so "not both" can be checked.
 */
export const createTradingStrategyRequestSchema = createTradingStrategySchema
  .extend({ ruleConfig: tradingRuleConfigSchema.optional(), riskConfig: tradingRiskConfigSchema.optional(), document: strategyDocumentSchema.optional() })
  .strict()
  .refine((v) => !(v.document && (v.ruleConfig || v.riskConfig)), { message: "Send either a document or ruleConfig / riskConfig, not both.", path: ["document"] });
export type CreateTradingStrategyRequest = Omit<CreateTradingStrategyInput, "ruleConfig" | "riskConfig"> & {
  ruleConfig?: CreateTradingStrategyInput["ruleConfig"];
  riskConfig?: CreateTradingStrategyInput["riskConfig"];
  document?: StrategyDocument;
};
