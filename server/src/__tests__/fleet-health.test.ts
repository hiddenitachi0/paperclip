import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FleetRequestLoad, FleetSchedulerStatus, FleetDatabaseLoad } from "@paperclipai/shared";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  computeFleetHealth,
  computeFleetSlotUsage,
  FLEET_HEALTH_WINDOW_MS,
  FLEET_ZOMBIE_SILENCE_MS,
  summarizeFleetHealth,
} from "../services/fleet-health.js";

const healthyScheduler: FleetSchedulerStatus = {
  enabled: true,
  intervalMs: 30_000,
  lastTickStartedAt: "2026-09-06T10:00:00.000Z",
  lastTickFinishedAt: "2026-09-06T10:00:00.250Z",
  lastTickResult: { checked: 12, enqueued: 8, skipped: 4 },
  lastTickError: null,
  sinceLastTickMs: 12_000,
  stale: false,
};

const quietRequests: FleetRequestLoad = {
  inFlight: 2,
  streaming: 0,
  peakInFlight: 9,
  peakInFlightAt: "2026-09-06T09:00:00.000Z",
  longestInFlightMs: 120,
  slowInFlight: 0,
  slowThresholdMs: 10_000,
  overloadThreshold: 50,
  overloaded: false,
  totalStarted: 1_000,
  totalFinished: 998,
};

const calmDatabase: FleetDatabaseLoad = {
  available: true,
  poolMax: 20,
  connections: 6,
  active: 1,
  idleInTransaction: 0,
  waitingOnLocks: 0,
};

function runs(overrides: Partial<Parameters<typeof summarizeFleetHealth>[0]["runs"]> = {}) {
  return {
    windowMinutes: 15,
    startedInWindow: 9,
    succeededInWindow: 7,
    failedInWindow: 1,
    cancelledInWindow: 0,
    running: 3,
    queued: 0,
    oldestQueuedWaitMs: null,
    zombieCandidates: 0,
    zombieSilenceMinutes: 30,
    ...overrides,
  };
}

function summarize(input: Partial<Parameters<typeof summarizeFleetHealth>[0]> = {}) {
  const runCounts = input.runs ?? runs();
  return summarizeFleetHealth({
    runs: runCounts,
    slots: input.slots ?? computeFleetSlotUsage(4, runCounts.running),
    agents: input.agents ?? { inError: 0, inErrorSample: [] },
    scheduler: input.scheduler ?? healthyScheduler,
    requests: input.requests ?? quietRequests,
    database: input.database ?? calmDatabase,
  });
}

describe("computeFleetSlotUsage", () => {
  it("reports headroom and saturation against the instance cap", () => {
    expect(computeFleetSlotUsage(4, 2)).toEqual({ max: 4, used: 2, available: 2, saturated: false });
    expect(computeFleetSlotUsage(4, 4)).toEqual({ max: 4, used: 4, available: 0, saturated: true });
    // Over the cap (stale rows) still reads as saturated with zero headroom.
    expect(computeFleetSlotUsage(4, 6)).toEqual({ max: 4, used: 6, available: 0, saturated: true });
    expect(computeFleetSlotUsage(0, 0)).toEqual({ max: 0, used: 0, available: 0, saturated: false });
  });
});

// Each case below is one of the incidents the signal exists for, expressed
// as the numbers an operator would have seen had the signal existed then.
describe("summarizeFleetHealth (DUR-3939/DUR-3940/DUR-272/DUR-98)", () => {
  it("reads as flowing when runs are starting and nothing is wrong", () => {
    const summary = summarize();
    expect(summary.level).toBe("ok");
    expect(summary.headline).toBe(
      "Runs are flowing: 9 started, 7 finished, 1 failed in the last 15 minutes. 3 of 4 slots in use.",
    );
    expect(summary.notes).toEqual([]);
  });

  it("says quiet, not healthy-by-assumption, when nothing has happened at all", () => {
    const summary = summarize({ runs: runs({ startedInWindow: 0, succeededInWindow: 0, failedInWindow: 0, running: 0 }) });
    expect(summary.level).toBe("ok");
    expect(summary.headline).toBe("Quiet: nothing started in the last 15 minutes and nothing is queued. 0 of 4 slots in use.");
  });

  it("2026-09-06 starvation: all slots held for 20+ minutes with 15 queued reads as cap saturation, not a broken scheduler", () => {
    const summary = summarize({
      runs: runs({ running: 4, queued: 15, oldestQueuedWaitMs: 20 * 60_000 }),
      slots: computeFleetSlotUsage(4, 4),
    });
    expect(summary.level).toBe("warning");
    expect(summary.headline).toBe(
      'All 4 run slots are in use and 15 runs are waiting for one (the oldest has waited 20 minutes). Nothing is broken; raise "Max concurrent runs (whole instance)" under Settings > Instance settings > General to let more through.',
    );
    expect(summary.notes.at(-1)).toContain("Runs are flowing");
  });

  it("a briefly full cap is informational, not a warning", () => {
    const summary = summarize({
      runs: runs({ running: 4, queued: 2, oldestQueuedWaitMs: 3 * 60_000 }),
      slots: computeFleetSlotUsage(4, 4),
    });
    expect(summary.level).toBe("ok");
    expect(summary.headline).toContain("Runs are flowing");
    expect(summary.notes).toEqual([
      'All 4 run slots are in use and 2 runs are waiting for one (the oldest has waited 3 minutes). Nothing is broken; raise "Max concurrent runs (whole instance)" under Settings > Instance settings > General to let more through.',
    ]);
  });

  it("DUR-3932 dormant fleet: a scheduler that stopped ticking is critical", () => {
    const summary = summarize({
      runs: runs({ startedInWindow: 0, succeededInWindow: 0, failedInWindow: 0, running: 0, queued: 6, oldestQueuedWaitMs: 5 * 3_600_000 }),
      scheduler: { ...healthyScheduler, sinceLastTickMs: 5 * 3_600_000, stale: true },
    });
    expect(summary.level).toBe("critical");
    expect(summary.headline).toBe(
      "The scheduler has not completed a tick for 5 hours. Agents will not be woken until this is fixed (a server restart usually clears it).",
    );
  });

  it("a scheduler that never ticked since boot is reported as such", () => {
    const summary = summarize({ scheduler: { ...healthyScheduler, lastTickFinishedAt: null, sinceLastTickMs: null, stale: true } });
    expect(summary.level).toBe("critical");
    expect(summary.headline).toContain("has not completed a tick since the server started");
  });

  it("queued work with free slots and a live scheduler but no starts is critical", () => {
    const summary = summarize({
      runs: runs({ startedInWindow: 0, succeededInWindow: 0, failedInWindow: 0, running: 1, queued: 4, oldestQueuedWaitMs: 40 * 60_000 }),
      slots: computeFleetSlotUsage(4, 1),
    });
    expect(summary.level).toBe("critical");
    expect(summary.headline).toBe(
      "4 runs are queued but none has started in the last 15 minutes, even though 3 slots are free. Something is holding the queue.",
    );
  });

  it("a switched-off scheduler is a warning, and a failing tick is surfaced", () => {
    expect(summarize({ scheduler: { ...healthyScheduler, enabled: false, stale: false } })).toMatchObject({
      level: "warning",
      headline: "The scheduler is switched off on this server, so no agent will wake on its own timer.",
    });
    expect(summarize({ scheduler: { ...healthyScheduler, lastTickError: "connection reset" } })).toMatchObject({
      level: "warning",
      headline: "The scheduler's last tick failed: connection reset",
    });
  });

  it("DUR-257 zombies: running rows silent past the threshold are called out as candidates", () => {
    const summary = summarize({ runs: runs({ zombieCandidates: 2 }) });
    expect(summary.level).toBe("warning");
    expect(summary.headline).toBe(
      "2 runs have shown no output for 30+ minutes and may be stuck, holding a slot. The watchdog ends a run once its process is confirmed gone.",
    );
  });

  it("DUR-128 agents in error are named so the operator knows who to look at", () => {
    const summary = summarize({
      agents: {
        inError: 5,
        inErrorSample: [
          { id: "a", name: "Reviewer", companyId: "c", errorAt: null },
          { id: "b", name: "Backend Engineer", companyId: "c", errorAt: null },
          { id: "c", name: "Fork Lead", companyId: "c", errorAt: null },
          { id: "d", name: "Writer", companyId: "c", errorAt: null },
        ],
      },
    });
    expect(summary.level).toBe("warning");
    expect(summary.headline).toBe(
      "5 agents have stopped with an error and will not take work until someone clears it: Reviewer, Backend Engineer, Fork Lead and 2 more.",
    );
    expect(summarize({ agents: { inError: 1, inErrorSample: [{ id: "a", name: "Reviewer", companyId: "c", errorAt: null }] } }).headline).toBe(
      "1 agent has stopped with an error and will not take work until someone clears it: Reviewer.",
    );
  });

  it("DUR-271 request pile-up reads as overloaded, not down", () => {
    const summary = summarize({ requests: { ...quietRequests, inFlight: 109, overloaded: true } });
    expect(summary.level).toBe("critical");
    expect(summary.headline).toBe(
      "The server is handling 109 requests at once (its overload line is 50). It is overloaded, not down; expect slow pages until this drains.",
    );
    // A few slow requests on their own are informational: the note is
    // there, but the strip stays green. (Long-running streams such as board
    // chat are not even counted -- see request-load.test.ts.)
    const slow = summarize({ requests: { ...quietRequests, slowInFlight: 3, streaming: 2 } });
    expect(slow.level).toBe("ok");
    expect(slow.headline).toContain("Runs are flowing");
    expect(slow.notes).toEqual([
      "3 requests have been waiting longer than 10 seconds. That is fine on its own; it only matters if pages feel slow.",
    ]);
  });

  it("an exhausted database pool is called out", () => {
    const summary = summarize({ database: { ...calmDatabase, active: 20 } });
    expect(summary.level).toBe("warning");
    expect(summary.headline).toBe("Every database connection is busy (20 of 20); requests are queuing behind the database.");
  });

  it("orders findings most severe first and keeps the flow line as the last note", () => {
    const summary = summarize({
      runs: runs({ zombieCandidates: 1, running: 4, queued: 2, oldestQueuedWaitMs: 60_000 }),
      slots: computeFleetSlotUsage(4, 4),
      scheduler: { ...healthyScheduler, stale: true, sinceLastTickMs: 10 * 60_000 },
      agents: { inError: 1, inErrorSample: [{ id: "a", name: "Reviewer", companyId: "c", errorAt: null }] },
    });
    expect(summary.level).toBe("critical");
    expect(summary.headline).toContain("The scheduler has not completed a tick for 10 minutes");
    expect(summary.notes).toHaveLength(4);
    expect(summary.notes[0]).toContain("may be stuck");
    expect(summary.notes[1]).toContain("Reviewer");
    expect(summary.notes[2]).toContain("All 4 run slots are in use");
    expect(summary.notes[3]).toContain("Runs are flowing");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres fleet-health tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("computeFleetHealth against live rows", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("fleet-health-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(companyId: string, name: string, status: string, errorAt?: Date) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "engineer",
      status,
      errorReason: status === "error" ? "Adapter crashed" : null,
      errorAt: errorAt ?? null,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    status: string;
    createdAt: Date;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    lastOutputAt?: Date | null;
    processStartedAt?: Date | null;
  }) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: input.status,
      contextSnapshot: {},
      createdAt: input.createdAt,
      startedAt: input.startedAt ?? null,
      finishedAt: input.finishedAt ?? null,
      lastOutputAt: input.lastOutputAt ?? null,
      processStartedAt: input.processStartedAt ?? null,
      updatedAt: new Date(),
    });
    return id;
  }

  it("counts the window, the active set, zombies, and agents in error from live rows", async () => {
    const now = new Date();
    const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Fleet Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const archivedCompanyId = randomUUID();
    await db.insert(companies).values({
      id: archivedCompanyId,
      name: "Archived Co",
      status: "archived",
      issuePrefix: `A${archivedCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const worker = await seedAgent(companyId, "Worker", "running");
    const broken = await seedAgent(companyId, "Broken", "error", minutesAgo(90));
    // An errored agent in an archived company is not the operator's problem today.
    await seedAgent(archivedCompanyId, "Ghost", "error", minutesAgo(10));

    // In-window: started 5 min ago, finished 3 min ago.
    await seedRun({ companyId, agentId: worker, status: "succeeded", createdAt: minutesAgo(6), startedAt: minutesAgo(5), finishedAt: minutesAgo(3) });
    // In-window failure and a timeout (both count as failed).
    await seedRun({ companyId, agentId: worker, status: "failed", createdAt: minutesAgo(10), startedAt: minutesAgo(9), finishedAt: minutesAgo(8) });
    await seedRun({ companyId, agentId: worker, status: "timed_out", createdAt: minutesAgo(12), startedAt: minutesAgo(11), finishedAt: minutesAgo(2) });
    // Cancelled in window.
    await seedRun({ companyId, agentId: worker, status: "cancelled", createdAt: minutesAgo(7), startedAt: minutesAgo(7), finishedAt: minutesAgo(6) });
    // Outside the window: two hours ago.
    await seedRun({ companyId, agentId: worker, status: "succeeded", createdAt: minutesAgo(130), startedAt: minutesAgo(125), finishedAt: minutesAgo(120) });
    // Live and healthy: output a moment ago.
    await seedRun({ companyId, agentId: worker, status: "running", createdAt: minutesAgo(4), startedAt: minutesAgo(4), processStartedAt: minutesAgo(4), lastOutputAt: minutesAgo(0) });
    // Zombie candidate: started an hour ago, last output 45 min ago -- but
    // updatedAt is fresh (the watchdog bumps it), which must NOT hide it.
    await seedRun({ companyId, agentId: worker, status: "running", createdAt: minutesAgo(60), startedAt: minutesAgo(60), processStartedAt: minutesAgo(60), lastOutputAt: minutesAgo(45) });
    // Started 40 minutes ago (outside the window), still running: counts as running, not as started-in-window.
    await seedRun({ companyId, agentId: worker, status: "running", createdAt: minutesAgo(41), startedAt: minutesAgo(40), processStartedAt: minutesAgo(40), lastOutputAt: minutesAgo(1) });
    // Two queued: one waiting 20 minutes, one just now.
    await seedRun({ companyId, agentId: broken, status: "queued", createdAt: minutesAgo(20) });
    await seedRun({ companyId, agentId: broken, status: "queued", createdAt: minutesAgo(0) });

    const snapshot = await computeFleetHealth(db, {
      now,
      windowMs: FLEET_HEALTH_WINDOW_MS,
      zombieSilenceMs: FLEET_ZOMBIE_SILENCE_MS,
      globalMaxConcurrentRuns: 3,
      scheduler: healthyScheduler,
      requests: quietRequests,
    });

    expect(snapshot.available).toBe(true);
    expect(snapshot.runs).toMatchObject({
      windowMinutes: 15,
      startedInWindow: 5,
      succeededInWindow: 1,
      failedInWindow: 2,
      cancelledInWindow: 1,
      running: 3,
      queued: 2,
      zombieCandidates: 1,
      zombieSilenceMinutes: 30,
    });
    expect(snapshot.runs.oldestQueuedWaitMs).toBeGreaterThanOrEqual(20 * 60_000 - 1_000);
    expect(snapshot.runs.oldestQueuedWaitMs).toBeLessThanOrEqual(20 * 60_000 + 5_000);
    expect(snapshot.slots).toEqual({ max: 3, used: 3, available: 0, saturated: true });
    expect(snapshot.agents.inError).toBe(1);
    // Name and time only: the error text ("Adapter crashed") is never
    // carried on this instance-wide signal.
    expect(snapshot.agents.inErrorSample).toEqual([
      { id: broken, name: "Broken", companyId, errorAt: expect.any(String) },
    ]);
    expect(snapshot.database.available).toBe(true);
    expect(snapshot.database.connections).toBeGreaterThanOrEqual(1);
    expect(snapshot.database.poolMax).toBeGreaterThan(0);
    expect(snapshot.scheduler).toEqual(healthyScheduler);
    expect(snapshot.requests).toEqual(quietRequests);
    expect(snapshot.summary.level).toBe("warning");
    expect(snapshot.summary.notes.join("\n")).toContain("Broken");
    expect(snapshot.summary.notes.concat(snapshot.summary.headline).join("\n")).toContain("may be stuck");
  });

  it("reads the instance-wide cap from settings when no override is given, and is quiet on an empty database", async () => {
    const snapshot = await computeFleetHealth(db, { scheduler: healthyScheduler, requests: quietRequests });
    expect(snapshot.slots.max).toBeGreaterThan(0);
    expect(snapshot.runs).toMatchObject({ startedInWindow: 0, running: 0, queued: 0, zombieCandidates: 0, oldestQueuedWaitMs: null });
    expect(snapshot.agents).toEqual({ inError: 0, inErrorSample: [] });
    expect(snapshot.summary.level).toBe("ok");
    expect(snapshot.summary.headline).toContain("Quiet:");
  });
});
