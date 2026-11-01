import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  tradingBacktestHoldoutReads,
  tradingBacktestRuns,
  tradingBacktestTrials,
  tradingStartGateOverrides,
  tradingStrategies,
  tradingStrategyVersions,
} from "@paperclipai/db";
import {
  TRADING_BACKTEST_COSTS,
  TRADING_BACKTEST_LIMITS,
  TRADING_START_GATE,
  tradingStrategySpecSchema,
  tradingVersionOnlyTightens,
  type HoldoutRead,
  type TradingBacktestPurpose,
  type TradingStrategySpec,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import type { BacktestOutcome, BacktestRunParams } from "./trading-backtest-run.js";

/**
 * DUR-5008: the database side of the past-data test.
 *
 * Request side (company-scoped db): queue a run, read runs, read the start
 * gate's state, record an owner's override. Worker side (the bypass
 * connection, so every query below names the company): claim the next queued
 * run, read its context, write its result once.
 *
 * What a person may do here is limited on purpose. A run can only be queued
 * for a version of the caller's own strategy, with a fixed parameter shape
 * the caller cannot widen (the costs, the data horizon and the seed come
 * from this file, not from the request). The verdict (`gate_passed`) is
 * written only by `finishRun`, from the worker's own computation, and the
 * database makes a finished run final.
 */

export type TradingBacktestRunRow = typeof tradingBacktestRuns.$inferSelect;

export interface QueueBacktestInput {
  versionId?: string;
  purpose?: TradingBacktestPurpose;
  selection?: "base" | "best_in_sample";
  maxVariants?: number;
  /** Server-side only: the template the strategy came from, so holdout reads count against it too. */
  templateKey?: string | null;
}

export interface StartGateState {
  cleared: boolean;
  /** Why it is cleared (or null when it is not). */
  basis: "grandfathered" | "passed" | "override" | "inherited" | null;
  versionId: string;
  versionNumber: number;
  /** The newest finished gate run for this version, if any. */
  latestRun: { id: string; status: string; gatePassed: boolean | null; summary: string | null; finishedAt: Date | null } | null;
  queuedRunId: string | null;
}

export type StartGateActor = { type: "user" | "agent" | "system"; id: string };

export interface TradingBacktestStoreDeps {
  now?: () => Date;
}

function floorToFiveMinutes(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 300_000) * 300_000);
}

/** Rows that belong to the strategy or, when it came from a template, to the template. */
function lineageOf(strategyId: string, templateKey: string | null | undefined, columns: { strategyId: any; templateKey: any }) {
  return templateKey ? or(eq(columns.strategyId, strategyId), eq(columns.templateKey, templateKey)) : eq(columns.strategyId, strategyId);
}

/**
 * Is this version allowed to be started? True for a grandfathered legacy
 * version, a version that has a passed gate run, or one an owner overrode.
 * Takes any db handle so the version-approval transaction can ask too.
 */
export async function isVersionStartCleared(handle: Db, companyId: string, version: { id: string; grandfathered: boolean }): Promise<"grandfathered" | "passed" | "override" | "inherited" | null> {
  if (version.grandfathered) return "grandfathered";
  const [passed] = await handle
    .select({ id: tradingBacktestRuns.id })
    .from(tradingBacktestRuns)
    .where(and(eq(tradingBacktestRuns.companyId, companyId), eq(tradingBacktestRuns.versionId, version.id), eq(tradingBacktestRuns.gatePassed, true), eq(tradingBacktestRuns.status, "succeeded"), eq(tradingBacktestRuns.purpose, "gate")))
    .limit(1);
  if (passed) return "passed";
  const [override] = await handle
    .select({ id: tradingStartGateOverrides.id, kind: tradingStartGateOverrides.kind })
    .from(tradingStartGateOverrides)
    .where(and(eq(tradingStartGateOverrides.companyId, companyId), eq(tradingStartGateOverrides.versionId, version.id)))
    .limit(1);
  return override ? (override.kind === "tightening_inherited" ? "inherited" : "override") : null;
}

/**
 * A new version that changes nothing but tightens the risk limits (or shrinks
 * the order size) takes over the clearance of the version it replaces. Records
 * that in the same table as an owner's override, as kind
 * 'tightening_inherited', so a later resume is not blocked. Returns whether it
 * inherited. Call inside the approval's transaction.
 */
export async function inheritStartClearance(handle: Db, companyId: string, previous: { id: string; grandfathered: boolean; spec: unknown } | null, next: { id: string; strategyId: string; version: number; spec: unknown }, approvedByUserId: string): Promise<boolean> {
  if (!previous) return false;
  const before = tradingStrategySpecSchema.safeParse(previous.spec);
  const after = tradingStrategySpecSchema.safeParse(next.spec);
  if (!before.success || !after.success || !tradingVersionOnlyTightens(before.data, after.data)) return false;
  const basis = await isVersionStartCleared(handle, companyId, previous);
  if (!basis) return false;
  await handle
    .insert(tradingStartGateOverrides)
    .values({
      companyId,
      strategyId: next.strategyId,
      versionId: next.id,
      kind: "tightening_inherited",
      reason: `Only the risk limits or the order size got tighter than the version before (${basis}); the entry and exit rules are unchanged.`,
      overriddenByUserId: approvedByUserId,
    })
    .onConflictDoNothing();
  return true;
}

export function tradingBacktestStore(db: Db, deps: TradingBacktestStoreDeps = {}) {
  const nowOf = () => deps.now?.() ?? new Date();

  async function requireVersion(companyId: string, strategyId: string, versionId: string) {
    const [version] = await db
      .select()
      .from(tradingStrategyVersions)
      .where(and(eq(tradingStrategyVersions.id, versionId), eq(tradingStrategyVersions.strategyId, strategyId), eq(tradingStrategyVersions.companyId, companyId)));
    if (!version) throw notFound("Strategy version not found.");
    return version;
  }

  async function startGateState(companyId: string, strategyId: string, version: { id: string; version: number; grandfathered: boolean }): Promise<StartGateState> {
    const basis = await isVersionStartCleared(db, companyId, version);
    const [latest] = await db
      .select()
      .from(tradingBacktestRuns)
      .where(and(eq(tradingBacktestRuns.companyId, companyId), eq(tradingBacktestRuns.versionId, version.id), eq(tradingBacktestRuns.purpose, "gate")))
      .orderBy(desc(tradingBacktestRuns.createdAt))
      .limit(1);
    const gate = (latest?.gate ?? null) as { summary?: string } | null;
    return {
      cleared: basis !== null,
      basis,
      versionId: version.id,
      versionNumber: version.version,
      latestRun: latest ? { id: latest.id, status: latest.status, gatePassed: latest.gatePassed, summary: gate?.summary ?? latest.error, finishedAt: latest.finishedAt } : null,
      queuedRunId: latest && (latest.status === "queued" || latest.status === "running") ? latest.id : null,
    };
  }

  /** Queue a past-data test of one version. The costs, data horizon and seed are fixed here; the request chooses only the purpose and the size. */
  async function queueRun(companyId: string, strategyId: string, input: QueueBacktestInput, actor: StartGateActor): Promise<TradingBacktestRunRow> {
    const [strategy] = await db.select().from(tradingStrategies).where(and(eq(tradingStrategies.id, strategyId), eq(tradingStrategies.companyId, companyId)));
    if (!strategy) throw notFound("Trading strategy not found.");
    const versionId = input.versionId ?? strategy.activeVersionId;
    if (!versionId) throw unprocessable("This strategy has no rule-book version to test yet.");
    const version = await requireVersion(companyId, strategyId, versionId);
    if (version.status === "superseded") throw unprocessable("These rules were replaced by a newer version. Test the newer version instead.", { code: "trading_backtest_version_superseded" });
    const parsed = tradingStrategySpecSchema.safeParse(version.spec);
    if (!parsed.success) throw unprocessable("The stored rules of this version are not a valid rule book, so they cannot be tested.");
    const spec: TradingStrategySpec = parsed.data;
    const purpose = input.purpose ?? "gate";
    const selection = input.selection ?? "base";
    if (purpose === "gate" && selection !== "base") throw unprocessable("A start-gate test runs the rules as written; re-tuning per window is for exploration runs.", { code: "trading_backtest_gate_needs_base" });
    const [active] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tradingBacktestRuns)
      .where(and(eq(tradingBacktestRuns.companyId, companyId), inArray(tradingBacktestRuns.status, ["queued", "running"])));
    if ((active?.n ?? 0) >= TRADING_BACKTEST_LIMITS.maxActiveRunsPerCompany) {
      throw conflict(`There are already ${TRADING_BACKTEST_LIMITS.maxActiveRunsPerCompany} past-data tests waiting or running. Let some finish first.`, { code: "trading_backtest_queue_full" });
    }
    const asOf = floorToFiveMinutes(nowOf());
    const params: BacktestRunParams = {
      schema: 1,
      asOf: asOf.toISOString(),
      source: TRADING_START_GATE.liveSource,
      purpose,
      assets: [...spec.universe.assets],
      costs: { feeRatePct: TRADING_BACKTEST_COSTS.feeRatePct, spreadPct: TRADING_BACKTEST_COSTS.spreadPct, slippagePct: TRADING_BACKTEST_COSTS.slippagePct },
      startingCashNok: strategy.startingCashNok,
      selection,
      maxVariants: Math.min(input.maxVariants ?? TRADING_BACKTEST_LIMITS.maxVariants, TRADING_BACKTEST_LIMITS.maxVariants),
      // Derived from what the run tests, so the random baseline is reproducible and cannot be shopped for a lucky draw.
      seed: Number.parseInt(version.specDigest.slice(0, 8), 16) >>> 0,
    };
    try {
      const [row] = await db
        .insert(tradingBacktestRuns)
        .values({
          companyId,
          strategyId,
          versionId,
          purpose,
          specDigest: version.specDigest,
          templateKey: input.templateKey ?? null,
          params: params as unknown as Record<string, unknown>,
          requestedByType: actor.type,
          requestedById: actor.id,
        })
        .returning();
      return row!;
    } catch (err) {
      const code = (err as { code?: string; cause?: { code?: string } }).code ?? (err as { cause?: { code?: string } }).cause?.code;
      if (code === "23505") throw conflict("A past-data test of this version is already waiting or running.", { code: "trading_backtest_already_active" });
      throw err;
    }
  }

  async function listRuns(companyId: string, strategyId: string, limit = 50) {
    const rows = await db
      .select({
        id: tradingBacktestRuns.id,
        versionId: tradingBacktestRuns.versionId,
        purpose: tradingBacktestRuns.purpose,
        status: tradingBacktestRuns.status,
        gatePassed: tradingBacktestRuns.gatePassed,
        gate: tradingBacktestRuns.gate,
        resultDigest: tradingBacktestRuns.resultDigest,
        variantsTried: tradingBacktestRuns.variantsTried,
        error: tradingBacktestRuns.error,
        createdAt: tradingBacktestRuns.createdAt,
        startedAt: tradingBacktestRuns.startedAt,
        finishedAt: tradingBacktestRuns.finishedAt,
      })
      .from(tradingBacktestRuns)
      .where(and(eq(tradingBacktestRuns.companyId, companyId), eq(tradingBacktestRuns.strategyId, strategyId)))
      .orderBy(desc(tradingBacktestRuns.createdAt))
      .limit(Math.min(limit, 200));
    return rows.map((row) => ({ ...row, gate: row.gate ? { passed: (row.gate as { passed?: boolean }).passed ?? null, summary: (row.gate as { summary?: string }).summary ?? null } : null }));
  }

  async function getRun(companyId: string, strategyId: string, runId: string): Promise<TradingBacktestRunRow> {
    const [row] = await db
      .select()
      .from(tradingBacktestRuns)
      .where(and(eq(tradingBacktestRuns.id, runId), eq(tradingBacktestRuns.strategyId, strategyId), eq(tradingBacktestRuns.companyId, companyId)));
    if (!row) throw notFound("Past-data test not found.");
    return row;
  }

  /** A queued run can be withdrawn; one that has started runs to its end or its time limit. */
  async function cancelQueued(companyId: string, strategyId: string, runId: string): Promise<TradingBacktestRunRow> {
    const [row] = await db
      .update(tradingBacktestRuns)
      .set({ status: "cancelled", finishedAt: nowOf(), updatedAt: nowOf(), error: "Withdrawn before it started." })
      .where(and(eq(tradingBacktestRuns.id, runId), eq(tradingBacktestRuns.strategyId, strategyId), eq(tradingBacktestRuns.companyId, companyId), eq(tradingBacktestRuns.status, "queued")))
      .returning();
    if (!row) {
      await getRun(companyId, strategyId, runId);
      throw conflict("Only a test that has not started yet can be withdrawn.");
    }
    return row;
  }

  async function recordOverride(companyId: string, strategyId: string, versionId: string, reason: string, userId: string) {
    const [row] = await db
      .insert(tradingStartGateOverrides)
      .values({ companyId, strategyId, versionId, kind: "owner_override", reason: reason.trim(), overriddenByUserId: userId })
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  }

  async function listOverrides(companyId: string, strategyId: string) {
    return db
      .select()
      .from(tradingStartGateOverrides)
      .where(and(eq(tradingStartGateOverrides.companyId, companyId), eq(tradingStartGateOverrides.strategyId, strategyId)))
      .orderBy(desc(tradingStartGateOverrides.createdAt));
  }

  // ─── Worker side (bypass connection: every query names the company) ───────

  /** Claim the oldest queued run, if any. One at a time: the supervisor never calls this while a run is going. */
  async function claimNextRun(): Promise<{ id: string; companyId: string } | null> {
    const [next] = await db.select({ id: tradingBacktestRuns.id, companyId: tradingBacktestRuns.companyId }).from(tradingBacktestRuns).where(eq(tradingBacktestRuns.status, "queued")).orderBy(asc(tradingBacktestRuns.createdAt)).limit(1);
    if (!next) return null;
    const [claimed] = await db
      .update(tradingBacktestRuns)
      .set({ status: "running", startedAt: nowOf(), updatedAt: nowOf() })
      .where(and(eq(tradingBacktestRuns.id, next.id), eq(tradingBacktestRuns.status, "queued")))
      .returning({ id: tradingBacktestRuns.id, companyId: tradingBacktestRuns.companyId });
    return claimed ?? null;
  }

  /** A restart can leave a run marked running whose worker is gone. */
  async function failInterrupted(): Promise<number> {
    const rows = await db
      .update(tradingBacktestRuns)
      .set({ status: "failed", error: "Interrupted by a server restart. Queue the test again.", finishedAt: nowOf(), updatedAt: nowOf() })
      .where(eq(tradingBacktestRuns.status, "running"))
      .returning({ id: tradingBacktestRuns.id });
    return rows.length;
  }

  async function failRun(companyId: string, runId: string, message: string): Promise<void> {
    await db
      .update(tradingBacktestRuns)
      .set({ status: "failed", error: message.slice(0, 1000), finishedAt: nowOf(), updatedAt: nowOf() })
      .where(and(eq(tradingBacktestRuns.id, runId), eq(tradingBacktestRuns.companyId, companyId), inArray(tradingBacktestRuns.status, ["queued", "running"])));
  }

  async function loadContext(companyId: string, runId: string) {
    const [run] = await db.select().from(tradingBacktestRuns).where(and(eq(tradingBacktestRuns.id, runId), eq(tradingBacktestRuns.companyId, companyId)));
    if (!run) throw notFound("Past-data test not found.");
    const [version] = await db.select().from(tradingStrategyVersions).where(and(eq(tradingStrategyVersions.id, run.versionId), eq(tradingStrategyVersions.companyId, companyId)));
    if (!version) throw notFound("Strategy version not found.");
    const parsed = tradingStrategySpecSchema.safeParse(version.spec);
    if (!parsed.success) throw unprocessable("The stored rules of this version are not a valid rule book.");
    const reads = await db
      .select()
      .from(tradingBacktestHoldoutReads)
      .where(and(eq(tradingBacktestHoldoutReads.companyId, companyId), lineageOf(run.strategyId, run.templateKey, tradingBacktestHoldoutReads)));
    const trials = await db
      .select({ variantDigest: tradingBacktestTrials.variantDigest, oosSharpe: tradingBacktestTrials.oosSharpe })
      .from(tradingBacktestTrials)
      .where(and(eq(tradingBacktestTrials.companyId, companyId), lineageOf(run.strategyId, run.templateKey, tradingBacktestTrials)));
    const priorReads: HoldoutRead[] = reads.filter((r) => r.runId !== run.id).map((r) => ({ runId: r.runId, holdoutStart: r.holdoutStart.toISOString(), holdoutEnd: r.holdoutEnd.toISOString() }));
    return { run, spec: parsed.data, params: run.params as unknown as BacktestRunParams, priorReads, priorTrials: trials };
  }

  /**
   * Write a finished run, its trials and (for a gate run) its holdout read in
   * one transaction. Trials are keyed by the variant's digest, so a variant
   * tried again is not counted again.
   */
  async function finishRun(companyId: string, runId: string, outcome: BacktestOutcome, ctx: { strategyId: string; versionId: string; templateKey: string | null; purpose: TradingBacktestPurpose }) {
    await db.transaction(async (tx) => {
      const handle = tx as unknown as Db;
      if (outcome.trials.length > 0) {
        await handle
          .insert(tradingBacktestTrials)
          .values(
            outcome.trials.map((t) => ({
              companyId,
              strategyId: ctx.strategyId,
              templateKey: ctx.templateKey,
              runId,
              variantDigest: t.variantDigest,
              variantLabel: t.variantLabel,
              oosSharpe: t.oosSharpe,
              oosObservations: t.oosObservations,
            })),
          )
          .onConflictDoNothing();
      }
      if (outcome.holdoutRead && ctx.purpose === "gate") {
        await handle.insert(tradingBacktestHoldoutReads).values({
          companyId,
          strategyId: ctx.strategyId,
          versionId: ctx.versionId,
          templateKey: ctx.templateKey,
          runId,
          holdoutStart: new Date(outcome.holdoutRead.start),
          holdoutEnd: new Date(outcome.holdoutRead.end),
          seenCount: outcome.holdoutRead.seenCount,
        });
      }
      const [row] = await handle
        .update(tradingBacktestRuns)
        .set({
          status: "succeeded",
          report: outcome.report,
          gate: outcome.gate as unknown as Record<string, unknown>,
          gatePassed: ctx.purpose === "gate" ? outcome.gate.passed : null,
          resultDigest: outcome.resultDigest,
          variantsTried: outcome.variantsTried,
          finishedAt: nowOf(),
          updatedAt: nowOf(),
        })
        .where(and(eq(tradingBacktestRuns.id, runId), eq(tradingBacktestRuns.companyId, companyId), eq(tradingBacktestRuns.status, "running")))
        .returning({ id: tradingBacktestRuns.id });
      if (!row) throw conflict("The test was no longer running, so its result was not saved.");
    });
  }

  /** How many distinct variants were ever tried for the strategy (and its template). */
  async function trialCount(companyId: string, strategyId: string, templateKey: string | null = null): Promise<number> {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tradingBacktestTrials)
      .where(and(eq(tradingBacktestTrials.companyId, companyId), lineageOf(strategyId, templateKey, tradingBacktestTrials)));
    return row?.n ?? 0;
  }

  async function holdoutReadCount(companyId: string, strategyId: string, templateKey: string | null = null): Promise<number> {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tradingBacktestHoldoutReads)
      .where(and(eq(tradingBacktestHoldoutReads.companyId, companyId), lineageOf(strategyId, templateKey, tradingBacktestHoldoutReads)));
    return row?.n ?? 0;
  }

  return {
    requireVersion,
    startGateState,
    queueRun,
    listRuns,
    getRun,
    cancelQueued,
    recordOverride,
    listOverrides,
    claimNextRun,
    failInterrupted,
    failRun,
    loadContext,
    finishRun,
    trialCount,
    holdoutReadCount,
  };
}

export type TradingBacktestStore = ReturnType<typeof tradingBacktestStore>;
