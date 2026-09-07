import type { NextFunction, Request, Response } from "express";
import { logger } from "../middleware/logger.js";

// DUR-272: during the 2026-08-27 API hang, "the server is overloaded by a
// request pile-up" and "the server is down" looked identical from outside
// the process -- both were 60-90s hangs with nothing received. Telling them
// apart needed live pg_stat_activity and /proc reads. This keeps a cheap
// in-process count of requests currently being handled (and how long the
// oldest has been waiting), exposes it on /api/health, and logs a warning
// when the count crosses a threshold, so the next regression of this class
// is visible in one request instead of a forensic session.

export const DEFAULT_REQUEST_LOAD_SLOW_THRESHOLD_MS = 10_000;
export const DEFAULT_REQUEST_LOAD_OVERLOAD_THRESHOLD = 50;
/** Minimum gap between two overload warnings so a sustained pile-up does not flood the log. */
export const REQUEST_LOAD_WARNING_INTERVAL_MS = 60_000;

export interface RequestLoadSnapshot {
  /** Requests being handled right now. */
  inFlight: number;
  /** Highest in-flight count seen since the process started. */
  peakInFlight: number;
  peakInFlightAt: string | null;
  /** Age in ms of the oldest request still in flight (0 when idle). */
  longestInFlightMs: number;
  /** In-flight requests older than `slowThresholdMs`. */
  slowInFlight: number;
  slowThresholdMs: number;
  /** In-flight count at or above which the server reports itself overloaded. */
  overloadThreshold: number;
  overloaded: boolean;
  /** Requests started / finished since the process started. */
  totalStarted: number;
  totalFinished: number;
}

export interface RequestLoadTrackerOptions {
  slowThresholdMs?: number;
  overloadThreshold?: number;
  now?: () => number;
  /** Test hook: receives the overload warning instead of the logger. */
  onOverload?: (snapshot: RequestLoadSnapshot) => void;
}

export function createRequestLoadTracker(options: RequestLoadTrackerOptions = {}) {
  const slowThresholdMs = Math.max(0, options.slowThresholdMs ?? DEFAULT_REQUEST_LOAD_SLOW_THRESHOLD_MS);
  const overloadThreshold = Math.max(1, options.overloadThreshold ?? DEFAULT_REQUEST_LOAD_OVERLOAD_THRESHOLD);
  const now = options.now ?? (() => Date.now());

  const inFlightStartedAt = new Map<symbol, number>();
  let peakInFlight = 0;
  let peakInFlightAt: number | null = null;
  let totalStarted = 0;
  let totalFinished = 0;
  let lastOverloadWarningAt: number | null = null;

  function snapshot(): RequestLoadSnapshot {
    const current = now();
    let longestInFlightMs = 0;
    let slowInFlight = 0;
    for (const startedAt of inFlightStartedAt.values()) {
      const age = Math.max(0, current - startedAt);
      if (age > longestInFlightMs) longestInFlightMs = age;
      if (slowThresholdMs > 0 && age >= slowThresholdMs) slowInFlight += 1;
    }
    const inFlight = inFlightStartedAt.size;
    return {
      inFlight,
      peakInFlight,
      peakInFlightAt: peakInFlightAt === null ? null : new Date(peakInFlightAt).toISOString(),
      longestInFlightMs,
      slowInFlight,
      slowThresholdMs,
      overloadThreshold,
      overloaded: inFlight >= overloadThreshold,
      totalStarted,
      totalFinished,
    };
  }

  function maybeWarnOverload() {
    const current = now();
    if (inFlightStartedAt.size < overloadThreshold) return;
    if (lastOverloadWarningAt !== null && current - lastOverloadWarningAt < REQUEST_LOAD_WARNING_INTERVAL_MS) return;
    lastOverloadWarningAt = current;
    const snap = snapshot();
    if (options.onOverload) {
      options.onOverload(snap);
      return;
    }
    logger.warn(
      { ...snap },
      "request pile-up: in-flight request count is at or above the overload threshold (DUR-272)",
    );
  }

  /** Marks a request as started; returns the function that marks it finished (idempotent). */
  function begin(): () => void {
    const key = Symbol("request");
    const startedAt = now();
    inFlightStartedAt.set(key, startedAt);
    totalStarted += 1;
    if (inFlightStartedAt.size > peakInFlight) {
      peakInFlight = inFlightStartedAt.size;
      peakInFlightAt = startedAt;
    }
    maybeWarnOverload();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      inFlightStartedAt.delete(key);
      totalFinished += 1;
    };
  }

  function middleware() {
    return (_req: Request, res: Response, next: NextFunction) => {
      const finish = begin();
      // "finish" fires when the response is fully sent; "close" covers a
      // client that gave up (or a streaming response torn down) so a hung
      // request never stays counted forever.
      res.once("finish", finish);
      res.once("close", finish);
      next();
    };
  }

  function reset() {
    inFlightStartedAt.clear();
    peakInFlight = 0;
    peakInFlightAt = null;
    totalStarted = 0;
    totalFinished = 0;
    lastOverloadWarningAt = null;
  }

  return { begin, middleware, snapshot, reset };
}

export type RequestLoadTracker = ReturnType<typeof createRequestLoadTracker>;

function readThreshold(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The process-wide tracker the app mounts and /api/health reads. Thresholds
 * are env-tunable so an operator can tighten them without a code change.
 */
export const requestLoadTracker = createRequestLoadTracker({
  slowThresholdMs: readThreshold(process.env.PAPERCLIP_REQUEST_LOAD_SLOW_MS, DEFAULT_REQUEST_LOAD_SLOW_THRESHOLD_MS),
  overloadThreshold: readThreshold(
    process.env.PAPERCLIP_REQUEST_LOAD_OVERLOAD_THRESHOLD,
    DEFAULT_REQUEST_LOAD_OVERLOAD_THRESHOLD,
  ),
});

export function getRequestLoadSnapshot(): RequestLoadSnapshot {
  return requestLoadTracker.snapshot();
}
