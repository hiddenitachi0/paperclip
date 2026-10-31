/**
 * Where the candle store's code writes log lines. The backfill runs in a worker
 * thread, and the server's own logger starts a transport (more threads, a log
 * file) the moment it is imported, so the candle code never imports it.
 * The worker forwards these lines to the main thread, which logs them for real.
 */
export interface CandleLogSink {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

const silent: CandleLogSink = { info() {}, warn() {}, error() {} };
let sink: CandleLogSink = silent;

export function setCandleLogSink(next: CandleLogSink | null): void {
  sink = next ?? silent;
}

/** Errors do not survive being logged from another thread; keep what matters. */
function plain(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) out[key] = value instanceof Error ? value.message : value;
  return out;
}

export const candleLog: CandleLogSink = {
  info: (fields, message) => sink.info(plain(fields), message),
  warn: (fields, message) => sink.warn(plain(fields), message),
  error: (fields, message) => sink.error(plain(fields), message),
};
