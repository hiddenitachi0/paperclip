// DUR-257: on SIGTERM/SIGINT (e.g. the deploy runner's `docker compose up -d
// --force-recreate` / `--no-build` swap, which SIGTERMs the old container before
// starting the replacement), give in-flight heartbeat runs a real chance to finish
// instead of dying mid-run and getting booked as process_lost the moment the next
// boot's reap finds them still "running" with no matching in-memory handle.
//
// Extracted from index.ts's shutdown() as a pure, injectable-clock function so the
// polling/timeout logic can be unit tested without real timers or a running server.

export interface ShutdownDrainLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

export interface ShutdownDrainDeps {
  getInFlightRunCount: () => number;
  logger: ShutdownDrainLogger;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Bounded by timeoutMs so a stuck run can't wedge shutdown forever -- the caller's
// docker-compose stop_grace_period should be set a few seconds above timeoutMs, but
// SIGKILL is still the backstop if the deadline passes.
export async function waitForInFlightRunsToDrain(
  signal: "SIGINT" | "SIGTERM",
  timeoutMs: number,
  deps: ShutdownDrainDeps,
): Promise<void> {
  const { getInFlightRunCount, logger } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const pollIntervalMs = deps.pollIntervalMs ?? 1000;

  const remaining = getInFlightRunCount();
  if (remaining === 0) return;

  if (timeoutMs <= 0) {
    logger.warn(
      { signal, remaining },
      "shutdown: draining disabled (shutdownDrainTimeoutMs=0), in-flight runs will be reaped as process_lost on next boot",
    );
    return;
  }

  logger.info({ signal, remaining, timeoutMs }, "shutdown: waiting for in-flight heartbeat runs to finish");
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(pollIntervalMs);
    const stillRunning = getInFlightRunCount();
    if (stillRunning === 0) {
      logger.info({ signal }, "shutdown: all in-flight heartbeat runs finished, proceeding");
      return;
    }
  }

  logger.warn(
    { signal, stillRunning: getInFlightRunCount(), timeoutMs },
    "shutdown: drain timed out with runs still in flight -- they will be reaped as process_lost (with one automatic retry) on next boot",
  );
}
