import { timeAgo } from "./timeAgo";

/** After this many quiet minutes, a running task is flagged as possibly stuck. */
export const STALL_THRESHOLD_MINUTES = 15;

export interface RunActivityTimestamps {
  lastOutputAt?: string | Date | null;
  lastUsefulActionAt?: string | Date | null;
  startedAt?: string | Date | null;
  createdAt?: string | Date | null;
}

export interface LivenessBadgeInfo {
  text: string;
  stalled: boolean;
}

function latestTimestamp(...values: Array<string | Date | null | undefined>): Date | null {
  let latest: Date | null = null;
  for (const value of values) {
    if (!value) continue;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) continue;
    if (!latest || d.getTime() > latest.getTime()) latest = d;
  }
  return latest;
}

function formatQuietDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  const hoursText = `${hours} hour${hours === 1 ? "" : "s"}`;
  return remainingMinutes > 0 ? `${hoursText} ${remainingMinutes} min` : hoursText;
}

/**
 * Plain-language "is this still alive" hint for a running task, derived from
 * the most recent of last_output_at / last_useful_action_at (falling back to
 * when the run started). No field names or run ids in the copy.
 */
export function describeRunLiveness(run: RunActivityTimestamps | null | undefined): LivenessBadgeInfo | null {
  if (!run) return null;
  const last = latestTimestamp(run.lastOutputAt, run.lastUsefulActionAt, run.startedAt, run.createdAt);
  if (!last) return { text: "working", stalled: false };

  const quietMinutes = Math.floor((Date.now() - last.getTime()) / 60_000);
  if (quietMinutes >= STALL_THRESHOLD_MINUTES) {
    return {
      text: `has been quiet for ${formatQuietDuration(quietMinutes)} — might be stuck`,
      stalled: true,
    };
  }
  return { text: `working — last activity ${timeAgo(last)}`, stalled: false };
}
