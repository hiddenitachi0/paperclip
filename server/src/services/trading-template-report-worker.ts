import { parentPort, workerData } from "node:worker_threads";
import { createDb } from "@paperclipai/db";
import { tradingCandleMarket, type TradingAsset, type TradingEngineBar } from "@paperclipai/shared";
import { BacktestOutOfTime, BacktestRefusal, executeBacktest } from "./trading-backtest-run.js";
import { tradingTemplateStore } from "./trading-template-store.js";
import { listCandles } from "./trading-candle-store.js";

/**
 * Worker-thread entry for one template's past-data report (DUR-5014). Same
 * shape and same guarantees as trading-backtest-worker.ts: its own thread, its
 * own small bypass database connection, a capped heap, and a wall-clock limit
 * the parent enforces by terminating it. The job carries the database address
 * in memory only; it is never logged.
 */
export type TemplateReportWorkerJob = { databaseUrl: string; reportId: string; maxWallMs: number };
export type TemplateReportWorkerMessage =
  | { type: "progress"; message: string }
  | { type: "result"; ok: boolean; gatePassed: boolean | null; message: string };

const MAX_BARS_PER_STREAM = 3_000_000;

async function main(job: TemplateReportWorkerJob, port: NonNullable<typeof parentPort>) {
  const db = createDb(job.databaseUrl);
  const store = tradingTemplateStore(db);
  const startedAt = Date.now();
  try {
    const ctx = await store.loadContext(job.reportId);
    const asOf = new Date(ctx.params.asOf);
    const outcome = await executeBacktest({
      spec: ctx.template.spec,
      params: ctx.params,
      priorReads: ctx.priorReads,
      priorTrials: ctx.priorTrials,
      loadBars: async (coin, timeframe) =>
        (await listCandles(db, { source: ctx.params.source, market: tradingCandleMarket(ctx.params.source, coin as TradingAsset), timeframe, to: asOf, limit: MAX_BARS_PER_STREAM })) as TradingEngineBar[],
      checkpoint: () => {
        if (Date.now() - startedAt > job.maxWallMs) throw new BacktestOutOfTime("The report ran past its time limit and was stopped.");
      },
    });
    const { notTestable } = await store.finishReport(job.reportId, outcome, { templateKey: ctx.template.key, assets: ctx.params.assets });
    port.postMessage({ type: "result", ok: !notTestable, gatePassed: notTestable ? null : outcome.gate.passed, message: notTestable ? "Not testable yet: no stored candles." : outcome.gate.summary } satisfies TemplateReportWorkerMessage);
  } catch (err) {
    const message = err instanceof BacktestRefusal || err instanceof BacktestOutOfTime ? err.message : err instanceof Error ? `The report failed: ${err.message}` : "The report failed.";
    await store.failReport(job.reportId, message).catch(() => {});
    port.postMessage({ type: "result", ok: false, gatePassed: null, message } satisfies TemplateReportWorkerMessage);
  } finally {
    await (db as unknown as { $client?: { end: (o?: { timeout?: number }) => Promise<void> } }).$client?.end({ timeout: 5 }).catch(() => {});
  }
}

if (parentPort) {
  void main(workerData as TemplateReportWorkerJob, parentPort);
}
