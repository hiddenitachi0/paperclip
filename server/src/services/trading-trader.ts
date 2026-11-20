import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companyCryptoSettings, tradingExperiments, tradingLedgerEntries, tradingStrategies, tradingStrategyVersions } from "@paperclipai/db";
import {
  TRADER_APPLY_REQUIRED_CHECKS,
  TRADER_LEDGER_REASONS,
  TRADING_TRADER_EXPERIMENTS_PER_STRATEGY_PER_DAY,
  TRADING_TRADER_LIMITS,
  TRADING_TRADER_PROPOSALS_PER_STRATEGY_PER_DAY,
  describeTradingSpec,
  queueTradingExperimentSchema,
  traderApplyChangeSchema,
  traderPostMortemSchema,
  traderProposeChangeSchema,
  tradingStrategySpecSchema,
  type AskTraderInput,
  type TradingStrategySpec,
} from "@paperclipai/shared";
import { forbidden, notFound, tooManyRequests, unprocessable } from "../errors.js";
import { issueService } from "./issues.js";
import { tradingEvaluatorService } from "./trading-evaluator.js";
import { tradingLedgerService } from "./trading-ledger.js";
import { tradingExperimentStore, experimentSummary, type TradingExperimentRow } from "./trading-experiment-store.js";
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECENT_LEDGER_ROWS = 40;
const RECENT_DAYS = 30;
const RECENT_VERSIONS = 10;

/** What the approval card shows of the experiment behind a proposal (never compared by the card check). */
function experimentCardFacts(row: TradingExperimentRow) {
  const s = experimentSummary(row);
  return {
    label: "The experiment this change was recommended by. A suggestion only; the rules above are what count.",
    experimentId: s.id,
    trialCount: s.trialCount,
    registryTrialCount: s.registryTrialCount,
    deflatedSharpe: s.deflatedSharpe,
    plateau: s.plateau,
    holdoutReadsLineage: s.holdoutReadsLineage,
    resultDigest: s.resultDigest,
  };
}

const HOUR_MS = 3_600_000;

export interface TradingTraderDeps {
  now?: () => Date;
  evaluator?: Pick<ReturnType<typeof tradingEvaluatorService>, "scoreboard">;
}

/**
 * Why an experiment's result may NOT be applied without a card, or null when it may.
 * A missing check, a missing double-fee check or a result older than the
 * freshness limit all count as "no". Pure so the rule is tested on its own.
 */
export function experimentNotAppliableReason(row: Pick<TradingExperimentRow, "recommendation" | "finishedAt" | "status">, now: Date): { code: string; message: string } | null {
  const rec = (row.recommendation ?? null) as { decision?: string; checks?: Array<{ key?: string; passed?: boolean }> } | null;
  if (rec?.decision !== "recommend") return { code: "trading_apply_not_recommended", message: "That experiment did not recommend a change, so there is nothing to apply." };
  const checks = Array.isArray(rec.checks) ? rec.checks : [];
  for (const key of TRADER_APPLY_REQUIRED_CHECKS) {
    const check = checks.find((c) => c?.key === key);
    if (!check || check.passed !== true) {
      return { code: "trading_apply_gate_not_passed", message: `That experiment's result did not pass the past-data check "${key}" (the one at double fees included), so it cannot be applied without a person's approval. File a proposal card instead.` };
    }
  }
  if (!row.finishedAt || now.getTime() - row.finishedAt.getTime() > TRADING_TRADER_LIMITS.appliedExperimentMaxAgeHours * HOUR_MS) {
    return { code: "trading_apply_experiment_too_old", message: `That experiment finished more than ${TRADING_TRADER_LIMITS.appliedExperimentMaxAgeHours} hours ago, so its result is stale. Run a new experiment on the live rules.` };
  }
  return null;
}

export function tradingTraderService(db: Db, rawDb: Db = db, deps: TradingTraderDeps = {}) {
  const nowOf = () => deps.now?.() ?? new Date();
  const versions = tradingVersionsService(db, { rawDb, now: deps.now });
  const ledger = tradingLedgerService(db);
  const experiments = tradingExperimentStore(db);
  const evaluator = deps.evaluator ?? tradingEvaluatorService(db);

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
    // A malformed id is "not found", not a database error.
    if (!UUID_RE.test(strategyId)) throw notFound("Trading strategy not found.");
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
    const { spec, guidelines, summary, reasons, experimentId } = parsed.data;
    if (!UUID_RE.test(strategyId)) throw notFound("Trading strategy not found.");
    // DUR-5018: no experiment, no proposal. Checked before anything is stored, so a refused proposal leaves no draft and no card.
    await requireStrategy(companyId, strategyId); // a strategy of another company is "not found" before anything else is said
    const experiment = await experiments.requireCitableExperiment(companyId, strategyId, experimentId, spec);
    return versions.proposeVersion(
      companyId,
      strategyId,
      { spec, guidelines },
      { type: "agent", id: agentId },
      {
        note: { summary, reasons },
        agentProposalsPerDay: TRADING_TRADER_PROPOSALS_PER_STRATEGY_PER_DAY,
        agentProposalsPerCompanyPerDay: TRADING_TRADER_LIMITS.proposalsPerCompanyPerDay,
        sizeFreezeDays: TRADING_TRADER_LIMITS.sizeFreezeDays,
        experiment: experimentCardFacts(experiment),
      },
    );
  }

  /**
   * DUR-5019: apply a finished experiment's recommendation to a PAPER strategy
   * with no card. The rules come from the experiment (the Trader sends only its
   * id and its own words), the experiment must have passed every required
   * check at double fees and be fresh, and the version must still be live; the
   * version service then enforces paper-only, tighten-only risk, the size
   * freeze after a safety stop and the daily caps under its locks. Anything
   * short of that is refused with a plain reason and the Trader files a
   * proposal card instead.
   */
  async function applyChange(companyId: string, agentId: string, strategyId: string, body: unknown) {
    const parsed = traderApplyChangeSchema.safeParse(body);
    if (!parsed.success) {
      throw unprocessable("This request is not valid.", { issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    const { experimentId, summary, reasons } = parsed.data;
    if (!UUID_RE.test(strategyId)) throw notFound("Trading strategy not found.");
    const strategy = await requireStrategy(companyId, strategyId);
    if (strategy.mode !== "paper") {
      throw unprocessable("The Trader may only apply changes to paper strategies. File a proposal card instead.", { reason: "trader_apply_paper_only" });
    }
    const row = await experiments.getExperiment(companyId, strategyId, experimentId);
    if (row.status !== "succeeded") throw unprocessable("That experiment has not finished with a result yet.", { code: "trading_experiment_not_finished", reason: "trading_experiment_not_finished" });
    const refused = experimentNotAppliableReason(row, nowOf());
    if (refused) throw unprocessable(refused.message, { code: refused.code, reason: refused.code });
    const spec = tradingStrategySpecSchema.safeParse(row.recommendedSpec);
    if (!spec.success) throw unprocessable("That experiment's recommended rules are not a valid rule book.", { reason: "trading_apply_bad_spec" });
    // Same checks as a card: same strategy, still the live version, and the rules are exactly the recommended variant.
    await experiments.requireCitableExperiment(companyId, strategyId, experimentId, spec.data);
    const { version: live } = await versions.ensureActiveVersion(strategy);
    const result = await versions.applyAgentVersion(companyId, strategyId, {
      spec: spec.data,
      // An experiment varies indicator settings only, so the guidelines stay as they are.
      guidelines: live.guidelines,
      expectedActiveVersionId: row.versionId,
      experimentId,
      agentId,
      note: { summary, reasons },
      limits: {
        proposalsPerCompanyPerDay: TRADING_TRADER_LIMITS.proposalsPerCompanyPerDay,
        appliesPerStrategyPerDay: TRADING_TRADER_LIMITS.appliesPerStrategyPerDay,
        appliesPerCompanyPerDay: TRADING_TRADER_LIMITS.appliesPerCompanyPerDay,
        sizeFreezeDays: TRADING_TRADER_LIMITS.sizeFreezeDays,
      },
    });
    return { ...result, experiment: experimentCardFacts(row) };
  }

  /**
   * DUR-5019: one short plain-language post-mortem for a strategy, stored as an
   * append-only ledger note. Each loss tag must name a LOSING sell of this
   * strategy and one of the live rules' own "common mistakes" (by position), so
   * a tag is always something the rule book itself already says. The text is the
   * Trader's own words: shown labelled, never acted on, never put into a
   * Telegram message.
   */
  async function filePostMortem(companyId: string, agentId: string, strategyId: string, body: unknown) {
    const parsed = traderPostMortemSchema.safeParse(body);
    if (!parsed.success) {
      throw unprocessable("This post-mortem is not valid.", { issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    if (!UUID_RE.test(strategyId)) throw notFound("Trading strategy not found.");
    const strategy = await requireStrategy(companyId, strategyId);
    const { spec, version } = await versions.ensureActiveVersion(strategy);
    const mistakes = (spec as TradingStrategySpec).meta.commonMistakes;
    const since = new Date(nowOf().getTime() - 24 * HOUR_MS);
    const [recent] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tradingLedgerEntries)
      .where(
        and(
          eq(tradingLedgerEntries.companyId, companyId),
          eq(tradingLedgerEntries.strategyId, strategyId),
          eq(tradingLedgerEntries.eventType, "reconciliation"),
          sql`${tradingLedgerEntries.detail}->>'reason' = ${TRADER_LEDGER_REASONS.postMortem}`,
          gte(tradingLedgerEntries.createdAt, since),
        ),
      );
    if ((recent?.n ?? 0) >= TRADING_TRADER_LIMITS.postMortemsPerStrategyPerDay) {
      throw tooManyRequests(`At most ${TRADING_TRADER_LIMITS.postMortemsPerStrategyPerDay} post-mortems can be written for one strategy per day.`, { reason: "trader_post_mortem_daily_cap" });
    }
    const tags = parsed.data.lossTags;
    const ids = [...new Set(tags.map((t) => t.ledgerEntryId))];
    const entries = ids.length
      ? await db
          .select({ id: tradingLedgerEntries.id, strategyId: tradingLedgerEntries.strategyId, eventType: tradingLedgerEntries.eventType, realizedPnlNok: tradingLedgerEntries.realizedPnlNok, createdAt: tradingLedgerEntries.createdAt })
          .from(tradingLedgerEntries)
          .where(and(eq(tradingLedgerEntries.companyId, companyId), inArray(tradingLedgerEntries.id, ids)))
      : [];
    const byId = new Map(entries.map((e) => [e.id, e]));
    const checked = tags.map((tag) => {
      const entry = byId.get(tag.ledgerEntryId);
      if (!entry || entry.strategyId !== strategyId) {
        throw unprocessable("A tagged trade was not found on this strategy.", { reason: "trader_tag_unknown_trade", ledgerEntryId: tag.ledgerEntryId });
      }
      if (entry.eventType !== "order_filled" || entry.realizedPnlNok === null || entry.realizedPnlNok >= 0) {
        throw unprocessable("Only a losing trade can be tagged with a mistake.", { reason: "trader_tag_not_a_loss", ledgerEntryId: tag.ledgerEntryId });
      }
      const mistake = mistakes[tag.mistakeIndex];
      if (mistake === undefined) {
        throw unprocessable(`This strategy's rules list ${mistakes.length} common mistake${mistakes.length === 1 ? "" : "s"}; ${tag.mistakeIndex} is not one of them.`, { reason: "trader_tag_unknown_mistake", mistakeIndex: tag.mistakeIndex });
      }
      return { ledgerEntryId: tag.ledgerEntryId, mistakeIndex: tag.mistakeIndex, mistake, lossNok: entry.realizedPnlNok };
    });
    const [written] = await db
      .insert(tradingLedgerEntries)
      .values({
        companyId,
        strategyId,
        strategyVersionId: version.id,
        eventType: "reconciliation",
        detail: {
          reason: TRADER_LEDGER_REASONS.postMortem,
          writtenByAgentId: agentId,
          label: "The Trader's own words. Check the numbers, not this text.",
          text: parsed.data.text,
          lossTags: checked,
          versionNumber: version.version,
        },
      })
      .returning({ id: tradingLedgerEntries.id });
    return { ledgerEntryId: written!.id, tagged: checked.length };
  }

  /**
   * DUR-5019: everything the Trader needs for its daily run in one read-only
   * call: per strategy, the last day's trades (losses marked), the safety stops,
   * the rules' common-mistakes list with positions to tag by, the scoreboard,
   * and what it already filed or applied; plus what is left of today's limits.
   * No wallet, key, order or secret id is read.
   */
  async function getDailyBrief(companyId: string) {
    const now = nowOf();
    const since = new Date(now.getTime() - 24 * HOUR_MS);
    const rows = await db.select().from(tradingStrategies).where(eq(tradingStrategies.companyId, companyId)).orderBy(tradingStrategies.createdAt);
    const strategies = [];
    for (const strategy of rows) {
      const { version: active, spec } = await versions.ensureActiveVersion(strategy);
      const entries = await db
        .select()
        .from(tradingLedgerEntries)
        .where(and(eq(tradingLedgerEntries.companyId, companyId), eq(tradingLedgerEntries.strategyId, strategy.id), gte(tradingLedgerEntries.createdAt, since)))
        .orderBy(desc(tradingLedgerEntries.createdAt))
        .limit(200);
      const trades = entries
        .filter((e) => e.eventType === "order_filled")
        .slice(0, 40)
        .map((e) => ({ ledgerEntryId: e.id, at: e.createdAt.toISOString(), nokValue: e.nokValue, feeNok: e.feeNok, realizedPnlNok: e.realizedPnlNok, isLoss: e.realizedPnlNok !== null && e.realizedPnlNok < 0, detail: e.detail }));
      const board = await evaluator.scoreboard(companyId, strategy.id);
      strategies.push({
        id: strategy.id,
        name: strategy.name,
        asset: strategy.asset,
        timeframe: strategy.timeframe,
        mode: strategy.mode,
        status: strategy.status,
        pauseReason: strategy.pauseReason,
        activeVersion: { id: active.id, version: active.version, readBack: describeTradingSpec(spec as TradingStrategySpec) },
        commonMistakes: (spec as TradingStrategySpec).meta.commonMistakes.map((text, index) => ({ index, text })),
        last24h: {
          trades,
          losingTrades: trades.filter((t) => t.isLoss).length,
          safetyStops: entries.filter((e) => e.eventType === "circuit_breaker").length,
          riskBlocks: entries.filter((e) => e.eventType === "risk_block").length,
        },
        scoreboard: {
          version: board.version,
          status: board.status,
          criteria: board.criteria,
          forecasters: board.forecasters.map((f) => ({ forecasterKey: f.forecasterKey, calls: f.calls, resolved: f.resolved, pending: f.pending, hitRate: f.hitRate, hitRateInterval: f.hitRateInterval })),
          trades: board.trades,
          verdict: board.verdict,
        },
      });
    }
    const changes = await db
      .select({
        id: tradingStrategyVersions.id,
        strategyId: tradingStrategyVersions.strategyId,
        version: tradingStrategyVersions.version,
        status: tradingStrategyVersions.status,
        proposedByType: tradingStrategyVersions.proposedByType,
        appliedByAgentId: tradingStrategyVersions.appliedByAgentId,
        appliedExperimentId: tradingStrategyVersions.appliedExperimentId,
        approvalId: tradingStrategyVersions.approvalId,
        createdAt: tradingStrategyVersions.createdAt,
      })
      .from(tradingStrategyVersions)
      .where(and(eq(tradingStrategyVersions.companyId, companyId), eq(tradingStrategyVersions.proposedByType, "agent"), gte(tradingStrategyVersions.createdAt, since)))
      .orderBy(desc(tradingStrategyVersions.createdAt))
      .limit(50);
    const [experimentCount] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tradingExperiments)
      .where(and(eq(tradingExperiments.companyId, companyId), eq(tradingExperiments.requestedByType, "agent"), gte(tradingExperiments.createdAt, since)));
    const applied = changes.filter((c) => c.appliedByAgentId !== null).length;
    return {
      generatedAt: now.toISOString(),
      strategies,
      changesInLast24h: changes.map((c) => ({ ...c, createdAt: c.createdAt.toISOString(), kind: c.appliedByAgentId ? "applied" : "proposed" })),
      limitsLeftToday: {
        changesAcrossCompany: Math.max(0, TRADING_TRADER_LIMITS.proposalsPerCompanyPerDay - changes.length),
        appliesAcrossCompany: Math.max(0, TRADING_TRADER_LIMITS.appliesPerCompanyPerDay - applied),
        appliesPerStrategy: TRADING_TRADER_LIMITS.appliesPerStrategyPerDay,
        proposalsPerStrategy: TRADING_TRADER_PROPOSALS_PER_STRATEGY_PER_DAY,
        experimentsRequestedByYouInLast24h: experimentCount?.n ?? 0,
        experimentsPerStrategy: TRADING_TRADER_EXPERIMENTS_PER_STRATEGY_PER_DAY,
      },
      rules: [
        "You can read, write a post-mortem, run experiments, and file or apply a rule change. You cannot place or cancel an order, start or stop a strategy, or touch a wallet.",
        "A change is applied without a card only when a finished experiment on the live rules recommended it, passed every check at double fees, and is under 72 hours old. Anything else goes out as a proposal card that cites an experiment.",
        `Nothing you file or apply may loosen a risk limit, or make a strategy bigger within ${TRADING_TRADER_LIMITS.sizeFreezeDays} days of a safety stop.`,
      ],
    };
  }

  /** "Ask the analyst": opens a task for the Trader. The question is a person's text; it is data in the task, not an instruction to the server. */
  async function askTrader(companyId: string, asker: { userId: string }, input: AskTraderInput) {
    const [settings] = await db
      .select({ traderAgentId: companyCryptoSettings.traderAgentId })
      .from(companyCryptoSettings)
      .where(eq(companyCryptoSettings.companyId, companyId));
    const noTrader = () => unprocessable("No Trader agent has been chosen for this company yet. The owner can choose one in the crypto settings.");
    if (!settings?.traderAgentId) throw noTrader();
    const [trader] = await db.select({ status: agents.status }).from(agents).where(and(eq(agents.id, settings.traderAgentId), eq(agents.companyId, companyId)));
    if (!trader || trader.status === "terminated") throw noTrader();
    let strategyLine = "";
    if (input.strategyId) {
      const strategy = await requireStrategy(companyId, input.strategyId);
      strategyLine = `Strategy: ${strategy.name} (${strategy.asset}, id ${strategy.id})\n\n`;
    }
    const title = `Trading question: ${input.question.replace(/\s+/g, " ").slice(0, 80)}`;
    const issue = await issueService(db).create(companyId, {
      title,
      description: `${strategyLine}${input.question}\n\nYou can read a strategy with trading_get_strategy and propose a rule change with trading_propose_change. A proposal must cite a finished experiment (trading_run_experiment, then trading_get_experiment) that recommended exactly those rules. A change only takes effect after a person approves its card.`,
      status: "todo",
      priority: "medium",
      assigneeAgentId: settings.traderAgentId,
      createdByUserId: asker.userId,
    });
    return { issueId: issue.id, identifier: issue.identifier ?? null };
  }

  /** The Trader asks for an experiment; it runs later in a worker thread. The strategy is checked in the Trader's own company. */
  async function requestExperiment(companyId: string, agentId: string, strategyId: string, body: unknown) {
    const parsed = queueTradingExperimentSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw unprocessable("This experiment request is not valid.", { issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    await requireStrategy(companyId, strategyId);
    return experiments.queueExperiment(companyId, strategyId, parsed.data, { type: "agent", id: agentId }, { agentExperimentsPerDay: TRADING_TRADER_EXPERIMENTS_PER_STRATEGY_PER_DAY });
  }

  async function listExperiments(companyId: string, strategyId: string) {
    await requireStrategy(companyId, strategyId);
    return experiments.listExperiments(companyId, strategyId, 20);
  }

  /** One experiment in full, including the exact rules it recommended (what a proposal must contain). */
  async function getExperiment(companyId: string, strategyId: string, experimentId: string) {
    await requireStrategy(companyId, strategyId);
    const row = await experiments.getExperiment(companyId, strategyId, experimentId);
    return { ...experimentSummary(row), params: row.params, report: row.report, recommendation: row.recommendation, recommendedSpec: row.recommendedSpec };
  }

  return { requireTrader, listStrategies, getStrategy, getDailyBrief, applyChange, filePostMortem, proposeChange, requestExperiment, listExperiments, getExperiment, askTrader };
}
