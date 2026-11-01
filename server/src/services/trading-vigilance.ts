/**
 * Vigilance alerts (DUR-5017, decision 16): the Telegram messages that make the
 * trading routine "vigilant". They reuse the existing trading-alerts outbox the
 * Telegram bridge already polls (DUR-5026); nothing new is delivered anywhere.
 *
 * Events, each with its own switch per company (trading_alert_settings; no row
 * means everything on):
 *   - weather_flips: a coin's market weather label changed (swept, not per tick)
 *   - big_moves: a closed 4-hour bar moved more than k ATR (swept)
 *   - breaker_trips: entries halted by a loss / drawdown / jump trip, or the
 *     data breaker stopped a strategy (called from the trading tick)
 *   - paused_after_restart: a strategy is still paused X hours after a restart (swept)
 *   - daily_summary: one message a day (swept)
 *
 * Rules kept here, not left to callers:
 *   - Each occurrence is queued once: every alert carries a dedupe key and the
 *     database refuses a second row with the same (company, key). A re-run of a
 *     sweep, or two server instances sweeping at once, cannot double-send.
 *   - The switch is read at the moment of queueing, so switching an event off
 *     stops it from the next check on. An alert already queued is still sent.
 *   - Text is built here from facts the server holds, never from agent text.
 *   - Alerts are company-scoped. Who in the company receives them is decided by
 *     the Telegram bridge's bot setup for that company (the owner/admin chat);
 *     this code never addresses a person, and only reads the owner's own rows.
 *   - Writing an alert must never stop the trading logic around it: callers get
 *     a boolean back and errors are logged without text.
 */

import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tradingAlertSettings, tradingCandles, tradingDailyStats, tradingLedgerEntries, tradingRegimes, tradingStrategies } from "@paperclipai/db";
import {
  TRADING_ALERT_DEFAULTS,
  TRADING_ASSETS,
  TRADING_ASSET_NAMES,
  TRADING_REGIME_RULES_VERSION,
  atrPercent,
  describeRegime,
  tradingCandleMarket,
  type RegimeBar,
  type TradingAlertEvent,
  type TradingAlertKind,
  type TradingAlertSettings,
  type TradingAsset,
  type TradingCandleSource,
  type TradingRegimeTrend,
  type TradingRegimeVolatility,
  type UpdateTradingAlertSettingsInput,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { tradingAlertsService } from "./trading-alerts.js";

const HOUR_MS = 3_600_000;
const FOUR_HOURS_MS = 4 * HOUR_MS;
/** Closed 4h bars needed before an ATR(14) means anything. */
const ATR_PERIOD = 14;
const BAR_LOOKBACK = 60;
/** A flip or a big move is only worth a message while it is news; older ones (a feature just switched on, a backlog) are skipped. */
const WEATHER_FLIP_MAX_AGE_MS = 36 * HOUR_MS;
const BIG_MOVE_MAX_AGE_MS = 8 * HOUR_MS;
/** The daily summary goes out from 07:00 UTC (08:00/09:00 in Norway) and covers the day before. */
const DAILY_SUMMARY_HOUR_UTC = 7;
const SOURCE_PREFERENCE: readonly TradingCandleSource[] = ["kraken", "coinbase"];

export interface TradingVigilanceDeps {
  now?: () => Date;
  /** Tests inject a recorder; the default writes to the trading_alerts outbox. */
  write?: (input: { companyId: string; kind: TradingAlertKind; text: string; dedupeKey: string }) => Promise<boolean>;
}

export interface VigilanceSweepResult {
  weatherFlips: number;
  bigMoves: number;
  pausedAfterRestart: number;
  dailySummaries: number;
}

type SettingsRow = typeof tradingAlertSettings.$inferSelect;

const EVENT_COLUMN: Record<TradingAlertEvent, keyof Pick<SettingsRow, "weatherFlipsOn" | "bigMovesOn" | "breakerTripsOn" | "pausedAfterRestartOn" | "dailySummaryOn">> = {
  weather_flips: "weatherFlipsOn",
  big_moves: "bigMovesOn",
  breaker_trips: "breakerTripsOn",
  paused_after_restart: "pausedAfterRestartOn",
  daily_summary: "dailySummaryOn",
};

export function defaultTradingAlertSettings(): TradingAlertSettings {
  return {
    weatherFlips: true,
    bigMoves: true,
    breakerTrips: true,
    pausedAfterRestart: true,
    dailySummary: true,
    bigMoveAtrK: TRADING_ALERT_DEFAULTS.bigMoveAtrK,
    pausedAfterRestartHours: TRADING_ALERT_DEFAULTS.pausedAfterRestartHours,
  };
}

function settingsOf(row: SettingsRow | undefined): TradingAlertSettings {
  if (!row) return defaultTradingAlertSettings();
  return {
    weatherFlips: row.weatherFlipsOn,
    bigMoves: row.bigMovesOn,
    breakerTrips: row.breakerTripsOn,
    pausedAfterRestart: row.pausedAfterRestartOn,
    dailySummary: row.dailySummaryOn,
    bigMoveAtrK: row.bigMoveAtrK,
    pausedAfterRestartHours: row.pausedAfterRestartHours,
  };
}

function enabledIn(settings: TradingAlertSettings, event: TradingAlertEvent): boolean {
  switch (event) {
    case "weather_flips":
      return settings.weatherFlips;
    case "big_moves":
      return settings.bigMoves;
    case "breaker_trips":
      return settings.breakerTrips;
    case "paused_after_restart":
      return settings.pausedAfterRestart;
    case "daily_summary":
      return settings.dailySummary;
  }
}

function assetName(asset: string): string {
  return (TRADING_ASSET_NAMES as Record<string, string>)[asset] ?? asset;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatNok(value: number): string {
  const rounded = Math.round(value);
  const sign = rounded > 0 ? "+" : rounded < 0 ? "-" : "";
  return `${sign}${Math.abs(rounded).toLocaleString("en-US")} NOK`;
}

function hoursWord(hours: number): string {
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

const TREND_WORDS: Record<TradingRegimeTrend, string> = { uptrend: "going up", downtrend: "going down", ranging: "moving sideways" };
const SWING_WORDS: Record<TradingRegimeVolatility, string> = { low: "calm", normal: "normal", high: "big" };

/** The trip a strategy's entries halt names, in words a non-trader reads. */
function haltSentence(cause: "daily_loss_limit" | "drawdown_limit" | "circuit_breaker"): string {
  switch (cause) {
    case "daily_loss_limit":
      return "it lost as much today as its daily limit allows. It starts looking for trades again on its own tomorrow.";
    case "drawdown_limit":
      return "its total value fell too far below its best level. It stays stopped until you start it again on the Trading page.";
    case "circuit_breaker":
      return "the price jumped suddenly from one step to the next, which it treats as a sign something is wrong. It stays stopped until you start it again on the Trading page.";
  }
}

export function tradingVigilanceService(db: Db, deps: TradingVigilanceDeps = {}) {
  const nowOf = () => deps.now?.() ?? new Date();
  const alerts = tradingAlertsService(db);
  const write = deps.write ?? ((input) => alerts.write({ companyId: input.companyId, walletId: null, kind: input.kind, text: input.text, dedupeKey: input.dedupeKey }));

  // ─── Settings ──────────────────────────────────────────────────────────

  async function getSettings(companyId: string): Promise<TradingAlertSettings> {
    const [row] = await db.select().from(tradingAlertSettings).where(eq(tradingAlertSettings.companyId, companyId));
    return settingsOf(row);
  }

  async function updateSettings(companyId: string, input: UpdateTradingAlertSettingsInput): Promise<TradingAlertSettings> {
    const values = {
      ...(input.weatherFlips !== undefined ? { weatherFlipsOn: input.weatherFlips } : {}),
      ...(input.bigMoves !== undefined ? { bigMovesOn: input.bigMoves } : {}),
      ...(input.breakerTrips !== undefined ? { breakerTripsOn: input.breakerTrips } : {}),
      ...(input.pausedAfterRestart !== undefined ? { pausedAfterRestartOn: input.pausedAfterRestart } : {}),
      ...(input.dailySummary !== undefined ? { dailySummaryOn: input.dailySummary } : {}),
      ...(input.bigMoveAtrK !== undefined ? { bigMoveAtrK: input.bigMoveAtrK } : {}),
      ...(input.pausedAfterRestartHours !== undefined ? { pausedAfterRestartHours: input.pausedAfterRestartHours } : {}),
    };
    const [row] = await db
      .insert(tradingAlertSettings)
      .values({ companyId, ...values })
      .onConflictDoUpdate({ target: tradingAlertSettings.companyId, set: { ...values, updatedAt: nowOf() } })
      .returning();
    return settingsOf(row);
  }

  // ─── Queueing ──────────────────────────────────────────────────────────

  /** Queue one occurrence if its event is switched on. True only when a new alert was queued. Never throws. */
  async function notify(companyId: string, event: TradingAlertEvent, kind: TradingAlertKind, dedupeKey: string, text: string, settings?: TradingAlertSettings): Promise<boolean> {
    try {
      const current = settings ?? (await getSettings(companyId));
      if (!enabledIn(current, event)) return false;
      return await write({ companyId, kind, text, dedupeKey });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.name : "unknown", companyId, kind }, "trading vigilance: could not queue an alert");
      return false;
    }
  }

  // ─── Event: breaker trips (called by the trading tick) ──────────────────

  /** Entries halted by a loss, drawdown or price-jump trip. `at` is the tick time: it names this occurrence. */
  async function entriesHalted(strategy: { id: string; companyId: string; name: string; asset: string }, cause: "daily_loss_limit" | "drawdown_limit" | "circuit_breaker", at: Date): Promise<boolean> {
    const text = `Safety stop: your strategy "${strategy.name}" (${assetName(strategy.asset)}) has stopped opening new trades because ${haltSentence(cause)} It still looks after any trade it already has open. Only paper money is involved.`;
    return notify(strategy.companyId, "breaker_trips", "entries_halted", `entries_halted:${strategy.id}:${cause}:${at.toISOString()}`, text);
  }

  /** The data breaker: too many failed price fetches in a row stopped the strategy completely. */
  async function strategyHalted(strategy: { id: string; companyId: string; name: string; asset: string }, at: Date): Promise<boolean> {
    const text = `Safety stop: your strategy "${strategy.name}" (${assetName(strategy.asset)}) has stopped completely because it could not get fresh market prices several times in a row, and it will not trade on old prices. It stays stopped until you start it again on the Trading page.`;
    return notify(strategy.companyId, "breaker_trips", "strategy_halted", `strategy_halted:${strategy.id}:${at.toISOString()}`, text);
  }

  // ─── Sweeps (scheduler) ────────────────────────────────────────────────

  /** Companies that run trading strategies: the only ones market-wide events are worth sending to. */
  async function tradingCompanyIds(): Promise<string[]> {
    const rows = await db.selectDistinct({ companyId: tradingStrategies.companyId }).from(tradingStrategies);
    return rows.map((row) => row.companyId);
  }

  async function settingsByCompany(companyIds: string[]): Promise<Map<string, TradingAlertSettings>> {
    const map = new Map<string, TradingAlertSettings>();
    if (companyIds.length === 0) return map;
    const rows = await db.select().from(tradingAlertSettings).where(inArray(tradingAlertSettings.companyId, companyIds));
    for (const row of rows) map.set(row.companyId, settingsOf(row));
    return map;
  }

  /** A coin's weather label changed since the day before. */
  async function sweepWeatherFlips(now: Date, companyIds: string[], settings: Map<string, TradingAlertSettings>): Promise<number> {
    let sent = 0;
    for (const asset of TRADING_ASSETS) {
      const rows = await db
        .select()
        .from(tradingRegimes)
        .where(and(eq(tradingRegimes.asset, asset), eq(tradingRegimes.rulesVersion, TRADING_REGIME_RULES_VERSION), lte(tradingRegimes.availableAt, now)))
        .orderBy(desc(tradingRegimes.availableAt))
        .limit(2);
      const [latest, previous] = rows;
      if (!latest || !previous) continue;
      if (now.getTime() - latest.availableAt.getTime() > WEATHER_FLIP_MAX_AGE_MS) continue;
      const flipped = latest.trend !== previous.trend || latest.volatility !== previous.volatility || latest.squeeze !== previous.squeeze;
      if (!flipped) continue;
      const name = assetName(asset);
      const nowText = describeRegime(asset as TradingAsset, latest as never, now).replace(`${name}: `, "");
      const wasText = describeRegime(asset as TradingAsset, previous as never, now).replace(`${name}: `, "");
      const text = `Market weather changed for ${name}. Now: ${nowText}. Before: ${wasText}. In plain words, ${name} is now ${TREND_WORDS[latest.trend as TradingRegimeTrend]} with ${SWING_WORDS[latest.volatility as TradingRegimeVolatility]} price swings. The Trading page shows the full picture.`;
      for (const companyId of companyIds) {
        if (await notify(companyId, "weather_flips", "market_weather_flip", `weather_flip:${asset}:${latest.day}`, text, settings.get(companyId) ?? defaultTradingAlertSettings())) sent += 1;
      }
    }
    return sent;
  }

  async function loadClosedFourHourBars(asset: TradingAsset, now: Date): Promise<RegimeBar[]> {
    for (const source of SOURCE_PREFERENCE) {
      const rows = await db
        .select({ openTime: tradingCandles.openTime, open: tradingCandles.open, high: tradingCandles.high, low: tradingCandles.low, close: tradingCandles.close })
        .from(tradingCandles)
        .where(
          and(
            eq(tradingCandles.source, source),
            eq(tradingCandles.market, tradingCandleMarket(source, asset)),
            eq(tradingCandles.timeframe, "4h"),
            // Closed bars only: a bar is closed once its open time is a full 4 hours back.
            lte(tradingCandles.openTime, new Date(now.getTime() - FOUR_HOURS_MS)),
          ),
        )
        .orderBy(desc(tradingCandles.openTime))
        .limit(BAR_LOOKBACK);
      if (rows.length > ATR_PERIOD + 1) return rows.reverse();
    }
    return [];
  }

  /**
   * An unusually big move: the newest closed 4-hour bar's open-to-close move is
   * more than k times the ATR(14) measured on the bars BEFORE it (so a spike
   * cannot hide itself by inflating its own yardstick).
   */
  async function sweepBigMoves(now: Date, companyIds: string[], settings: Map<string, TradingAlertSettings>): Promise<number> {
    let sent = 0;
    for (const asset of TRADING_ASSETS) {
      const bars = await loadClosedFourHourBars(asset, now);
      const last = bars[bars.length - 1];
      const before = bars[bars.length - 2];
      if (!last || !before) continue;
      if (now.getTime() - (last.openTime.getTime() + FOUR_HOURS_MS) > BIG_MOVE_MAX_AGE_MS) continue;
      const atrAtBefore = atrPercent(bars.slice(0, -1), ATR_PERIOD).at(-1);
      if (atrAtBefore === null || atrAtBefore === undefined || atrAtBefore <= 0) continue;
      const atr = (atrAtBefore / 100) * before.close;
      const move = last.close - last.open;
      const multiple = Math.abs(move) / atr;
      const movePct = (move / last.open) * 100;
      const name = assetName(asset);
      const barKey = last.openTime.toISOString();
      for (const companyId of companyIds) {
        const own = settings.get(companyId) ?? defaultTradingAlertSettings();
        if (multiple <= own.bigMoveAtrK) continue;
        const direction = move > 0 ? "rose" : "fell";
        const text = `Unusually big move: ${name} ${direction} about ${Math.abs(movePct).toFixed(1)}% in the last 4 hours. That is about ${multiple.toFixed(1)} times its usual 4-hour swing (you get this message above ${own.bigMoveAtrK} times). Strategies keep following their own rules and safety stops.`;
        if (await notify(companyId, "big_moves", "big_move", `big_move:${asset}:${barKey}`, text, own)) sent += 1;
      }
    }
    return sent;
  }

  /** The moment a strategy was paused by a restart: the boot's own ledger note, else the row's last change. */
  async function restartPausedAt(strategy: { id: string; updatedAt: Date }): Promise<Date> {
    const [entry] = await db
      .select({ createdAt: tradingLedgerEntries.createdAt })
      .from(tradingLedgerEntries)
      .where(and(eq(tradingLedgerEntries.strategyId, strategy.id), eq(tradingLedgerEntries.eventType, "reconciliation"), sql`${tradingLedgerEntries.detail}->>'reason' = 'server_restart'`))
      .orderBy(desc(tradingLedgerEntries.createdAt))
      .limit(1);
    return entry?.createdAt ?? strategy.updatedAt;
  }

  /** Strategies still paused (by a restart, not by the owner) after the company's chosen number of hours. */
  async function sweepPausedAfterRestart(now: Date, companyIds: string[], settings: Map<string, TradingAlertSettings>): Promise<number> {
    let sent = 0;
    for (const companyId of companyIds) {
      const own = settings.get(companyId) ?? defaultTradingAlertSettings();
      if (!own.pausedAfterRestart) continue;
      const paused = await db
        .select()
        .from(tradingStrategies)
        .where(and(eq(tradingStrategies.companyId, companyId), eq(tradingStrategies.status, "paused"), eq(tradingStrategies.pauseReason, "restart")))
        .orderBy(asc(tradingStrategies.createdAt));
      for (const strategy of paused) {
        const since = await restartPausedAt(strategy);
        if (now.getTime() - since.getTime() < own.pausedAfterRestartHours * HOUR_MS) continue;
        const hours = Math.max(own.pausedAfterRestartHours, Math.floor((now.getTime() - since.getTime()) / HOUR_MS));
        const text = `Still paused: your strategy "${strategy.name}" (${assetName(strategy.asset)}) has been paused for about ${hoursWord(hours)} since the system was last updated or restarted. It does not start again by itself, so it is not trading right now. Start it on the Trading page when you want it to continue.`;
        if (await notify(companyId, "paused_after_restart", "paused_after_restart", `paused_after_restart:${strategy.id}:${since.toISOString()}`, text, own)) sent += 1;
      }
    }
    return sent;
  }

  /** One short message a day, from 07:00 UTC, about the day before. */
  async function sweepDailySummaries(now: Date, companyIds: string[], settings: Map<string, TradingAlertSettings>): Promise<number> {
    if (now.getUTCHours() < DAILY_SUMMARY_HOUR_UTC) return 0;
    const today = utcDay(now);
    const yesterday = utcDay(new Date(now.getTime() - 24 * HOUR_MS));
    let sent = 0;
    let weatherLines: string[] | null = null;
    for (const companyId of companyIds) {
      const own = settings.get(companyId) ?? defaultTradingAlertSettings();
      if (!own.dailySummary) continue;
      const strategies = await db.select().from(tradingStrategies).where(eq(tradingStrategies.companyId, companyId));
      if (strategies.length === 0) continue;
      const running = strategies.filter((s) => s.status === "running");
      const entriesStopped = running.filter((s) => s.pauseReason === "daily_loss_limit" || s.pauseReason === "drawdown_limit" || s.pauseReason === "circuit_breaker").length;
      const stopped = entriesStopped + strategies.filter((s) => s.status === "halted_risk").length;
      const paused = strategies.filter((s) => s.status === "paused").length;
      const trading = running.length - entriesStopped;
      const stats = await db
        .select({ realizedPnlNok: tradingDailyStats.realizedPnlNok, ordersCount: tradingDailyStats.ordersCount })
        .from(tradingDailyStats)
        .where(and(eq(tradingDailyStats.companyId, companyId), eq(tradingDailyStats.statDate, yesterday)));
      const result = stats.reduce((sum, s) => sum + s.realizedPnlNok, 0);
      const trades = stats.reduce((sum, s) => sum + s.ordersCount, 0);
      const stops = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(tradingLedgerEntries)
        .where(and(eq(tradingLedgerEntries.companyId, companyId), eq(tradingLedgerEntries.eventType, "circuit_breaker"), gte(tradingLedgerEntries.createdAt, new Date(now.getTime() - 24 * HOUR_MS))));
      if (weatherLines === null) weatherLines = await currentWeatherLines(now);
      const parts = [
        `Daily trading summary. You have ${strategies.length} paper-trading ${strategies.length === 1 ? "strategy" : "strategies"}: ${trading} trading, ${paused} paused, ${stopped} stopped by a safety rule.`,
        trades === 0 ? "Yesterday there were no trades." : `Yesterday there ${trades === 1 ? "was 1 trade" : `were ${trades} trades`}, with a result of ${formatNok(result)} on paper.`,
        (stops[0]?.n ?? 0) > 0 ? `Safety stops in the last day: ${stops[0]!.n}.` : "No safety stops in the last day.",
        ...(weatherLines.length > 0 ? ["Market weather now:", ...weatherLines] : []),
      ];
      if (await notify(companyId, "daily_summary", "daily_summary", `daily_summary:${today}`, parts.join("\n"), own)) sent += 1;
    }
    return sent;
  }

  async function currentWeatherLines(now: Date): Promise<string[]> {
    const rows = await db
      .selectDistinctOn([tradingRegimes.asset])
      .from(tradingRegimes)
      .where(and(eq(tradingRegimes.rulesVersion, TRADING_REGIME_RULES_VERSION), lte(tradingRegimes.availableAt, now)))
      .orderBy(tradingRegimes.asset, desc(tradingRegimes.availableAt));
    return rows.slice(0, 12).map((row) => `- ${describeRegime(row.asset as TradingAsset, row as never, now)}`);
  }

  /** One pass over every event that is found by looking, not by being told. Safe to run as often as you like. */
  async function sweep(now: Date = nowOf()): Promise<VigilanceSweepResult> {
    const companyIds = await tradingCompanyIds();
    const settings = await settingsByCompany(companyIds);
    // One failing check must not hide the others.
    const run = async (label: string, fn: () => Promise<number>): Promise<number> => {
      try {
        return await fn();
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : "unknown", check: label }, "trading vigilance: a check failed");
        return 0;
      }
    };
    return {
      weatherFlips: await run("weather_flips", () => sweepWeatherFlips(now, companyIds, settings)),
      bigMoves: await run("big_moves", () => sweepBigMoves(now, companyIds, settings)),
      pausedAfterRestart: await run("paused_after_restart", () => sweepPausedAfterRestart(now, companyIds, settings)),
      dailySummaries: await run("daily_summary", () => sweepDailySummaries(now, companyIds, settings)),
    };
  }

  return { getSettings, updateSettings, entriesHalted, strategyHalted, sweep };
}

export type TradingVigilanceService = ReturnType<typeof tradingVigilanceService>;
