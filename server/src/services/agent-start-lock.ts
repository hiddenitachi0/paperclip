import { logger } from "../middleware/logger.js";

const AGENT_START_LOCK_STALE_MS = 30_000;
const startLocksByAgent = new Map<string, { promise: Promise<void>; startedAtMs: number }>();

// DUR-151: a single fixed key so the same keyed-lock machinery can also
// serialize the whole-instance concurrency check across different agents'
// concurrent startNextQueuedRunForAgent calls (single Node process, so an
// in-process lock is sufficient — see heartbeat.ts global-cap comment).
const GLOBAL_RUN_START_LOCK_KEY = "__global__";

async function waitForKeyedStartLock(
  locks: Map<string, { promise: Promise<void>; startedAtMs: number }>,
  key: string,
  lock: { promise: Promise<void>; startedAtMs: number },
) {
  const elapsedMs = Date.now() - lock.startedAtMs;
  const remainingMs = AGENT_START_LOCK_STALE_MS - elapsedMs;
  if (remainingMs <= 0) {
    logger.warn({ key, staleMs: elapsedMs }, "start lock stale; continuing queued-run start");
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
    logger.warn({ key, staleMs: AGENT_START_LOCK_STALE_MS }, "start lock timed out; continuing queued-run start");
  }
}

async function withKeyedStartLock<T>(
  locks: Map<string, { promise: Promise<void>; startedAtMs: number }>,
  key: string,
  fn: () => Promise<T>,
) {
  const previous = locks.get(key);
  const waitForPrevious = previous ? waitForKeyedStartLock(locks, key, previous) : Promise.resolve();
  const run = waitForPrevious.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, { promise: marker, startedAtMs: Date.now() });
  try {
    return await run;
  } finally {
    if (locks.get(key)?.promise === marker) {
      locks.delete(key);
    }
  }
}

export async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
  return withKeyedStartLock(startLocksByAgent, agentId, fn);
}

const globalRunStartLock = new Map<string, { promise: Promise<void>; startedAtMs: number }>();

export async function withGlobalRunStartLock<T>(fn: () => Promise<T>) {
  return withKeyedStartLock(globalRunStartLock, GLOBAL_RUN_START_LOCK_KEY, fn);
}
