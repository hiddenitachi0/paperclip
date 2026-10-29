import { desc, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { fxRates } from "@paperclipai/db";
import { TRADING_ESTIMATED_USD_NOK_RATE, TRADING_FX_SOURCE_ESTIMATED, TRADING_FX_SOURCE_NORGES_BANK } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

/**
 * The daily USD/NOK rate for the trading agent (DUR-5001). Norges Bank
 * publishes one rate per Norwegian business day; this service stores each in
 * fx_rates and hands the trading service the newest one on or before "today".
 * On weekends and Norwegian holidays that is the last published rate together
 * with the date it was published for, so a fill is never stamped with a date
 * that has no rate. Only when no rate is stored at all does it fall back to
 * 11.5, flagged 'estimated' so nobody mistakes the guess for a real rate.
 *
 * The only outbound call is a GET to one fixed Norges Bank URL: no credentials,
 * no user-supplied input, a short timeout, and the answer is validated before
 * it is stored. A failed fetch never throws into the trading tick -- it just
 * leaves the last stored rate in place.
 */

/** NOK per 1 USD for one published date. */
export interface FxRateObservation {
  date: string;
  rate: number;
}

export interface FxRateFetcher {
  /** The most recent published observations, oldest-first. Throws on any failure. */
  fetchRecent(): Promise<FxRateObservation[]>;
}

/** What a fill is stamped with. `date` is null only for the 'estimated' fallback. */
export interface FxRateQuote {
  rate: number;
  date: string | null;
  source: string;
}

export interface FxRatesService {
  /** Fetch recent Norges Bank rates and store the new ones. Returns how many rows were inserted; never throws. */
  refresh(): Promise<number>;
  /** The rate to use at `now`. Refreshes first when none is stored for today yet and a fetcher is configured. */
  current(now: Date): Promise<FxRateQuote>;
}

const NORGES_BANK_URL = "https://data.norges-bank.no/api/data/EXR/B.USD.NOK.SP?format=sdmx-json&lastNObservations=10";
/** Plausibility band for USD/NOK: anything outside is a parse error or garbage, never stored. */
const MIN_PLAUSIBLE_RATE = 3;
const MAX_PLAUSIBLE_RATE = 30;
const FETCH_TIMEOUT_MS = 10_000;
/** After a refresh attempt (ok or not), do not try again for this long. */
const REFRESH_COOLDOWN_MS = 30 * 60_000;

function isPlausibleRate(rate: unknown): rate is number {
  return typeof rate === "number" && Number.isFinite(rate) && rate >= MIN_PLAUSIBLE_RATE && rate <= MAX_PLAUSIBLE_RATE;
}

/** Parses Norges Bank's SDMX-JSON answer for one daily series into observations, oldest-first. Throws on a shape it does not recognise. */
export function parseNorgesBankObservations(body: unknown): FxRateObservation[] {
  const root = body as {
    data?: {
      dataSets?: Array<{ series?: Record<string, { observations?: Record<string, unknown[]> }> }>;
      structure?: { dimensions?: { observation?: Array<{ id?: string; values?: Array<{ id?: string }> }> } };
    };
  };
  const dates = root?.data?.structure?.dimensions?.observation?.find((d) => d.id === "TIME_PERIOD")?.values;
  const series = root?.data?.dataSets?.[0]?.series;
  const observations = series ? Object.values(series)[0]?.observations : undefined;
  if (!Array.isArray(dates) || !observations) throw new Error("Norges Bank answer had no observations.");
  const parsed: FxRateObservation[] = [];
  for (const [index, cell] of Object.entries(observations)) {
    const date = dates[Number(index)]?.id;
    const rate = Number(Array.isArray(cell) ? cell[0] : NaN);
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !isPlausibleRate(rate)) continue;
    parsed.push({ date, rate });
  }
  parsed.sort((a, b) => a.date.localeCompare(b.date));
  if (parsed.length === 0) throw new Error("Norges Bank answer had no usable rate.");
  return parsed;
}

export function norgesBankFetcher(fetchImpl: typeof fetch = fetch): FxRateFetcher {
  return {
    async fetchRecent() {
      const response = await fetchImpl(NORGES_BANK_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Norges Bank answered HTTP ${response.status}.`);
      return parseNorgesBankObservations(await response.json());
    },
  };
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * `fetcher` omitted = read-only: the service only reads what is already
 * stored (the route layer and tests use that; the server's scheduler is the
 * one with the Norges Bank fetcher, and stores for everyone).
 */
export function fxRatesService(db: Db, fetcher?: FxRateFetcher): FxRatesService {
  let lastAttemptAt = 0;

  async function newestOnOrBefore(day: string) {
    const [row] = await db.select().from(fxRates).where(lte(fxRates.rateDate, day)).orderBy(desc(fxRates.rateDate)).limit(1);
    return row ?? null;
  }

  async function refresh(): Promise<number> {
    if (!fetcher) return 0;
    lastAttemptAt = Date.now();
    try {
      const observations = await fetcher.fetchRecent();
      const inserted = await db
        .insert(fxRates)
        .values(observations.map((o) => ({ rateDate: o.date, rate: o.rate, source: TRADING_FX_SOURCE_NORGES_BANK })))
        .onConflictDoNothing({ target: fxRates.rateDate })
        .returning({ id: fxRates.id });
      return inserted.length;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "trading: could not fetch the Norges Bank USD/NOK rate; keeping the last stored one");
      return 0;
    }
  }

  async function current(now: Date): Promise<FxRateQuote> {
    const day = utcDay(now);
    let row = await newestOnOrBefore(day);
    // No rate for today yet (weekend, holiday, or not published yet): try to
    // pick up a newer one, at most every 30 minutes. A weekend simply keeps
    // finding nothing new and uses the last published rate.
    if (fetcher && (row === null || row.rateDate < day) && Date.now() - lastAttemptAt >= REFRESH_COOLDOWN_MS) {
      if ((await refresh()) > 0) row = await newestOnOrBefore(day);
    }
    if (!row) return { rate: TRADING_ESTIMATED_USD_NOK_RATE, date: null, source: TRADING_FX_SOURCE_ESTIMATED };
    return { rate: row.rate, date: row.rateDate, source: row.source };
  }

  return { refresh, current };
}
