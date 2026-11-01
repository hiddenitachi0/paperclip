import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tradingCandles, tradingRegimes } from "@paperclipai/db";
import {
  TRADING_ASSETS,
  TRADING_ASSET_NAMES,
  TRADING_REGIME_PARAMS,
  TRADING_REGIME_RULES_VERSION,
  computeRegimeLabels,
  describeRegime,
  regimeFlipCounts,
  regimeSpells,
  tradingCandleMarket,
  type RegimeBar,
  type TradingAsset,
  type TradingCandleSource,
  type TradingRegimeFlipCounts,
  type TradingRegimeLabel,
  type TradingRegimeSpell,
  type TradingRegimeTrend,
  type TradingRegimeVolatility,
} from "@paperclipai/shared";

/**
 * Market weather, database side (DUR-5013). The scheduler chain calls
 * `refreshRegimes` (bypass connection); company routes and the prediction /
 * past-data-test code call the read functions below with the request-scoped db.
 *
 * The rule that matters to every caller: read labels through `regimeAsOf` (or
 * `regimeWindow`), which only returns rows whose `available_at` has passed at
 * the decision time. Never select the newest row by day.
 */

const DAY_MS = 86_400_000;
/** Sources tried in this order for each coin; the first with enough closed daily bars wins. Binance is internal-test history only, so it is the last resort. */
const SOURCE_PREFERENCE: readonly TradingCandleSource[] = ["kraken", "coinbase", "binance"];
/** SMA200 + a full 365-day percentile window of a 14-day ATR. */
const MIN_BARS_FOR_ANY_LABEL = TRADING_REGIME_PARAMS.percentileWindowDays + TRADING_REGIME_PARAMS.atrDays + 1;
const WRITE_BATCH = 1000;
const SAME_TOLERANCE = 1e-9;

export interface StoredRegime {
  asset: TradingAsset;
  day: string;
  availableAt: Date;
  source: TradingCandleSource;
  trend: TradingRegimeTrend;
  volatility: TradingRegimeVolatility;
  squeeze: boolean;
  close: number;
  sma200: number;
  adx: number;
  atrPct: number;
  atrPctPercentile: number;
  bbWidthPercentile: number;
  spellNo: number;
  spellStartDay: string;
}

function toStored(row: typeof tradingRegimes.$inferSelect): StoredRegime {
  return {
    asset: row.asset as TradingAsset,
    day: row.day,
    availableAt: row.availableAt,
    source: row.source as TradingCandleSource,
    trend: row.trend as TradingRegimeTrend,
    volatility: row.volatility as TradingRegimeVolatility,
    squeeze: row.squeeze,
    close: row.close,
    sma200: row.sma200,
    adx: row.adx,
    atrPct: row.atrPct,
    atrPctPercentile: row.atrPctPercentile,
    bbWidthPercentile: row.bbWidthPercentile,
    spellNo: row.spellNo,
    spellStartDay: row.spellStartDay,
  };
}

// ─── Writing (scheduler, bypass connection) ───

export interface RefreshAssetResult {
  asset: TradingAsset;
  source: TradingCandleSource | null;
  bars: number;
  inserted: number;
  /** Past days whose stored label changed because older candles arrived. Logged by the caller. */
  revised: number;
}

function sameNumber(a: number, b: number): boolean {
  return Math.abs(a - b) <= SAME_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));
}

function sameLabel(stored: StoredRegime, next: TradingRegimeLabel, source: TradingCandleSource): boolean {
  return (
    stored.source === source &&
    stored.trend === next.trend &&
    stored.volatility === next.volatility &&
    stored.squeeze === next.squeeze &&
    stored.spellNo === next.spellNo &&
    stored.spellStartDay === next.spellStartDay &&
    sameNumber(stored.close, next.close) &&
    sameNumber(stored.sma200, next.sma200) &&
    sameNumber(stored.adx, next.adx) &&
    sameNumber(stored.atrPct, next.atrPct) &&
    sameNumber(stored.atrPctPercentile, next.atrPctPercentile) &&
    sameNumber(stored.bbWidthPercentile, next.bbWidthPercentile)
  );
}

async function loadDailyBars(db: Db, source: TradingCandleSource, asset: TradingAsset, now: Date): Promise<RegimeBar[]> {
  const rows = await db
    .select({ openTime: tradingCandles.openTime, open: tradingCandles.open, high: tradingCandles.high, low: tradingCandles.low, close: tradingCandles.close })
    .from(tradingCandles)
    .where(
      and(
        eq(tradingCandles.source, source),
        eq(tradingCandles.market, tradingCandleMarket(source, asset)),
        eq(tradingCandles.timeframe, "1d"),
        // Closed bars only: the candle store holds none other, this is the belt to its braces.
        lte(tradingCandles.openTime, new Date(now.getTime() - DAY_MS)),
      ),
    )
    .orderBy(asc(tradingCandles.openTime));
  return rows;
}

async function countDailyBars(db: Db, source: TradingCandleSource, asset: TradingAsset): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tradingCandles)
    .where(and(eq(tradingCandles.source, source), eq(tradingCandles.market, tradingCandleMarket(source, asset)), eq(tradingCandles.timeframe, "1d")));
  return row?.n ?? 0;
}

/** Recomputes one coin's whole label history from the candle store and writes what is new or changed. */
export async function refreshAssetRegimes(db: Db, asset: TradingAsset, now: Date): Promise<RefreshAssetResult> {
  let source: TradingCandleSource | null = null;
  for (const candidate of SOURCE_PREFERENCE) {
    if ((await countDailyBars(db, candidate, asset)) >= MIN_BARS_FOR_ANY_LABEL) {
      source = candidate;
      break;
    }
  }
  if (!source) return { asset, source: null, bars: 0, inserted: 0, revised: 0 };
  const bars = await loadDailyBars(db, source, asset, now);
  const labels = computeRegimeLabels(bars);
  const stored = new Map(
    (await db.select().from(tradingRegimes).where(and(eq(tradingRegimes.asset, asset), eq(tradingRegimes.rulesVersion, TRADING_REGIME_RULES_VERSION)))).map((row) => [row.day, toStored(row)]),
  );
  const toWrite: TradingRegimeLabel[] = [];
  let inserted = 0;
  let revised = 0;
  for (const label of labels) {
    const was = stored.get(label.day);
    if (!was) inserted += 1;
    else if (!sameLabel(was, label, source)) revised += 1;
    else continue;
    toWrite.push(label);
  }
  for (let from = 0; from < toWrite.length; from += WRITE_BATCH) {
    await db
      .insert(tradingRegimes)
      .values(
        toWrite.slice(from, from + WRITE_BATCH).map((label) => ({
          asset,
          rulesVersion: TRADING_REGIME_RULES_VERSION,
          day: label.day,
          availableAt: label.availableAt,
          source: source!,
          trend: label.trend,
          volatility: label.volatility,
          squeeze: label.squeeze,
          close: label.close,
          sma200: label.sma200,
          adx: label.adx,
          atrPct: label.atrPct,
          atrPctPercentile: label.atrPctPercentile,
          bbWidthPercentile: label.bbWidthPercentile,
          spellNo: label.spellNo,
          spellStartDay: label.spellStartDay,
        })),
      )
      .onConflictDoUpdate({
        target: [tradingRegimes.asset, tradingRegimes.rulesVersion, tradingRegimes.day],
        set: {
          source: sql`excluded.source`,
          trend: sql`excluded.trend`,
          volatility: sql`excluded.volatility`,
          squeeze: sql`excluded.squeeze`,
          close: sql`excluded.close`,
          sma200: sql`excluded.sma200`,
          adx: sql`excluded.adx`,
          atrPct: sql`excluded.atr_pct`,
          atrPctPercentile: sql`excluded.atr_pct_percentile`,
          bbWidthPercentile: sql`excluded.bb_width_percentile`,
          spellNo: sql`excluded.spell_no`,
          spellStartDay: sql`excluded.spell_start_day`,
          updatedAt: sql`now()`,
        },
      });
  }
  return { asset, source, bars: bars.length, inserted, revised };
}

export async function refreshRegimes(db: Db, now: Date = new Date()): Promise<RefreshAssetResult[]> {
  const results: RefreshAssetResult[] = [];
  for (const asset of TRADING_ASSETS) results.push(await refreshAssetRegimes(db, asset, now));
  return results;
}

// ─── Reading ───

/**
 * The label a decision made at `decisionAt` may use: the newest one whose day
 * has closed by then. An intraday decision on day D gets D-1's label. Null when
 * the coin has no label yet (young coin, or the candle store has not caught up).
 */
export async function regimeAsOf(db: Db, asset: TradingAsset, decisionAt: Date): Promise<StoredRegime | null> {
  const [row] = await db
    .select()
    .from(tradingRegimes)
    .where(and(eq(tradingRegimes.asset, asset), eq(tradingRegimes.rulesVersion, TRADING_REGIME_RULES_VERSION), lte(tradingRegimes.availableAt, decisionAt)))
    .orderBy(desc(tradingRegimes.availableAt))
    .limit(1);
  return row ? toStored(row) : null;
}

export interface RegimeWindowSummary {
  asset: TradingAsset;
  from: string;
  to: string;
  /** The label in force at `from` (what the first decision of the window reads). Null if none yet. */
  atStart: StoredRegime | null;
  /** Every spell a decision inside the window could have read, oldest first. */
  spells: TradingRegimeSpell[];
  flips: TradingRegimeFlipCounts;
}

/**
 * The market weather a prediction or past-data test window [from, to) was
 * exposed to, as the decisions inside it saw it: the label in force at `from`
 * plus every label that became available before `to`.
 */
export async function regimeWindow(db: Db, asset: TradingAsset, from: Date, to: Date): Promise<RegimeWindowSummary> {
  const atStart = await regimeAsOf(db, asset, from);
  const rows = await db
    .select()
    .from(tradingRegimes)
    .where(
      and(
        eq(tradingRegimes.asset, asset),
        eq(tradingRegimes.rulesVersion, TRADING_REGIME_RULES_VERSION),
        atStart ? gte(tradingRegimes.availableAt, atStart.availableAt) : undefined,
        lte(tradingRegimes.availableAt, to),
      ),
    )
    .orderBy(asc(tradingRegimes.availableAt));
  // A label that becomes available exactly at `to` cannot be read by a decision before `to`.
  const readable = rows.filter((row) => row.availableAt.getTime() < to.getTime()).map(toStored);
  return { asset, from: from.toISOString(), to: to.toISOString(), atStart, spells: regimeSpells(readable), flips: regimeFlipCounts(readable) };
}

export interface MarketWeatherItem {
  asset: TradingAsset;
  name: string;
  /** UI-ready, e.g. `Bitcoin: uptrend, normal swings, since 12 Oct`. */
  text: string;
  trend: TradingRegimeTrend;
  volatility: TradingRegimeVolatility;
  squeeze: boolean;
  spellNo: number;
  spellStartDay: string;
  /** Day the label describes, and when it became available. */
  day: string;
  availableAt: string;
  source: TradingCandleSource;
}

export function marketWeatherItem(label: StoredRegime, now: Date): MarketWeatherItem {
  return {
    asset: label.asset,
    name: TRADING_ASSET_NAMES[label.asset],
    text: describeRegime(label.asset, label, now),
    trend: label.trend,
    volatility: label.volatility,
    squeeze: label.squeeze,
    spellNo: label.spellNo,
    spellStartDay: label.spellStartDay,
    day: label.day,
    availableAt: label.availableAt.toISOString(),
    source: label.source,
  };
}

/** The current label for every coin that has one. */
export async function currentMarketWeather(db: Db, now: Date = new Date()): Promise<MarketWeatherItem[]> {
  const rows = await db
    .selectDistinctOn([tradingRegimes.asset])
    .from(tradingRegimes)
    .where(and(eq(tradingRegimes.rulesVersion, TRADING_REGIME_RULES_VERSION), lte(tradingRegimes.availableAt, now)))
    .orderBy(tradingRegimes.asset, desc(tradingRegimes.availableAt));
  const byAsset = new Map(rows.map((row) => [row.asset, toStored(row)]));
  return TRADING_ASSETS.flatMap((asset) => {
    const label = byAsset.get(asset);
    return label ? [marketWeatherItem(label, now)] : [];
  });
}

export interface MarketWeatherHistory {
  asset: TradingAsset;
  name: string;
  current: MarketWeatherItem | null;
  /** All spells in the range, newest first, capped at `spellLimit`. `flips.spells` is the true count. */
  spells: TradingRegimeSpell[];
  flips: TradingRegimeFlipCounts;
  firstDay: string | null;
}

export async function marketWeatherHistory(db: Db, asset: TradingAsset, now: Date, range: { from?: Date; to?: Date; spellLimit: number }): Promise<MarketWeatherHistory> {
  const upper = range.to && range.to.getTime() < now.getTime() ? range.to : now;
  const rows = await db
    .select()
    .from(tradingRegimes)
    .where(
      and(
        eq(tradingRegimes.asset, asset),
        eq(tradingRegimes.rulesVersion, TRADING_REGIME_RULES_VERSION),
        range.from ? gte(tradingRegimes.availableAt, range.from) : undefined,
        lte(tradingRegimes.availableAt, upper),
      ),
    )
    .orderBy(asc(tradingRegimes.availableAt));
  const labels = rows.map(toStored);
  const spells = regimeSpells(labels);
  const current = labels.length > 0 ? marketWeatherItem(labels[labels.length - 1]!, now) : null;
  return {
    asset,
    name: TRADING_ASSET_NAMES[asset],
    current,
    spells: spells.slice(-range.spellLimit).reverse(),
    flips: regimeFlipCounts(labels),
    firstDay: labels[0]?.day ?? null,
  };
}
