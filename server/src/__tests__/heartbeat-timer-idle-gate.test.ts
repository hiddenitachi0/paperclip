import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

// DUR-3943 round 2, end to end through the real heartbeat service: a plain
// scheduled wake-up for an agent with open work but nothing new since its
// last run must not start a run; everything else must behave as before.
// These tests import only the heartbeat service (not the gate module), so
// they can be run against the code from before the gate existed.

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Timer idle gate test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat timer idle gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const MINUTE = 60_000;
const ago = (minutes: number, from = new Date()) => new Date(from.getTime() - minutes * MINUTE);

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("heartbeat timer idle gate (DUR-3943)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-timer-idle-gate-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await waitFor(async () => {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running')`);
      return active.length === 0;
    }, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await db.execute(sql.raw(`TRUNCATE TABLE "companies" RESTART IDENTITY CASCADE`));
        return;
      } catch (error) {
        if (attempt === 9) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  type Seeded = { companyId: string; agentId: string; standingIssueId: string; lastRunId: string };

  async function seed(opts: {
    heartbeat?: Record<string, unknown>;
    lastRun?: { status?: string; startedMinutesAgo?: number } | null;
    standingIssueStatus?: string;
  } = {}): Promise<Seeded> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Idle Gate Co",
      issuePrefix: `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Dashboard Boss",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 900, wakeOnDemand: true, maxConcurrentRuns: 1, ...(opts.heartbeat ?? {}) },
      },
      permissions: {},
      lastHeartbeatAt: ago(20),
    });
    const standingIssueId = randomUUID();
    await db.insert(issues).values({
      id: standingIssueId,
      companyId,
      title: "Standing work",
      status: opts.standingIssueStatus ?? "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
      createdAt: ago(2 * 24 * 60),
      updatedAt: ago(2 * 24 * 60),
    });
    const lastRunId = randomUUID();
    if (opts.lastRun !== null) {
      const startedMinutesAgo = opts.lastRun?.startedMinutesAgo ?? 30;
      await db.insert(heartbeatRuns).values({
        id: lastRunId,
        companyId,
        agentId,
        invocationSource: "timer",
        triggerDetail: "system",
        status: opts.lastRun?.status ?? "succeeded",
        createdAt: ago(startedMinutesAgo + 1),
        startedAt: ago(startedMinutesAgo),
        finishedAt: ago(startedMinutesAgo - 5),
      });
    }
    return { companyId, agentId, standingIssueId, lastRunId };
  }

  // Exactly what tickTimers passes.
  const timerWake = (agentId: string) =>
    heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
      contextSnapshot: { source: "scheduler", reason: "interval_elapsed", now: new Date().toISOString() },
    });

  const runsFor = (agentId: string) =>
    db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));

  async function expectRanAndExecuted(run: { id: string } | null) {
    expect(run).not.toBeNull();
    await waitFor(async () => mockAdapterExecute.mock.calls.some(([ctx]) => (ctx as { runId?: string })?.runId === run!.id));
    expect(mockAdapterExecute.mock.calls.some(([ctx]) => (ctx as { runId?: string })?.runId === run!.id)).toBe(true);
  }

  it("skips an idle scheduled wake-up before any run exists, and records it without per-skip rows", async () => {
    const s = await seed();
    const before = await db.select({ lastHeartbeatAt: agents.lastHeartbeatAt }).from(agents).where(eq(agents.id, s.agentId));

    const run = await timerWake(s.agentId);

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(await runsFor(s.agentId)).toHaveLength(1); // only the seeded previous run
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, s.agentId))).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, s.companyId))).toHaveLength(0);

    const [state] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, s.agentId));
    expect(state?.stateJson).toMatchObject({ timerIdleSkips: { total: 1, dayCount: 1, lastBaselineRunId: s.lastRunId } });
    const [after] = await db.select({ lastHeartbeatAt: agents.lastHeartbeatAt }).from(agents).where(eq(agents.id, s.agentId));
    expect(after!.lastHeartbeatAt!.getTime()).toBeGreaterThan(before[0]!.lastHeartbeatAt!.getTime());
  });

  it("tickTimers: a skip advances the timer so the next tick does not retry it, and repeated skips add no rows", async () => {
    const s = await seed();
    const now = new Date();

    const first = await heartbeat.tickTimers(now);
    const second = await heartbeat.tickTimers(now);
    expect(first).toMatchObject({ checked: 1, enqueued: 0, skipped: 1 });
    expect(second).toMatchObject({ checked: 1, enqueued: 0, skipped: 0 });

    // Two more intervals pass with nothing new.
    for (let i = 0; i < 2; i += 1) {
      await db.update(agents).set({ lastHeartbeatAt: ago(20) }).where(eq(agents.id, s.agentId));
      expect(await heartbeat.tickTimers(new Date())).toMatchObject({ enqueued: 0, skipped: 1 });
    }

    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(await runsFor(s.agentId)).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, s.agentId))).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, s.companyId))).toHaveLength(0);
    const [state] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, s.agentId));
    expect(state?.stateJson).toMatchObject({ timerIdleSkips: { total: 3 } });
  });

  it("runs a scheduled wake-up when someone commented on the agent's issue since its last run", async () => {
    const s = await seed();
    await db.insert(issueComments).values({
      companyId: s.companyId,
      issueId: s.standingIssueId,
      authorUserId: "board-user",
      authorType: "user",
      body: "Any news on this?",
      createdAt: ago(10),
    });
    await expectRanAndExecuted(await timerWake(s.agentId));
  });

  it("runs a scheduled wake-up when a new task was assigned since its last run", async () => {
    const s = await seed();
    await db.insert(issues).values({
      companyId: s.companyId,
      title: "Fresh task",
      status: "todo",
      priority: "high",
      assigneeAgentId: s.agentId,
      createdByUserId: "board-user",
      createdAt: ago(10),
      updatedAt: ago(10),
    });
    await expectRanAndExecuted(await timerWake(s.agentId));
  });

  it("runs once the last run started longer ago than the safety window", async () => {
    const s = await seed({ lastRun: { startedMinutesAgo: 130 } });
    await expectRanAndExecuted(await timerWake(s.agentId));
  });

  it("runs when the agent has never run", async () => {
    const s = await seed({ lastRun: null });
    await expectRanAndExecuted(await timerWake(s.agentId));
  });

  for (const status of ["failed", "cancelled", "timed_out"]) {
    it(`runs when the previous run ended ${status}`, async () => {
      const s = await seed({ lastRun: { status } });
      await expectRanAndExecuted(await timerWake(s.agentId));
    });
  }

  it("runs when the agent holds an in-progress issue", async () => {
    const s = await seed({ standingIssueStatus: "in_progress" });
    await expectRanAndExecuted(await timerWake(s.agentId));
  });

  for (const source of ["on_demand", "assignment", "automation"] as const) {
    it(`never gates a ${source} wake-up, even for an idle agent`, async () => {
      const s = await seed();
      await expectRanAndExecuted(
        await heartbeat.wakeup(s.agentId, { source, triggerDetail: "system", requestedByActorType: "system" }),
      );
    });
  }

  it("never gates a timer wake-up that carries an issue (e.g. a monitor)", async () => {
    const s = await seed();
    const run = await heartbeat.wakeup(s.agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "issue_monitor_due",
      payload: { issueId: s.standingIssueId },
      contextSnapshot: { issueId: s.standingIssueId, wakeReason: "issue_monitor_due" },
    });
    expect(run).not.toBeNull();
  });

  it("runs every scheduled wake-up when the agent opts out (skipTimerWhenNothingNew: false)", async () => {
    const s = await seed({ heartbeat: { skipTimerWhenNothingNew: false } });
    await expectRanAndExecuted(await timerWake(s.agentId));
  });

  it("fails open: a database error inside the check lets the run go ahead", async () => {
    const s = await seed();
    // approval_comments is read only by the idle check, late in its sequence
    // (every earlier signal is quiet for this agent), and not by the run path.
    await db.execute(sql.raw(`ALTER TABLE "approval_comments" RENAME TO "approval_comments_hidden_for_test"`));
    try {
      const run = await timerWake(s.agentId);
      expect(run).not.toBeNull();
    } finally {
      await db.execute(sql.raw(`ALTER TABLE "approval_comments_hidden_for_test" RENAME TO "approval_comments"`));
    }
    const [state] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, s.agentId));
    expect((state?.stateJson as Record<string, unknown> | undefined)?.timerIdleSkips).toBeUndefined();
  });

  it("a run's own work does not make the agent's next scheduled tick look busy", async () => {
    const s = await seed({ lastRun: null, standingIssueStatus: "todo" });
    const run = await heartbeat.wakeup(s.agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: s.standingIssueId },
      requestedByActorType: "system",
      contextSnapshot: { issueId: s.standingIssueId, source: "issue.create" },
    });
    expect(run).not.toBeNull();
    await waitFor(async () => {
      const rows = await runsFor(s.agentId);
      return rows.length > 0 && rows.every((row) => !["queued", "running", "scheduled_retry"].includes(row.status));
    }, 10_000);
    // Put the issue back into a waiting state the way a person would have
    // left it before the run, so only the run's own side effects remain.
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, s.standingIssueId));
    await db
      .update(issues)
      .set({ checkoutRunId: null, executionRunId: null, executionLockedAt: null })
      .where(eq(issues.id, s.standingIssueId));

    const rows = await runsFor(s.agentId);
    expect(rows.map((row) => row.status)).toEqual(["succeeded"]);
    expect(await timerWake(s.agentId)).toBeNull();
  });
});
