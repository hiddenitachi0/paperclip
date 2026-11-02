import type { Db } from "@paperclipai/db";
import { tradingVigilanceService, type VigilanceSweepResult } from "./trading-vigilance.js";

/**
 * The vigilance scheduler chain (DUR-5017). The events that are found by
 * looking (weather flips, big moves, strategies still paused, the daily
 * summary) are checked every few minutes; each occurrence is queued once by its
 * dedupe key, so a pass that finds nothing new writes nothing. The breaker
 * alerts do not come through here: the trading tick queues them the moment it
 * trips.
 */

export interface VigilanceRunnerLogger {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface VigilanceRunnerOptions {
  db: Db;
  logger: VigilanceRunnerLogger;
  enabled?: boolean;
  startDelayMs?: number;
  everyMs?: number;
  now?: () => Date;
  /** Tests inject a fake sweep. */
  sweep?: (now: Date) => Promise<VigilanceSweepResult>;
}

// Long enough after boot for the candle store and market-weather chains to have written their first pass.
const DEFAULT_START_DELAY_MS = 5 * 60_000;
const DEFAULT_EVERY_MS = 10 * 60_000;

export function tradingVigilanceRunner(options: VigilanceRunnerOptions) {
  const nowOf = options.now ?? (() => new Date());
  const enabled = options.enabled ?? true;
  const everyMs = options.everyMs ?? DEFAULT_EVERY_MS;
  const sweep = options.sweep ?? ((now: Date) => tradingVigilanceService(options.db, { now: () => now }).sweep(now));
  const state = { running: false, nextRunAt: nowOf().getTime() + (options.startDelayMs ?? DEFAULT_START_DELAY_MS) };

  async function tick(now: Date = nowOf()): Promise<{ started: boolean; result: VigilanceSweepResult | null }> {
    if (!enabled || state.running || now.getTime() < state.nextRunAt) return { started: false, result: null };
    state.running = true;
    try {
      const result = await sweep(now);
      if (result.weatherFlips + result.bigMoves + result.pausedAfterRestart + result.dailySummaries > 0) {
        options.logger.info({ ...result }, "trading vigilance: alerts queued");
      }
      return { started: true, result };
    } catch (err) {
      options.logger.error({ err: err instanceof Error ? err.message : "unknown" }, "trading vigilance pass failed; trying again next time");
      return { started: true, result: null };
    } finally {
      state.nextRunAt = nowOf().getTime() + everyMs;
      state.running = false;
    }
  }

  return { tick };
}

export type TradingVigilanceRunner = ReturnType<typeof tradingVigilanceRunner>;
