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
  /**
   * The requester's own message for this turn, verbatim. Host services use
   * it to tell "the person named this task" from "a file or a data lookup
   * the agent read this turn named it" (see laneAPluginRunNamesIssue).
   */
  requesterMessage: string;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Did the person talking to the quick agent name this task themselves, in
 * this turn's message — by its id or by its reference (for example DUR-12)?
 *
 * Only the requester's message counts. Text the quick agent read through a
 * tool this turn (a company file, a sales lookup, an earlier tool result) is
 * not the requester's, so a task reference planted there cannot make the
 * agent attach to that task. The reference must stand on its own:
 * "DUR-12" matches, "DUR-123" does not.
 */
export function laneAPluginRunNamesIssue(
  run: Pick<LaneAPluginRun, "requesterMessage">,
  issue: { id: string; identifier: string | null },
): boolean {
  const message = run.requesterMessage ?? "";
  if (message.length === 0) return false;
  if (message.toLowerCase().includes(issue.id.toLowerCase())) return true;
  const identifier = issue.identifier?.trim();
  if (!identifier) return false;
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(identifier)}(?![A-Za-z0-9])`, "i").test(message);
}
