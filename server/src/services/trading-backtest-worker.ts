import { parentPort, workerData } from "node:worker_threads";
import { createDb } from "@paperclipai/db";
import { tradingCandleMarket, type TradingAsset, type TradingEngineBar } from "@paperclipai/shared";
import { BacktestOutOfTime, BacktestRefusal, executeBacktest } from "./trading-backtest-run.js";
import { tradingBacktestStore } from "./trading-backtest-store.js";
import { listCandles } from "./trading-candle-store.js";

/**
 * Worker-thread entry for one past-data test (DUR-5008). It runs in its own
 * thread with its own small database connection, so the simulation never
 * touches the API's event loop or its connection pool, and a capped heap means
 * a runaway test can only take this thread down. The parent enforces a
 * wall-clock limit and terminates it.
 *
 * The connection is the bypass one (it has to read the public candle store and
 * write the run's company-scoped rows), so every query in the store names the
 * company explicitly. The job carries the database address in memory only; it
 * is never logged.
 */
export type BacktestWorkerJob = { databaseUrl: string; runId: string; companyId: string; maxWallMs: number };
export type BacktestWorkerMessage =
  | { type: "progress"; message: string }
  | { type: "result"; ok: boolean; gatePassed: boolean | null; message: string };

const MAX_BARS_PER_STREAM = 3_000_000;

async function main(job: BacktestWorkerJob, port: NonNullable<typeof parentPort>) {
  const db = createDb(job.databaseUrl);
  const store = tradingBacktestStore(db);
  const startedAt = Date.now();
  try {
    const ctx = await store.loadContext(job.companyId, job.runId);
    const asOf = new Date(ctx.params.asOf);
    const outcome = await executeBacktest({
      spec: ctx.spec,
      params: ctx.params,
      priorReads: ctx.priorReads,
      priorTrials: ctx.priorTrials,
      loadBars: async (coin, timeframe) =>
        (await listCandles(db, { source: ctx.params.source, market: tradingCandleMarket(ctx.params.source, coin as TradingAsset), timeframe, to: asOf, limit: MAX_BARS_PER_STREAM })) as TradingEngineBar[],
      checkpoint: () => {
        if (Date.now() - startedAt > job.maxWallMs) throw new BacktestOutOfTime("The test ran past its time limit and was stopped.");
      },
    });
    await store.finishRun(job.companyId, job.runId, outcome, { strategyId: ctx.run.strategyId, versionId: ctx.run.versionId, templateKey: ctx.run.templateKey, purpose: ctx.params.purpose });
    port.postMessage({ type: "result", ok: true, gatePassed: ctx.params.purpose === "gate" ? outcome.gate.passed : null, message: outcome.gate.summary } satisfies BacktestWorkerMessage);
  } catch (err) {
    const message = err instanceof BacktestRefusal || err instanceof BacktestOutOfTime ? err.message : err instanceof Error ? `The test failed: ${err.message}` : "The test failed.";
    await store.failRun(job.companyId, job.runId, message).catch(() => {});
    port.postMessage({ type: "result", ok: false, gatePassed: null, message } satisfies BacktestWorkerMessage);
  } finally {
    await (db as unknown as { $client?: { end: (o?: { timeout?: number }) => Promise<void> } }).$client?.end({ timeout: 5 }).catch(() => {});
  }
}

if (parentPort) {
  void main(workerData as BacktestWorkerJob, parentPort);
}
