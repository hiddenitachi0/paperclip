import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { companies, createDb, tradingBacktestRuns, tradingLedgerEntries, tradingStrategies, type Db } from "@paperclipai/db";
import { type CreateTradingStrategyInput, type TradingRiskConfig, type TradingRuleConfig, type TradingStrategySpecInput } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { tradingService } from "../services/trading.ts";
import { fakeTradingMarketData } from "../services/trading-market-data.ts";
import type { BacktestOutcome } from "../services/trading-backtest-run.js";

/**
 * DUR-5008: the start gate in setStatus, the run bookkeeping around it and the
 * database's own guards, against a real database.
 *
 *  - a new version (not a grandfathered legacy conversion) cannot be started
 *    until a past-data test of exactly that version passed, or an owner started
 *    it with a written reason;
 *  - a legacy strategy, and a version that already cleared, resume as before;
 *  - the verdict can only be written by finishing a run, and a finished run is
 *    final;
 *  - holdout reads and variants are counted per strategy and template.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping trading start gate tests: ${support.reason ?? "unsupported environment"}`);
}

const RULE: TradingRuleConfig = { type: "sma_crossover", version: 1, fastPeriod: 2, slowPeriod: 3, orderSizeFraction: 0.5 };
const OWNER = { type: "user" as const, id: "owner-1" };
const NOW = new Date("2026-10-30T12:00:00Z");

function riskConfig(overrides: Partial<TradingRiskConfig> = {}): TradingRiskConfig {
  return { maxPositionNok: 5_000, maxTotalExposureNok: 15_000, maxOrdersPerDay: 20, dailyLossLimitNok: 1_000, maxDrawdownPct: 20, priceBandPct: 5, approvalAboveNok: 1_000_000_000, feeRatePct: 0.25, ...overrides };
}

const INPUT: CreateTradingStrategyInput = { name: "Gated", asset: "BTC", timeframe: "4h", checkEveryMinutes: 15, startingCashNok: 2_000, ruleConfig: RULE, riskConfig: riskConfig() };

/** The same crossover with a stop added: a change to the exit logic. */
function stopSpec(): TradingStrategySpecInput {
  return {
    specVersion: 2,
    meta: { name: "Gated", family: "trend", thesis: "A crossover with a stop." },
    universe: { assets: ["BTC"], decisionTimeframe: "4h", warmupBars: 4 },
    indicators: { fast: { kind: "sma", period: 2 }, slow: { kind: "sma", period: 3 } },
    entry: { conditions: { match: "all", conditions: [{ left: { ref: "fast" }, op: "crosses_above", right: { ref: "slow" } }] } },
    exit: { stop: { kind: "pct", pct: 5 }, conditions: { match: "all", conditions: [{ left: { ref: "fast" }, op: "crosses_below", right: { ref: "slow" } }] } },
    sizing: { kind: "fraction_of_cash", fraction: 0.5 },
    neverDo: riskConfig(),
    prediction: { horizonBars: 6, kind: "direction", flatBandPct: 0.25, rUnit: "atr_at_entry" },
  } as TradingStrategySpecInput;
}

function outcome(passed: boolean, over: Partial<BacktestOutcome> = {}): BacktestOutcome {
  return {
    report: { schema: 1 },
    gate: { passed, items: [], thresholds: {} as never, summary: passed ? "Passed every check of the start gate." : "Did not pass: x." },
    resultDigest: "a".repeat(64),
    trials: [{ variantDigest: randomUUID().replace(/-/g, "").padEnd(64, "0"), variantLabel: "your rules as written", oosSharpe: 0.01, oosObservations: 100 }],
    holdoutRead: { start: "2025-10-30T12:00:00.000Z", end: "2026-10-30T12:00:00.000Z", seenCount: 0 },
    variantsTried: 1,
    ...over,
  };
}

d("trading start gate", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: Db;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("trading-start-gate");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Gate Co", issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    return companyId;
  }

  function service() {
    return tradingService(db, { now: () => NOW, marketData: fakeTradingMarketData({ candles: { BTC: { candles: [] } }, quotes: { BTC: { bidUsd: 21, askUsd: 21, at: NOW } } }) });
  }

  async function newStrategy(companyId: string) {
    return service().createStrategy(companyId, INPUT, { actorType: "user", actorId: "owner-1" });
  }

  /** A strategy from before rule books existed: no version row at all. */
  async function legacyStrategy(companyId: string) {
    const [row] = await db.insert(tradingStrategies).values({ companyId, name: "Old", asset: "BTC", timeframe: "4h", ruleConfig: RULE, riskConfig: riskConfig(), startingCashNok: 2_000, cashNok: 2_000, peakEquityNok: 2_000 }).returning();
    return row!;
  }

  /** Queue a gate run for the version, claim it the way the worker does and finish it with the given verdict. */
  async function finishedRun(companyId: string, strategyId: string, versionId: string, passed: boolean, over: Partial<BacktestOutcome> = {}, purpose: "gate" | "explore" = "gate", templateKey: string | null = null) {
    const store = service().backtests;
    const queued = await store.queueRun(companyId, strategyId, { versionId, purpose, templateKey }, OWNER);
    const claimed = await store.claimNextRun();
    expect(claimed?.id).toBe(queued.id);
    await store.finishRun(companyId, queued.id, outcome(passed, over), { strategyId, versionId, templateKey, purpose });
    return queued.id;
  }

  async function drainQueue() {
    const store = service().backtests;
    for (let i = 0; i < 20; i++) {
      const next = await store.claimNextRun();
      if (!next) return;
      await store.failRun(next.companyId, next.id, "drained by the test");
    }
  }

  it("refuses to start a new version that has not passed, says why, and leaves the strategy paused", async () => {
    const companyId = await seedCompany();
    const strategy = await newStrategy(companyId);
    expect(strategy.status).toBe("paused");
    await expect(service().setStatus(companyId, strategy.id, "running")).rejects.toMatchObject({ status: 422, details: { code: "trading_start_gate_not_passed" } });
    await expect(service().setStatus(companyId, strategy.id, "running")).rejects.toThrow(/past-data test/);
    expect((await service().requireStrategy(companyId, strategy.id)).status).toBe("paused");
  });

  it("never blocks a grandfathered legacy strategy: it resumes, pauses and resumes again as before", async () => {
    const companyId = await seedCompany();
    const legacy = await legacyStrategy(companyId);
    const trading = service();
    expect((await trading.setStatus(companyId, legacy.id, "running")).status).toBe("running");
    expect((await trading.setStatus(companyId, legacy.id, "paused")).status).toBe("paused");
    expect((await trading.setStatus(companyId, legacy.id, "running")).status).toBe("running");
    const [kill] = (await db.select().from(tradingLedgerEntries).where(eq(tradingLedgerEntries.strategyId, legacy.id))).filter((e) => e.eventType === "kill_switch");
    expect(kill!.detail).toMatchObject({ action: "resume", startGate: "grandfathered" });
  });

  it("an owner can start it with a written reason; the reason is stored and later resumes need nothing", async () => {
    const companyId = await seedCompany();
    const strategy = await newStrategy(companyId);
    const trading = service();
    const reason = "Paper money only; I watched these rules by hand for a week.";
    const started = await trading.setStatus(companyId, strategy.id, "running", { reason, userId: "owner-1" });
    expect(started.status).toBe("running");
    const state = await trading.backtests.startGateState(companyId, strategy.id, (await trading.versions.ensureActiveVersion(strategy)).version);
    expect(state).toMatchObject({ cleared: true, basis: "override" });
    const overrides = await trading.backtests.listOverrides(companyId, strategy.id);
    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toMatchObject({ reason, overriddenByUserId: "owner-1", kind: "owner_override" });
    const ledger = (await db.select().from(tradingLedgerEntries).where(eq(tradingLedgerEntries.strategyId, strategy.id))).filter((e) => e.eventType === "kill_switch");
    expect(ledger[0]!.detail).toMatchObject({ action: "resume", startGate: "override", overrideReason: reason, overriddenByUserId: "owner-1" });
    await trading.setStatus(companyId, strategy.id, "paused");
    expect((await trading.setStatus(companyId, strategy.id, "running")).status).toBe("running"); // no override needed the second time
  });

  it("a passed gate run of exactly this version lets it start; a failed run, an exploration run and another version's pass do not", async () => {
    const companyId = await seedCompany();
    const strategy = await newStrategy(companyId);
    const trading = service();
    const v1 = (await trading.versions.ensureActiveVersion(strategy)).version;

    await finishedRun(companyId, strategy.id, v1.id, false);
    await expect(trading.setStatus(companyId, strategy.id, "running")).rejects.toMatchObject({ details: { code: "trading_start_gate_not_passed" } });
    const failed = await trading.backtests.startGateState(companyId, strategy.id, v1);
    expect(failed).toMatchObject({ cleared: false, latestRun: { status: "succeeded", gatePassed: false } });

    await finishedRun(companyId, strategy.id, v1.id, true, {}, "explore");
    await expect(trading.setStatus(companyId, strategy.id, "running")).rejects.toMatchObject({ details: { code: "trading_start_gate_not_passed" } });

    // A pass for a different strategy's version does not count.
    const other = await newStrategy(companyId);
    const otherV1 = (await trading.versions.ensureActiveVersion(other)).version;
    await finishedRun(companyId, other.id, otherV1.id, true);
    await expect(trading.setStatus(companyId, strategy.id, "running")).rejects.toMatchObject({ details: { code: "trading_start_gate_not_passed" } });

    await finishedRun(companyId, strategy.id, v1.id, true);
    expect((await trading.setStatus(companyId, strategy.id, "running")).status).toBe("running");
    expect(await trading.backtests.startGateState(companyId, strategy.id, v1)).toMatchObject({ cleared: true, basis: "passed" });
    // Once passed, resuming is never blocked again.
    await trading.setStatus(companyId, strategy.id, "paused");
    expect((await trading.setStatus(companyId, strategy.id, "running")).status).toBe("running");
  });

  it("a new version needs its own pass; the old version's pass does not carry over", async () => {
    const companyId = await seedCompany();
    const strategy = await newStrategy(companyId);
    const trading = service();
    const v1 = (await trading.versions.ensureActiveVersion(strategy)).version;
    await finishedRun(companyId, strategy.id, v1.id, true);
    await trading.setStatus(companyId, strategy.id, "running");
    await trading.setStatus(companyId, strategy.id, "paused");
    const proposed = await trading.versions.proposeVersion(companyId, strategy.id, { spec: stopSpec(), guidelines: "" }, { type: "user", id: "owner-1" });
    if (proposed.outcome !== "drafted") throw new Error("expected a draft");
    const { version: v2 } = await trading.versions.approveFromCard(companyId, proposed.approvalId, "owner-1"); // paused: approving is fine
    expect(v2.version).toBe(2);
    await expect(trading.setStatus(companyId, strategy.id, "running")).rejects.toMatchObject({ details: { code: "trading_start_gate_not_passed", versionNumber: 2 } });
    await finishedRun(companyId, strategy.id, v2.id, true);
    expect((await trading.setStatus(companyId, strategy.id, "running")).status).toBe("running");
  });

  it("refuses to switch a RUNNING strategy to untested entry/exit rules on a card, but lets a risk-only tightening through", async () => {
    const companyId = await seedCompany();
    const strategy = await newStrategy(companyId);
    const trading = service();
    await trading.setStatus(companyId, strategy.id, "running", { reason: "paper money; start for the test", userId: "owner-1" });

    const loosening = await trading.versions.proposeVersion(companyId, strategy.id, { spec: stopSpec(), guidelines: "" }, { type: "user", id: "owner-1" });
    if (loosening.outcome !== "drafted") throw new Error("expected a draft");
    await expect(trading.versions.approveFromCard(companyId, loosening.approvalId, "owner-1")).rejects.toMatchObject({ details: { code: "trading_version_needs_start_gate" } });
    expect((await trading.requireStrategy(companyId, strategy.id)).status).toBe("running");

    // Only the risk limits get tighter: nothing about when it trades changes, so it takes over the clearance.
    const active = (await trading.versions.ensureActiveVersion(strategy)).spec;
    const tighter = { ...active, neverDo: { ...active.neverDo, maxPositionNok: 1_000 } } as unknown as TradingStrategySpecInput;
    const change = await trading.versions.proposeVersion(companyId, strategy.id, { spec: tighter, guidelines: "" }, { type: "user", id: "owner-1" });
    if (change.outcome !== "drafted") throw new Error("expected a draft");
    const { version } = await trading.versions.approveFromCard(companyId, change.approvalId, "owner-1");
    expect(await trading.backtests.startGateState(companyId, strategy.id, version)).toMatchObject({ cleared: true, basis: "inherited" });
    expect((await trading.requireStrategy(companyId, strategy.id)).status).toBe("running");
    const overrides = await trading.backtests.listOverrides(companyId, strategy.id);
    expect(overrides.map((o) => o.kind)).toEqual(expect.arrayContaining(["tightening_inherited", "owner_override"]));
  });

  describe("the run records", () => {
    it("holdout reads and variants are counted per strategy, and a template's reads count for every strategy that came from it", async () => {
      const companyId = await seedCompany();
      const trading = service();
      const a = await newStrategy(companyId);
      const b = await newStrategy(companyId);
      const va = (await trading.versions.ensureActiveVersion(a)).version;
      const vb = (await trading.versions.ensureActiveVersion(b)).version;
      await finishedRun(companyId, a.id, va.id, false, {}, "gate", "template:trend-sma");
      expect(await trading.backtests.holdoutReadCount(companyId, a.id)).toBe(1);
      expect(await trading.backtests.holdoutReadCount(companyId, b.id)).toBe(0);
      // b came from the same template: a's read counts against b's lineage, so b's next run sees it.
      expect(await trading.backtests.holdoutReadCount(companyId, b.id, "template:trend-sma")).toBe(1);
      expect(await trading.backtests.trialCount(companyId, b.id, "template:trend-sma")).toBe(1);
      const queued = await trading.backtests.queueRun(companyId, b.id, { versionId: vb.id, purpose: "gate", templateKey: "template:trend-sma" }, OWNER);
      await trading.backtests.claimNextRun();
      const ctx = await trading.backtests.loadContext(companyId, queued.id);
      expect(ctx.priorReads).toHaveLength(1);
      expect(ctx.priorTrials).toHaveLength(1);
      await trading.backtests.failRun(companyId, queued.id, "test over");
    });

    it("a variant tried twice is one trial", async () => {
      const companyId = await seedCompany();
      const trading = service();
      const a = await newStrategy(companyId);
      const va = (await trading.versions.ensureActiveVersion(a)).version;
      const same = "b".repeat(64);
      const trial = { variantDigest: same, variantLabel: "your rules as written", oosSharpe: 0.02, oosObservations: 50 };
      await finishedRun(companyId, a.id, va.id, false, { trials: [trial] }, "explore");
      await finishedRun(companyId, a.id, va.id, false, { trials: [trial] }, "explore");
      expect(await trading.backtests.trialCount(companyId, a.id)).toBe(1);
    });

    it("only one test of a version can wait or run at a time, and queueing never touches another company's strategy", async () => {
      const companyId = await seedCompany();
      const otherCompany = await seedCompany();
      const trading = service();
      const a = await newStrategy(companyId);
      const first = await trading.backtests.queueRun(companyId, a.id, {}, OWNER);
      await expect(trading.backtests.queueRun(companyId, a.id, {}, OWNER)).rejects.toMatchObject({ status: 409, details: { code: "trading_backtest_already_active" } });
      await expect(trading.backtests.queueRun(otherCompany, a.id, {}, OWNER)).rejects.toMatchObject({ status: 404 });
      await expect(trading.backtests.getRun(otherCompany, a.id, first.id)).rejects.toMatchObject({ status: 404 });
      await trading.backtests.cancelQueued(companyId, a.id, first.id);
      await drainQueue();
    });

    it("a company cannot pile up more than ten waiting or running tests", async () => {
      const companyId = await seedCompany();
      const trading = service();
      for (let i = 0; i < 10; i++) {
        const s = await newStrategy(companyId);
        await trading.backtests.queueRun(companyId, s.id, {}, OWNER);
      }
      const extra = await newStrategy(companyId);
      await expect(trading.backtests.queueRun(companyId, extra.id, {}, OWNER)).rejects.toMatchObject({ status: 409, details: { code: "trading_backtest_queue_full" } });
      for (let i = 0; i < 10; i++) {
        const next = await trading.backtests.claimNextRun();
        if (next) await trading.backtests.failRun(next.companyId, next.id, "cleared by the test");
      }
    });

    it("a gate run must test the rules as written; the data horizon, source and costs come from the server", async () => {
      const companyId = await seedCompany();
      const trading = service();
      const a = await newStrategy(companyId);
      await expect(trading.backtests.queueRun(companyId, a.id, { purpose: "gate", selection: "best_in_sample" }, OWNER)).rejects.toMatchObject({ details: { code: "trading_backtest_gate_needs_base" } });
      const run = await trading.backtests.queueRun(companyId, a.id, { purpose: "explore", selection: "best_in_sample", maxVariants: 9999 }, OWNER);
      expect(run.params).toMatchObject({ source: "kraken", selection: "best_in_sample", maxVariants: 25, costs: { feeRatePct: 0.4, spreadPct: 0.1, slippagePct: 0.05 } });
      await trading.backtests.cancelQueued(companyId, a.id, run.id);
    });
  });

  describe("the database's own guards", () => {
    async function fails(promise: Promise<unknown>, message: RegExp) {
      let error: unknown = null;
      try {
        await promise;
      } catch (err) {
        error = err;
      }
      expect(String((error as { cause?: { message?: string } } | null)?.cause?.message ?? (error as Error | null)?.message ?? error)).toMatch(message);
    }

    it("a finished run is final: its verdict cannot be edited, not even by a direct update", async () => {
      const companyId = await seedCompany();
      const a = await newStrategy(companyId);
      const v = (await service().versions.ensureActiveVersion(a)).version;
      const runId = await finishedRun(companyId, a.id, v.id, false);
      await fails(db.update(tradingBacktestRuns).set({ gatePassed: true }).where(eq(tradingBacktestRuns.id, runId)), /finished run is final/);
      await fails(db.execute(sql`UPDATE trading_backtest_runs SET status = 'queued' WHERE id = ${runId}`), /finished run is final/);
    });

    it("a run cannot be created already passed or already finished", async () => {
      const companyId = await seedCompany();
      const a = await newStrategy(companyId);
      const v = (await service().versions.ensureActiveVersion(a)).version;
      const base = { companyId, strategyId: a.id, versionId: v.id, purpose: "gate", specDigest: v.specDigest, params: {}, requestedByType: "user", requestedById: "x" };
      await fails(db.insert(tradingBacktestRuns).values({ ...base, status: "succeeded", gatePassed: true }), /starts queued and empty/);
      await fails(db.insert(tradingBacktestRuns).values({ ...base, gatePassed: true }), /starts queued and empty/);
    });

    it("a passing verdict can only sit on a succeeded gate run, and what a run tests never changes", async () => {
      const companyId = await seedCompany();
      const a = await newStrategy(companyId);
      const v = (await service().versions.ensureActiveVersion(a)).version;
      const [run] = await db.insert(tradingBacktestRuns).values({ companyId, strategyId: a.id, versionId: v.id, purpose: "explore", specDigest: v.specDigest, params: {}, requestedByType: "user", requestedById: "x" }).returning();
      await fails(db.execute(sql`UPDATE trading_backtest_runs SET status = 'running' WHERE id = ${run!.id}`).then(() => db.execute(sql`UPDATE trading_backtest_runs SET status = 'succeeded', gate_passed = true WHERE id = ${run!.id}`)), /gate_passed_check/);
      await fails(db.execute(sql`UPDATE trading_backtest_runs SET version_id = ${v.id}, purpose = 'gate' WHERE id = ${run!.id}`), /never changes/);
      await db.execute(sql`UPDATE trading_backtest_runs SET status = 'cancelled' WHERE id = ${run!.id}`);
    });

    it("trials, holdout reads and overrides are append-only", async () => {
      const companyId = await seedCompany();
      const a = await newStrategy(companyId);
      const trading = service();
      const v = (await trading.versions.ensureActiveVersion(a)).version;
      await finishedRun(companyId, a.id, v.id, false);
      await trading.backtests.recordOverride(companyId, a.id, v.id, "a reason that is long enough", "owner-1");
      await fails(db.execute(sql`UPDATE trading_backtest_trials SET variant_label = 'x' WHERE strategy_id = ${a.id}`), /append-only/);
      await fails(db.execute(sql`UPDATE trading_backtest_holdout_reads SET seen_count = 0 WHERE strategy_id = ${a.id}`), /append-only/);
      await fails(db.execute(sql`UPDATE trading_start_gate_overrides SET reason = 'something else entirely' WHERE strategy_id = ${a.id}`), /append-only/);
      await fails(db.execute(sql`INSERT INTO trading_start_gate_overrides (company_id, strategy_id, version_id, reason, overridden_by_user_id) VALUES (${companyId}, ${a.id}, ${v.id}, 'short', 'x')`), /reason_check|duplicate/);
    });
  });
});
