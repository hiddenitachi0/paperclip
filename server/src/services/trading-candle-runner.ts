import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { CandleCycleResult } from "./trading-candle-backfill.js";
import type { CandleWorkerJob, CandleWorkerMessage } from "./trading-candle-worker.js";

/**
 * The candle store's supervisor (DUR-5007), driven by its own scheduler chain
 * (`candleStore`), never the trading tick and never the API's event loop.
 *
 * tick() returns at once: it only decides whether a cycle is due and, if so,
 * starts it in a worker thread (a scheduler tick that ran for the whole
 * backfill would be mistaken for a wedged chain). The worker has its own
 * database connection and a capped heap; this class enforces the wall-clock
 * limit and keeps the last result for the status report.
 *
 * Cadence: after a clean cycle the live feeds are topped up every few minutes
 * and the archive index is re-checked every six hours; a cycle that ran out of
 * time carries straight on; failures back off up to an hour; a source that
 * told us to stop is left alone and the rest carries on.
 */

export interface CandleRunnerLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface CandleRunnerOptions {
  databaseUrl: string;
  logger: CandleRunnerLogger;
  enabled?: boolean;
  /** Wait this long after boot before the first cycle, so the server settles first. */
  startDelayMs?: number;
  budgetMs?: number;
  topUpEveryMs?: number;
  archiveCheckEveryMs?: number;
  now?: () => Date;
  /** Tests inject a fake worker. */
  runWorker?: (job: CandleWorkerJob, onMessage: (message: CandleWorkerMessage) => void, limitMs: number) => Promise<CandleCycleResult>;
}

export interface CandleRunnerStatus {
  enabled: boolean;
  running: boolean;
  nextRunAt: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastResult: CandleCycleResult | null;
  lastFailure: string | null;
  consecutiveFailures: number;
}

const DEFAULT_START_DELAY_MS = 2 * 60_000;
const DEFAULT_BUDGET_MS = 10 * 60_000;
const DEFAULT_TOP_UP_EVERY_MS = 5 * 60_000;
const DEFAULT_ARCHIVE_CHECK_EVERY_MS = 6 * 3_600_000;
const FAILURE_BACKOFF_BASE_MS = 5 * 60_000;
const FAILURE_BACKOFF_MAX_MS = 60 * 60_000;
const WORKER_HEAP_MB = 768;
const CONTINUE_PAUSE_MS = 15_000;
const STOPPED_SOURCE_RETRY_MS = 15 * 60_000;

function resolveWorker(): { url: URL; execArgv: string[] } {
  const compiled = new URL("./trading-candle-worker.js", import.meta.url);
  if (existsSync(compiled)) return { url: compiled, execArgv: [] };
  // Source run (tsx / vitest): load the .ts worker through tsx.
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
  return { url: new URL("./trading-candle-worker.ts", import.meta.url), execArgv: ["--import", tsx] };
}

export function spawnCandleWorker(job: CandleWorkerJob, onMessage: (message: CandleWorkerMessage) => void, limitMs: number): Promise<CandleCycleResult> {
  const { url, execArgv } = resolveWorker();
  return new Promise((resolve, reject) => {
    const worker = new Worker(url, { workerData: job, execArgv, resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } });
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      settle();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("The candle worker ran past its time limit and was stopped."))), limitMs);
    worker.on("message", (message: CandleWorkerMessage) => {
      if (message.type === "result") finish(() => resolve(message.result));
      else if (message.type === "failed") finish(() => reject(new Error(message.message)));
      else onMessage(message);
    });
    worker.once("error", (error) => finish(() => reject((error as { code?: string }).code === "ERR_WORKER_OUT_OF_MEMORY" ? new Error("The candle worker ran out of memory.") : error)));
    worker.once("exit", () => finish(() => reject(new Error("The candle worker stopped without a result."))));
  });
}

export function tradingCandleRunner(options: CandleRunnerOptions) {
  const nowOf = options.now ?? (() => new Date());
  const enabled = options.enabled ?? true;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const topUpEveryMs = options.topUpEveryMs ?? DEFAULT_TOP_UP_EVERY_MS;
  const archiveCheckEveryMs = options.archiveCheckEveryMs ?? DEFAULT_ARCHIVE_CHECK_EVERY_MS;
  const runWorker = options.runWorker ?? spawnCandleWorker;
  const bootAt = nowOf().getTime();
  const state = {
    running: false,
    nextRunAt: bootAt + (options.startDelayMs ?? DEFAULT_START_DELAY_MS),
    lastStartedAt: null as Date | null,
    lastFinishedAt: null as Date | null,
    lastResult: null as CandleCycleResult | null,
    lastFailure: null as string | null,
    consecutiveFailures: 0,
    lastArchiveRunAt: 0,
    archivesPending: true,
  };

  function handleMessage(message: CandleWorkerMessage) {
    if (message.type === "log") options.logger[message.level](message.fields, message.message);
    else if (message.type === "progress") options.logger.info({}, `candle store: ${message.message}`);
  }

  async function runCycle(startedAt: Date): Promise<void> {
    const runArchives = state.archivesPending || startedAt.getTime() - state.lastArchiveRunAt >= archiveCheckEveryMs;
    try {
      const result = await runWorker({ databaseUrl: options.databaseUrl, budgetMs, runArchives }, handleMessage, budgetMs + 3 * 60_000);
      const finishedAt = nowOf();
      state.lastResult = result;
      state.lastFailure = result.errors.length > 0 ? result.errors.join("; ") : null;
      state.consecutiveFailures = result.errors.length > 0 ? state.consecutiveFailures + 1 : 0;
      if (runArchives) {
        state.lastArchiveRunAt = startedAt.getTime();
        state.archivesPending = !result.complete;
      }
      const wait =
        result.errors.length > 0
          ? Math.min(FAILURE_BACKOFF_BASE_MS * 2 ** (state.consecutiveFailures - 1), FAILURE_BACKOFF_MAX_MS)
          : result.timedOut
            ? CONTINUE_PAUSE_MS
            : result.stops.length > 0
              ? STOPPED_SOURCE_RETRY_MS
              : topUpEveryMs;
      state.nextRunAt = finishedAt.getTime() + wait;
      state.lastFinishedAt = finishedAt;
      if (result.inserted > 0 || result.corrections > 0 || result.errors.length > 0) {
        options.logger.info(
          { inserted: result.inserted, corrections: result.corrections, invalid: result.invalid, entriesDone: result.entriesDone, timedOut: result.timedOut, complete: result.complete, errors: result.errors },
          "candle store cycle",
        );
      }
    } catch (err) {
      state.consecutiveFailures += 1;
      state.lastFailure = err instanceof Error ? err.message : "candle cycle failed";
      state.nextRunAt = nowOf().getTime() + Math.min(FAILURE_BACKOFF_BASE_MS * 2 ** (state.consecutiveFailures - 1), FAILURE_BACKOFF_MAX_MS);
      state.lastFinishedAt = nowOf();
      options.logger.error({ err: state.lastFailure }, "candle store cycle failed; backing off");
    } finally {
      state.running = false;
    }
  }

  /** Called by the `candleStore` scheduler chain. Returns at once; never awaits the cycle. */
  function tick(now: Date = nowOf()): { started: boolean } {
    if (!enabled || state.running || now.getTime() < state.nextRunAt) return { started: false };
    state.running = true;
    state.lastStartedAt = now;
    void runCycle(now);
    return { started: true };
  }

  function status(): CandleRunnerStatus {
    return {
      enabled,
      running: state.running,
      nextRunAt: enabled ? new Date(state.nextRunAt).toISOString() : null,
      lastStartedAt: state.lastStartedAt?.toISOString() ?? null,
      lastFinishedAt: state.lastFinishedAt?.toISOString() ?? null,
      lastResult: state.lastResult,
      lastFailure: state.lastFailure,
      consecutiveFailures: state.consecutiveFailures,
    };
  }

  return { tick, status };
}

export type TradingCandleRunner = ReturnType<typeof tradingCandleRunner>;

let registered: TradingCandleRunner | null = null;

/** The running server registers its runner so the report routes can show where the backfill is. */
export function registerCandleRunner(runner: TradingCandleRunner | null): void {
  registered = runner;
}

export function getCandleRunnerStatus(): CandleRunnerStatus | null {
  return registered?.status() ?? null;
}
