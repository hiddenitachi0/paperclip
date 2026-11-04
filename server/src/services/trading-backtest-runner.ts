import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { TRADING_BACKTEST_LIMITS, TRADING_EXPERIMENT_LIMITS } from "@paperclipai/shared";
import type { BacktestWorkerJob, BacktestWorkerMessage } from "./trading-backtest-worker.js";
import type { ExperimentWorkerJob, ExperimentWorkerMessage } from "./trading-experiment-worker.js";
import type { TemplateReportWorkerJob, TemplateReportWorkerMessage } from "./trading-template-report-worker.js";

/**
 * The past-data test's supervisor (DUR-5008), driven by its own scheduler chain
 * (`tradingBacktest`), never the trading tick and never the API's event loop.
 *
 * tick() returns at once: it only decides whether a run should be looked for
 * and, if so, starts it in a worker thread (a scheduler tick that ran for the
 * whole simulation would be mistaken for a wedged chain). One test at a time,
 * with a wall-clock limit enforced here by terminating the thread. The live
 * trading tick (`tradingAgent` chain) shares nothing with this: its own
 * connection pool, its own chain, and the simulation runs in another thread.
 *
 * Queue access is injected (`queue`) so the supervisor itself is unit-testable
 * without a database.
 */

export interface BacktestRunnerLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface BacktestQueue {
  claimNextRun(): Promise<{ id: string; companyId: string } | null>;
  failInterrupted(): Promise<number>;
  failRun(companyId: string, runId: string, message: string): Promise<void>;
  /**
   * DUR-5014: the template library's report queue shares this one chain, so a
   * company test and a template report never run side by side. Absent = no
   * template reports (tests that only exercise company runs).
   */
  /** DUR-5018: experiments share this chain too (one heavy job at a time); they go after company tests and before template reports. */
  experiments?: {
    claimNextExperiment(): Promise<{ id: string; companyId: string } | null>;
    failInterrupted(): Promise<number>;
    failExperiment(companyId: string, experimentId: string, message: string): Promise<void>;
  };
  templateReports?: {
    claimNextReport(): Promise<{ id: string } | null>;
    failInterrupted(): Promise<number>;
    failReport(reportId: string, message: string): Promise<void>;
    /** Stores the matrix versions and queues the reports that are missing. Called at most every `prepareEveryMs`. */
    prepare?(): Promise<unknown>;
  };
}

export interface BacktestRunnerOptions {
  databaseUrl: string;
  queue: BacktestQueue;
  logger: BacktestRunnerLogger;
  enabled?: boolean;
  /** How often an idle runner looks at the queue. */
  pollEveryMs?: number;
  maxWallMs?: number;
  now?: () => Date;
  /** Tests inject a fake worker. */
  runWorker?: (job: BacktestWorkerJob, limitMs: number) => Promise<BacktestWorkerMessage & { type: "result" }>;
  runExperimentWorker?: (job: ExperimentWorkerJob, limitMs: number) => Promise<ExperimentWorkerMessage & { type: "result" }>;
  /** Wall-clock limit for one experiment. */
  experimentMaxWallMs?: number;
  runTemplateWorker?: (job: TemplateReportWorkerJob, limitMs: number) => Promise<TemplateReportWorkerMessage & { type: "result" }>;
}

export interface BacktestRunnerStatus {
  enabled: boolean;
  running: boolean;
  currentRunId: string | null;
  lastFinishedAt: string | null;
  lastMessage: string | null;
}

const DEFAULT_POLL_EVERY_MS = 15_000;
const WORKER_HEAP_MB = 1536;

function resolveWorker(name = "trading-backtest-worker"): { url: URL; execArgv: string[] } {
  const compiled = new URL(`./${name}.js`, import.meta.url);
  if (existsSync(compiled)) return { url: compiled, execArgv: [] };
  // Source run (tsx / vitest): load the .ts worker through tsx.
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
  return { url: new URL(`./${name}.ts`, import.meta.url), execArgv: ["--import", tsx] };
}

export function spawnBacktestWorker(job: BacktestWorkerJob, limitMs: number): Promise<BacktestWorkerMessage & { type: "result" }> {
  return spawnWorker(resolveWorker(), job, limitMs);
}

/** DUR-5014: the template-report worker, same limits and same supervision. */
export function spawnTemplateReportWorker(job: TemplateReportWorkerJob, limitMs: number): Promise<TemplateReportWorkerMessage & { type: "result" }> {
  return spawnWorker(resolveWorker("trading-template-report-worker"), job, limitMs);
}

/** DUR-5018: the experiment worker, same limits and same supervision. */
export function spawnExperimentWorker(job: ExperimentWorkerJob, limitMs: number): Promise<ExperimentWorkerMessage & { type: "result" }> {
  return spawnWorker(resolveWorker("trading-experiment-worker"), job, limitMs);
}

function spawnWorker<M extends { type: string }>(target: { url: URL; execArgv: string[] }, job: unknown, limitMs: number): Promise<M & { type: "result" }> {
  const { url, execArgv } = target;
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
    const timer = setTimeout(() => finish(() => reject(new Error("The past-data test ran past its time limit and was stopped."))), limitMs);
    worker.on("message", (message: M) => {
      if (message.type === "result") finish(() => resolve(message as M & { type: "result" }));
    });
    worker.once("error", (error) => finish(() => reject((error as { code?: string }).code === "ERR_WORKER_OUT_OF_MEMORY" ? new Error("The past-data test ran out of memory and was stopped.") : error)));
    worker.once("exit", () => finish(() => reject(new Error("The past-data test stopped without a result."))));
  });
}

export function tradingBacktestRunner(options: BacktestRunnerOptions) {
  const nowOf = options.now ?? (() => new Date());
  const enabled = options.enabled ?? true;
  const pollEveryMs = options.pollEveryMs ?? DEFAULT_POLL_EVERY_MS;
  const maxWallMs = options.maxWallMs ?? TRADING_BACKTEST_LIMITS.maxWallMs;
  const runWorker = options.runWorker ?? spawnBacktestWorker;
  const runTemplateWorker = options.runTemplateWorker ?? spawnTemplateReportWorker;
  const runExperimentWorker = options.runExperimentWorker ?? spawnExperimentWorker;
  const experimentMaxWallMs = options.experimentMaxWallMs ?? TRADING_EXPERIMENT_LIMITS.maxWallMs;
  const prepareEveryMs = 10 * 60_000;
  const state = {
    nextPrepareAt: 0,
    running: false,
    currentRunId: null as string | null,
    nextPollAt: 0,
    recovered: false,
    lastFinishedAt: null as Date | null,
    lastMessage: null as string | null,
  };

  /** An experiment only runs when no company test is waiting; a template report only when no experiment is. Returns whether it ran one. */
  async function runNextExperiment(): Promise<boolean> {
    const queue = options.queue.experiments;
    if (!queue) return false;
    const claimed = await queue.claimNextExperiment();
    if (!claimed) return false;
    state.currentRunId = claimed.id;
    options.logger.info({ experimentId: claimed.id }, "experiment started");
    try {
      const result = await runExperimentWorker({ databaseUrl: options.databaseUrl, experimentId: claimed.id, companyId: claimed.companyId, maxWallMs: experimentMaxWallMs }, experimentMaxWallMs + 60_000);
      state.lastMessage = result.message;
      options.logger.info({ experimentId: claimed.id, ok: result.ok, decision: result.decision }, "experiment finished");
    } catch (err) {
      const message = err instanceof Error ? err.message.replace("past-data test", "experiment") : "The experiment failed.";
      state.lastMessage = message;
      await queue.failExperiment(claimed.companyId, claimed.id, message).catch((e) => options.logger.error({ err: e }, "could not mark the experiment failed"));
      options.logger.error({ experimentId: claimed.id, err: message }, "experiment failed");
    }
    state.nextPollAt = 0;
    return true;
  }

  /** Company tests come first; a template report only runs when none is waiting. */
  async function runNextTemplateReport(): Promise<void> {
    const queue = options.queue.templateReports;
    if (!queue) return;
    if (queue.prepare && nowOf().getTime() >= state.nextPrepareAt) {
      state.nextPrepareAt = nowOf().getTime() + prepareEveryMs;
      await queue.prepare().catch((err) => options.logger.error({ err }, "template library preparation failed"));
    }
    const claimed = await queue.claimNextReport();
    if (!claimed) return;
    state.currentRunId = claimed.id;
    options.logger.info({ reportId: claimed.id }, "template report started");
    try {
      const result = await runTemplateWorker({ databaseUrl: options.databaseUrl, reportId: claimed.id, maxWallMs }, maxWallMs + 60_000);
      state.lastMessage = result.message;
      options.logger.info({ reportId: claimed.id, ok: result.ok, gatePassed: result.gatePassed }, "template report finished");
    } catch (err) {
      const message = err instanceof Error ? err.message : "The template report failed.";
      state.lastMessage = message;
      await queue.failReport(claimed.id, message).catch((e) => options.logger.error({ err: e }, "could not mark the template report failed"));
      options.logger.error({ reportId: claimed.id, err: message }, "template report failed");
    }
    // More may be waiting: look again on the next tick.
    state.nextPollAt = 0;
  }

  async function cycle(): Promise<void> {
    try {
      if (!state.recovered) {
        state.recovered = true;
        const n = await options.queue.failInterrupted();
        if (n > 0) options.logger.warn({ runs: n }, "past-data tests interrupted by a restart were marked failed");
        const interruptedExperiments = (await options.queue.experiments?.failInterrupted()) ?? 0;
        if (interruptedExperiments > 0) options.logger.warn({ experiments: interruptedExperiments }, "experiments interrupted by a restart were marked failed");
        const reports = (await options.queue.templateReports?.failInterrupted()) ?? 0;
        if (reports > 0) options.logger.warn({ reports }, "template reports interrupted by a restart were marked failed");
      }
      const claimed = await options.queue.claimNextRun();
      if (!claimed) {
        if (await runNextExperiment()) return;
        await runNextTemplateReport();
        return;
      }
      state.currentRunId = claimed.id;
      options.logger.info({ runId: claimed.id }, "past-data test started");
      try {
        // The thread gets a little longer than the test's own limit, so the test can stop itself and say why.
        const result = await runWorker({ databaseUrl: options.databaseUrl, runId: claimed.id, companyId: claimed.companyId, maxWallMs }, maxWallMs + 60_000);
        state.lastMessage = result.message;
        options.logger.info({ runId: claimed.id, ok: result.ok, gatePassed: result.gatePassed }, "past-data test finished");
      } catch (err) {
        const message = err instanceof Error ? err.message : "The past-data test failed.";
        state.lastMessage = message;
        await options.queue.failRun(claimed.companyId, claimed.id, message).catch((e) => options.logger.error({ err: e }, "could not mark the past-data test failed"));
        options.logger.error({ runId: claimed.id, err: message }, "past-data test failed");
      }
      // More may be waiting: look again on the next tick.
      state.nextPollAt = 0;
    } catch (err) {
      options.logger.error({ err }, "past-data test queue check failed");
    } finally {
      state.currentRunId = null;
      state.lastFinishedAt = nowOf();
      state.running = false;
    }
  }

  /** Called by the `tradingBacktest` scheduler chain. Returns at once; never awaits the test. */
  function tick(now: Date = nowOf()): { started: boolean } {
    if (!enabled || state.running || now.getTime() < state.nextPollAt) return { started: false };
    state.running = true;
    state.nextPollAt = now.getTime() + pollEveryMs;
    void cycle();
    return { started: true };
  }

  function status(): BacktestRunnerStatus {
    return { enabled, running: state.running, currentRunId: state.currentRunId, lastFinishedAt: state.lastFinishedAt?.toISOString() ?? null, lastMessage: state.lastMessage };
  }

  return { tick, status };
}

export type TradingBacktestRunner = ReturnType<typeof tradingBacktestRunner>;
