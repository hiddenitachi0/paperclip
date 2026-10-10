import { logger } from "../middleware/logger.js";

/**
 * Storyline strip (design 2.9): every heavy ffmpeg job (combining a film,
 * reading clip frames for a transition, poster pictures) runs on the
 * production box, which has no GPU and also runs the agents. This in-process
 * queue lets at most PAPERCLIP_MEDIA_JOB_CONCURRENCY (default 2) such jobs
 * run at once; the rest wait their turn in order. Only top-level callers
 * take a slot -- a job never takes a second slot inside itself, so the
 * queue cannot deadlock.
 */

const DEFAULT_CONCURRENCY = 2;

function configuredConcurrency(): number {
  const raw = Number.parseInt(process.env.PAPERCLIP_MEDIA_JOB_CONCURRENCY ?? "", 10);
  return Number.isFinite(raw) && raw >= 1 && raw <= 16 ? raw : DEFAULT_CONCURRENCY;
}

let running = 0;
const waiting: Array<() => void> = [];

function acquire(): Promise<void> {
  if (running < configuredConcurrency()) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiting.push(() => {
      running += 1;
      resolve();
    });
  });
}

function release(): void {
  running = Math.max(0, running - 1);
  const next = waiting.shift();
  if (next) next();
}

/** Runs one heavy media job when a slot is free. */
export async function runMediaJob<T>(label: string, job: () => Promise<T>): Promise<T> {
  const queuedAt = Date.now();
  await acquire();
  const waitedMs = Date.now() - queuedAt;
  if (waitedMs > 5_000) logger.info({ label, waitedMs }, "media job queue: job waited for a free slot");
  try {
    return await job();
  } finally {
    release();
  }
}

/** For tests and the health view: how busy the queue is. */
export function mediaJobQueueState(): { running: number; waiting: number; max: number } {
  return { running, waiting: waiting.length, max: configuredConcurrency() };
}
