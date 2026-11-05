import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { approvals, companies, createDb, tradingLedgerEntries, tradingOrders, tradingRegimes, tradingShadowCells, tradingShadowTrades, tradingStrategies, type Db } from "@paperclipai/db";
import {
  TRADING_REGIME_RULES_VERSION,
  legacySmaCrossoverSpec,
  tradingTimeframeMs,
  type TradingCandle,
  type TradingRiskConfig,
  type TradingTemplate,
} from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { tradingShadowService } from "../services/trading-shadow.ts";

/**
 * DUR-5015: the shadow runs against a real Postgres. A shadow run records
 * simulated trades on closed bars and must not touch a paper balance, an order,
 * the ledger or an approval card. The database stamps decided_at itself, so the
 * signal bar is built from the real clock.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping trading shadow tests: ${support.reason ?? "unsupported environment"}`);

const TF = "4h" as const;
const TF_MS = tradingTimeframeMs(TF);
const RISK: TradingRiskConfig = { maxPositionNok: 5_000, maxTotalExposureNok: 15_000, maxOrdersPerDay: 20, dailyLossLimitNok: 1_000, maxDrawdownPct: 20, priceBandPct: 5, approvalAboveNok: 1_000_000_000, feeRatePct: 0.25 };

function bars(closes: number[], firstOpen: Date): TradingCandle[] {
  return closes.map((close, i) => ({ openTime: new Date(firstOpen.getTime() + i * TF_MS), open: close, high: close * 1.005, low: close * 0.995, close, volume: 1 }));
}

const WARM = Array.from({ length: 18 }, () => 20);
const CROSS_UP = [...WARM, 20, 20, 20, 21];
const AFTER = [22, 24, 26, 18, 14, 12];

const fakeTemplate: TradingTemplate = {
  key: "test_sma_trend",
  templateVersion: 1,
  wave: "first",
  style: "test",
  spec: legacySmaCrossoverSpec({ name: "Test SMA", asset: "BTC", timeframe: TF, rule: { type: "sma_crossover", version: 1, fastPeriod: 2, slowPeriod: 3, orderSizeFraction: 0.5 }, risk: RISK }),
  guidelines: "test",
  worksWhen: ["x"],
  failsWhen: ["y"],
  allowedWeather: { trend: ["up", "range"], squeeze: "any", note: "test" },
  startingValues: [{ path: "indicators.fast.period", label: "fast", status: "to_be_tested" }],
  requiresData: [],
  simplifications: [],
};

d("tradingShadowService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: Db;
  const signalClose = new Date(Math.floor(Date.now() / TF_MS) * TF_MS);
  const signalBarsFirstOpen = new Date(signalClose.getTime() - CROSS_UP.length * TF_MS);
  let served: TradingCandle[] = [];

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("trading-shadow");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);
  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Shadow Co", issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    const strategyId = randomUUID();
    await db.insert(tradingStrategies).values({
      id: strategyId,
      companyId,
      name: "S",
      asset: "BTC",
      timeframe: TF,
      status: "paused",
      ruleConfig: { type: "sma_crossover", version: 1, fastPeriod: 2, slowPeriod: 3, orderSizeFraction: 0.5 },
      riskConfig: RISK,
      startingCashNok: 2_000,
      cashNok: 2_000,
      peakEquityNok: 2_000,
    });
    return { companyId, strategyId };
  }

  async function seedWeather(trend: "uptrend" | "downtrend" | "ranging") {
    const day = new Date(signalClose.getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
    await db.delete(tradingRegimes);
    await db.insert(tradingRegimes).values({
      asset: "BTC",
      rulesVersion: TRADING_REGIME_RULES_VERSION,
      day,
      availableAt: new Date(Date.parse(day) + 86_400_000),
      source: "kraken",
      trend,
      volatility: "normal",
      squeeze: false,
      close: 20,
      sma200: 18,
      adx: 30,
      atrPct: 2,
      atrPctPercentile: 50,
      bbWidthPercentile: 50,
      spellNo: 1,
      spellStartDay: day,
    });
  }

  const service = (now: Date) =>
    tradingShadowService(db, {
      now: () => now,
      bootedAt: new Date(signalClose.getTime() - 30 * 86_400_000),
      templates: [fakeTemplate],
      loadBars: async (asset) => (asset === "BTC" ? served : []),
    });

  it("registers the cell, records the signal, and closes it later at both fee levels, touching no balance, order, ledger entry or approval", async () => {
    const { companyId, strategyId } = await seedCompany();
    await seedWeather("uptrend");
    served = bars(CROSS_UP, signalBarsFirstOpen);
    const touched = async () => ({
      strategy: (await db.select().from(tradingStrategies).where(eq(tradingStrategies.id, strategyId)))[0],
      orders: (await db.select().from(tradingOrders).where(eq(tradingOrders.companyId, companyId))).length,
      ledger: (await db.select().from(tradingLedgerEntries).where(eq(tradingLedgerEntries.companyId, companyId))).length,
      approvals: (await db.select().from(approvals).where(eq(approvals.companyId, companyId))).length,
    });
    const before = await touched();

    const shadow = service(new Date(signalClose.getTime() + 60_000));
    const first = await shadow.tick(new Date(signalClose.getTime() + 60_000));
    expect(first.cellsRegistered).toBe(1);
    expect(first.opened).toBe(1);
    const cells = await db.select().from(tradingShadowCells).where(eq(tradingShadowCells.companyId, companyId));
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ templateKey: "test_sma_trend", weather: "up", asset: "BTC", family: "trend" });
    const [open] = await db.select().from(tradingShadowTrades).where(eq(tradingShadowTrades.companyId, companyId));
    expect(open).toMatchObject({ status: "open", signalBarCloseAt: signalClose, weather: "up" });
    expect(open!.weatherLabel).toMatchObject({ trend: "uptrend", matrixVersion: 1 });

    // The same bar again changes nothing.
    const again = await shadow.tick(new Date(signalClose.getTime() + 120_000));
    expect(again.opened).toBe(0);
    expect(await db.select().from(tradingShadowTrades).where(eq(tradingShadowTrades.companyId, companyId))).toHaveLength(1);

    // Later bars arrive: the trade enters at the next open and exits on the cross down.
    served = bars([...CROSS_UP, ...AFTER], signalBarsFirstOpen);
    const later = new Date(signalClose.getTime() + AFTER.length * TF_MS + 60_000);
    const closed = await service(later).resolveOpen(later, { companies: 0, cellsRegistered: 0, signals: 0, opened: 0, closed: 0, voided: 0 });
    void closed;
    const [trade] = await db.select().from(tradingShadowTrades).where(eq(tradingShadowTrades.companyId, companyId));
    expect(trade!.voidReason).toBeNull();
    expect(trade!.status).toBe("closed");
    expect(trade!.exitReason).toBeTruthy();
    expect(trade!.entryAt!.getTime()).toBeGreaterThanOrEqual(signalClose.getTime());
    expect(trade!.exitAt!.getTime()).toBeGreaterThan(trade!.entryAt!.getTime());
    expect(trade!.r1x).not.toBeNull();
    expect(trade!.r2x).not.toBeNull();
    // Double fees can only cost more.
    expect(trade!.r2x!).toBeLessThan(trade!.r1x!);
    expect(trade!.netReturn2x!).toBeLessThan(trade!.netReturn1x!);

    // A closed trade is final.
    await expect(db.update(tradingShadowTrades).set({ r2x: 5 }).where(eq(tradingShadowTrades.id, trade!.id))).rejects.toThrow();

    expect(await touched()).toEqual(before);
  }, 60_000);

  it("runs a template only in weather its matrix row allows", async () => {
    const { companyId } = await seedCompany();
    await seedWeather("downtrend");
    served = bars(CROSS_UP, signalBarsFirstOpen);
    const now = new Date(signalClose.getTime() + 60_000);
    const result = await service(now).tick(now);
    expect(result.opened).toBe(0);
    expect(await db.select().from(tradingShadowCells).where(eq(tradingShadowCells.companyId, companyId))).toHaveLength(0);
  });

  it("keeps companies apart: each company gets its own cell and trade, none sees the other's", async () => {
    await seedWeather("uptrend");
    served = bars(CROSS_UP, signalBarsFirstOpen);
    const a = await seedCompany();
    const b = await seedCompany();
    const now = new Date(signalClose.getTime() + 60_000);
    const shadow = tradingShadowService(db, { now: () => now, bootedAt: new Date(signalClose.getTime() - 40 * 86_400_000), templates: [fakeTemplate], loadBars: async (asset) => (asset === "BTC" ? served : []) });
    await shadow.tick(now);
    for (const c of [a, b]) {
      const mine = await db.select().from(tradingShadowTrades).where(eq(tradingShadowTrades.companyId, c.companyId));
      expect(mine.length).toBeGreaterThanOrEqual(1);
      const cellIds = new Set((await db.select().from(tradingShadowCells).where(eq(tradingShadowCells.companyId, c.companyId))).map((x) => x.id));
      for (const t of mine) expect(cellIds.has(t.cellId)).toBe(true);
    }
    const [{ n }] = (await db.execute(sql`SELECT count(*)::int AS n FROM trading_shadow_trades t JOIN trading_shadow_cells c ON c.id = t.cell_id WHERE t.company_id <> c.company_id`)) as unknown as Array<{ n: number }>;
    expect(n).toBe(0);
    void and;
  });

  it("never signals a bar that closed before the process started", async () => {
    const { companyId } = await seedCompany();
    await seedWeather("uptrend");
    served = bars(CROSS_UP, signalBarsFirstOpen);
    const now = new Date(signalClose.getTime() + 60_000);
    const late = tradingShadowService(db, { now: () => now, bootedAt: new Date(signalClose.getTime() + 1_000), templates: [fakeTemplate], loadBars: async (asset) => (asset === "BTC" ? served : []) });
    const result = await late.tick(now);
    expect(result.opened).toBe(0);
    expect(await db.select().from(tradingShadowCells).where(eq(tradingShadowCells.companyId, companyId))).toHaveLength(0);
  });
  it("keeps orphaned open trades out of the resolve window, and gives them up once they are old enough", async () => {
    const { companyId } = await seedCompany();
    await seedWeather("uptrend");
    served = bars(CROSS_UP, signalBarsFirstOpen);
    const now0 = new Date(signalClose.getTime() + 60_000);
    await service(now0).tick(now0);
    const [real] = await db.select().from(tradingShadowTrades).where(eq(tradingShadowTrades.companyId, companyId));
    expect(real!.status).toBe("open");

    // 2,005 open trades of template versions that no longer compete, all older than the real trade (so oldest-first fills the window) but young.
    const [{ cellId }] = (await db.execute(sql`INSERT INTO trading_shadow_cells (company_id, template_key, template_version, family, weather, asset) VALUES (${companyId}, 'gone_template', 1, 'trend', 'up', 'ETH') RETURNING id AS "cellId"`)) as unknown as Array<{ cellId: string }>;
    await db.execute(sql`
      INSERT INTO trading_shadow_trades (company_id, cell_id, template_key, template_version, asset, timeframe, weather, signal_bar_close_at, weather_label)
      SELECT ${companyId}, ${cellId}, 'gone_template', v, 'ETH', '4h', 'up', now() - interval '5 days' - v * interval '1 minute', '{}'::jsonb FROM generate_series(1, 2005) AS v`);
    // And one old enough to be given up (more than 600 bars ago).
    await db.execute(sql`
      INSERT INTO trading_shadow_trades (company_id, cell_id, template_key, template_version, asset, timeframe, weather, signal_bar_close_at, weather_label)
      VALUES (${companyId}, ${cellId}, 'gone_template', 9999, 'ETH', '4h', 'up', now() - interval '200 days', '{}'::jsonb)`);

    served = bars([...CROSS_UP, ...AFTER], signalBarsFirstOpen);
    const later = new Date(signalClose.getTime() + AFTER.length * TF_MS + 60_000);
    const result = { companies: 0, cellsRegistered: 0, signals: 0, opened: 0, closed: 0, voided: 0 };
    await service(later).resolveOpen(later, result);

    expect(result.voided).toBeGreaterThanOrEqual(1);
    const [after] = await db.select().from(tradingShadowTrades).where(eq(tradingShadowTrades.id, real!.id));
    expect(after!.status).toBe("closed");
    const old = await db.select().from(tradingShadowTrades).where(and(eq(tradingShadowTrades.companyId, companyId), eq(tradingShadowTrades.templateVersion, 9999)));
    expect(old[0]).toMatchObject({ status: "void" });
    expect(old[0]!.voidReason).toMatch(/no longer run/);
    // The young orphans are left open (not voided) and nothing real was voided.
    const openOrphans = await db.select().from(tradingShadowTrades).where(and(eq(tradingShadowTrades.companyId, companyId), eq(tradingShadowTrades.status, "open")));
    expect(openOrphans).toHaveLength(2005);
  }, 90_000);
});
