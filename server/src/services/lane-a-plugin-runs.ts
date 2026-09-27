import { randomUUID } from "node:crypto";

/**
 * Quick agents (Lane A) have no heartbeat run: a chat turn is not a run row,
 * and no task is checked out. The plugin host services (plugin-host-services.ts)
 * work out "which agent is calling" from the run id a plugin hands back, never
 * from an agent id the plugin claims. So a quick agent's plugin tool call gets
 * a short-lived run of its own here: one id per tool call, registered in this
 * process before the plugin worker is called and dropped right after.
 *
 * Host services look a run id up in `heartbeat_runs` first and here second.
 * The table lives in memory on purpose: the server is one process, a Lane A
 * tool call lasts seconds, and nothing needs to survive a restart.
 */
export interface LaneAPluginRun {
  runId: string;
  /** The quick agent doing the calling. */
  agentId: string;
  companyId: string;
  conversationId: string;
  /** The person (or agent) talking to the quick agent. */
  requestedByUserId: string | null;
  requestedByAgentId: string | null;
  startedAt: Date;
}

/** A run that was never closed (a crash mid-call) stops resolving after this long. */
export const LANE_A_PLUGIN_RUN_MAX_AGE_MS = 10 * 60 * 1000;

const activeRuns = new Map<string, LaneAPluginRun>();

function isStale(run: LaneAPluginRun, now: number): boolean {
  return now - run.startedAt.getTime() > LANE_A_PLUGIN_RUN_MAX_AGE_MS;
}

function sweepStale(now: number): void {
  for (const [runId, run] of activeRuns) {
    if (isStale(run, now)) activeRuns.delete(runId);
  }
}

/**
 * Open a run for one plugin tool call. Call `close()` in a `finally` once the
 * worker has answered; the id stops resolving from then on.
 */
export function openLaneAPluginRun(
  input: Omit<LaneAPluginRun, "runId" | "startedAt">,
): { run: LaneAPluginRun; close: () => void } {
  sweepStale(Date.now());
  const run: LaneAPluginRun = { ...input, runId: randomUUID(), startedAt: new Date() };
  activeRuns.set(run.runId, run);
  let closed = false;
  return {
    run,
    close: () => {
      if (closed) return;
      closed = true;
      activeRuns.delete(run.runId);
    },
  };
}

/** The open quick-agent run with this id, or null (unknown, closed, or stale). */
export function findLaneAPluginRun(runId: string): LaneAPluginRun | null {
  const run = activeRuns.get(runId);
  if (!run) return null;
  if (isStale(run, Date.now())) {
    activeRuns.delete(runId);
    return null;
  }
  return run;
}

/** Exported for tests: no call may leave a run behind. */
export function activeLaneAPluginRunCount(): number {
  return activeRuns.size;
}
