import { describe, expect, it } from "vitest";
import { computeCacheWriteCostCents, isCacheWarm, splitCacheWriteTokens } from "./prompt-cache.js";

describe("prompt-cache", () => {
  it("splits 1h writes out of the total and clamps", () => {
    expect(splitCacheWriteTokens(1000, 400)).toEqual({ total: 1000, oneHour: 400, fiveMinute: 600 });
    expect(splitCacheWriteTokens(100, 500)).toEqual({ total: 100, oneHour: 100, fiveMinute: 0 });
    expect(splitCacheWriteTokens(undefined, 5)).toEqual({ total: 0, oneHour: 0, fiveMinute: 0 });
  });

  it("prices 5m writes at 1.25x and 1h writes at 2x input", () => {
    // sonnet: $2/M input. 1M 5m tokens => $2.50 = 250c; 1M 1h => $4 = 400c.
    expect(computeCacheWriteCostCents("claude-sonnet-5", 1_000_000, 0)).toBeCloseTo(250);
    expect(computeCacheWriteCostCents("claude-sonnet-5", 1_000_000, 1_000_000)).toBeCloseTo(400);
    expect(computeCacheWriteCostCents("gpt-4.1", 1_000_000, 0)).toBe(0);
  });

  it("determines warm vs cold against the lifetime", () => {
    const now = new Date("2026-10-03T12:00:00Z");
    expect(isCacheWarm({ lastHeartbeatAt: "2026-10-03T11:57:00Z" }, undefined, now)).toBe(true);
    expect(isCacheWarm({ lastHeartbeatAt: "2026-10-03T11:50:00Z" }, undefined, now)).toBe(false);
    expect(isCacheWarm({ lastHeartbeatAt: "2026-10-03T11:50:00Z", wroteOneHourCache: true }, undefined, now)).toBe(true);
    expect(isCacheWarm({ lastHeartbeatAt: null }, undefined, now)).toBe(false);
  });
});
