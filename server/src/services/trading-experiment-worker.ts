import { parentPort, workerData } from "node:worker_threads";
import { createDb } from "@paperclipai/db";
import { tradingCandleMarket, type TradingAsset, type TradingEngineBar } from "@paperclipai/shared";
import { BacktestOutOfTime, BacktestRefusal } from "./trading-backtest-run.js";
import { executeExperiment } from "./trading-experiment-run.js";
import { tradingExperimentStore } from "./trading-experiment-store.js";
import { listCandles } from "./trading-candle-store.js";

/**
 * Worker-thread entry for one experiment (DUR-5018). Same shape and same
 * guarantees as trading-backtest-worker.ts: its own thread, its own small
 * bypass database connection, a capped heap, and a wall-clock limit the parent
 * enforces by terminating it. The job carries the database address in memory
 * only; it is never logged.
 */
export type ExperimentWorkerJob = { databaseUrl: string; experimentId: string; companyId: string; maxWallMs: number };
export type ExperimentWorkerMessage =
  | { type: "progress"; message: string }
  | { type: "result"; ok: boolean; decision: "recommend" | "no_change" | null; message: string };

const MAX_BARS_PER_STREAM = 3_000_000;

async function main(job: ExperimentWorkerJob, port: NonNullable<typeof parentPort>) {
  const db = createDb(job.databaseUrl);
  const store = tradingExperimentStore(db);
  const startedAt = Date.now();
  try {
    const ctx = await store.loadContext(job.companyId, job.experimentId);
    const asOf = new Date(ctx.params.asOf);
    const outcome = await executeExperiment({
      spec: ctx.spec,
      params: ctx.params,
      priorReads: ctx.priorReads,
      priorTrials: ctx.priorTrials,
      loadBars: async (coin, timeframe) =>
        (await listCandles(db, { source: ctx.params.source, market: tradingCandleMarket(ctx.params.source, coin as TradingAsset), timeframe, to: asOf, limit: MAX_BARS_PER_STREAM })) as TradingEngineBar[],
      checkpoint: () => {
        if (Date.now() - startedAt > job.maxWallMs) throw new BacktestOutOfTime("The experiment ran past its time limit and was stopped.");
      },
    });
    await store.finishExperiment(job.companyId, job.experimentId, outcome);
    port.postMessage({ type: "result", ok: true, decision: outcome.recommendation.decision, message: outcome.recommendation.summary } satisfies ExperimentWorkerMessage);
  } catch (err) {
    const message = err instanceof BacktestRefusal || err instanceof BacktestOutOfTime ? err.message : err instanceof Error ? `The experiment failed: ${err.message}` : "The experiment failed.";
    await store.failExperiment(job.companyId, job.experimentId, message).catch(() => {});
    port.postMessage({ type: "result", ok: false, decision: null, message } satisfies ExperimentWorkerMessage);
  } finally {
    await (db as unknown as { $client?: { end: (o?: { timeout?: number }) => Promise<void> } }).$client?.end({ timeout: 5 }).catch(() => {});
  }
}

if (parentPort) {
  void main(workerData as ExperimentWorkerJob, parentPort);
}
