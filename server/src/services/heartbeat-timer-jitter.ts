// DUR-273: spread heartbeat timer wake-ups out instead of letting every agent
// wake in the same scheduler tick.
//
// During the 2026-08-27 API hang (DUR-271) many agents woke inside one narrow
// window and fired the same set of per-heartbeat queries at once -- 109
// established connections against a 10-connection pool. The two hot queries
// were fixed, but nothing stopped the *shape* of the failure from coming back
// the next time a per-agent query got expensive. Every agent's timer is
// `lastHeartbeatAt + intervalSec`, and after a restart/reap the fleet's
// lastHeartbeatAt values all land within seconds of each other, so their
// timers line up again.
//
// The fix is a small per-agent offset added to the interval. It is
// deterministic per agent (hash of the id, not Math.random) so a given agent
// always waits the same extra few seconds -- the fleet stays spread out from
// tick to tick rather than re-rolling into a new coincidental cluster -- and
// so the value is reproducible in tests and logs. It is bounded twice: as a
// fraction of the agent's own interval (default 5%) and by an absolute cap
// (default 5 minutes) so a very long interval never drifts by more than that.

export const DEFAULT_HEARTBEAT_TIMER_JITTER_RATIO = 0.05;
export const DEFAULT_HEARTBEAT_TIMER_JITTER_MAX_MS = 5 * 60 * 1000;
/** Hard ceiling on the ratio: more than half an interval stops being "jitter". */
export const MAX_HEARTBEAT_TIMER_JITTER_RATIO = 0.5;

export interface HeartbeatTimerJitterOptions {
  /** Fraction of intervalSec the offset may reach (0 disables jitter). */
  ratio?: number;
  /** Absolute cap on the offset in milliseconds. */
  maxMs?: number;
  /**
   * Maps an agent id to a number in [0, 1). Defaults to a stable hash of the
   * id; tests inject a fixed value to pin the outcome.
   */
  sample?: (agentId: string) => number;
}

/** FNV-1a 32-bit hash mapped to [0, 1). Stable across processes and restarts. */
export function stableUnitSample(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x1_0000_0000;
}

export function normalizeHeartbeatTimerJitterRatio(value: unknown): number {
  const ratio = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  return Math.min(MAX_HEARTBEAT_TIMER_JITTER_RATIO, ratio);
}

export function normalizeHeartbeatTimerJitterMaxMs(value: unknown): number {
  const maxMs = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(maxMs) || maxMs <= 0) return 0;
  return Math.floor(maxMs);
}

/**
 * Extra milliseconds this agent's timer waits beyond `intervalSec` before it
 * is considered due. Always >= 0, never more than `ratio * intervalSec` and
 * never more than `maxMs`.
 */
export function computeHeartbeatTimerJitterMs(
  agentId: string,
  intervalSec: number,
  options: HeartbeatTimerJitterOptions = {},
): number {
  const ratio = normalizeHeartbeatTimerJitterRatio(options.ratio ?? DEFAULT_HEARTBEAT_TIMER_JITTER_RATIO);
  const maxMs = normalizeHeartbeatTimerJitterMaxMs(options.maxMs ?? DEFAULT_HEARTBEAT_TIMER_JITTER_MAX_MS);
  if (ratio <= 0 || maxMs <= 0) return 0;
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) return 0;

  const rawSample = (options.sample ?? stableUnitSample)(agentId);
  const sample = Number.isFinite(rawSample) ? Math.min(1, Math.max(0, rawSample)) : 0;
  const spanMs = Math.min(maxMs, ratio * intervalSec * 1000);
  return Math.floor(sample * spanMs);
}
