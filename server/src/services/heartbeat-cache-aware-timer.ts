// DUR-4473 (cache-aware agent runs, parent DUR-4465): pull a timer wake that
// was going to land just AFTER the prompt cache expires back to just BEFORE it.
//
// This only ever moves a wake that was already due soon after expiry. It never
// invents a keep-alive: an agent whose next timer is far past the cache
// lifetime is left alone, because paying for wakes to keep a cache warm costs
// more than the one cold restart it avoids.

import { CACHE_LIFETIME_5M_MS } from "@paperclipai/shared";

/** Wake this long before the cache expires, so the run starts while it is still warm. */
export const CACHE_WAKE_SAFETY_MARGIN_MS = 30_000;
/** A timer due at most this fraction of the lifetime past expiry counts as "soon anyway". */
export const CACHE_WAKE_GRACE_RATIO = 0.5;

export interface CacheAwareTimerInput {
  settings: { enabled: boolean; schedulingEnabled: boolean; cacheLifetimeMinutes: number | null } | null | undefined;
  /** Last time the agent touched the prompt cache. */
  lastHeartbeatAtMs: number;
  /** Normal due time: lastHeartbeat + interval + jitter. */
  dueAtMs: number;
}

/** Returns the time the timer should fire: dueAtMs unless pulling it into the warm window applies. */
export function computeCacheAwareDueAtMs(input: CacheAwareTimerInput): number {
  const { settings, lastHeartbeatAtMs, dueAtMs } = input;
  if (!settings?.enabled || !settings.schedulingEnabled) return dueAtMs;
  if (!Number.isFinite(lastHeartbeatAtMs) || !Number.isFinite(dueAtMs)) return dueAtMs;
  const lifetimeMs =
    settings.cacheLifetimeMinutes != null && settings.cacheLifetimeMinutes > 0
      ? settings.cacheLifetimeMinutes * 60_000
      : CACHE_LIFETIME_5M_MS;
  const wakeBy = lastHeartbeatAtMs + lifetimeMs - Math.min(CACHE_WAKE_SAFETY_MARGIN_MS, lifetimeMs / 2);
  const expiry = lastHeartbeatAtMs + lifetimeMs;
  if (dueAtMs <= wakeBy) return dueAtMs; // already inside the warm window
  if (dueAtMs > expiry + lifetimeMs * CACHE_WAKE_GRACE_RATIO) return dueAtMs; // long idle: no keep-alive
  return wakeBy;
}
