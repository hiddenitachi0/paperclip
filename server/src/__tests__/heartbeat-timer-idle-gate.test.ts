import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueRelations,
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
    // Wait for in-flight runs BEFORE clearing the mock: clearing first let a
    // run that finished milliseconds later register against the next test,
    // which is half of what made this file flaky on CI (DUR-3981).
    await waitFor(async () => {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running')`);
      return active.length === 0;
    }, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
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

  /** The gate records a failed signal query; a clean case must have none. */
  async function readIdleSkipState(agentId: string) {
    const [state] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, agentId));
    return (state?.stateJson as Record<string, Record<string, unknown>> | undefined)?.timerIdleSkips;
  }

  async function expectNoCheckError(agentId: string) {
    const skips = await readIdleSkipState(agentId);
    expect(skips?.lastCheckError, "the gate fell open because a signal query failed, so this case proves nothing").toBeUndefined();
  }

  async function expectRanAndExecuted(run: { id: string } | null, agentId?: string) {
    expect(run).not.toBeNull();
    if (agentId) await expectNoCheckError(agentId);
    await waitFor(async () => mockAdapterExecute.mock.calls.some(([ctx]) => (ctx as { runId?: string })?.runId === run!.id));
    expect(mockAdapterExecute.mock.calls.some(([ctx]) => (ctx as { runId?: string })?.runId === run!.id)).toBe(true);
  }

  it("skips an idle scheduled wake-up before any run exists, and records it without per-skip rows", async () => {
    const s = await seed();
    const before = await db.select({ lastHeartbeatAt: agents.lastHeartbeatAt }).from(agents).where(eq(agents.id, s.agentId));

    const run = await timerWake(s.agentId);

    expect(run).toBeNull();
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
    await expectRanAndExecuted(await timerWake(s.agentId), s.agentId);
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
    await expectRanAndExecuted(await timerWake(s.agentId), s.agentId);
  });

  it("runs once the last run started longer ago than the safety window", async () => {
    const s = await seed({ lastRun: { startedMinutesAgo: 130 } });
    await expectRanAndExecuted(await timerWake(s.agentId), s.agentId);
  });

  it("runs when the agent has never run", async () => {
    const s = await seed({ lastRun: null });
    await expectRanAndExecuted(await timerWake(s.agentId), s.agentId);
  });

  for (const status of ["failed", "cancelled", "timed_out"]) {
    it(`runs when the previous run ended ${status}`, async () => {
      const s = await seed({ lastRun: { status } });
      await expectRanAndExecuted(await timerWake(s.agentId), s.agentId);
    });
  }

  // ---- DUR-3943 round 3 ------------------------------------------------

  /** The reasons a scheduled wake-up was let through, as GET /api/agents/:id/runtime-state returns them. */
  async function readRunReasons(agentId: string) {
    const state = await heartbeat.getRuntimeState(agentId);
    return (state?.stateJson as Record<string, Record<string, unknown>> | undefined)?.timerIdleRunReasons;
  }

  it("records why each scheduled wake-up ran, per reason, on the runtime state the API returns", async () => {
    // no_previous_run
    const fresh = await seed({ lastRun: null });
    await expectRanAndExecuted(await timerWake(fresh.agentId), fresh.agentId);
    expect(await readRunReasons(fresh.agentId)).toMatchObject({
      byReason: { no_previous_run: 1 },
      lastReason: "no_previous_run",
      day: new Date().toISOString().slice(0, 10),
    });

    // previous_run_not_succeeded
    const failed = await seed({ lastRun: { status: "failed" } });
    await expectRanAndExecuted(await timerWake(failed.agentId), failed.agentId);
    expect(await readRunReasons(failed.agentId)).toMatchObject({
      byReason: { previous_run_not_succeeded: 1 },
      lastReason: "previous_run_not_succeeded",
      lastDetail: "failed",
    });

    // wake_on_demand_off
    const noDemand = await seed({ heartbeat: { wakeOnDemand: false } });
    await expectRanAndExecuted(await timerWake(noDemand.agentId), noDemand.agentId);
    expect(await readRunReasons(noDemand.agentId)).toMatchObject({ lastReason: "wake_on_demand_off" });

    // Something new: which signal, and what matched.
    const commented = await seed();
    await db.update(issues).set({ identifier: "NOR-77" }).where(eq(issues.id, commented.standingIssueId));
    await db.update(issues).set({ updatedAt: ago(2 * 24 * 60) }).where(eq(issues.id, commented.standingIssueId));
    await db.insert(issueComments).values({
      companyId: commented.companyId,
      issueId: commented.standingIssueId,
      authorUserId: "board-user",
      authorType: "user",
      body: "Any news on this?",
      createdAt: ago(10),
    });
    await expectRanAndExecuted(await timerWake(commented.agentId), commented.agentId);
    expect(await readRunReasons(commented.agentId)).toMatchObject({
      byReason: { comment_on_assigned_issue: 1 },
      lastReason: "comment_on_assigned_issue",
      lastDetail: "NOR-77",
    });

    // A skip adds no run reason.
    const idle = await seed();
    expect(await timerWake(idle.agentId)).toBeNull();
    expect(await readRunReasons(idle.agentId)).toBeUndefined();
  });

  it("skips an agent whose only in-progress issue has had nothing new since a succeeded run (Dashboard Boss)", async () => {
    const s = await seed({ standingIssueStatus: "in_progress" });
    expect(await timerWake(s.agentId)).toBeNull();
    expect(await runsFor(s.agentId)).toHaveLength(1);
    await expectNoCheckError(s.agentId);
    expect(await readIdleSkipState(s.agentId)).toMatchObject({ total: 1 });
  });

  it("runs for an in-progress issue that changed since the last run", async () => {
    const s = await seed({ standingIssueStatus: "in_progress" });
    await db.update(issues).set({ updatedAt: ago(5) }).where(eq(issues.id, s.standingIssueId));
    await expectRanAndExecuted(await timerWake(s.agentId), s.agentId);
    expect(await readRunReasons(s.agentId)).toMatchObject({ lastReason: "held_issue_changed" });
  });

  it("runs for an in-progress issue whose checkout belongs to a run that is no longer active", async () => {
    const s = await seed({ standingIssueStatus: "in_progress" });
    await db.update(issues).set({ checkoutRunId: s.lastRunId }).where(eq(issues.id, s.standingIssueId));
    await db.update(issues).set({ updatedAt: ago(2 * 24 * 60) }).where(eq(issues.id, s.standingIssueId));
    await expectRanAndExecuted(await timerWake(s.agentId), s.agentId);
    expect(await readRunReasons(s.agentId)).toMatchObject({ lastReason: "held_issue_stale_checkout" });
  });

  it("the safety window still forces a run for an untouched in-progress issue", async () => {
    const s = await seed({ standingIssueStatus: "in_progress", lastRun: { startedMinutesAgo: 130 } });
    await expectRanAndExecuted(await timerWake(s.agentId), s.agentId);
    expect(await readRunReasons(s.agentId)).toMatchObject({ lastReason: "safety_window_elapsed" });
  });

  describe("board-approval wait (DUR-3979) unchanged", () => {
    async function linkApproval(s: Seeded, status: string) {
      const approvalId = randomUUID();
      await db.insert(approvals).values({
        id: approvalId,
        companyId: s.companyId,
        type: "request_board_approval",
        requestedByAgentId: s.agentId,
        status,
        payload: { title: "Put the new dashboard live" },
        createdAt: ago(300),
        updatedAt: ago(300),
      });
      await db.insert(issueApprovals).values({ companyId: s.companyId, issueId: s.standingIssueId, approvalId, createdAt: ago(300) });
    }

    it("an in-progress, checked-out-by-a-finished-run issue waiting only on the operator's decision does not keep the timer awake", async () => {
      const s = await seed({ standingIssueStatus: "in_progress" });
      await linkApproval(s, "pending");
      await db.update(issues).set({ checkoutRunId: s.lastRunId }).where(eq(issues.id, s.standingIssueId));
      await db.update(issues).set({ updatedAt: ago(2 * 24 * 60) }).where(eq(issues.id, s.standingIssueId));
      expect(await timerWake(s.agentId)).toBeNull();
      await expectNoCheckError(s.agentId);
    });

    it("an approval the operator sent back for changes still runs every tick (nothing else wakes the agent for it)", async () => {
      const s = await seed({ standingIssueStatus: "in_progress" });
      await linkApproval(s, "revision_requested");
      await expectRanAndExecuted(await timerWake(s.agentId), s.agentId);
      expect(await readRunReasons(s.agentId)).toMatchObject({ lastReason: "held_issue_approval_sent_back" });
    });
  });

  it("reproduction (Tech Boss / CEO): the stranded-task sweep's rejected asks for a blocked task no longer make every tick run", async () => {
    // Tech Boss: no in-progress or checked-out work, wake on demand, a
    // succeeded previous run. It owns a todo task that has never had a run
    // and is blocked by a task still open.
    const s = await seed({ standingIssueStatus: "blocked" });
    const blockerId = randomUUID();
    const blockedTodoId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId: s.companyId,
        title: "Prerequisite still open",
        status: "todo",
        priority: "medium",
        assigneeUserId: "board-user",
        createdAt: ago(2 * 24 * 60),
        updatedAt: ago(2 * 24 * 60),
      },
      {
        id: blockedTodoId,
        companyId: s.companyId,
        title: "Plan the next release",
        status: "todo",
        priority: "medium",
        assigneeAgentId: s.agentId,
        createdByUserId: "board-user",
        createdAt: ago(2 * 24 * 60),
        updatedAt: ago(2 * 24 * 60),
      },
    ]);
    await db.insert(issueRelations).values({
      companyId: s.companyId,
      issueId: blockerId,
      relatedIssueId: blockedTodoId,
      type: "blocks",
      createdAt: ago(2 * 24 * 60),
      updatedAt: ago(2 * 24 * 60),
    });

    // The periodic recovery pipeline (every 30 s on production) asks to wake
    // the agent for that task on every pass; the heartbeat turns each ask
    // down. This is the row the gate used to count as news.
    await heartbeat.reconcileStrandedAssignedIssues();
    await heartbeat.reconcileStrandedAssignedIssues();
    const rejected = await db
      .select({ reason: agentWakeupRequests.reason, status: agentWakeupRequests.status, source: agentWakeupRequests.source })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, s.agentId));
    expect(rejected.length).toBeGreaterThanOrEqual(2);
    expect(rejected.every((row) => row.reason === "issue_dependencies_blocked" && row.status === "skipped")).toBe(true);

    // The scheduled tick: nothing new for this agent, so it is skipped.
    expect(await timerWake(s.agentId)).toBeNull();
    expect(await runsFor(s.agentId)).toHaveLength(1);
    await expectNoCheckError(s.agentId);
    expect(await readIdleSkipState(s.agentId)).toMatchObject({ total: 1 });

    // And finishing the blocker is still news.
    await db
      .update(issues)
      .set({ status: "done", completedAt: ago(1), updatedAt: ago(1) })
      .where(eq(issues.id, blockerId));
    await expectRanAndExecuted(await timerWake(s.agentId), s.agentId);
    expect(await readRunReasons(s.agentId)).toMatchObject({ lastReason: "blocker_resolved" });
  });

  for (const source of ["on_demand", "assignment", "automation"] as const) {
    it(`never gates a ${source} wake-up, even for an idle agent`, async () => {
      const s = await seed();
      await expectRanAndExecuted(
        await heartbeat.wakeup(s.agentId, { source, triggerDetail: "system", requestedByActorType: "system" }),
        s.agentId,
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
    await expectRanAndExecuted(await timerWake(s.agentId), s.agentId);
  });

  it("fails open: a signal whose query fails lets the run go ahead and is recorded", async () => {
    const s = await seed();
    // First prove this fixture reaches a skip, which means every signal query
    // ran and answered "nothing new" -- including the approval-comments one
    // broken below. Without this the test could pass on an early return.
    expect(await timerWake(s.agentId)).toBeNull();
    await expectNoCheckError(s.agentId);

    // Each test file owns its embedded Postgres cluster, so renaming a table
    // breaks exactly this check, in this database, and nothing else. The run
    // path does not read approval_comments.
    await db.execute(sql.raw(`ALTER TABLE "approval_comments" RENAME TO "approval_comments_hidden_for_test"`));
    try {
      expect(await timerWake(s.agentId)).not.toBeNull();
    } finally {
      await db.execute(sql.raw(`ALTER TABLE "approval_comments_hidden_for_test" RENAME TO "approval_comments"`));
    }

    // The broken signal is named, so a permanently failing query is visible
    // instead of quietly running every tick at full price.
    const skips = await readIdleSkipState(s.agentId);
    expect(skips?.lastCheckError).toMatchObject({ signals: "approval_comment_by_others" });
  });

  it("a run's own work does not make the agent's next scheduled tick look busy", async () => {
    // DUR-3981: this used to drive a real run and then assert the run table.
    // A finished run queues a `finish_successful_run_handoff` wake-up about
    // 100ms later, so whether a second run existed at assertion time was a
    // race against the machine's speed -- green locally, red on CI.
    //
    // The rule under test is that a run's OWN writes are not news, so the
    // artifacts a finished run leaves behind are written here with fixed
    // timestamps relative to the seeded run, and the tick is then taken.
    const s2 = await seed();
    const [lastRun] = await db
      .select({ startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, s2.lastRunId));
    const startedAt = lastRun!.startedAt!;
    const finishedAt = lastRun!.finishedAt!;
    const during = new Date(startedAt.getTime() + 1_000);

    // Its own clean-up bump on the issue, moments after it finished.
    await db
      .update(issues)
      .set({ updatedAt: new Date(finishedAt.getTime() + 1_000) })
      .where(eq(issues.id, s2.standingIssueId));
    // Its own comment on its own issue.
    await db.insert(issueComments).values({
      companyId: s2.companyId,
      issueId: s2.standingIssueId,
      authorAgentId: s2.agentId,
      authorType: "agent",
      body: "Looked at this and left a note.",
      createdAt: during,
    });
    // Activity written by the agent, and by the system for that same run.
    await db.insert(activityLog).values([
      {
        companyId: s2.companyId,
        actorType: "agent",
        actorId: s2.agentId,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: s2.standingIssueId,
        runId: s2.lastRunId,
        createdAt: during,
      },
      {
        companyId: s2.companyId,
        actorType: "system",
        actorId: "heartbeat",
        action: "issue.successful_run_handoff_required",
        entityType: "issue",
        entityId: s2.standingIssueId,
        runId: s2.lastRunId,
        createdAt: new Date(finishedAt.getTime() + 200),
      },
      {
        companyId: s2.companyId,
        actorType: "agent",
        actorId: s2.agentId,
        action: "environment.lease_released",
        entityType: "environment_lease",
        entityId: randomUUID(),
        runId: s2.lastRunId,
        createdAt: new Date(finishedAt.getTime() + 300),
      },
      {
        // The agent's own work, with no run id on the row: this one is
        // excluded because of WHO wrote it, not which run it belonged to, so
        // both halves of that rule are covered independently.
        companyId: s2.companyId,
        actorType: "agent",
        actorId: s2.agentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: s2.standingIssueId,
        createdAt: during,
      },
    ]);
    // The wake-up that started it: asked for before it began, now finished.
    await db.insert(agentWakeupRequests).values({
      companyId: s2.companyId,
      agentId: s2.agentId,
      source: "assignment",
      reason: "issue_assigned",
      status: "completed",
      requestedAt: new Date(startedAt.getTime() - 1_000),
      runId: s2.lastRunId,
    });

    expect(await timerWake(s2.agentId)).toBeNull();
    // Agent-scoped, so a neighbouring test's run can never affect it.
    expect(await runsFor(s2.agentId)).toHaveLength(1);
    // It skipped because the rule said so, not because a query threw.
    await expectNoCheckError(s2.agentId);
    expect(await readIdleSkipState(s2.agentId)).toMatchObject({ total: 1 });
  });

  it("does run the next tick when the finished run left real follow-up work", async () => {
    // The other half of the same rule: a real run queues a handoff wake-up as
    // it ends, and that IS news -- this tick must not be skipped.
    const s3 = await seed();
    await db.insert(agentWakeupRequests).values({
      companyId: s3.companyId,
      agentId: s3.agentId,
      source: "automation",
      reason: "finish_successful_run_handoff",
      status: "completed",
      requestedAt: ago(24),
    });
    await expectRanAndExecuted(await timerWake(s3.agentId), s3.agentId);
  });
});
