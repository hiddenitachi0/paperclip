import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// DUR-3979 part 5: a task whose only remaining blocker is a pending board
// approval must stop re-waking its agent, stop producing "needs a
// disposition" / "escalating to a normal-sized run" notices, and must tell
// the agent the approval's real age instead of letting it invent one.

const boardApprovalWaitControl = vi.hoisted(() => ({ forceCheckFailure: false }));

vi.mock("../services/board-approval-wait.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/board-approval-wait.ts")>();
  const throwingDb = { select: () => { throw new Error("board approval wait: database unavailable"); } } as never;
  return {
    ...actual,
    evaluateBoardApprovalWait: (db: never, input: { companyId: string; issueId: string }) =>
      actual.evaluateBoardApprovalWait(boardApprovalWaitControl.forceCheckFailure ? throwingDb : db, input),
    isIssueWaitingOnlyOnBoardApproval: (db: never, input: { companyId: string; issueId: string }) =>
      actual.isIssueWaitingOnlyOnBoardApproval(boardApprovalWaitControl.forceCheckFailure ? throwingDb : db, input),
  };
});

const {
  buildBoardApprovalWaitContext,
  evaluateBoardApprovalWait,
  formatBoardApprovalAge,
  formatBoardApprovalWaitingSince,
} = await import("../services/board-approval-wait.ts");
const { recoveryService } = await import("../services/recovery/service.ts");
const { recordCheapRunEscalation } = await import("../services/recovery/cheap-run-escalation.ts");
const { decideRunLivenessContinuation } = await import("../services/recovery/run-liveness-continuations.ts");
const { SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY } = await import("../services/recovery/index.ts");
const { buildPaperclipTaskMarkdown, buildPaperclipWakePayload } = await import("../services/heartbeat.ts");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres board approval wait tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("board approval wait formatting", () => {
  const now = new Date("2026-09-15T22:12:00.000Z");

  it("writes the absolute filing time in UTC, with the year only when it is not this one", () => {
    expect(formatBoardApprovalWaitingSince(new Date("2026-09-15T16:40:00.000Z"), now)).toBe("15 Sep 16:40 UTC");
    expect(formatBoardApprovalWaitingSince(new Date("2025-12-03T09:05:00.000Z"), now)).toBe("3 Dec 2025 09:05 UTC");
  });

  it("writes an age a person can read, and never a negative one", () => {
    expect(formatBoardApprovalAge(5 * 3_600_000 + 32 * 60_000)).toBe("5 h 32 min");
    expect(formatBoardApprovalAge(45 * 60_000)).toBe("45 min");
    expect(formatBoardApprovalAge(3 * 3_600_000)).toBe("3 h");
    expect(formatBoardApprovalAge(2 * 86_400_000 + 3 * 3_600_000)).toBe("2 d 3 h");
    expect(formatBoardApprovalAge(2 * 86_400_000)).toBe("2 d");
    expect(formatBoardApprovalAge(-10_000)).toBe("less than 1 min");
  });
});

describe("decideRunLivenessContinuation while waiting on a board approval", () => {
  const baseInput = {
    run: { id: "run-1", companyId: "company-1", agentId: "agent-1", continuationAttempt: 0 },
    issue: {
      id: "issue-1",
      companyId: "company-1",
      identifier: "NOR-1437",
      title: "Ship the dashboard",
      status: "in_progress",
      assigneeAgentId: "agent-1",
      executionState: null,
      projectId: null,
    },
    agent: { id: "agent-1", companyId: "company-1", status: "idle" },
    livenessState: "empty_response" as const,
    livenessReason: "Run ended without concrete progress",
    nextAction: null,
    budgetBlocked: false,
    idempotentWakeExists: false,
  } as never as Parameters<typeof decideRunLivenessContinuation>[0];

  it("continues as before when the issue is not waiting on a decision", () => {
    expect(decideRunLivenessContinuation(baseInput).kind).toBe("enqueue");
  });

  it("neither continues nor posts the exhausted notice while the decision is pending", () => {
    expect(decideRunLivenessContinuation({ ...baseInput, waitingOnBoardApproval: true })).toEqual({
      kind: "skip",
      reason: "issue is waiting only on the operator's decision on a linked approval",
    });
    expect(
      decideRunLivenessContinuation({
        ...baseInput,
        run: { ...baseInput.run, continuationAttempt: 5 } as never,
        waitingOnBoardApproval: true,
      }).kind,
    ).toBe("skip");
  });
});

describeEmbeddedPostgres("waiting only on a board approval (embedded postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-board-approval-wait-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    boardApprovalWaitControl.forceCheckFailure = false;
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" RESTART IDENTITY CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const NOW = new Date("2026-09-15T22:12:00.000Z");
  const APPROVAL_FILED_AT = new Date("2026-09-15T16:40:00.000Z");
  const RUN_STARTED_AT = new Date("2026-09-15T16:00:00.000Z");
  const RUN_FINISHED_AT = new Date("2026-09-15T16:39:00.000Z");

  type Fixture = {
    companyId: string;
    agentId: string;
    otherAgentId: string;
    issueId: string;
    runId: string;
    approvalId: string;
  };

  /**
   * One agent-owned `in_progress` task whose last run succeeded and made
   * progress (exactly the shape the stranded sweep re-wakes), with one
   * pending board approval linked to it.
   */
  async function seed(opts: {
    approvalStatus?: string;
    linkApproval?: boolean;
    runStatus?: string;
    runContext?: Record<string, unknown>;
    livenessState?: string | null;
  } = {}): Promise<Fixture> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const approvalId = randomUUID();
    const issuePrefix = `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Nordstrand",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    for (const [id, name] of [[agentId, "Tech Boss"], [otherAgentId, "Teammate"]] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Put the new dashboard live",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: RUN_STARTED_AT,
      createdAt: RUN_STARTED_AT,
      updatedAt: RUN_FINISHED_AT,
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "completed",
      runId,
      claimedAt: RUN_STARTED_AT,
      finishedAt: RUN_FINISHED_AT,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: opts.runStatus ?? "succeeded",
      contextSnapshot: { issueId, taskId: issueId, ...(opts.runContext ?? {}) },
      createdAt: RUN_STARTED_AT,
      startedAt: RUN_STARTED_AT,
      finishedAt: RUN_FINISHED_AT,
      updatedAt: RUN_FINISHED_AT,
      livenessState: opts.livenessState === undefined ? "advanced" : opts.livenessState,
    });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      requestedByAgentId: agentId,
      status: opts.approvalStatus ?? "pending",
      payload: { title: "Put the new dashboard live", kind: "deploy" },
      createdAt: APPROVAL_FILED_AT,
      updatedAt: APPROVAL_FILED_AT,
    });
    if (opts.linkApproval !== false) {
      await db.insert(issueApprovals).values({ companyId, issueId, approvalId, createdAt: APPROVAL_FILED_AT });
    }
    return { companyId, agentId, otherAgentId, issueId, runId, approvalId };
  }

  const evaluate = (fixture: Fixture) =>
    evaluateBoardApprovalWait(db, { companyId: fixture.companyId, issueId: fixture.issueId });

  async function addComment(fixture: Fixture, input: {
    body: string;
    authorAgentId?: string | null;
    authorUserId?: string | null;
    authorType: "agent" | "user" | "system";
    createdAt: Date;
  }) {
    await db.insert(issueComments).values({
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      authorType: input.authorType,
      authorAgentId: input.authorAgentId ?? null,
      authorUserId: input.authorUserId ?? null,
      body: input.body,
      createdAt: input.createdAt,
    });
  }

  describe("the check itself", () => {
    it("says the task waits only on the operator, and names the approval with its filing time", async () => {
      const fixture = await seed();
      const wait = await evaluate(fixture);
      expect(wait.waiting).toBe(true);
      expect(wait.approvals).toHaveLength(1);
      expect(wait.approvals[0]).toMatchObject({
        id: fixture.approvalId,
        type: "request_board_approval",
        title: "Put the new dashboard live",
      });
      expect(wait.approvals[0]?.createdAt.toISOString()).toBe(APPROVAL_FILED_AT.toISOString());
    });

    it("does not count an approval that is not linked to the task", async () => {
      const fixture = await seed({ linkApproval: false });
      expect(await evaluate(fixture)).toMatchObject({ waiting: false, reason: "no_pending_approval" });
    });

    it("does not count a decided approval", async () => {
      const fixture = await seed({ approvalStatus: "approved" });
      expect(await evaluate(fixture)).toMatchObject({ waiting: false, reason: "no_pending_approval" });
    });

    it("does not silence a task whose approval was sent back for changes: that is the agent's move", async () => {
      const fixture = await seed();
      const sentBackId = randomUUID();
      await db.insert(approvals).values({
        id: sentBackId,
        companyId: fixture.companyId,
        type: "request_board_approval",
        requestedByAgentId: fixture.agentId,
        status: "revision_requested",
        payload: { title: "Deploy the API change" },
        createdAt: APPROVAL_FILED_AT,
        updatedAt: APPROVAL_FILED_AT,
      });
      await db.insert(issueApprovals).values({
        companyId: fixture.companyId,
        issueId: fixture.issueId,
        approvalId: sentBackId,
        createdAt: APPROVAL_FILED_AT,
      });
      expect(await evaluate(fixture)).toMatchObject({ waiting: false, reason: "approval_sent_back" });
    });

    it("treats a lone sent-back approval as nothing to wait for", async () => {
      const fixture = await seed({ approvalStatus: "revision_requested" });
      expect(await evaluate(fixture)).toMatchObject({ waiting: false, reason: "no_pending_approval" });
    });

    it("still waits after its own comment or a Paperclip notice, but not after someone else's", async () => {
      const fixture = await seed();
      await addComment(fixture, {
        body: "Waiting for the board decision.",
        authorType: "agent",
        authorAgentId: fixture.agentId,
        createdAt: new Date("2026-09-15T18:00:00.000Z"),
      });
      await addComment(fixture, {
        body: "Paperclip needs a disposition before this issue can continue.",
        authorType: "system",
        createdAt: new Date("2026-09-15T19:00:00.000Z"),
      });
      expect(await evaluate(fixture)).toMatchObject({ waiting: true });

      await addComment(fixture, {
        body: "Hold off on the deploy until Friday.",
        authorType: "user",
        authorUserId: "board-user-1",
        createdAt: new Date("2026-09-15T20:00:00.000Z"),
      });
      expect(await evaluate(fixture)).toMatchObject({ waiting: false, reason: "unanswered_comment" });
    });

    it("counts another agent's comment as something to answer", async () => {
      const fixture = await seed();
      await addComment(fixture, {
        body: "Can you also bump the version?",
        authorType: "agent",
        authorAgentId: fixture.otherAgentId,
        createdAt: new Date("2026-09-15T20:00:00.000Z"),
      });
      expect(await evaluate(fixture)).toMatchObject({ waiting: false, reason: "unanswered_comment" });
    });

    it("is not 'only an approval' when something else is also open", async () => {
      const withInteraction = await seed();
      await db.insert(issueThreadInteractions).values({
        companyId: withInteraction.companyId,
        issueId: withInteraction.issueId,
        kind: "ask_user_questions",
        status: "pending",
        payload: {},
        createdByAgentId: withInteraction.agentId,
      });
      expect(await evaluate(withInteraction)).toMatchObject({ waiting: false, reason: "pending_interaction" });

      const withBlocker = await seed();
      const blockerId = randomUUID();
      await db.insert(issues).values({
        id: blockerId,
        companyId: withBlocker.companyId,
        title: "Fix the migration first",
        status: "todo",
        priority: "high",
        issueNumber: 2,
      });
      await db.insert(issueRelations).values({
        companyId: withBlocker.companyId,
        issueId: blockerId,
        relatedIssueId: withBlocker.issueId,
        type: "blocks",
      });
      expect(await evaluate(withBlocker)).toMatchObject({ waiting: false, reason: "unresolved_blocker" });

      const withChild = await seed();
      await db.insert(issues).values({
        companyId: withChild.companyId,
        parentId: withChild.issueId,
        title: "Write the release note",
        status: "todo",
        priority: "medium",
        issueNumber: 3,
      });
      expect(await evaluate(withChild)).toMatchObject({ waiting: false, reason: "open_child_issue" });
    });

    it("leaves people's own tasks and closed tasks alone", async () => {
      const humanOwned = await seed();
      await db
        .update(issues)
        .set({ assigneeAgentId: null, assigneeUserId: "board-user-1" })
        .where(eq(issues.id, humanOwned.issueId));
      expect(await evaluate(humanOwned)).toMatchObject({ waiting: false, reason: "not_agent_owned" });

      const closed = await seed();
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, closed.issueId));
      expect(await evaluate(closed)).toMatchObject({ waiting: false, reason: "issue_not_open" });
    });

    it("fails open: a broken check answers 'not waiting'", async () => {
      const fixture = await seed();
      const brokenDb = { select: () => { throw new Error("database unavailable"); } } as never;
      expect(await evaluateBoardApprovalWait(brokenDb, {
        companyId: fixture.companyId,
        issueId: fixture.issueId,
      })).toEqual({ waiting: false, reason: "check_failed", approvals: [] });
    });
  });

  describe("the stranded-task sweep", () => {
    function sweepService() {
      const wakeups: Array<{ agentId: string; opts: Record<string, unknown> }> = [];
      const recovery = recoveryService(db, {
        enqueueWakeup: (async (agentId: string, opts: Record<string, unknown> = {}) => {
          wakeups.push({ agentId, opts });
          return { id: randomUUID() } as never;
        }) as never,
      });
      return { recovery, wakeups };
    }

    async function commentsOn(fixture: Fixture) {
      return db.select().from(issueComments).where(eq(issueComments.issueId, fixture.issueId));
    }

    it("does not re-wake a task that waits only on the operator's decision", async () => {
      const fixture = await seed();
      const { recovery, wakeups } = sweepService();

      const result = await recovery.reconcileStrandedAssignedIssues();

      expect(result.waitingOnBoardApproval).toBe(1);
      expect(result.continuationRequeued).toBe(0);
      expect(result.escalated).toBe(0);
      expect(wakeups).toHaveLength(0);
      expect(await commentsOn(fixture)).toHaveLength(0);
      const issue = await db.select().from(issues).where(eq(issues.id, fixture.issueId)).then((rows) => rows[0]);
      expect(issue?.status).toBe("in_progress");
    });

    it("posts no 'needs a disposition' escalation while the decision is pending", async () => {
      const fixture = await seed({
        runStatus: "failed",
        livenessState: null,
        runContext: {
          wakeReason: "finish_successful_run_handoff",
          handoffRequired: true,
          handoffReason: "successful_run_missing_state",
          handoffAttempt: 1,
          maxHandoffAttempts: 1,
          sourceRunId: randomUUID(),
        },
      });
      const { recovery, wakeups } = sweepService();

      const result = await recovery.reconcileStrandedAssignedIssues();

      expect(result.waitingOnBoardApproval).toBe(1);
      expect(result.successfulRunHandoffEscalated).toBe(0);
      expect(wakeups).toHaveLength(0);
      const comments = await commentsOn(fixture);
      expect(comments.map((comment) => comment.body)).not.toContain(SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY);
      expect(comments).toHaveLength(0);
      const recoveryActions = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId));
      expect(recoveryActions).toHaveLength(0);
    });

    it("does not block a task that already went round the productive-recovery loop once", async () => {
      const fixture = await seed({
        runContext: {
          wakeReason: "issue_continuation_needed",
          retryReason: "issue_continuation_needed",
          source: "issue.productive_terminal_continuation_recovery",
        },
      });
      const { recovery, wakeups } = sweepService();

      const result = await recovery.reconcileStrandedAssignedIssues();

      expect(result.waitingOnBoardApproval).toBe(1);
      expect(result.escalated).toBe(0);
      expect(wakeups).toHaveLength(0);
      const issue = await db.select().from(issues).where(eq(issues.id, fixture.issueId)).then((rows) => rows[0]);
      expect(issue?.status).toBe("in_progress");
      expect(await commentsOn(fixture)).toHaveLength(0);
    });

    it("wakes the agent again as soon as the operator decides", async () => {
      const fixture = await seed({ approvalStatus: "approved" });
      const { recovery, wakeups } = sweepService();

      const result = await recovery.reconcileStrandedAssignedIssues();

      expect(result.waitingOnBoardApproval).toBe(0);
      expect(result.continuationRequeued).toBe(1);
      expect(wakeups).toHaveLength(1);
      expect(wakeups[0]?.agentId).toBe(fixture.agentId);
      expect(wakeups[0]?.opts.reason).toBe("issue_continuation_needed");
    });

    it("leaves a task with other open work exactly as it was", async () => {
      const fixture = await seed();
      await addComment(fixture, {
        body: "Please also update the release note before the deploy.",
        authorType: "user",
        authorUserId: "board-user-1",
        createdAt: new Date("2026-09-15T20:00:00.000Z"),
      });
      const { recovery, wakeups } = sweepService();

      const result = await recovery.reconcileStrandedAssignedIssues();

      expect(result.waitingOnBoardApproval).toBe(0);
      expect(result.continuationRequeued).toBe(1);
      expect(wakeups).toHaveLength(1);
    });

    it("fails open: when the check breaks, the sweep behaves exactly as before", async () => {
      await seed();
      boardApprovalWaitControl.forceCheckFailure = true;
      const { recovery, wakeups } = sweepService();

      const result = await recovery.reconcileStrandedAssignedIssues();

      expect(result.waitingOnBoardApproval).toBe(0);
      expect(result.continuationRequeued).toBe(1);
      expect(wakeups).toHaveLength(1);
    });
  });

  describe("cheap-run escalation", () => {
    it("does not buy a normal-sized run, or say it did, while the decision is pending", async () => {
      const fixture = await seed();
      const wakeup = vi.fn(async () => ({ id: randomUUID() }));

      const outcome = await recordCheapRunEscalation(db, wakeup, {
        companyId: fixture.companyId,
        issueId: fixture.issueId,
        agentId: fixture.agentId,
        sourceRunId: fixture.runId,
        blockedAction: "mark this issue blocked",
      });

      expect(outcome).toEqual({
        escalated: false,
        alreadyPending: false,
        capped: false,
        failed: false,
        waitingOnBoardApproval: true,
      });
      expect(wakeup).not.toHaveBeenCalled();
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, fixture.issueId));
      expect(comments).toHaveLength(0);
    });

    it("still escalates once the approval is decided", async () => {
      const fixture = await seed({ approvalStatus: "approved" });
      const wakeup = vi.fn(async () => ({ id: randomUUID() }));

      const outcome = await recordCheapRunEscalation(db, wakeup, {
        companyId: fixture.companyId,
        issueId: fixture.issueId,
        agentId: fixture.agentId,
        sourceRunId: fixture.runId,
        blockedAction: "mark this issue blocked",
      });

      expect(outcome).toMatchObject({ escalated: true, capped: false, failed: false });
      expect(wakeup).toHaveBeenCalledTimes(1);
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, fixture.issueId));
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).toContain("Escalating to a normal-sized run");
    });
  });

  describe("what the agent is told", () => {
    it("gives the wake payload and the prompt the approval's real age, from created_at", async () => {
      const fixture = await seed();

      const payload = await buildPaperclipWakePayload({
        db,
        companyId: fixture.companyId,
        contextSnapshot: { issueId: fixture.issueId, taskId: fixture.issueId, wakeReason: "heartbeat_timer" },
        now: NOW,
      });

      expect(payload?.boardApprovalWait).toMatchObject({
        waitingOnlyOnBoardApproval: true,
        approvals: [
          {
            id: fixture.approvalId,
            title: "Put the new dashboard live",
            createdAt: APPROVAL_FILED_AT.toISOString(),
            waitingSince: "15 Sep 16:40 UTC",
            age: "5 h 32 min",
          },
        ],
      });

      const prompt = renderPaperclipWakePrompt(payload);
      expect(prompt).toContain("Waiting for the operator's decision:");
      expect(prompt).toContain("waiting for the operator's decision since 15 Sep 16:40 UTC (5 h 32 min)");
      expect(prompt).toContain("Do not post comments that only repeat that you are still waiting");
      expect(prompt).toContain("never estimate");
      expect(prompt).toContain("end this run without a new status comment");
    });

    it("still shows the age, without the 'nothing else needs you' line, when something else is open", async () => {
      const fixture = await seed();
      await addComment(fixture, {
        body: "Please also update the release note.",
        authorType: "user",
        authorUserId: "board-user-1",
        createdAt: new Date("2026-09-15T20:00:00.000Z"),
      });

      const payload = await buildPaperclipWakePayload({
        db,
        companyId: fixture.companyId,
        contextSnapshot: { issueId: fixture.issueId, taskId: fixture.issueId },
        now: NOW,
      });

      expect(payload?.boardApprovalWait?.waitingOnlyOnBoardApproval).toBe(false);
      const prompt = renderPaperclipWakePrompt(payload);
      expect(prompt).toContain("15 Sep 16:40 UTC (5 h 32 min)");
      expect(prompt).not.toContain("end this run without a new status comment");
    });

    it("says nothing about approvals when the task has none pending", async () => {
      const fixture = await seed({ approvalStatus: "approved" });
      const payload = await buildPaperclipWakePayload({
        db,
        companyId: fixture.companyId,
        contextSnapshot: { issueId: fixture.issueId },
        now: NOW,
      });
      expect(payload?.boardApprovalWait).toBeNull();
      expect(renderPaperclipWakePrompt(payload)).not.toContain("Waiting for the operator's decision");
    });

    it("puts the same lines in the task block, or points at the wake payload when both are rendered", async () => {
      const fixture = await seed();
      const wait = buildBoardApprovalWaitContext(await evaluate(fixture), NOW);

      const taskMarkdown = buildPaperclipTaskMarkdown({
        issue: { id: fixture.issueId, identifier: "NOR-1437", title: "Put the new dashboard live", workMode: "standard" },
        boardApprovalWait: wait,
      });
      expect(taskMarkdown).toContain("waiting for the operator's decision since 15 Sep 16:40 UTC (5 h 32 min)");

      const deduped = buildPaperclipTaskMarkdown({
        issue: { id: fixture.issueId, identifier: "NOR-1437", title: "Put the new dashboard live", workMode: "standard" },
        boardApprovalWait: wait,
        boardApprovalWaitInlinedInWakePayload: true,
      });
      expect(deduped).toContain("The real waiting time is in the wake payload");
      expect(deduped).not.toContain("15 Sep 16:40 UTC");
    });
  });
});
