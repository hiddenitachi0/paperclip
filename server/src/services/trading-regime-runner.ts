import type { Db } from "@paperclipai/db";
import { refreshRegimes, type RefreshAssetResult } from "./trading-regimes.js";

/**
 * The market-weather scheduler chain (DUR-5013). Recomputing every coin's labels
 * from the candle store is a few thousand rows and a few milliseconds of
 * arithmetic per coin, so it runs in-process on its own chain, never in the
 * trading tick. The daily bar closes at 00:00 UTC and the candle top-up lands
 * within minutes, so an hourly check is plenty; each pass only writes days that
 * are new or changed.
 */

export interface RegimeRunnerLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface RegimeRunnerOptions {
  db: Db;
  logger: RegimeRunnerLogger;
  enabled?: boolean;
  startDelayMs?: number;
  everyMs?: number;
  now?: () => Date;
  /** Tests inject a fake refresh. */
  refresh?: (db: Db, now: Date) => Promise<RefreshAssetResult[]>;
}

export interface RegimeRunnerStatus {
  enabled: boolean;
  running: boolean;
  nextRunAt: string | null;
  lastFinishedAt: string | null;
  lastResults: RefreshAssetResult[];
  lastFailure: string | null;
  consecutiveFailures: number;
}

const DEFAULT_START_DELAY_MS = 3 * 60_000;
const DEFAULT_EVERY_MS = 60 * 60_000;
const FAILURE_BACKOFF_BASE_MS = 5 * 60_000;
const FAILURE_BACKOFF_MAX_MS = 60 * 60_000;

export function tradingRegimeRunner(options: RegimeRunnerOptions) {
  const nowOf = options.now ?? (() => new Date());
  const enabled = options.enabled ?? true;
  const everyMs = options.everyMs ?? DEFAULT_EVERY_MS;
  const refresh = options.refresh ?? refreshRegimes;
  const state = {
    running: false,
    nextRunAt: nowOf().getTime() + (options.startDelayMs ?? DEFAULT_START_DELAY_MS),
    lastFinishedAt: null as Date | null,
    lastResults: [] as RefreshAssetResult[],
    lastFailure: null as string | null,
    consecutiveFailures: 0,
  };

  async function tick(now: Date = nowOf()): Promise<{ started: boolean; inserted: number; revised: number }> {
    if (!enabled || state.running || now.getTime() < state.nextRunAt) return { started: false, inserted: 0, revised: 0 };
    state.running = true;
    try {
      const results = await refresh(options.db, now);
      const inserted = results.reduce((sum, r) => sum + r.inserted, 0);
      const revised = results.reduce((sum, r) => sum + r.revised, 0);
      state.lastResults = results;
      state.lastFailure = null;
      state.consecutiveFailures = 0;
      state.nextRunAt = nowOf().getTime() + everyMs;
      state.lastFinishedAt = nowOf();
      if (revised > 0) {
        options.logger.warn(
          { revised, assets: results.filter((r) => r.revised > 0).map((r) => r.asset) },
          "market weather: past labels changed because older candles arrived (rewritten from the candle store)",
        );
      }
      if (inserted > 0) options.logger.info({ inserted }, "market weather: new labels written");
      return { started: true, inserted, revised };
    } catch (err) {
      state.consecutiveFailures += 1;
      state.lastFailure = err instanceof Error ? err.message : "market weather refresh failed";
      state.nextRunAt = nowOf().getTime() + Math.min(FAILURE_BACKOFF_BASE_MS * 2 ** (state.consecutiveFailures - 1), FAILURE_BACKOFF_MAX_MS);
      state.lastFinishedAt = nowOf();
      options.logger.error({ err: state.lastFailure }, "market weather refresh failed; backing off");
      return { started: true, inserted: 0, revised: 0 };
    } finally {
      state.running = false;
    }
  }

  function status(): RegimeRunnerStatus {
    return {
      enabled,
      running: state.running,
      nextRunAt: enabled ? new Date(state.nextRunAt).toISOString() : null,
      lastFinishedAt: state.lastFinishedAt?.toISOString() ?? null,
      lastResults: state.lastResults,
      lastFailure: state.lastFailure,
      consecutiveFailures: state.consecutiveFailures,
    };
  }

  return { tick, status };
}

export type TradingRegimeRunner = ReturnType<typeof tradingRegimeRunner>;
