import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, tradingStrategies, tradingStrategyVersions, tradingTemplateReports, type Db } from "@paperclipai/db";
import { TRADING_TEMPLATE_PASSED_LABEL, createTradingStrategySchema, findTradingTemplate, tradingTemplates } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { tradingService } from "../services/trading.ts";
import { fakeTradingMarketData } from "../services/trading-market-data.ts";
import { tradingTemplateStore } from "../services/trading-template-store.ts";
import type { BacktestOutcome } from "../services/trading-backtest-run.js";

/**
 * DUR-5014: the template library against a real database. The matrix is stored
 * and versioned, every template gets a report row, the wording rule holds
 * (passed = "paper only, not a recommendation", never "ready"), a template's
 * holdout reads and variants count toward strategies created from it, and the
 * database makes a finished report final.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping trading template library tests: ${support.reason ?? "unsupported environment"}`);

const NOW = new Date("2026-10-30T12:00:00Z");
const OWNER = { type: "user" as const, id: "owner-1" };
const SYSTEM = { type: "system" as const, id: "test" };

function outcome(passed: boolean, over: Partial<BacktestOutcome> = {}): BacktestOutcome {
  return {
    report: { schema: 1, skippedCoins: [] },
    gate: { passed, items: [], thresholds: {} as never, summary: passed ? "Passed every check of the start gate." : "Did not pass: x." },
    resultDigest: "a".repeat(64),
    trials: [{ variantDigest: randomUUID().replace(/-/g, "").padEnd(64, "0"), variantLabel: "your rules as written", oosSharpe: 0.01, oosObservations: 100 }],
    holdoutRead: { start: "2025-10-30T12:00:00.000Z", end: "2026-10-30T12:00:00.000Z", seenCount: 0 },
    variantsTried: 1,
    variantStats: [],
    registrySize: 1,
    priorHoldoutReads: 0,
    ...over,
  };
}

d("strategy template library", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: Db;
  const store = () => tradingTemplateStore(db, { now: () => NOW });

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("trading-template-library");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);

  afterAll(async () => {
    await stopDb?.();
  });

  async function finish(templateKey: string, o: BacktestOutcome) {
    const queued = await store().queueReport(templateKey, SYSTEM);
    const claimed = await store().claimNextReport();
    expect(claimed?.id).toBe(queued.id);
    await store().finishReport(queued.id, o, { templateKey, assets: ["BTC", "ETH"] });
    return queued.id;
  }

  it("stores the matrix once and versioned, and a second seed changes nothing", async () => {
    expect(await store().seedMatrices()).toEqual({ inserted: 1 });
    expect(await store().seedMatrices()).toEqual({ inserted: 0 });
    const lib = await store().library();
    expect(lib.matrix.version).toBe(1);
    expect(lib.matrix.stored).toBe(true);
    expect(lib.matrixVersions.map((m) => m.version)).toEqual([1]);
  });

  it("lists every template with no report yet as not tested, the controls as controls, and the excluded style with its reason", async () => {
    const lib = await store().library();
    expect(lib.templates).toHaveLength(tradingTemplates().length);
    for (const t of lib.templates) {
      expect(t.problems).toEqual([]);
      expect(t.passedPastDataChecks).toBe(false);
      expect(t.report).toBeNull();
      expect(t.label).not.toMatch(/\b(ready|promising)\b/i);
      expect(t.startingValues.every((v) => v.status === "to_be_tested" && v.value !== undefined)).toBe(true);
    }
    expect(lib.templates.find((t) => t.key === "stay_in_cash")!.label).toMatch(/control/);
    expect(lib.excluded).toEqual([expect.objectContaining({ key: "gap_and_go", reason: expect.stringMatching(/no opening gap/) })]);
  });

  it("queues one report per template, once each, and queues nothing twice", async () => {
    const first = await store().queueMissing(SYSTEM);
    expect(first.queued.sort()).toEqual(tradingTemplates().map((t) => t.key).sort());
    const second = await store().queueMissing(SYSTEM);
    expect(second.queued).toEqual([]);
    await expect(store().queueReport("pullback", SYSTEM)).rejects.toMatchObject({ status: 409 });
    // Drain: claim every one and fail it, so later tests start from an empty queue.
    for (let i = 0; i < 20; i++) {
      const next = await store().claimNextReport();
      if (!next) break;
      await store().failReport(next.id, "drained by the test");
    }
  });

  it("labels a passed template 'paper only, not a recommendation', and a price-only one never passes", async () => {
    await finish("pullback", outcome(true));
    await finish("high_volume_spike", outcome(true));
    const lib = await store().library();
    const pullback = lib.templates.find((t) => t.key === "pullback")!;
    expect(pullback.label).toBe(TRADING_TEMPLATE_PASSED_LABEL);
    expect(pullback.passedPastDataChecks).toBe(true);
    expect(pullback.report).toMatchObject({ status: "succeeded", gatePassed: true, matchesCurrentRules: true, matrixVersion: 1 });
    const spike = lib.templates.find((t) => t.key === "high_volume_spike")!;
    expect(spike.passedPastDataChecks).toBe(false);
    expect(spike.label).toMatch(/funding and open-interest/);
  });

  it("stores a report with no candles as not testable, with the reason, and not as a pass", async () => {
    const o = outcome(false, { report: { schema: 1, skippedCoins: [{ coin: "BTC", reason: "no 4h candles stored on kraken" }, { coin: "ETH", reason: "no 4h candles stored on kraken" }] }, holdoutRead: null });
    const id = await finish("momentum", o);
    const [row] = await db.select().from(tradingTemplateReports).where(eq(tradingTemplateReports.id, id));
    expect(row).toMatchObject({ status: "not_testable", gatePassed: null, holdoutStart: null });
    expect(row!.error).toMatch(/no 4h candles stored/);
    const lib = await store().library();
    expect(lib.templates.find((t) => t.key === "momentum")!.label).toBe("not yet tested on past data");
  });

  it("makes a finished report final, and refuses a verdict on a report that never ran", async () => {
    const [row] = await db.select().from(tradingTemplateReports).where(eq(tradingTemplateReports.templateKey, "pullback"));
    await expect(db.update(tradingTemplateReports).set({ gatePassed: false }).where(eq(tradingTemplateReports.id, row!.id))).rejects.toThrow();
    await expect(store().finishReport(row!.id, outcome(true), { templateKey: "pullback", assets: ["BTC", "ETH"] })).rejects.toThrow();
  });

  it("flags a stored report as out of date, and does not call the template passed, when its rules changed since", async () => {
    await db.insert(tradingTemplateReports).values({
      templateKey: "reversal",
      templateVersion: 1,
      specDigest: "c".repeat(64),
      matrixVersion: 1,
      status: "succeeded",
      gatePassed: true,
      params: {},
      requestedByType: "system",
      requestedById: "test",
    });
    const reversal = (await store().library()).templates.find((t) => t.key === "reversal")!;
    expect(reversal.report).toMatchObject({ status: "succeeded", matchesCurrentRules: false });
    expect(reversal.passedPastDataChecks).toBe(false);
    expect(reversal.label).toBe("not yet tested on past data");
  });

  describe("lineage", () => {
    async function seedCompany() {
      const companyId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Lineage Co", issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
      return companyId;
    }
    function service() {
      return tradingService(db, { now: () => NOW, marketData: fakeTradingMarketData({ candles: { BTC: { candles: [] } }, quotes: { BTC: { bidUsd: 21, askUsd: 21, at: NOW } } }) });
    }

    it("creates a strategy from a template with the template's rules as version 1 and remembers the key", async () => {
      const companyId = await seedCompany();
      const template = findTradingTemplate("pullback")!;
      const input = createTradingStrategySchema.parse({ name: "My pullback", asset: "ETH", timeframe: template.spec.universe.decisionTimeframe });
      const row = await service().createStrategy(companyId, input, { actorType: "user", actorId: "owner-1" }, template);
      expect(row).toMatchObject({ templateKey: "pullback", templateVersion: 1, status: "paused", asset: "ETH" });
      const [version] = await db.select().from(tradingStrategyVersions).where(eq(tradingStrategyVersions.strategyId, row.id));
      const spec = version!.spec as { meta: { name: string; family: string }; universe: { assets: string[] }; indicators: unknown };
      expect(spec.meta).toMatchObject({ name: "My pullback", family: "trend" });
      expect(spec.universe.assets).toEqual(["ETH"]);
      expect(spec.indicators).toEqual(template.spec.indicators);
      expect(version!.guidelines).toBe(template.guidelines);
      // A plain strategy keeps NULL.
      const plain = await service().createStrategy(companyId, createTradingStrategySchema.parse({ name: "Plain", asset: "BTC", timeframe: "4h" }), { actorType: "user", actorId: "owner-1" });
      expect(plain.templateKey).toBeNull();
    });

    it("counts the template's holdout read and variants toward a strategy created from it, and carries them into its next test", async () => {
      const companyId = await seedCompany();
      const template = findTradingTemplate("breakout")!;
      await finish("breakout", outcome(false));
      const input = createTradingStrategySchema.parse({ name: "My breakout", asset: "BTC", timeframe: template.spec.universe.decisionTimeframe });
      const strategy = await service().createStrategy(companyId, input, { actorType: "user", actorId: "owner-1" }, template);
      const trading = service();
      expect(await trading.backtests.holdoutReadCount(companyId, strategy.id)).toBe(1);
      expect(await trading.backtests.trialCount(companyId, strategy.id)).toBe(1);
      const queued = await trading.backtests.queueRun(companyId, strategy.id, { purpose: "gate" }, OWNER);
      expect(queued.templateKey).toBe("breakout");
      const ctx = await trading.backtests.loadContext(companyId, queued.id);
      expect(ctx.priorReads).toHaveLength(1);
      expect(ctx.priorTrials).toHaveLength(1);
      // A strategy of another template sees none of it.
      const other = await service().createStrategy(companyId, createTradingStrategySchema.parse({ name: "Other", asset: "BTC", timeframe: "4h" }), { actorType: "user", actorId: "owner-1" });
      expect(await trading.backtests.holdoutReadCount(companyId, other.id)).toBe(0);
    });

    it("counts what a strategy of the template read against the template's next report", async () => {
      const companyId = await seedCompany();
      const template = findTradingTemplate("trend_continuation")!;
      const strategy = await service().createStrategy(companyId, createTradingStrategySchema.parse({ name: "TC", asset: "BTC", timeframe: template.spec.universe.decisionTimeframe }), { actorType: "user", actorId: "owner-1" }, template);
      const trading = service();
      const queued = await trading.backtests.queueRun(companyId, strategy.id, { purpose: "gate" }, OWNER);
      // Other tests may have left runs waiting: drain until this one is claimed.
      for (let i = 0; i < 20; i++) {
        const next = await trading.backtests.claimNextRun();
        if (!next || next.id === queued.id) break;
        await trading.backtests.failRun(next.companyId, next.id, "drained by the test");
      }
      const [version] = await db.select().from(tradingStrategyVersions).where(eq(tradingStrategyVersions.strategyId, strategy.id));
      await trading.backtests.finishRun(companyId, queued.id, outcome(false), { strategyId: strategy.id, versionId: version!.id, templateKey: "trend_continuation", purpose: "gate" });
      const report = await store().queueReport("trend_continuation", SYSTEM);
      const ctx = await store().loadContext(report.id);
      expect(ctx.priorReads.length).toBe(1);
      expect(ctx.priorTrials.length).toBe(1);
      await store().failReport(report.id, "test cleanup");
    });
  });
});
