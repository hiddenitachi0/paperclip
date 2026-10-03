import { LANE_A_MODEL_CATALOGUE } from "./lane-a-models.js";

/**
 * DUR-4470: shared prompt-cache arithmetic for cache-aware agent runs.
 * Cache writes bill above fresh input: 1.25x for 5-minute entries, 2x for
 * 1-hour entries. Cache reads are not covered here (cachedInputTokens).
 */
export const CACHE_WRITE_MULTIPLIER_5M = 1.25;
export const CACHE_WRITE_MULTIPLIER_1H = 2;
/** Claude's default cache lifetime. A 1-hour write extends it to CACHE_LIFETIME_1H_MS. */
export const CACHE_LIFETIME_5M_MS = 5 * 60 * 1000;
export const CACHE_LIFETIME_1H_MS = 60 * 60 * 1000;

function inputUsdPerMillionForModel(model: string | null | undefined): number | null {
  const id = (model ?? "").toLowerCase();
  for (const family of ["haiku", "sonnet", "opus"] as const) {
    if (id.includes(family)) {
      const entry = Object.entries(LANE_A_MODEL_CATALOGUE).find(([key]) => key.includes(family));
      return entry ? entry[1].inputUsdPerMillion : null;
    }
  }
  return null;
}

function clampTokens(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Split the adapter's cacheCreationInputTokens (total) into the 1-hour part
 * and the remaining 5-minute part. The 1h part can never exceed the total.
 */
export function splitCacheWriteTokens(
  cacheCreationInputTokens: number | null | undefined,
  cacheCreation1hInputTokens: number | null | undefined,
): { total: number; oneHour: number; fiveMinute: number } {
  const total = clampTokens(cacheCreationInputTokens);
  const oneHour = Math.min(total, clampTokens(cacheCreation1hInputTokens));
  return { total, oneHour, fiveMinute: total - oneHour };
}

/**
 * Cost of a run's cache writes in (fractional) cents, at list price. Returns 0
 * for a model with no known Claude price: an unpriced model must read as
 * "unknown", not as an invented figure.
 */
export function computeCacheWriteCostCents(
  model: string | null | undefined,
  cacheCreationInputTokens: number | null | undefined,
  cacheCreation1hInputTokens: number | null | undefined,
): number {
  const price = inputUsdPerMillionForModel(model);
  if (price === null) return 0;
  const { oneHour, fiveMinute } = splitCacheWriteTokens(cacheCreationInputTokens, cacheCreation1hInputTokens);
  const usd =
    (fiveMinute * price * CACHE_WRITE_MULTIPLIER_5M + oneHour * price * CACHE_WRITE_MULTIPLIER_1H) / 1_000_000;
  return usd * 100;
}

export interface CacheWarmthInput {
  /** When the run last touched the prompt cache (last heartbeat / run finish). */
  lastHeartbeatAt: Date | string | number | null | undefined;
  /** True if the run wrote any 1-hour cache entries; extends the default lifetime. */
  wroteOneHourCache?: boolean;
}

/**
 * Whether a session's prompt cache is still warm at `now`. `lifetimeMs`
 * defaults to the 5-minute lifetime, or 1 hour when the last run wrote 1h
 * entries. No timestamp => cold.
 */
export function isCacheWarm(
  run: CacheWarmthInput | null | undefined,
  lifetimeMs?: number,
  now: Date | number = Date.now(),
): boolean {
  if (!run || run.lastHeartbeatAt == null) return false;
  const last = new Date(run.lastHeartbeatAt).getTime();
  if (!Number.isFinite(last)) return false;
  const lifetime = lifetimeMs ?? (run.wroteOneHourCache ? CACHE_LIFETIME_1H_MS : CACHE_LIFETIME_5M_MS);
  const elapsed = (typeof now === "number" ? now : now.getTime()) - last;
  return elapsed >= 0 && elapsed < lifetime;
}
