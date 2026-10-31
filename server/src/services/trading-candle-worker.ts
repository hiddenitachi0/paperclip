import { parentPort, workerData } from "node:worker_threads";
import { createDb } from "@paperclipai/db";
import { runCandleCycle, noteBinanceWeight, type CandleCycleResult } from "./trading-candle-backfill.js";
import { createCandleHttp } from "./trading-candle-http.js";
import { setCandleLogSink } from "./trading-candle-log.js";

/**
 * Worker-thread entry for the candle store's backfill (DUR-5007). It runs in
 * its own thread with its own small database connection, so the downloading,
 * inflating and parsing never touch the API's event loop or its connection
 * pool, and a capped heap means a broken file can only take this thread down.
 * The parent enforces a wall-clock limit and terminates it.
 *
 * The job carries the database address in memory only; it is never logged.
 */
export type CandleWorkerJob = { databaseUrl: string; budgetMs: number; runArchives: boolean };
export type CandleWorkerMessage =
  | { type: "log"; level: "info" | "warn" | "error"; fields: Record<string, unknown>; message: string }
  | { type: "progress"; message: string }
  | { type: "result"; result: CandleCycleResult }
  | { type: "failed"; message: string };

async function main(job: CandleWorkerJob, port: NonNullable<typeof parentPort>) {
  setCandleLogSink({
    info: (fields, message) => port.postMessage({ type: "log", level: "info", fields, message } satisfies CandleWorkerMessage),
    warn: (fields, message) => port.postMessage({ type: "log", level: "warn", fields, message } satisfies CandleWorkerMessage),
    error: (fields, message) => port.postMessage({ type: "log", level: "error", fields, message } satisfies CandleWorkerMessage),
  });
  const db = createDb(job.databaseUrl);
  try {
    const result = await runCandleCycle({
      db,
      http: createCandleHttp({ onWeight: noteBinanceWeight }),
      budgetMs: job.budgetMs,
      runArchives: job.runArchives,
      onProgress: (message) => port.postMessage({ type: "progress", message } satisfies CandleWorkerMessage),
    });
    port.postMessage({ type: "result", result } satisfies CandleWorkerMessage);
  } catch (err) {
    port.postMessage({ type: "failed", message: err instanceof Error ? err.message : "candle worker failed" } satisfies CandleWorkerMessage);
  } finally {
    await (db as unknown as { $client?: { end: (o?: { timeout?: number }) => Promise<void> } }).$client?.end({ timeout: 5 }).catch(() => {});
  }
}

if (parentPort) {
  void main(workerData as CandleWorkerJob, parentPort);
}
