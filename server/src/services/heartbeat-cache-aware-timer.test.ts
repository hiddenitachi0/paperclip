import { describe, expect, it } from "vitest";
import { computeCacheAwareDueAtMs } from "./heartbeat-cache-aware-timer.js";

const on = { enabled: true, schedulingEnabled: true, cacheLifetimeMinutes: null };
const MIN = 60_000;

describe("computeCacheAwareDueAtMs", () => {
  it("pulls a wake due just after cache expiry to just before it", () => {
    expect(computeCacheAwareDueAtMs({ settings: on, lastHeartbeatAtMs: 0, dueAtMs: 6 * MIN })).toBe(5 * MIN - 30_000);
  });
  it("leaves a wake already inside the warm window", () => {
    expect(computeCacheAwareDueAtMs({ settings: on, lastHeartbeatAtMs: 0, dueAtMs: 2 * MIN })).toBe(2 * MIN);
  });
  it("adds no keep-alive when the agent would idle for a long time", () => {
    expect(computeCacheAwareDueAtMs({ settings: on, lastHeartbeatAtMs: 0, dueAtMs: 30 * MIN })).toBe(30 * MIN);
  });
  it("is a no-op when disabled or scheduling is off", () => {
    expect(computeCacheAwareDueAtMs({ settings: { ...on, enabled: false }, lastHeartbeatAtMs: 0, dueAtMs: 6 * MIN })).toBe(6 * MIN);
    expect(computeCacheAwareDueAtMs({ settings: { ...on, schedulingEnabled: false }, lastHeartbeatAtMs: 0, dueAtMs: 6 * MIN })).toBe(6 * MIN);
    expect(computeCacheAwareDueAtMs({ settings: null, lastHeartbeatAtMs: 0, dueAtMs: 6 * MIN })).toBe(6 * MIN);
  });
  it("honours the lifetime override", () => {
    const s = { ...on, cacheLifetimeMinutes: 60 };
    expect(computeCacheAwareDueAtMs({ settings: s, lastHeartbeatAtMs: 0, dueAtMs: 70 * MIN })).toBe(60 * MIN - 30_000);
    expect(computeCacheAwareDueAtMs({ settings: s, lastHeartbeatAtMs: 0, dueAtMs: 6 * MIN })).toBe(6 * MIN);
  });
});
