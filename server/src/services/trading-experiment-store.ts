import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tradingExperiments, tradingStrategies, tradingStrategyVersions } from "@paperclipai/db";
import {
  TRADING_BACKTEST_COSTS,
  TRADING_EXPERIMENT_LIMITS,
  TRADING_START_GATE,
  canonicalExperimentGrid,
  canonicalTradingJson,
  tradingStrategySpecSchema,
  type QueueTradingExperimentInput,
  type TradingStrategySpec,
} from "@paperclipai/shared";
import { conflict, notFound, tooManyRequests, unprocessable } from "../errors.js";
import { BacktestRefusal, specVariantDigest } from "./trading-backtest-run.js";
import { tradingBacktestStore } from "./trading-backtest-store.js";
import { validateExperimentGrid, type ExperimentOutcome, type ExperimentParams } from "./trading-experiment-run.js";

/**
 * DUR-5018: the database side of the experiment runner.
 *
 * Request side (company-scoped db): queue an experiment, read experiments,
 * withdraw a queued one, and check that a proposal cites a usable experiment.
 * Worker side (the bypass connection, so every query names the company): claim
 * the next queued experiment, read its context, write its result once.
 *
 * What a requester may choose is small: which version (default: the live one)
 * and a grid of indicator settings. The costs, the data horizon, the source and
 * the seed come from this file, and the purpose is always an exploration that
 * never reads the holdout. The result is written only by `finishExperiment`
 * from the worker's own computation, and the database makes it final.
 *
 * Nothing here applies a result.
 */

export type TradingExperimentRow = typeof tradingExperiments.$inferSelect;
export type ExperimentActor = { type: "user" | "agent" | "system"; id: string };

function floorToFiveMinutes(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 300_000) * 300_000);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a report page and the trader see. Trial counts are always on it. */
export function experimentSummary(row: TradingExperimentRow) {
  const recommendation = (row.recommendation ?? null) as { decision?: string; variantLabel?: string | null; summary?: string } | null;
  return {
    id: row.id,
    strategyId: row.strategyId,
    versionId: row.versionId,
    status: row.status,
    trialCount: row.trialCount,
    registryTrialCount: row.registryTrialCount,
    deflatedSharpe: row.deflatedSharpe,
    plateau: row.plateau,
    holdoutReadsLineage: row.holdoutReadsLineage,
    decision: recommendation?.decision ?? null,
    recommendedVariant: recommendation?.variantLabel ?? null,
    summary: recommendation?.summary ?? row.error,
    resultDigest: row.resultDigest,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

export function tradingExperimentStore(db: Db, deps: { now?: () => Date } = {}) {
  const nowOf = () => deps.now?.() ?? new Date();

  async function queueExperiment(companyId: string, strategyId: string, input: QueueTradingExperimentInput, actor: ExperimentActor, options: { agentExperimentsPerDay?: number } = {}): Promise<TradingExperimentRow> {
    const [strategy] = await db.select().from(tradingStrategies).where(and(eq(tradingStrategies.id, strategyId), eq(tradingStrategies.companyId, companyId)));
    if (!strategy) throw notFound("Trading strategy not found.");
    const versionId = input.versionId ?? strategy.activeVersionId;
    if (!versionId) throw unprocessable("This strategy has no rule-book version to experiment on yet.");
    const [version] = await db
      .select()
      .from(tradingStrategyVersions)
      .where(and(eq(tradingStrategyVersions.id, versionId), eq(tradingStrategyVersions.strategyId, strategyId), eq(tradingStrategyVersions.companyId, companyId)));
    if (!version) throw notFound("Strategy version not found.");
    if (version.status === "superseded") throw unprocessable("These rules were replaced by a newer version. Experiment on the newer version instead.", { code: "trading_experiment_version_superseded" });
    const parsed = tradingStrategySpecSchema.safeParse(version.spec);
    if (!parsed.success) throw unprocessable("The stored rules of this version are not a valid rule book, so they cannot be tested.");
    const spec: TradingStrategySpec = parsed.data;
    const grid = input.grid ? canonicalExperimentGrid(input.grid) : null;
    if (grid) {
      try {
        validateExperimentGrid(spec, grid);
      } catch (err) {
        if (err instanceof BacktestRefusal) throw unprocessable(err.message, { code: "trading_experiment_bad_grid" });
        throw err;
      }
    }
    const [active] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tradingExperiments)
      .where(and(eq(tradingExperiments.companyId, companyId), inArray(tradingExperiments.status, ["queued", "running"])));
    if ((active?.n ?? 0) >= TRADING_EXPERIMENT_LIMITS.maxActivePerCompany) {
      throw conflict(`There are already ${TRADING_EXPERIMENT_LIMITS.maxActivePerCompany} experiments waiting or running. Let some finish first.`, { code: "trading_experiment_queue_full" });
    }
    if (actor.type === "agent" && options.agentExperimentsPerDay !== undefined) {
      const [recent] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(tradingExperiments)
        .where(and(eq(tradingExperiments.strategyId, strategyId), eq(tradingExperiments.requestedByType, "agent"), sql`${tradingExperiments.createdAt} > now() - interval '24 hours'`));
      if ((recent?.n ?? 0) >= options.agentExperimentsPerDay) {
        throw tooManyRequests(`At most ${options.agentExperimentsPerDay} experiments can be requested for one strategy per day, and that many were already requested in the last 24 hours. Try again tomorrow.`, { reason: "trader_experiment_daily_cap" });
      }
    }
    const asOf = floorToFiveMinutes(nowOf());
    const params: ExperimentParams = {
      schema: 1,
      asOf: asOf.toISOString(),
      source: TRADING_START_GATE.liveSource,
      purpose: "explore",
      assets: [...spec.universe.assets],
      costs: { feeRatePct: TRADING_BACKTEST_COSTS.feeRatePct, spreadPct: TRADING_BACKTEST_COSTS.spreadPct, slippagePct: TRADING_BACKTEST_COSTS.slippagePct },
      startingCashNok: strategy.startingCashNok,
      selection: "base",
      maxVariants: TRADING_EXPERIMENT_LIMITS.maxVariants,
      // Derived from what the experiment tests, so the random baselines are reproducible and cannot be shopped for a lucky draw.
      seed: Number.parseInt(version.specDigest.slice(0, 8), 16) >>> 0,
      grid,
    };
    try {
      const [row] = await db
        .insert(tradingExperiments)
        .values({
          companyId,
          strategyId,
          versionId,
          specDigest: version.specDigest,
          templateKey: strategy.templateKey ?? null,
          params: params as unknown as Record<string, unknown>,
          requestedByType: actor.type,
          requestedById: actor.id,
        })
        .returning();
      return row!;
    } catch (err) {
      const code = (err as { code?: string; cause?: { code?: string } }).code ?? (err as { cause?: { code?: string } }).cause?.code;
      if (code === "23505") throw conflict("An experiment on this version is already waiting or running.", { code: "trading_experiment_already_active" });
      throw err;
    }
  }

  async function listExperiments(companyId: string, strategyId: string, limit = 50) {
    const rows = await db
      .select()
      .from(tradingExperiments)
      .where(and(eq(tradingExperiments.companyId, companyId), eq(tradingExperiments.strategyId, strategyId)))
      .orderBy(desc(tradingExperiments.createdAt))
      .limit(Math.min(limit, 200));
    return rows.map(experimentSummary);
  }

  async function getExperiment(companyId: string, strategyId: string, experimentId: string): Promise<TradingExperimentRow> {
    if (!UUID_RE.test(experimentId)) throw notFound("Experiment not found.");
    const [row] = await db
      .select()
      .from(tradingExperiments)
      .where(and(eq(tradingExperiments.id, experimentId), eq(tradingExperiments.strategyId, strategyId), eq(tradingExperiments.companyId, companyId)));
    if (!row) throw notFound("Experiment not found.");
    return row;
  }

  /** A queued experiment can be withdrawn; one that has started runs to its end or its time limit. */
  async function cancelQueued(companyId: string, strategyId: string, experimentId: string): Promise<TradingExperimentRow> {
    const [row] = await db
      .update(tradingExperiments)
      .set({ status: "cancelled", finishedAt: nowOf(), updatedAt: nowOf(), error: "Withdrawn before it started." })
      .where(and(eq(tradingExperiments.id, experimentId), eq(tradingExperiments.strategyId, strategyId), eq(tradingExperiments.companyId, companyId), eq(tradingExperiments.status, "queued")))
      .returning();
    if (!row) {
      await getExperiment(companyId, strategyId, experimentId);
      throw conflict("Only an experiment that has not started yet can be withdrawn.");
    }
    return row;
  }

  /**
   * The proposal gate. A proposal for a strategy's rules must cite a finished
   * experiment of THAT strategy, run on the strategy's CURRENT live version,
   * whose recommended variant is exactly the rules being proposed. Anything
   * else is refused with a plain reason before a draft or a card exists. The
   * Trader cannot use an experiment to wave through rules it did not test,
   * an experiment of another strategy or company, or an out-of-date one.
   */
  async function requireCitableExperiment(companyId: string, strategyId: string, experimentId: string, proposedSpec: TradingStrategySpec): Promise<TradingExperimentRow> {
    const refuse = (message: string, code: string) => unprocessable(message, { code, reason: code });
    if (!UUID_RE.test(experimentId)) throw refuse("Cite the experiment that recommended this change (experimentId).", "trading_experiment_required");
    const [row] = await db
      .select()
      .from(tradingExperiments)
      .where(and(eq(tradingExperiments.id, experimentId), eq(tradingExperiments.companyId, companyId)));
    if (!row || row.strategyId !== strategyId) throw refuse("That experiment does not exist for this strategy. Run an experiment on this strategy and cite it.", "trading_experiment_not_found");
    if (row.status !== "succeeded") throw refuse("That experiment has not finished with a result yet.", "trading_experiment_not_finished");
    if (!row.recommendedVariantDigest) throw refuse("That experiment's result was 'no change', so it supports no rule change.", "trading_experiment_no_recommendation");
    const [strategy] = await db.select({ activeVersionId: tradingStrategies.activeVersionId }).from(tradingStrategies).where(and(eq(tradingStrategies.id, strategyId), eq(tradingStrategies.companyId, companyId)));
    if (!strategy?.activeVersionId || strategy.activeVersionId !== row.versionId) {
      throw refuse("That experiment was run on rules that are no longer the live rules. Run a new experiment on the live rules.", "trading_experiment_stale");
    }
    if (specVariantDigest(proposedSpec) !== row.recommendedVariantDigest) {
      throw refuse("The proposed rules are not the variant that experiment recommended. Propose exactly the recommended rules.", "trading_experiment_spec_mismatch");
    }
    return row;
  }

  // ─── Worker side (bypass connection: every query names the company) ───────

  /** Claim the oldest queued experiment, if any. One at a time: the supervisor never calls this while a job is going. */
  async function claimNextExperiment(): Promise<{ id: string; companyId: string } | null> {
    const [next] = await db.select({ id: tradingExperiments.id }).from(tradingExperiments).where(eq(tradingExperiments.status, "queued")).orderBy(asc(tradingExperiments.createdAt)).limit(1);
    if (!next) return null;
    const [claimed] = await db
      .update(tradingExperiments)
      .set({ status: "running", startedAt: nowOf(), updatedAt: nowOf() })
      .where(and(eq(tradingExperiments.id, next.id), eq(tradingExperiments.status, "queued")))
      .returning({ id: tradingExperiments.id, companyId: tradingExperiments.companyId });
    return claimed ?? null;
  }

  async function failInterrupted(): Promise<number> {
    const rows = await db
      .update(tradingExperiments)
      .set({ status: "failed", error: "Interrupted by a server restart. Queue the experiment again.", finishedAt: nowOf(), updatedAt: nowOf() })
      .where(eq(tradingExperiments.status, "running"))
      .returning({ id: tradingExperiments.id });
    return rows.length;
  }

  async function failExperiment(companyId: string, experimentId: string, message: string): Promise<void> {
    await db
      .update(tradingExperiments)
      .set({ status: "failed", error: message.slice(0, 1000), finishedAt: nowOf(), updatedAt: nowOf() })
      .where(and(eq(tradingExperiments.id, experimentId), eq(tradingExperiments.companyId, companyId), inArray(tradingExperiments.status, ["queued", "running"])));
  }

  async function loadContext(companyId: string, experimentId: string) {
    const [row] = await db.select().from(tradingExperiments).where(and(eq(tradingExperiments.id, experimentId), eq(tradingExperiments.companyId, companyId)));
    if (!row) throw notFound("Experiment not found.");
    const [version] = await db.select().from(tradingStrategyVersions).where(and(eq(tradingStrategyVersions.id, row.versionId), eq(tradingStrategyVersions.companyId, companyId)));
    if (!version) throw notFound("Strategy version not found.");
    const parsed = tradingStrategySpecSchema.safeParse(version.spec);
    if (!parsed.success) throw unprocessable("The stored rules of this version are not a valid rule book.");
    const { priorReads, priorTrials } = await tradingBacktestStore(db).lineage(companyId, row.strategyId, row.templateKey, { experimentId: row.id });
    return { experiment: row, spec: parsed.data, params: row.params as unknown as ExperimentParams, priorReads, priorTrials };
  }

  /** Write the finished experiment once. The database refuses any later change. */
  async function finishExperiment(companyId: string, experimentId: string, outcome: ExperimentOutcome): Promise<void> {
    const recommended = outcome.recommendedSpec;
    const [row] = await db
      .update(tradingExperiments)
      .set({
        status: "succeeded",
        report: outcome.report,
        trials: outcome.trials,
        trialCount: outcome.trialCount,
        registryTrialCount: outcome.registryTrialCount,
        deflatedSharpe: outcome.deflatedSharpe,
        plateau: outcome.plateau as unknown as Record<string, unknown>,
        holdoutReadsLineage: outcome.holdoutReadsLineage,
        recommendation: outcome.recommendation as unknown as Record<string, unknown>,
        recommendedVariantDigest: recommended ? specVariantDigest(recommended) : null,
        recommendedSpec: recommended ? (JSON.parse(canonicalTradingJson(recommended)) as Record<string, unknown>) : null,
        resultDigest: outcome.resultDigest,
        finishedAt: nowOf(),
        updatedAt: nowOf(),
      })
      .where(and(eq(tradingExperiments.id, experimentId), eq(tradingExperiments.companyId, companyId), eq(tradingExperiments.status, "running")))
      .returning({ id: tradingExperiments.id });
    if (!row) throw conflict("The experiment was no longer running, so its result was not saved.");
  }

  return { queueExperiment, listExperiments, getExperiment, cancelQueued, requireCitableExperiment, claimNextExperiment, failInterrupted, failExperiment, loadContext, finishExperiment };
}

export type TradingExperimentStore = ReturnType<typeof tradingExperimentStore>;
