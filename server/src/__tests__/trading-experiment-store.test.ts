import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { companies, createDb, tradingBacktestRuns, tradingExperiments, tradingStrategies, tradingStrategyVersions, type Db } from "@paperclipai/db";
import { DEFAULT_TRADING_RISK_CONFIG, TRADING_EXPERIMENT_LIMITS, legacySmaCrossoverSpec, tradingStrategySpecSchema, type CreateTradingStrategyInput } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { tradingService } from "../services/trading.js";
import { fakeTradingMarketData } from "../services/trading-market-data.js";
import { tradingBacktestStore } from "../services/trading-backtest-store.js";
import { specVariantDigest } from "../services/trading-backtest-run.js";
import { buildExperimentVariants, type ExperimentOutcome } from "../services/trading-experiment-run.js";
import { tradingExperimentStore } from "../services/trading-experiment-store.js";

/**
 * DUR-5018: the experiment store, with a real database. The queue and the
 * worker-side lifecycle, company isolation, and the lineage trial registry:
 * the variants an experiment tried must count toward the Deflated Sharpe of
 * every later test of the same strategy (and of its template), but never leak
 * into another strategy's.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping experiment store tests: ${support.reason ?? "unsupported environment"}`);

const NOW = new Date("2026-11-04T12:03:00.000Z");
const INPUT: CreateTradingStrategyInput = {
  name: "Experiments",
  asset: "BTC",
  timeframe: "4h",
  checkEveryMinutes: 15,
  startingCashNok: 2_000,
  ruleConfig: { type: "sma_crossover", version: 1, fastPeriod: 5, slowPeriod: 15, orderSizeFraction: 0.5 },
  riskConfig: { ...DEFAULT_TRADING_RISK_CONFIG },
};

function fakeOutcome(label: string, over: Partial<ExperimentOutcome> = {}, recommend = false, baseSpec?: unknown): ExperimentOutcome {
  const spec = recommend ? tradingStrategySpecSchema.parse(baseSpec) : null;
  const digest = (n: number) => n.toString(16).padStart(64, "0");
  return {
    report: { schema: 1, kind: "experiment", label },
    resultDigest: "c".repeat(64),
    trials: [0, 1, 2].map((n) => ({ digest: digest(n + (label === "other" ? 100 : 0)), label: `v${n}`, oosSharpe: 0.01 * n, observations: 100 })),
    trialCount: 3,
    registryTrialCount: 3,
    deflatedSharpe: 0.5,
    plateau: { applicable: true, variant: "v1", neighbours: [], positive: 0, share: null, passed: null },
    holdoutReadsLineage: 0,
    recommendation: { decision: recommend ? "recommend" : "no_change", variantDigest: spec ? specVariantDigest(spec) : null, variantLabel: recommend ? "v1" : null, checks: [], summary: "x", thresholds: {} as never },
    recommendedSpec: spec,
    backtest: {} as never,
    ...over,
  };
}

d("trading experiment store (DUR-5018)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: Db;
  const marketData = () => fakeTradingMarketData({ quotes: { BTC: { bidUsd: 21, askUsd: 21, at: new Date() } } });
  const store = () => tradingExperimentStore(db, { now: () => NOW });
  const OWNER = { type: "user" as const, id: "owner-1" };

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("trading-experiment-store");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);

  afterAll(async () => {
    await stopDb?.();
  });

  async function seed(name = "Experiments") {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Exp Co", issuePrefix: `E${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    const strategy = await tradingService(db, { marketData: marketData(), now: () => NOW }).createStrategy(companyId, { ...INPUT, name }, { actorType: "user", actorId: "owner-1" });
    const [row] = await db.select().from(tradingStrategies).where(eq(tradingStrategies.id, strategy.id));
    return { companyId, strategyId: strategy.id, versionId: row!.activeVersionId! };
  }

  /** Runs one experiment through the worker-side lifecycle. */
  async function runToEnd(companyId: string, id: string, outcome: ExperimentOutcome) {
    const claimed = await store().claimNextExperiment();
    expect(claimed).toEqual({ id, companyId });
    await store().finishExperiment(companyId, id, outcome);
  }

  it("queues an exploration of the live version with fixed costs and the canonical grid, and nothing the request can widen", async () => {
    const a = await seed();
    const row = await store().queueExperiment(a.companyId, a.strategyId, { grid: [{ indicator: "slow", param: "period", values: [20, 10, 10, 25] }] }, OWNER);
    expect(row).toMatchObject({ status: "queued", versionId: a.versionId, requestedByType: "user", requestedById: "owner-1", trialCount: 0 });
    expect(row.params).toMatchObject({
      purpose: "explore",
      selection: "base",
      source: "kraken",
      asOf: "2026-11-04T12:00:00.000Z",
      costs: { feeRatePct: 0.4 },
      maxVariants: TRADING_EXPERIMENT_LIMITS.maxVariants,
      grid: [{ indicator: "slow", param: "period", values: [10, 20, 25] }],
    });
    const again = store().queueExperiment(a.companyId, a.strategyId, {}, OWNER);
    await expect(again).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a grid that names no such setting or is too big, a missing strategy, a superseded version and another company's strategy", async () => {
    const a = await seed();
    const b = await seed();
    await expect(store().queueExperiment(a.companyId, a.strategyId, { grid: [{ indicator: "nope", param: "period", values: [3] }] }, OWNER)).rejects.toMatchObject({ status: 422 });
    await expect(store().queueExperiment(a.companyId, randomUUID(), {}, OWNER)).rejects.toMatchObject({ status: 404 });
    await expect(store().queueExperiment(b.companyId, a.strategyId, {}, OWNER)).rejects.toMatchObject({ status: 404 });
    await expect(store().queueExperiment(a.companyId, a.strategyId, { versionId: b.versionId }, OWNER)).rejects.toMatchObject({ status: 404 });
    await db.update(tradingStrategyVersions).set({ status: "superseded" }).where(eq(tradingStrategyVersions.id, a.versionId));
    await expect(store().queueExperiment(a.companyId, a.strategyId, { versionId: a.versionId }, OWNER)).rejects.toMatchObject({ status: 422 });
    expect(await db.select().from(tradingExperiments).where(eq(tradingExperiments.companyId, a.companyId))).toHaveLength(0);
  });

  it("refuses new experiments when too many are already waiting for the company", async () => {
    const a = await seed();
    for (let n = 0; n < TRADING_EXPERIMENT_LIMITS.maxActivePerCompany; n++) {
      const versionId = randomUUID();
      await db.insert(tradingStrategyVersions).values({ id: versionId, companyId: a.companyId, strategyId: a.strategyId, version: 10 + n, spec: {}, status: "draft", proposedByType: "user", proposedById: "u", specDigest: "d".repeat(64) });
      await db.insert(tradingExperiments).values({ companyId: a.companyId, strategyId: a.strategyId, versionId, specDigest: "a".repeat(64), params: {}, requestedByType: "user", requestedById: "u" });
    }
    await expect(store().queueExperiment(a.companyId, a.strategyId, {}, OWNER)).rejects.toMatchObject({ status: 409 });
  });

  it("claims the oldest queued experiment once, writes the result once, and then it is final", async () => {
    await db.update(tradingExperiments).set({ status: "cancelled" }).where(eq(tradingExperiments.status, "queued"));
    const a = await seed();
    const row = await store().queueExperiment(a.companyId, a.strategyId, {}, OWNER);
    await runToEnd(a.companyId, row.id, fakeOutcome("one"));
    const done = await store().getExperiment(a.companyId, a.strategyId, row.id);
    expect(done).toMatchObject({ status: "succeeded", trialCount: 3, registryTrialCount: 3, deflatedSharpe: 0.5, holdoutReadsLineage: 0, resultDigest: "c".repeat(64), recommendedVariantDigest: null, recommendedSpec: null });
    expect(done.finishedAt).toEqual(NOW);
    await expect(store().finishExperiment(a.companyId, row.id, fakeOutcome("one"))).rejects.toMatchObject({ status: 409 });
    await expect(db.update(tradingExperiments).set({ resultDigest: "d".repeat(64) }).where(eq(tradingExperiments.id, row.id))).rejects.toThrow();
    expect(await store().claimNextExperiment()).toBeNull();
  });

  it("stores a recommendation with the exact rules, and the proposal gate accepts exactly those and nothing else", async () => {
    await db.update(tradingExperiments).set({ status: "cancelled" }).where(eq(tradingExperiments.status, "queued"));
    const a = await seed();
    const [version] = await db.select().from(tradingStrategyVersions).where(eq(tradingStrategyVersions.id, a.versionId));
    const base = tradingStrategySpecSchema.parse(version!.spec);
    const variants = buildExperimentVariants(base, null);
    const recommended = variants[1]!.spec;
    const row = await store().queueExperiment(a.companyId, a.strategyId, {}, OWNER);
    await runToEnd(a.companyId, row.id, fakeOutcome("rec", {}, true, recommended));
    await expect(store().requireCitableExperiment(a.companyId, a.strategyId, row.id, recommended)).resolves.toMatchObject({ id: row.id });
    await expect(store().requireCitableExperiment(a.companyId, a.strategyId, row.id, variants[2]!.spec)).rejects.toMatchObject({ status: 422 });
    await expect(store().requireCitableExperiment(a.companyId, a.strategyId, row.id, base)).rejects.toMatchObject({ status: 422 });
    // another company cannot cite it, even for the same strategy id
    const b = await seed();
    await expect(store().requireCitableExperiment(b.companyId, a.strategyId, row.id, recommended)).rejects.toMatchObject({ status: 422 });
    // a single changed number in an otherwise identical spec is a different variant
    const tweaked = JSON.parse(JSON.stringify(recommended)) as typeof recommended;
    tweaked.neverDo.maxPositionNok = tweaked.neverDo.maxPositionNok - 1;
    await expect(store().requireCitableExperiment(a.companyId, a.strategyId, row.id, tweaked)).rejects.toMatchObject({ status: 422 });
  });

  it("marks what a restart interrupted as failed, and a failure never leaves a recommendation", async () => {
    await db.update(tradingExperiments).set({ status: "cancelled" }).where(eq(tradingExperiments.status, "queued"));
    const a = await seed();
    const row = await store().queueExperiment(a.companyId, a.strategyId, {}, OWNER);
    expect(await store().claimNextExperiment()).toEqual({ id: row.id, companyId: a.companyId });
    expect(await store().failInterrupted()).toBe(1);
    const failed = await store().getExperiment(a.companyId, a.strategyId, row.id);
    expect(failed).toMatchObject({ status: "failed", recommendedVariantDigest: null });
    expect(failed.error).toMatch(/restart/);
    const second = await store().queueExperiment(a.companyId, a.strategyId, {}, OWNER);
    await store().claimNextExperiment();
    await store().failExperiment(a.companyId, second.id, "The experiment ran past its time limit and was stopped.");
    expect((await store().getExperiment(a.companyId, a.strategyId, second.id)).status).toBe("failed");
  });

  it("a queued experiment can be withdrawn, a running one cannot", async () => {
    await db.update(tradingExperiments).set({ status: "cancelled" }).where(eq(tradingExperiments.status, "queued"));
    const a = await seed();
    const row = await store().queueExperiment(a.companyId, a.strategyId, {}, OWNER);
    const b = await seed();
    await expect(store().cancelQueued(b.companyId, a.strategyId, row.id)).rejects.toMatchObject({ status: 404 });
    expect((await store().cancelQueued(a.companyId, a.strategyId, row.id)).status).toBe("cancelled");
    const next = await store().queueExperiment(a.companyId, a.strategyId, {}, OWNER);
    await store().claimNextExperiment();
    await expect(store().cancelQueued(a.companyId, a.strategyId, next.id)).rejects.toMatchObject({ status: 409 });
    await store().failExperiment(a.companyId, next.id, "x");
  });

  it("never lists or reads another company's experiments", async () => {
    await db.update(tradingExperiments).set({ status: "cancelled" }).where(eq(tradingExperiments.status, "queued"));
    const a = await seed();
    const b = await seed();
    const row = await store().queueExperiment(a.companyId, a.strategyId, {}, OWNER);
    expect(await store().listExperiments(b.companyId, a.strategyId)).toEqual([]);
    await expect(store().getExperiment(b.companyId, a.strategyId, row.id)).rejects.toMatchObject({ status: 404 });
    expect(await store().listExperiments(a.companyId, a.strategyId)).toEqual([expect.objectContaining({ id: row.id, status: "queued", trialCount: 0 })]);
    await store().cancelQueued(a.companyId, a.strategyId, row.id);
  });

  describe("the lineage trial registry", () => {
    it("counts the variants a finished experiment tried toward the strategy's trial count and context, but not its own context, and not another strategy's", async () => {
      await db.update(tradingExperiments).set({ status: "cancelled" }).where(eq(tradingExperiments.status, "queued"));
      const a = await seed();
      const other = await seed("Other");
      const backtests = tradingBacktestStore(db, { now: () => NOW });
      expect(await backtests.trialCount(a.companyId, a.strategyId)).toBe(0);

      const row = await store().queueExperiment(a.companyId, a.strategyId, {}, OWNER);
      // While it is only queued or running, nothing of it counts yet.
      expect((await backtests.lineage(a.companyId, a.strategyId, null)).priorTrials).toHaveLength(0);
      await runToEnd(a.companyId, row.id, fakeOutcome("a"));
      expect(await backtests.trialCount(a.companyId, a.strategyId)).toBe(3);
      expect((await backtests.lineage(a.companyId, a.strategyId, null)).priorTrials.map((t) => t.variantDigest).sort()).toHaveLength(3);
      // The experiment's own context leaves its own trials out, so a rerun is judged against what came before it.
      const ctx = await store().loadContext(a.companyId, row.id);
      expect(ctx.priorTrials).toHaveLength(0);
      expect((await backtests.lineage(a.companyId, a.strategyId, null, { experimentId: row.id })).priorTrials).toHaveLength(0);
      // The same variants tried again are not new trials.
      const second = await store().queueExperiment(a.companyId, a.strategyId, {}, OWNER);
      await runToEnd(a.companyId, second.id, fakeOutcome("a"));
      expect(await backtests.trialCount(a.companyId, a.strategyId)).toBe(3);
      expect((await store().loadContext(a.companyId, second.id)).priorTrials).toHaveLength(3);
      // Another strategy of the same company, and another company, see none of it.
      expect(await backtests.trialCount(other.companyId, other.strategyId)).toBe(0);
      expect(await backtests.trialCount(a.companyId, other.strategyId)).toBe(0);
    });

    it("feeds an ordinary past-data test's context, so its Deflated Sharpe counts what experiments tried", async () => {
      await db.update(tradingExperiments).set({ status: "cancelled" }).where(eq(tradingExperiments.status, "queued"));
      const a = await seed();
      const exp = await store().queueExperiment(a.companyId, a.strategyId, {}, OWNER);
      await runToEnd(a.companyId, exp.id, fakeOutcome("a"));
      const backtests = tradingBacktestStore(db, { now: () => NOW });
      const run = await backtests.queueRun(a.companyId, a.strategyId, { purpose: "explore" }, { type: "user", id: "owner-1" });
      const ctx = await backtests.loadContext(a.companyId, run.id);
      expect(ctx.priorTrials).toHaveLength(3);
      expect((await db.select().from(tradingBacktestRuns).where(and(eq(tradingBacktestRuns.id, run.id))))[0]!.purpose).toBe("explore");
    });
  });
});
