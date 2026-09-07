import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  DEFAULT_HEARTBEAT_TIMER_JITTER_MAX_MS,
  DEFAULT_HEARTBEAT_TIMER_JITTER_RATIO,
  MAX_HEARTBEAT_TIMER_JITTER_RATIO,
  computeHeartbeatTimerJitterMs,
  stableUnitSample,
} from "../services/heartbeat-timer-jitter.js";
import { resolveHeartbeatTimerJitterMaxMs, resolveHeartbeatTimerJitterRatio } from "../config.js";
import { heartbeatService } from "../services/heartbeat.ts";

// DUR-273: heartbeat timer wakes get a small, stable, bounded per-agent
// offset so a fleet whose lastHeartbeatAt values coincide does not wake in
// the same scheduler tick (the 2026-08-27 thundering-herd shape).
describe("computeHeartbeatTimerJitterMs (DUR-273)", () => {
  it("is deterministic for the same agent and interval", () => {
    const agentId = randomUUID();
    const first = computeHeartbeatTimerJitterMs(agentId, 600);
    const second = computeHeartbeatTimerJitterMs(agentId, 600);
    expect(first).toBe(second);
  });

  it("never exceeds the ratio of the interval, and defaults to a few percent", () => {
    expect(DEFAULT_HEARTBEAT_TIMER_JITTER_RATIO).toBeGreaterThan(0);
    expect(DEFAULT_HEARTBEAT_TIMER_JITTER_RATIO).toBeLessThanOrEqual(0.1);
    for (let index = 0; index < 500; index += 1) {
      const jitter = computeHeartbeatTimerJitterMs(randomUUID(), 600);
      expect(jitter).toBeGreaterThanOrEqual(0);
      expect(jitter).toBeLessThanOrEqual(DEFAULT_HEARTBEAT_TIMER_JITTER_RATIO * 600 * 1000);
    }
  });

  it("is capped by the absolute maximum for very long intervals", () => {
    const oneDaySec = 24 * 60 * 60;
    const jitter = computeHeartbeatTimerJitterMs("agent", oneDaySec, { sample: () => 0.999 });
    expect(jitter).toBeLessThanOrEqual(DEFAULT_HEARTBEAT_TIMER_JITTER_MAX_MS);
    expect(computeHeartbeatTimerJitterMs("agent", oneDaySec, { sample: () => 0.999, maxMs: 1_000 })).toBe(999);
  });

  it("is zero when disabled or when the interval is not positive", () => {
    expect(computeHeartbeatTimerJitterMs("agent", 600, { ratio: 0 })).toBe(0);
    expect(computeHeartbeatTimerJitterMs("agent", 600, { maxMs: 0 })).toBe(0);
    expect(computeHeartbeatTimerJitterMs("agent", 0)).toBe(0);
    expect(computeHeartbeatTimerJitterMs("agent", -5)).toBe(0);
    expect(computeHeartbeatTimerJitterMs("agent", Number.NaN)).toBe(0);
  });

  it("clamps an oversized ratio so jitter can never exceed half an interval", () => {
    const jitter = computeHeartbeatTimerJitterMs("agent", 100, { ratio: 5, maxMs: Number.MAX_SAFE_INTEGER, sample: () => 1 });
    expect(jitter).toBe(MAX_HEARTBEAT_TIMER_JITTER_RATIO * 100 * 1000);
  });

  it("uses the injected sample and clamps it to [0, 1]", () => {
    expect(computeHeartbeatTimerJitterMs("agent", 100, { ratio: 0.1, sample: () => 1 })).toBe(10_000);
    expect(computeHeartbeatTimerJitterMs("agent", 100, { ratio: 0.1, sample: () => 7 })).toBe(10_000);
    expect(computeHeartbeatTimerJitterMs("agent", 100, { ratio: 0.1, sample: () => -1 })).toBe(0);
    expect(computeHeartbeatTimerJitterMs("agent", 100, { ratio: 0.1, sample: () => Number.NaN })).toBe(0);
  });

  it("spreads a fleet of agents across the window instead of piling them up", () => {
    const samples = Array.from({ length: 200 }, () => stableUnitSample(randomUUID()));
    for (const sample of samples) {
      expect(sample).toBeGreaterThanOrEqual(0);
      expect(sample).toBeLessThan(1);
    }
    const distinct = new Set(samples.map((sample) => Math.floor(sample * 10)));
    // 200 ids hashed into ten buckets: a stable hash that clustered would
    // defeat the point of the offset, so expect most buckets populated.
    expect(distinct.size).toBeGreaterThanOrEqual(8);
  });
});

describe("heartbeat timer jitter config (DUR-273)", () => {
  it("defaults when the env vars are unset or blank", () => {
    expect(resolveHeartbeatTimerJitterRatio({})).toBe(DEFAULT_HEARTBEAT_TIMER_JITTER_RATIO);
    expect(resolveHeartbeatTimerJitterRatio({ HEARTBEAT_TIMER_JITTER_RATIO: "  " })).toBe(DEFAULT_HEARTBEAT_TIMER_JITTER_RATIO);
    expect(resolveHeartbeatTimerJitterMaxMs({})).toBe(DEFAULT_HEARTBEAT_TIMER_JITTER_MAX_MS);
  });

  it("honours explicit values, treats 0/negative/garbage as disabled, and caps the ratio", () => {
    expect(resolveHeartbeatTimerJitterRatio({ HEARTBEAT_TIMER_JITTER_RATIO: "0.02" })).toBe(0.02);
    expect(resolveHeartbeatTimerJitterRatio({ HEARTBEAT_TIMER_JITTER_RATIO: "0" })).toBe(0);
    expect(resolveHeartbeatTimerJitterRatio({ HEARTBEAT_TIMER_JITTER_RATIO: "-1" })).toBe(0);
    expect(resolveHeartbeatTimerJitterRatio({ HEARTBEAT_TIMER_JITTER_RATIO: "abc" })).toBe(0);
    expect(resolveHeartbeatTimerJitterRatio({ HEARTBEAT_TIMER_JITTER_RATIO: "3" })).toBe(MAX_HEARTBEAT_TIMER_JITTER_RATIO);
    expect(resolveHeartbeatTimerJitterMaxMs({ HEARTBEAT_TIMER_JITTER_MAX_MS: "1500" })).toBe(1500);
    expect(resolveHeartbeatTimerJitterMaxMs({ HEARTBEAT_TIMER_JITTER_MAX_MS: "0" })).toBe(0);
    expect(resolveHeartbeatTimerJitterMaxMs({ HEARTBEAT_TIMER_JITTER_MAX_MS: "nope" })).toBe(0);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres timer-jitter tickTimers tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat tickTimers applies per-agent jitter (DUR-273)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-timer-jitter-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 600, wakeOnDemand: true } },
      permissions: {},
      lastHeartbeatAt: new Date("2026-06-04T00:00:00Z"),
    });
    return agentId;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Jitter Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function wakeupsFor(agentId: string) {
    return db
      .select({ agentId: agentWakeupRequests.agentId, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
  }

  // The agents here have no assigned work, so a timer wake that fires is
  // recorded as an agentWakeupRequests row (reason
  // "heartbeat.timer.no_actionable_work") rather than a run -- the same
  // observable the DUR-3932 isolation test keys on. No row at all means the
  // timer never fired for that agent on that tick.
  it("does not wake an agent at exactly intervalSec when its jitter offset has not elapsed", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Late Agent");
    const heartbeat = heartbeatService(db, {
      // 5% of 600s = 30s, and the sample pins this agent at the top of that span.
      timerJitter: { ratio: 0.05, maxMs: 60_000, sample: () => 1 },
    });

    const atInterval = await heartbeat.tickTimers(new Date("2026-06-04T00:10:00Z"));
    expect(atInterval.checked).toBe(1);
    expect(atInterval.enqueued + atInterval.skipped).toBe(0);
    expect(await wakeupsFor(agentId)).toHaveLength(0);

    const justBeforeOffset = await heartbeat.tickTimers(new Date("2026-06-04T00:10:29Z"));
    expect(justBeforeOffset.enqueued + justBeforeOffset.skipped).toBe(0);
    expect(await wakeupsFor(agentId)).toHaveLength(0);

    const afterOffset = await heartbeat.tickTimers(new Date("2026-06-04T00:10:30Z"));
    expect(afterOffset.enqueued + afterOffset.skipped).toBe(1);
    expect(await wakeupsFor(agentId)).toHaveLength(1);
  });

  it("wakes at exactly intervalSec when jitter is disabled", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Punctual Agent");
    const heartbeat = heartbeatService(db, { timerJitter: { ratio: 0 } });

    const result = await heartbeat.tickTimers(new Date("2026-06-04T00:10:00Z"));
    expect(result.checked).toBe(1);
    expect(result.enqueued + result.skipped).toBe(1);
    expect(await wakeupsFor(agentId)).toHaveLength(1);
  });

  it("wakes agents that share a lastHeartbeatAt at different ticks instead of all at once", async () => {
    const companyId = await seedCompany();
    const early = await seedAgent(companyId, "Early");
    const late = await seedAgent(companyId, "Late");
    const heartbeat = heartbeatService(db, {
      timerJitter: {
        ratio: 0.05,
        maxMs: 60_000,
        sample: (agentId) => (agentId === early ? 0 : 1),
      },
    });

    const firstTick = await heartbeat.tickTimers(new Date("2026-06-04T00:10:00Z"));
    expect(firstTick.checked).toBe(2);
    expect(await wakeupsFor(early)).toHaveLength(1);
    expect(await wakeupsFor(late)).toHaveLength(0);

    await heartbeat.tickTimers(new Date("2026-06-04T00:10:30Z"));
    expect(await wakeupsFor(late)).toHaveLength(1);
  });
});
