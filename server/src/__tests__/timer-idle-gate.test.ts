import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  approvalComments,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";
import { buildAgentMentionHref } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  DEFAULT_NOTHING_NEW_SAFETY_WINDOW_SEC,
  SELF_WRITE_GRACE_MS,
  TIMER_IDLE_SKIP_STATE_KEY,
  evaluateTimerIdleGate,
  readTimerIdleGatePolicy,
  recordTimerIdleSkip,
} from "../services/timer-idle-gate.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres timer idle gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const MINUTE = 60_000;

describe("readTimerIdleGatePolicy", () => {
  it("is on by default with a two hour safety window", () => {
    expect(readTimerIdleGatePolicy({ heartbeat: { enabled: true, intervalSec: 900 } })).toEqual({
      enabled: true,
      safetyWindowSec: DEFAULT_NOTHING_NEW_SAFETY_WINDOW_SEC,
    });
    expect(DEFAULT_NOTHING_NEW_SAFETY_WINDOW_SEC).toBe(7200);
  });

  it("is switched off by its own opt-out and by the DUR-42 always-wake opt-out", () => {
    expect(readTimerIdleGatePolicy({ heartbeat: { skipTimerWhenNothingNew: false } }).enabled).toBe(false);
    expect(readTimerIdleGatePolicy({ heartbeat: { skipTimerWhenNoActionableWork: false } }).enabled).toBe(false);
  });

  it("reads exactly one spelling of the window (…Sec, like intervalSec) and clamps it", () => {
    expect(readTimerIdleGatePolicy({ heartbeat: { nothingNewSafetyWindowSec: 600 } }).safetyWindowSec).toBe(600);
    // Parsed exactly like intervalSec (asNumber): a quoted number is not read,
    // and the safe default applies rather than something surprising.
    expect(readTimerIdleGatePolicy({ heartbeat: { nothingNewSafetyWindowSec: "900" } }).safetyWindowSec).toBe(7200);
    expect(readTimerIdleGatePolicy({ heartbeat: { nothingNewSafetyWindowSec: 5 } }).safetyWindowSec).toBe(60);
    expect(readTimerIdleGatePolicy({ heartbeat: { nothingNewSafetyWindowSec: 10_000_000 } }).safetyWindowSec).toBe(86_400);
    expect(readTimerIdleGatePolicy({ heartbeat: { nothingNewSafetyWindowSec: -1 } }).safetyWindowSec).toBe(7200);
    expect(readTimerIdleGatePolicy({ heartbeat: { nothingNewSafetyWindowSec: "soon" } }).safetyWindowSec).toBe(7200);
    // Not a second spelling: an unknown key leaves the default in place.
    expect(readTimerIdleGatePolicy({ heartbeat: { nothingNewSafetyWindowSeconds: 600 } }).safetyWindowSec).toBe(7200);
  });
});

describeEmbeddedPostgres("evaluateTimerIdleGate (embedded postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-timer-idle-gate-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" RESTART IDENTITY CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  type Fixture = {
    now: Date;
    companyId: string;
    agentId: string;
    otherAgentId: string;
    standingIssueId: string;
    lastRunId: string;
    runStartedAt: Date;
    runFinishedAt: Date;
    agent: { id: string; companyId: string; runtimeConfig: unknown; adapterType: string };
  };

  const ago = (now: Date, minutes: number) => new Date(now.getTime() - minutes * MINUTE);

  /**
   * An agent with one standing open issue (blocked, untouched for two days)
   * whose last run -- a timer run -- started 30 minutes ago and finished 25
   * minutes ago. With nothing else seeded, the gate must skip.
   */
  async function seed(opts: {
    heartbeat?: Record<string, unknown>;
    lastRun?: { status?: string; startedMinutesAgo?: number; finishedMinutesAgo?: number } | null;
  } = {}): Promise<Fixture> {
    const now = new Date();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Idle Gate Co",
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const runtimeConfig = {
      heartbeat: { enabled: true, intervalSec: 900, wakeOnDemand: true, ...(opts.heartbeat ?? {}) },
    };
    for (const [id, name] of [[agentId, "Dashboard Boss"], [otherAgentId, "Teammate"]] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: id === agentId ? runtimeConfig : {},
        permissions: {},
      });
    }
    const standingIssueId = randomUUID();
    await db.insert(issues).values({
      id: standingIssueId,
      companyId,
      title: "Standing work",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
      createdAt: ago(now, 2 * 24 * 60),
      updatedAt: ago(now, 2 * 24 * 60),
    });
    const lastRunId = randomUUID();
    const startedMinutesAgo = opts.lastRun?.startedMinutesAgo ?? 30;
    const finishedMinutesAgo = opts.lastRun?.finishedMinutesAgo ?? 25;
    const runStartedAt = ago(now, startedMinutesAgo);
    const runFinishedAt = ago(now, finishedMinutesAgo);
    if (opts.lastRun !== null) {
      await db.insert(heartbeatRuns).values({
        id: lastRunId,
        companyId,
        agentId,
        invocationSource: "timer",
        triggerDetail: "system",
        status: opts.lastRun?.status ?? "succeeded",
        createdAt: ago(now, startedMinutesAgo + 1),
        startedAt: runStartedAt,
        finishedAt: runFinishedAt,
      });
    }
    return {
      now,
      companyId,
      agentId,
      otherAgentId,
      standingIssueId,
      lastRunId,
      runStartedAt,
      runFinishedAt,
      agent: { id: agentId, companyId, runtimeConfig, adapterType: "codex_local" },
    };
  }

  const evaluate = (f: Fixture) => evaluateTimerIdleGate(db, f.agent, { now: f.now });

  it("skips when nothing has changed since the last run started", async () => {
    const f = await seed();
    expect(await evaluate(f)).toMatchObject({ decision: "skip", baselineRunId: f.lastRunId });
  });

  describe("standing rules that always run", () => {
    it("runs when the agent has no previous run", async () => {
      const f = await seed({ lastRun: null });
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "no_previous_run" });
    });

    for (const status of ["failed", "cancelled", "timed_out"]) {
      it(`runs when the previous run ended ${status}`, async () => {
        const f = await seed({ lastRun: { status } });
        expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "previous_run_not_succeeded" });
      });
    }

    it("runs once the last run started longer ago than the default safety window", async () => {
      const f = await seed({ lastRun: { startedMinutesAgo: 121, finishedMinutesAgo: 115 } });
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "safety_window_elapsed" });
    });

    it("skips just inside the default safety window", async () => {
      const f = await seed({ lastRun: { startedMinutesAgo: 119, finishedMinutesAgo: 115 } });
      expect(await evaluate(f)).toMatchObject({ decision: "skip" });
    });

    it("honours a per-agent safety window", async () => {
      const f = await seed({ heartbeat: { nothingNewSafetyWindowSec: 600 } });
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "safety_window_elapsed" });
    });

    it("runs when the agent holds an in-progress issue", async () => {
      const f = await seed();
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.standingIssueId));
      await db.update(issues).set({ updatedAt: ago(f.now, 2 * 24 * 60) }).where(eq(issues.id, f.standingIssueId));
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "holds_checked_out_or_in_progress_issue" });
    });

    it("runs when the agent holds a checked-out issue", async () => {
      const f = await seed();
      await db
        .update(issues)
        .set({ checkoutRunId: f.lastRunId, updatedAt: ago(f.now, 2 * 24 * 60) })
        .where(eq(issues.id, f.standingIssueId));
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "holds_checked_out_or_in_progress_issue" });
    });

    // DUR-3979: an in-progress task whose only remaining blocker is a
    // pending board approval is not work to continue -- it must not keep the
    // agent's timer awake on every tick.
    async function linkApproval(f: Fixture, status: string) {
      const approvalId = randomUUID();
      await db.insert(approvals).values({
        id: approvalId,
        companyId: f.companyId,
        type: "request_board_approval",
        requestedByAgentId: f.agentId,
        status,
        payload: { title: "Put the new dashboard live" },
        createdAt: ago(f.now, 300),
        updatedAt: ago(f.now, 300),
      });
      await db.insert(issueApprovals).values({
        companyId: f.companyId,
        issueId: f.standingIssueId,
        approvalId,
        createdAt: ago(f.now, 300),
      });
      return approvalId;
    }

    it("does not count an in-progress issue that waits only on the operator's decision (DUR-3979)", async () => {
      const f = await seed();
      await linkApproval(f, "pending");
      await db
        .update(issues)
        .set({ status: "in_progress", updatedAt: ago(f.now, 2 * 24 * 60) })
        .where(eq(issues.id, f.standingIssueId));
      expect(await evaluate(f)).toMatchObject({ decision: "skip", baselineRunId: f.lastRunId });
    });

    it("still runs when the operator sent that approval back for changes", async () => {
      const f = await seed();
      await linkApproval(f, "revision_requested");
      await db
        .update(issues)
        .set({ status: "in_progress", updatedAt: ago(f.now, 2 * 24 * 60) })
        .where(eq(issues.id, f.standingIssueId));
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "holds_checked_out_or_in_progress_issue" });
    });

    it("still runs when another held issue is real work", async () => {
      const f = await seed();
      await linkApproval(f, "pending");
      await db
        .update(issues)
        .set({ status: "in_progress", updatedAt: ago(f.now, 2 * 24 * 60) })
        .where(eq(issues.id, f.standingIssueId));
      await db.insert(issues).values({
        companyId: f.companyId,
        title: "Second task in progress",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: f.agentId,
        createdAt: ago(f.now, 2 * 24 * 60),
        updatedAt: ago(f.now, 2 * 24 * 60),
      });
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "holds_checked_out_or_in_progress_issue" });
    });

    it("runs when a run is queued or scheduled for the agent", async () => {
      const f = await seed();
      await db.insert(heartbeatRuns).values({
        companyId: f.companyId,
        agentId: f.agentId,
        invocationSource: "automation",
        status: "scheduled_retry",
        scheduledRetryAt: new Date(f.now.getTime() + 10 * MINUTE),
        createdAt: ago(f.now, 40),
      });
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "run_active_or_pending" });
    });

    it("never gates an agent that is not woken on demand (its timer is its only way to hear anything)", async () => {
      const f = await seed({ heartbeat: { wakeOnDemand: false } });
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "wake_on_demand_off" });
    });

    it("is off with skipTimerWhenNothingNew: false", async () => {
      const f = await seed({ heartbeat: { skipTimerWhenNothingNew: false } });
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "gate_disabled" });
    });
  });

  describe("something new since the last run started", () => {
    it("a non-timer wake-up requested since, whatever became of it", async () => {
      const f = await seed();
      await db.insert(agentWakeupRequests).values({
        companyId: f.companyId,
        agentId: f.agentId,
        source: "automation",
        reason: "issue_commented",
        status: "coalesced",
        requestedAt: ago(f.now, 10),
      });
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "wakeup_request" });
    });

    it("a wake-up still waiting from before the last run", async () => {
      const f = await seed();
      await db.insert(agentWakeupRequests).values({
        companyId: f.companyId,
        agentId: f.agentId,
        source: "assignment",
        reason: "issue_assigned",
        status: "deferred_issue_execution",
        requestedAt: ago(f.now, 300),
      });
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "wakeup_request" });
    });

    it("but not an earlier timer wake-up record", async () => {
      const f = await seed();
      await db.insert(agentWakeupRequests).values({
        companyId: f.companyId,
        agentId: f.agentId,
        source: "timer",
        reason: "heartbeat.timer.no_actionable_work",
        status: "skipped",
        requestedAt: ago(f.now, 5),
      });
      expect(await evaluate(f)).toMatchObject({ decision: "skip" });
    });

    it("an open issue newly assigned to the agent", async () => {
      const f = await seed();
      await db.insert(issues).values({
        companyId: f.companyId,
        title: "Fresh task",
        status: "todo",
        priority: "high",
        assigneeAgentId: f.agentId,
        createdByUserId: "board-user",
        createdAt: ago(f.now, 28),
        updatedAt: ago(f.now, 28),
      });
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "assigned_issue_created" });
    });

    it("but not an issue the agent created for itself during its own run", async () => {
      const f = await seed();
      await db.insert(issues).values({
        companyId: f.companyId,
        title: "Note to self",
        status: "backlog",
        priority: "low",
        assigneeAgentId: f.agentId,
        createdByAgentId: f.agentId,
        createdAt: ago(f.now, 27),
        updatedAt: ago(f.now, 27),
      });
      expect(await evaluate(f)).toMatchObject({ decision: "skip" });
    });

    it("an assigned open issue changed after the last run finished", async () => {
      const f = await seed();
      await db.update(issues).set({ updatedAt: ago(f.now, 5) }).where(eq(issues.id, f.standingIssueId));
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "assigned_issue_updated" });
    });

    it("but not the run's own clean-up bump right after it finished", async () => {
      const f = await seed();
      await db
        .update(issues)
        .set({ updatedAt: new Date(f.runFinishedAt.getTime() + SELF_WRITE_GRACE_MS / 2) })
        .where(eq(issues.id, f.standingIssueId));
      expect(await evaluate(f)).toMatchObject({ decision: "skip" });
    });

    it("activity on its issue by someone else", async () => {
      const f = await seed();
      await db.insert(activityLog).values({
        companyId: f.companyId,
        actorType: "user",
        actorId: "board-user",
        action: "issue.updated",
        entityType: "issue",
        entityId: f.standingIssueId,
        createdAt: ago(f.now, 27),
      });
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "issue_activity_by_others" });
    });

    it("but not activity by the agent itself or written for its own run", async () => {
      const f = await seed();
      await db.insert(activityLog).values([
        {
          companyId: f.companyId,
          actorType: "agent",
          actorId: f.agentId,
          action: "issue.updated",
          entityType: "issue",
          entityId: f.standingIssueId,
          createdAt: ago(f.now, 27),
        },
        {
          companyId: f.companyId,
          actorType: "system",
          actorId: "heartbeat",
          action: "issue.execution_released",
          entityType: "issue",
          entityId: f.standingIssueId,
          runId: f.lastRunId,
          createdAt: ago(f.now, 26),
        },
        {
          companyId: f.companyId,
          actorType: "system",
          actorId: "heartbeat",
          action: "environment.lease_released",
          entityType: "environment",
          entityId: randomUUID(),
          createdAt: ago(f.now, 25),
        },
      ]);
      expect(await evaluate(f)).toMatchObject({ decision: "skip" });
    });

    it("a comment by someone else on one of its issues", async () => {
      const f = await seed();
      await db.insert(issueComments).values({
        companyId: f.companyId,
        issueId: f.standingIssueId,
        authorUserId: "board-user",
        authorType: "user",
        body: "Any news on this?",
        createdAt: ago(f.now, 27),
      });
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "comment_on_assigned_issue" });
    });

    it("but not its own comment", async () => {
      const f = await seed();
      await db.insert(issueComments).values({
        companyId: f.companyId,
        issueId: f.standingIssueId,
        authorAgentId: f.agentId,
        authorType: "agent",
        body: "Still blocked.",
        createdAt: ago(f.now, 27),
      });
      expect(await evaluate(f)).toMatchObject({ decision: "skip" });
    });

    it("a mention of the agent on someone else's issue", async () => {
      const f = await seed();
      const otherIssueId = randomUUID();
      await db.insert(issues).values({
        id: otherIssueId,
        companyId: f.companyId,
        title: "Teammate's task",
        status: "todo",
        priority: "medium",
        assigneeAgentId: f.otherAgentId,
        createdAt: ago(f.now, 3000),
        updatedAt: ago(f.now, 3000),
      });
      await db.insert(issueComments).values({
        companyId: f.companyId,
        issueId: otherIssueId,
        authorAgentId: f.otherAgentId,
        authorType: "agent",
        body: `Can [@Dashboard Boss](${buildAgentMentionHref(f.agentId)}) take a look?`,
        createdAt: ago(f.now, 10),
      });
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "mentioned_in_comment" });
    });

    it("but not a comment that only contains the agent id without mentioning it", async () => {
      const f = await seed();
      const otherIssueId = randomUUID();
      await db.insert(issues).values({
        id: otherIssueId,
        companyId: f.companyId,
        title: "Teammate's task",
        status: "todo",
        priority: "medium",
        assigneeAgentId: f.otherAgentId,
        createdAt: ago(f.now, 3000),
        updatedAt: ago(f.now, 3000),
      });
      await db.insert(issueComments).values({
        companyId: f.companyId,
        issueId: otherIssueId,
        authorAgentId: f.otherAgentId,
        authorType: "agent",
        body: `Log line mentions agent ${f.agentId} in passing.`,
        createdAt: ago(f.now, 10),
      });
      expect(await evaluate(f)).toMatchObject({ decision: "skip" });
    });

    it("an approval the agent asked for was decided", async () => {
      const f = await seed();
      await db.insert(approvals).values({
        companyId: f.companyId,
        type: "request_board_approval",
        requestedByAgentId: f.agentId,
        status: "approved",
        payload: {},
        decidedByUserId: "board-user",
        decidedAt: ago(f.now, 3),
        createdAt: ago(f.now, 600),
        updatedAt: ago(f.now, 3),
      });
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "approval_decided" });
    });

    it("an approval linked to one of its issues was decided", async () => {
      const f = await seed();
      const approvalId = randomUUID();
      await db.insert(approvals).values({
        id: approvalId,
        companyId: f.companyId,
        type: "request_board_approval",
        requestedByAgentId: f.otherAgentId,
        status: "rejected",
        payload: {},
        decidedAt: ago(f.now, 3),
        createdAt: ago(f.now, 600),
        updatedAt: ago(f.now, 3),
      });
      await db.insert(issueApprovals).values({ companyId: f.companyId, issueId: f.standingIssueId, approvalId });
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "approval_decided" });
    });

    it("but not a still-pending approval it filed before its last run", async () => {
      const f = await seed();
      await db.insert(approvals).values({
        companyId: f.companyId,
        type: "request_board_approval",
        requestedByAgentId: f.agentId,
        status: "pending",
        payload: {},
        createdAt: ago(f.now, 600),
        updatedAt: ago(f.now, 600),
      });
      expect(await evaluate(f)).toMatchObject({ decision: "skip" });
    });

    it("a comment by someone else on an approval it asked for", async () => {
      const f = await seed();
      const approvalId = randomUUID();
      await db.insert(approvals).values({
        id: approvalId,
        companyId: f.companyId,
        type: "request_board_approval",
        requestedByAgentId: f.agentId,
        status: "pending",
        payload: {},
        createdAt: ago(f.now, 600),
        updatedAt: ago(f.now, 600),
      });
      await db.insert(approvalComments).values({
        companyId: f.companyId,
        approvalId,
        authorUserId: "board-user",
        body: "Why do you need this?",
        createdAt: ago(f.now, 4),
      });
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "approval_comment_by_others" });
    });

    it("an approval now waiting for this agent's answer (boss review)", async () => {
      const f = await seed();
      await db.insert(approvals).values({
        companyId: f.companyId,
        type: "model_boost",
        requestedByAgentId: f.otherAgentId,
        status: "pending",
        payload: { bossReview: { bossAgentId: f.agentId, status: "awaiting_boss" } },
        createdAt: ago(f.now, 4),
        updatedAt: ago(f.now, 4),
      });
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "approval_waiting_for_agent" });
    });

    it("an interaction on its issue was answered", async () => {
      const f = await seed();
      await db.insert(issueThreadInteractions).values({
        companyId: f.companyId,
        issueId: f.standingIssueId,
        kind: "ask_user_questions",
        status: "answered",
        createdByAgentId: f.agentId,
        resolvedByUserId: "board-user",
        resolvedAt: ago(f.now, 2),
        payload: { questions: [{ id: "q1", question: "Which environment?" }] },
        createdAt: ago(f.now, 600),
        updatedAt: ago(f.now, 2),
      });
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "interaction_changed" });
    });

    it("but not a question the agent itself asked during its run and nobody answered", async () => {
      const f = await seed();
      await db.insert(issueThreadInteractions).values({
        companyId: f.companyId,
        issueId: f.standingIssueId,
        kind: "ask_user_questions",
        status: "pending",
        createdByAgentId: f.agentId,
        payload: { questions: [{ id: "q1", question: "Which environment?" }] },
        createdAt: ago(f.now, 27),
        updatedAt: ago(f.now, 27),
      });
      expect(await evaluate(f)).toMatchObject({ decision: "skip" });
    });

    it("a blocker of one of its issues was finished", async () => {
      const f = await seed();
      const blockerId = randomUUID();
      await db.insert(issues).values({
        id: blockerId,
        companyId: f.companyId,
        title: "Blocker",
        status: "done",
        priority: "medium",
        assigneeAgentId: f.otherAgentId,
        completedAt: ago(f.now, 20),
        createdAt: ago(f.now, 3000),
        updatedAt: ago(f.now, 20),
      });
      await db.insert(issueRelations).values({
        companyId: f.companyId,
        issueId: blockerId,
        relatedIssueId: f.standingIssueId,
        type: "blocks",
        createdAt: ago(f.now, 3000),
        updatedAt: ago(f.now, 3000),
      });
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "blocker_resolved" });
    });

    it("a sub-task of one of its issues was completed", async () => {
      const f = await seed();
      await db.insert(issues).values({
        companyId: f.companyId,
        parentId: f.standingIssueId,
        title: "Delegated piece",
        status: "done",
        priority: "medium",
        assigneeAgentId: f.otherAgentId,
        completedAt: ago(f.now, 15),
        createdAt: ago(f.now, 3000),
        updatedAt: ago(f.now, 15),
      });
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "child_issue_closed" });
    });

    it("a monitor on one of its issues is due", async () => {
      const f = await seed();
      await db
        .update(issues)
        .set({ monitorNextCheckAt: ago(f.now, 1), updatedAt: ago(f.now, 3000) })
        .where(eq(issues.id, f.standingIssueId));
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "issue_monitor_due" });
    });

    it("a recovery action it owns changed", async () => {
      const f = await seed();
      await db.insert(issueRecoveryActions).values({
        companyId: f.companyId,
        sourceIssueId: f.standingIssueId,
        kind: "stranded_assignment",
        status: "active",
        ownerAgentId: f.agentId,
        cause: "stranded",
        fingerprint: "fp-1",
        nextAction: "pick the task back up",
        createdAt: ago(f.now, 600),
        updatedAt: ago(f.now, 6),
      });
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "recovery_action_changed" });
    });

    it("an issue moved to a review stage where this agent is the reviewer", async () => {
      const f = await seed();
      await db.insert(issues).values({
        companyId: f.companyId,
        title: "Needs review",
        status: "in_review",
        priority: "medium",
        assigneeAgentId: f.otherAgentId,
        executionState: {
          status: "pending",
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: f.agentId },
          returnAssignee: { type: "agent", agentId: f.otherAgentId },
        },
        createdAt: ago(f.now, 3000),
        updatedAt: ago(f.now, 12),
      });
      expect(await evaluate(f)).toMatchObject({ decision: "run", signal: "execution_stage_changed" });
    });
  });

  describe("fail-open", () => {
    it("runs when a query in the check throws part-way through", async () => {
      const f = await seed();
      let selects = 0;
      const brokenDb = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === "select") {
            return (...args: unknown[]) => {
              selects += 1;
              if (selects === 5) throw new Error("simulated database failure");
              return (target.select as (...inner: unknown[]) => unknown)(...args);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      expect(await evaluateTimerIdleGate(brokenDb, f.agent, { now: f.now })).toMatchObject({
        decision: "run",
        signal: "check_failed",
      });
      expect(selects).toBe(5);
    });

    it("runs when the agent's runtime config is unreadable junk", async () => {
      const f = await seed();
      const decision = await evaluateTimerIdleGate(db, { ...f.agent, runtimeConfig: "not-an-object" }, { now: f.now });
      // No heartbeat object -> wakeOnDemand defaults to on and the gate to on,
      // so this is an ordinary evaluation; the point is it does not throw.
      expect(decision.decision === "run" || decision.decision === "skip").toBe(true);
    });
  });

  describe("recordTimerIdleSkip", () => {
    it("counts skips on the runtime state without touching the rest of it", async () => {
      const f = await seed();
      await db.insert(agentRuntimeState).values({
        agentId: f.agentId,
        companyId: f.companyId,
        adapterType: "codex_local",
        sessionId: "session-123",
        stateJson: { adapterCursor: "keep-me" },
      });
      const decision = { decision: "skip" as const, baselineRunId: f.lastRunId, baselineAt: f.runStartedAt };
      await recordTimerIdleSkip(db, f.agent, decision, new Date("2026-09-15T23:50:00Z"));
      await recordTimerIdleSkip(db, f.agent, decision, new Date("2026-09-15T23:55:00Z"));
      await recordTimerIdleSkip(db, f.agent, decision, new Date("2026-09-16T00:05:00Z"));

      const [state] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, f.agentId));
      expect(state?.sessionId).toBe("session-123");
      expect(state?.stateJson).toMatchObject({
        adapterCursor: "keep-me",
        [TIMER_IDLE_SKIP_STATE_KEY]: {
          total: 3,
          day: "2026-09-16",
          dayCount: 1,
          previousDay: "2026-09-15",
          previousDayCount: 2,
          lastSkippedAt: "2026-09-16T00:05:00.000Z",
          lastBaselineRunId: f.lastRunId,
        },
      });
    });

    it("creates the runtime state row when the agent has none yet", async () => {
      const f = await seed();
      await recordTimerIdleSkip(db, f.agent, { decision: "skip", baselineRunId: f.lastRunId, baselineAt: f.runStartedAt }, f.now);
      const [state] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, f.agentId));
      expect(state?.stateJson).toMatchObject({ [TIMER_IDLE_SKIP_STATE_KEY]: { total: 1, dayCount: 1 } });
    });
  });
});
