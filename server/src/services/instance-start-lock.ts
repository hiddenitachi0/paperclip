import { logger } from "../middleware/logger.js";

// Same shape as agent-start-lock.ts, but a single chain per heartbeatService
// instance instead of one per agent: serializes the "check the instance-wide
// running-run count, then claim runs" critical section across every agent's
// start attempt, so two agents racing to start at the same moment can't both
// observe spare capacity and jointly overshoot the cap.
//
// Deliberately a FACTORY, not module-level singleton state: heartbeatService(db)
// is instantiated once per server process in production, but tests create many
// independent instances (one per embedded-Postgres describe block). A bare
// module-level lock would serialize -- and let a hang in one instance stall --
// unrelated instances that share nothing but this module.
const INSTANCE_START_LOCK_STALE_MS = 30_000;

export function createInstanceStartLock() {
  let instanceStartLock: { promise: Promise<void>; startedAtMs: number } | null = null;

  async function waitForInstanceStartLock(lock: { promise: Promise<void>; startedAtMs: number }) {
    const elapsedMs = Date.now() - lock.startedAtMs;
    const remainingMs = INSTANCE_START_LOCK_STALE_MS - elapsedMs;
    if (remainingMs <= 0) {
      logger.warn({ staleMs: elapsedMs }, "instance start lock stale; continuing queued-run start");
      return;
    }

    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      lock.promise,
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          timedOut = true;
          resolve();
        }, remainingMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);

    if (timedOut) {
      logger.warn({ staleMs: INSTANCE_START_LOCK_STALE_MS }, "instance start lock timed out; continuing queued-run start");
    }
  }

  async function withInstanceStartLock<T>(fn: () => Promise<T>) {
    const previous = instanceStartLock;
    const waitForPrevious = previous ? waitForInstanceStartLock(previous) : Promise.resolve();
    const run = waitForPrevious.then(fn);
    const marker = run.then(
      () => undefined,
      () => undefined,
    );
    instanceStartLock = { promise: marker, startedAtMs: Date.now() };
    try {
      return await run;
    } finally {
      if (instanceStartLock?.promise === marker) {
        instanceStartLock = null;
      }
    }
  }

  return { withInstanceStartLock };
}
