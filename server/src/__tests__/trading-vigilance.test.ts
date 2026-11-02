import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { companies, createDb, tradingAlerts, tradingCandles, tradingDailyStats, tradingRegimes, tradingStrategies, type Db } from "@paperclipai/db";
import { TRADING_ALERT_DEFAULTS, TRADING_REGIME_RULES_VERSION, updateTradingAlertSettingsSchema } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { tradingService } from "../services/trading.js";
import { tradingVigilanceService } from "../services/trading-vigilance.js";
import { tradingVigilanceRunner } from "../services/trading-vigilance-runner.js";
import { tradingAlertsService } from "../services/trading-alerts.js";

/**
 * DUR-5017: the vigilance alerts against a real Postgres. The three things the
 * ticket accepts: each event fires once per occurrence, the text reads in plain
 * words, and switching an event off stops it.
 */

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RISK = { maxPositionNok: 5_000, maxTotalExposureNok: 15_000, maxOrdersPerDay: 20, dailyLossLimitNok: 1_000, maxDrawdownPct: 20, priceBandPct: 5, approvalAboveNok: 1_000_000_000, feeRatePct: 0.25 };
// A fixed "now": 09:30 UTC, after the daily summary hour.
const NOW = new Date(Date.UTC(2026, 10, 2, 9, 30));

describeDb("vigilance alerts (DUR-5017)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db!: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-trading-vigilance-");
    db = createDb(tempDb.connectionString);
  }, 90_000);
  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(opts: { strategy?: Partial<typeof tradingStrategies.$inferInsert> | false } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Vigil Co", issuePrefix: `V${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    let strategyId: string | null = null;
    if (opts.strategy !== false) {
      strategyId = randomUUID();
      await db.insert(tradingStrategies).values({
        id: strategyId,
        companyId,
        name: "My BTC rule",
        asset: "BTC",
        timeframe: "4h",
        status: "paused",
        ruleConfig: { type: "sma_crossover", version: 1, fastPeriod: 2, slowPeriod: 3, orderSizeFraction: 0.5 },
        riskConfig: RISK,
        startingCashNok: 2_000,
        cashNok: 2_000,
        peakEquityNok: 2_000,
        ...opts.strategy,
      });
    }
    return { companyId, strategyId };
  }

  const alertsOf = async (companyId: string, kind?: string) =>
    (await db.select().from(tradingAlerts).where(kind ? and(eq(tradingAlerts.companyId, companyId), eq(tradingAlerts.kind, kind)) : eq(tradingAlerts.companyId, companyId))).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  async function setRegime(asset: string, day: string, trend: string, volatility: string, spellNo: number, spellStartDay: string) {
    await db
      .insert(tradingRegimes)
      .values({
        asset,
        rulesVersion: TRADING_REGIME_RULES_VERSION,
        day,
        availableAt: new Date(Date.parse(`${day}T00:00:00Z`) + DAY),
        source: "kraken",
        trend,
        volatility,
        squeeze: false,
        close: 100,
        sma200: 100,
        adx: 20,
        atrPct: 2,
        atrPctPercentile: 50,
        bbWidthPercentile: 50,
        spellNo,
        spellStartDay,
      })
      .onConflictDoNothing();
  }

  it("market-weather flip: queued once for companies that trade, in plain words; a second pass adds nothing", async () => {
    const { companyId } = await seedCompany();
    const { companyId: noTrading } = await seedCompany({ strategy: false });
    await setRegime("ETH", "2026-10-30", "uptrend", "normal", 1, "2026-09-01");
    await setRegime("ETH", "2026-10-31", "ranging", "high", 2, "2026-10-31");
    const vigilance = tradingVigilanceService(db, { now: () => NOW });

    expect((await vigilance.sweep(NOW)).weatherFlips).toBeGreaterThanOrEqual(1);
    const first = await alertsOf(companyId, "market_weather_flip");
    expect(first).toHaveLength(1);
    expect(first[0]!.text).toContain("Market weather changed for Ethereum");
    expect(first[0]!.text).toContain("moving sideways");
    expect(first[0]!.text).not.toMatch(/ADX|ATR|spell|regime/i);
    expect(await alertsOf(noTrading)).toHaveLength(0);

    await vigilance.sweep(new Date(NOW.getTime() + 10 * 60_000));
    expect(await alertsOf(companyId, "market_weather_flip")).toHaveLength(1);
  });

  it("market-weather flip: an old flip (feature just switched on) is not news, and an unchanged label is not a flip", async () => {
    const { companyId } = await seedCompany();
    await setRegime("SOL", "2026-08-01", "uptrend", "normal", 1, "2026-07-01");
    await setRegime("SOL", "2026-08-02", "downtrend", "normal", 2, "2026-08-02");
    await setRegime("ADA", "2026-10-30", "uptrend", "normal", 1, "2026-09-01");
    await setRegime("ADA", "2026-10-31", "uptrend", "normal", 1, "2026-09-01");
    await tradingVigilanceService(db, { now: () => NOW }).sweep(NOW);
    const texts = (await alertsOf(companyId, "market_weather_flip")).map((a) => a.text);
    expect(texts.some((t) => t.includes("Solana") || t.includes("Cardano"))).toBe(false);
  });

  it("switching weather flips off stops them; switching it back on lets the next one through", async () => {
    const { companyId } = await seedCompany();
    const vigilance = tradingVigilanceService(db, { now: () => NOW });
    await vigilance.updateSettings(companyId, { weatherFlips: false });
    await setRegime("DOGE", "2026-10-30", "uptrend", "normal", 1, "2026-09-01");
    await setRegime("DOGE", "2026-10-31", "downtrend", "normal", 2, "2026-10-31");
    await vigilance.sweep(NOW);
    expect((await alertsOf(companyId, "market_weather_flip")).filter((a) => a.text.includes("Dogecoin"))).toHaveLength(0);

    await vigilance.updateSettings(companyId, { weatherFlips: true });
    await vigilance.sweep(new Date(NOW.getTime() + 10 * 60_000));
    expect((await alertsOf(companyId, "market_weather_flip")).filter((a) => a.text.includes("Dogecoin"))).toHaveLength(1);
  });

  /** 4h Kraken bars for a coin: small steady swings, then one last bar that moves `lastMovePct`. The last bar closed 1h before NOW. */
  async function seedFourHourBars(asset: string, market: string, lastMovePct: number) {
    const lastOpen = NOW.getTime() - 5 * HOUR;
    const rows = Array.from({ length: 40 }, (_, i) => {
      const openTime = new Date(lastOpen - (39 - i) * 4 * HOUR);
      const open = 100;
      const close = i === 39 ? 100 * (1 + lastMovePct / 100) : 100 + (i % 2 === 0 ? 0.3 : -0.3);
      return { source: "kraken", market, timeframe: "4h", openTime, open, high: Math.max(open, close) + 0.3, low: Math.min(open, close) - 0.3, close, volume: 5 };
    });
    await db.insert(tradingCandles).values(rows).onConflictDoNothing();
    return new Date(lastOpen);
  }

  it("unusually big move: fires once for the bar, reads in plain words, and a quiet bar does not fire", async () => {
    const { companyId } = await seedCompany();
    await seedFourHourBars("XRP", "XRP/USD", -9);
    await seedFourHourBars("LTC", "LTC/USD", 0.2);
    const vigilance = tradingVigilanceService(db, { now: () => NOW });

    await vigilance.sweep(NOW);
    await vigilance.sweep(new Date(NOW.getTime() + 10 * 60_000));
    const moves = await alertsOf(companyId, "big_move");
    expect(moves).toHaveLength(1);
    expect(moves[0]!.text).toMatch(/^Unusually big move: XRP fell about 9\.0% in the last 4 hours/);
    expect(moves[0]!.text).not.toMatch(/ATR|sigma|standard deviation/i);
  });

  it("unusually big move: the company's own threshold decides, and a switched-off company gets nothing", async () => {
    const strict = await seedCompany();
    const lax = await seedCompany();
    const off = await seedCompany();
    const vigilance = tradingVigilanceService(db, { now: () => NOW });
    await vigilance.updateSettings(lax.companyId, { bigMoveAtrK: 10 });
    await vigilance.updateSettings(off.companyId, { bigMoves: false });
    await seedFourHourBars("TRX", "TRX/USD", 7);
    await vigilance.sweep(NOW);
    const hasTrx = async (companyId: string) => (await alertsOf(companyId, "big_move")).some((a) => a.text.includes("TRON"));
    expect(await hasTrx(strict.companyId)).toBe(true);
    expect(await hasTrx(lax.companyId)).toBe(false);
    expect(await hasTrx(off.companyId)).toBe(false);
  });

  it("breaker trips: entries halted and the data breaker each queue once, name the strategy, and the switch stops them", async () => {
    const { companyId, strategyId } = await seedCompany();
    const vigilance = tradingVigilanceService(db, { now: () => NOW });
    const strategy = { id: strategyId!, companyId, name: "My BTC rule", asset: "BTC" };

    expect(await vigilance.entriesHalted(strategy, "drawdown_limit", NOW)).toBe(true);
    expect(await vigilance.entriesHalted(strategy, "drawdown_limit", NOW)).toBe(false); // the same trip, seen twice
    expect(await vigilance.strategyHalted(strategy, NOW)).toBe(true);
    const halted = await alertsOf(companyId, "entries_halted");
    expect(halted).toHaveLength(1);
    expect(halted[0]!.text).toContain('Safety stop: your strategy "My BTC rule" (Bitcoin)');
    expect(halted[0]!.text).toContain("paper money");
    expect(halted[0]!.text).not.toMatch(/drawdown_limit|circuit_breaker/);
    expect(await alertsOf(companyId, "strategy_halted")).toHaveLength(1);

    await vigilance.updateSettings(companyId, { breakerTrips: false });
    expect(await vigilance.entriesHalted(strategy, "daily_loss_limit", new Date(NOW.getTime() + HOUR))).toBe(false);
    expect(await vigilance.strategyHalted(strategy, new Date(NOW.getTime() + HOUR))).toBe(false);
    expect(await alertsOf(companyId, "entries_halted")).toHaveLength(1);
    expect(await alertsOf(companyId, "strategy_halted")).toHaveLength(1);
  });

  it("the tick itself queues the alert when the data breaker or a halt trips (wired into the trading service)", async () => {
    const { companyId, strategyId } = await seedCompany({ strategy: { status: "running", consecutiveErrors: 4, nextCheckAt: new Date(NOW.getTime() - HOUR) } });
    // A market source that always fails drives recordTickFailure to its 5th straight error.
    const failing = {
      fetchCandles: async () => ({ kind: "upstream" as const, message: "exchange down" }),
      fetchQuote: async () => ({ kind: "upstream" as const, message: "exchange down" }),
      marketAvailability: async () => "present" as const,
    };
    const trading = tradingService(db, { now: () => NOW, marketData: failing as never });
    await trading.tick(NOW);
    const [row] = await db.select().from(tradingStrategies).where(eq(tradingStrategies.id, strategyId!));
    expect(row!.status).toBe("halted_risk");
    const alerts = await alertsOf(companyId, "strategy_halted");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.text).toContain("could not get fresh market prices");
  });

  it("paused after restart: nothing before the chosen hours, one alert after, never again, and never for a manual pause", async () => {
    const { companyId, strategyId } = await seedCompany({ strategy: { status: "running" } });
    const manual = await seedCompany({ strategy: { status: "paused", pauseReason: "manual" } });
    // The real boot path: running strategies are paused with reason "restart" and a ledger note.
    await tradingService(db, { now: () => NOW }).reconcileOnBoot();
    const [row] = await db.select().from(tradingStrategies).where(eq(tradingStrategies.id, strategyId!));
    expect(row).toMatchObject({ status: "paused", pauseReason: "restart" });

    const vigilance = tradingVigilanceService(db);
    const realNow = Date.now();
    await vigilance.sweep(new Date(realNow + HOUR)); // 1h < the 2h default
    expect(await alertsOf(companyId, "paused_after_restart")).toHaveLength(0);

    await vigilance.sweep(new Date(realNow + 3 * HOUR));
    await vigilance.sweep(new Date(realNow + 5 * HOUR));
    const alerts = await alertsOf(companyId, "paused_after_restart");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.text).toContain('Still paused: your strategy "My BTC rule"');
    expect(alerts[0]!.text).toContain("It does not start again by itself");
    expect(await alertsOf(manual.companyId, "paused_after_restart")).toHaveLength(0);
  });

  it("paused after restart: the hours are the company's own, and the switch stops it", async () => {
    const own = await seedCompany({ strategy: { status: "paused", pauseReason: "restart" } });
    const off = await seedCompany({ strategy: { status: "paused", pauseReason: "restart" } });
    const vigilance = tradingVigilanceService(db);
    await vigilance.updateSettings(own.companyId, { pausedAfterRestartHours: 12 });
    await vigilance.updateSettings(off.companyId, { pausedAfterRestart: false });
    // No boot ledger note here, so the row's own updated_at is "when it was paused".
    const base = Date.now();
    await vigilance.sweep(new Date(base + 6 * HOUR));
    expect(await alertsOf(own.companyId, "paused_after_restart")).toHaveLength(0);
    await vigilance.sweep(new Date(base + 13 * HOUR));
    expect(await alertsOf(own.companyId, "paused_after_restart")).toHaveLength(1);
    expect(await alertsOf(off.companyId, "paused_after_restart")).toHaveLength(0);
  });

  it("daily summary: nothing before 07:00 UTC, one message a day after, and it can be switched off", async () => {
    const { companyId, strategyId } = await seedCompany();
    const off = await seedCompany();
    await db.insert(tradingDailyStats).values({ companyId, strategyId: strategyId!, statDate: "2026-11-01", realizedPnlNok: 120, ordersCount: 2 });
    const vigilance = tradingVigilanceService(db);
    await vigilance.updateSettings(off.companyId, { dailySummary: false });

    await vigilance.sweep(new Date(Date.UTC(2026, 10, 2, 6, 30)));
    expect(await alertsOf(companyId, "daily_summary")).toHaveLength(0);

    await vigilance.sweep(new Date(Date.UTC(2026, 10, 2, 7, 5)));
    await vigilance.sweep(new Date(Date.UTC(2026, 10, 2, 15, 0)));
    const first = await alertsOf(companyId, "daily_summary");
    expect(first).toHaveLength(1);
    expect(first[0]!.text).toContain("Daily trading summary. You have 1 paper-trading strategy: 0 trading, 1 paused, 0 stopped by a safety rule.");
    expect(first[0]!.text).toContain("Yesterday there were 2 trades, with a result of +120 NOK on paper.");

    await vigilance.sweep(new Date(Date.UTC(2026, 10, 3, 8, 0)));
    expect(await alertsOf(companyId, "daily_summary")).toHaveLength(2);
    expect(await alertsOf(off.companyId, "daily_summary")).toHaveLength(0);
  });

  it("alerts are company-scoped: one company's occurrence never lands in, or blocks, another's outbox", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const vigilance = tradingVigilanceService(db, { now: () => NOW });
    await vigilance.entriesHalted({ id: a.strategyId!, companyId: a.companyId, name: "A", asset: "BTC" }, "circuit_breaker", NOW);
    await vigilance.entriesHalted({ id: b.strategyId!, companyId: b.companyId, name: "B", asset: "BTC" }, "circuit_breaker", NOW);
    const outboxA = await tradingAlertsService(db).outbox(a.companyId);
    const outboxB = await tradingAlertsService(db).outbox(b.companyId);
    expect(outboxA.filter((x) => x.kind === "entries_halted").map((x) => x.text).join()).toContain('"A"');
    expect(outboxA.map((x) => x.text).join()).not.toContain('"B"');
    expect(outboxB.filter((x) => x.kind === "entries_halted")).toHaveLength(1);
  });

  it("settings: default to everything on, change one at a time, and refuse nonsense", async () => {
    const { companyId } = await seedCompany();
    const vigilance = tradingVigilanceService(db);
    expect(await vigilance.getSettings(companyId)).toEqual({ weatherFlips: true, bigMoves: true, breakerTrips: true, pausedAfterRestart: true, dailySummary: true, bigMoveAtrK: TRADING_ALERT_DEFAULTS.bigMoveAtrK, pausedAfterRestartHours: TRADING_ALERT_DEFAULTS.pausedAfterRestartHours });
    expect(await vigilance.updateSettings(companyId, { dailySummary: false })).toMatchObject({ dailySummary: false, weatherFlips: true });
    expect(await vigilance.updateSettings(companyId, { bigMoveAtrK: 4.5 })).toMatchObject({ dailySummary: false, bigMoveAtrK: 4.5 });
    expect(updateTradingAlertSettingsSchema.safeParse({}).success).toBe(false);
    expect(updateTradingAlertSettingsSchema.safeParse({ bigMoveAtrK: 0.2 }).success).toBe(false);
    expect(updateTradingAlertSettingsSchema.safeParse({ pausedAfterRestartHours: 0 }).success).toBe(false);
    expect(updateTradingAlertSettingsSchema.safeParse({ pausedAfterRestartHours: 2.5 }).success).toBe(false);
    expect(updateTradingAlertSettingsSchema.safeParse({ companyId: "x", dailySummary: true }).success).toBe(false);
  });

  it("the runner waits for its start delay, runs a pass, and then waits its interval", async () => {
    let calls = 0;
    let clock = new Date(NOW);
    const runner = tradingVigilanceRunner({
      db,
      logger: { info() {}, error() {} },
      startDelayMs: 60_000,
      everyMs: 10 * 60_000,
      now: () => clock,
      sweep: async () => {
        calls += 1;
        return { weatherFlips: 0, bigMoves: 0, pausedAfterRestart: 0, dailySummaries: 0 };
      },
    });
    expect((await runner.tick(clock)).started).toBe(false);
    clock = new Date(NOW.getTime() + 61_000);
    expect((await runner.tick(clock)).started).toBe(true);
    clock = new Date(clock.getTime() + 5 * 60_000);
    expect((await runner.tick(clock)).started).toBe(false);
    clock = new Date(clock.getTime() + 6 * 60_000);
    expect((await runner.tick(clock)).started).toBe(true);
    expect(calls).toBe(2);
  });

  it("a failing pass is logged, not thrown, and the runner tries again at the next interval", async () => {
    const errors: string[] = [];
    let clock = new Date(NOW);
    const runner = tradingVigilanceRunner({
      db,
      logger: { info() {}, error: (_f, m) => errors.push(m) },
      startDelayMs: 0,
      everyMs: 60_000,
      now: () => clock,
      sweep: async () => {
        throw new Error("db gone");
      },
    });
    expect((await runner.tick(clock)).result).toBeNull();
    expect(errors).toHaveLength(1);
    clock = new Date(clock.getTime() + 61_000);
    await runner.tick(clock);
    expect(errors).toHaveLength(2);
  });
});
