import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companyCryptoSettings, tradingStrategies, tradingStrategyVersions } from "@paperclipai/db";
import {
  TRADING_TRADER_PROPOSALS_PER_STRATEGY_PER_DAY,
  describeTradingSpec,
  traderProposeChangeSchema,
  type AskTraderInput,
  type TradingStrategySpec,
} from "@paperclipai/shared";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { issueService } from "./issues.js";
import { tradingLedgerService } from "./trading-ledger.js";
import { tradingVersionsService, type ProposeVersionResult } from "./trading-versions.js";

/**
 * DUR-5004: what the Trader agent may do with trading, and nothing else.
 *
 * The Trader is the agent named in company_crypto_settings.trader_agent_id
 * (DUR-5026): one designation, owner-only, and that agent can own no wallet
 * (enforced both ways in the wallet service). This file reuses that
 * designation rather than keeping a second one that could disagree.
 *
 * The Trader can READ a strategy and PROPOSE a change. A proposal is stored
 * as a draft version and an approval card that only a person can answer
 * (trading-versions.ts); nothing here activates a version, touches an order,
 * a wallet or a key, and no route that calls this file takes a strategy
 * status or mode. The server is the gate: MCP tools exist for every agent,
 * so every call is checked against the designation first.
 */

const RECENT_LEDGER_ROWS = 40;
const RECENT_DAYS = 30;
const RECENT_VERSIONS = 10;

export function tradingTraderService(db: Db, rawDb: Db = db) {
  const versions = tradingVersionsService(db, { rawDb });
  const ledger = tradingLedgerService(db);

  /** The one place that decides who the Trader is. Same company, same agent, or a plain 403. */
  async function requireTrader(companyId: string, agentId: string): Promise<void> {
    const [settings] = await db
      .select({ traderAgentId: companyCryptoSettings.traderAgentId })
      .from(companyCryptoSettings)
      .where(eq(companyCryptoSettings.companyId, companyId));
    if (!settings?.traderAgentId || settings.traderAgentId !== agentId) {
      throw forbidden("Only the company's Trader agent can use the trading tools.");
    }
    const [agent] = await db.select({ id: agents.id, status: agents.status }).from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
    if (!agent || agent.status === "terminated") throw forbidden("Only the company's Trader agent can use the trading tools.");
  }

  async function requireStrategy(companyId: string, strategyId: string) {
    const [row] = await db.select().from(tradingStrategies).where(and(eq(tradingStrategies.id, strategyId), eq(tradingStrategies.companyId, companyId)));
    if (!row) throw notFound("Trading strategy not found.");
    return row;
  }

  async function listStrategies(companyId: string) {
    const rows = await db.select().from(tradingStrategies).where(eq(tradingStrategies.companyId, companyId)).orderBy(tradingStrategies.createdAt);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      asset: r.asset,
      timeframe: r.timeframe,
      mode: r.mode,
      status: r.status,
      activeVersionId: r.activeVersionId,
    }));
  }

  /** Read-only: the live rules, the open draft, recent history and the scores. No wallet, key or secret id is read. */
  async function getStrategy(companyId: string, strategyId: string) {
    const strategy = await requireStrategy(companyId, strategyId);
    const { version: active, spec } = await versions.ensureActiveVersion(strategy);
    const all = await db
      .select()
      .from(tradingStrategyVersions)
      .where(and(eq(tradingStrategyVersions.companyId, companyId), eq(tradingStrategyVersions.strategyId, strategyId)))
      .orderBy(desc(tradingStrategyVersions.version))
      .limit(RECENT_VERSIONS);
    const ledgerRows = await ledger.listLedgerEntries({ companyId, strategyId, limit: RECENT_LEDGER_ROWS });
    const stats = await ledger.listDailyStats({ companyId, strategyId, limit: RECENT_DAYS });
    return {
      strategy: {
        id: strategy.id,
        name: strategy.name,
        asset: strategy.asset,
        timeframe: strategy.timeframe,
        mode: strategy.mode,
        status: strategy.status,
        pauseReason: strategy.pauseReason,
        startingCashNok: strategy.startingCashNok,
        cashNok: strategy.cashNok,
        positionQuantity: strategy.positionQuantity,
      },
      activeVersion: {
        id: active.id,
        version: active.version,
        specDigest: active.specDigest,
        spec,
        guidelines: active.guidelines,
        readBack: describeTradingSpec(spec as TradingStrategySpec),
      },
      versions: all.map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status,
        proposedByType: v.proposedByType,
        createdAt: v.createdAt.toISOString(),
        approvedAt: v.approvedAt?.toISOString() ?? null,
        specDigest: v.specDigest,
      })),
      recentLedger: ledgerRows.map((r) => ({
        at: r.createdAt.toISOString(),
        eventType: r.eventType,
        strategyVersionId: r.strategyVersionId,
        nokValue: r.nokValue,
        feeNok: r.feeNok,
        realizedPnlNok: r.realizedPnlNok,
        detail: r.detail,
      })),
      dailyScores: stats,
      limits: { proposalsPerStrategyPerDay: TRADING_TRADER_PROPOSALS_PER_STRATEGY_PER_DAY },
    };
  }

  /**
   * Validate (zod, bounds, tighten-only risk) and store a draft + card.
   * Every refusal is a 4xx with a plain reason; a success is a pending card,
   * never an active rule.
   */
  async function proposeChange(companyId: string, agentId: string, strategyId: string, body: unknown): Promise<ProposeVersionResult> {
    const parsed = traderProposeChangeSchema.safeParse(body);
    if (!parsed.success) {
      throw unprocessable("This proposal is not valid.", {
        issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const { spec, guidelines, summary, reasons } = parsed.data;
    return versions.proposeVersion(
      companyId,
      strategyId,
      { spec, guidelines },
      { type: "agent", id: agentId },
      { note: { summary, reasons }, agentProposalsPerDay: TRADING_TRADER_PROPOSALS_PER_STRATEGY_PER_DAY },
    );
  }

  /** "Ask the analyst": opens a task for the Trader. The question is a person's text; it is data in the task, not an instruction to the server. */
  async function askTrader(companyId: string, asker: { userId: string }, input: AskTraderInput) {
    const [settings] = await db
      .select({ traderAgentId: companyCryptoSettings.traderAgentId })
      .from(companyCryptoSettings)
      .where(eq(companyCryptoSettings.companyId, companyId));
    if (!settings?.traderAgentId) {
      throw unprocessable("No Trader agent has been chosen for this company yet. The owner can choose one in the crypto settings.");
    }
    let strategyLine = "";
    if (input.strategyId) {
      const strategy = await requireStrategy(companyId, input.strategyId);
      strategyLine = `Strategy: ${strategy.name} (${strategy.asset}, id ${strategy.id})\n\n`;
    }
    const title = `Trading question: ${input.question.replace(/\s+/g, " ").slice(0, 80)}`;
    const issue = await issueService(db).create(companyId, {
      title,
      description: `${strategyLine}${input.question}\n\nYou can read a strategy with trading_get_strategy and propose a rule change with trading_propose_change. A change only takes effect after a person approves its card.`,
      status: "todo",
      priority: "medium",
      assigneeAgentId: settings.traderAgentId,
      createdByUserId: asker.userId,
    });
    return { issueId: issue.id, identifier: issue.identifier ?? null };
  }

  return { requireTrader, listStrategies, getStrategy, proposeChange, askTrader };
}
