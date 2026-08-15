import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  GOAL_CONDITION_JUDGE_CONTEXT_KEY,
  GOAL_CONDITION_JUDGE_REASON,
  buildGoalConditionEscalationSummary,
  buildGoalConditionJudgeIdempotencyKey,
  buildGoalConditionJudgeInstruction,
  buildGoalConditionVerdictMonitorPatch,
  computeGoalConditionSpendCents,
  evaluateGoalConditionBounds,
  evaluateGoalConditionDoneGate,
  goalConditionAlreadyMetForRound,
  isGoalConditionJudgeContext,
  isGoalConditionJudgeRun,
  issueHasGoalCondition,
  mergeGoalConditionMonitorState,
  nextGoalConditionRound,
  parseGoalConditionVerdict,
  postGoalConditionJudgeNoticeComment,
  findExistingGoalConditionJudgeNoticeCommentForRun,
  readGoalConditionMonitorPolicy,
  type GoalConditionGateWakeup,
} from "./goal-condition-judge.js";

describe("isGoalConditionJudgeContext / isGoalConditionJudgeRun", () => {
  it("recognizes the explicit marker and the wake reason", () => {
    expect(isGoalConditionJudgeContext({ [GOAL_CONDITION_JUDGE_CONTEXT_KEY]: true })).toBe(true);
    expect(isGoalConditionJudgeContext({ wakeReason: GOAL_CONDITION_JUDGE_REASON })).toBe(true);
    expect(isGoalConditionJudgeContext({ wakeReason: "something_else" })).toBe(false);
    expect(isGoalConditionJudgeContext(null)).toBe(false);
  });

  it("recognizes a run via scheduledRetryReason or contextSnapshot", () => {
    expect(isGoalConditionJudgeRun({ scheduledRetryReason: GOAL_CONDITION_JUDGE_REASON, contextSnapshot: null })).toBe(
      true,
    );
    expect(
      isGoalConditionJudgeRun({
        scheduledRetryReason: null,
        contextSnapshot: { [GOAL_CONDITION_JUDGE_CONTEXT_KEY]: true },
      }),
    ).toBe(true);
    expect(isGoalConditionJudgeRun({ scheduledRetryReason: "self_review_pass", contextSnapshot: {} })).toBe(false);
  });
});

describe("readGoalConditionMonitorPolicy / issueHasGoalCondition", () => {
  it("requires kind goal_condition AND a non-empty condition", () => {
    expect(issueHasGoalCondition({ monitor: { kind: "goal_condition", condition: "ship it" } })).toBe(true);
    expect(issueHasGoalCondition({ monitor: { kind: "goal_condition", condition: "" } })).toBe(false);
    expect(issueHasGoalCondition({ monitor: { kind: "external_service", condition: "ship it" } })).toBe(false);
    expect(issueHasGoalCondition({ monitor: null })).toBe(false);
    expect(issueHasGoalCondition(null)).toBe(false);
    expect(issueHasGoalCondition(undefined)).toBe(false);
  });
});

describe("nextGoalConditionRound / goalConditionAlreadyMetForRound", () => {
  it("starts at round 1 with no prior state", () => {
    expect(nextGoalConditionRound(null)).toBe(1);
    expect(nextGoalConditionRound(undefined)).toBe(1);
  });

  it("increments off the persisted attemptCount", () => {
    expect(nextGoalConditionRound({ attemptCount: 2 } as any)).toBe(3);
  });

  it("is not met until a judge verdict says so for that round", () => {
    const now = new Date("2026-08-15T12:00:00Z");
    const recent = { lastVerdict: "met", attemptCount: 1, lastTriggeredAt: "2026-08-15T11:59:00Z" } as any;
    expect(goalConditionAlreadyMetForRound(null, 1, now)).toBe(false);
    expect(goalConditionAlreadyMetForRound({ lastVerdict: "not_met", attemptCount: 1 } as any, 2, now)).toBe(false);
    expect(goalConditionAlreadyMetForRound(recent, 2, now)).toBe(true);
  });

  it("stops trusting a met verdict once it's stale (e.g. the issue was reopened long after)", () => {
    const now = new Date("2026-08-15T12:00:00Z");
    const stale = { lastVerdict: "met", attemptCount: 1, lastTriggeredAt: "2026-08-15T11:00:00Z" } as any;
    expect(goalConditionAlreadyMetForRound(stale, 2, now)).toBe(false);
  });

  it("never trusts a met verdict with no lastTriggeredAt recorded", () => {
    expect(goalConditionAlreadyMetForRound({ lastVerdict: "met", attemptCount: 1 } as any, 2)).toBe(false);
  });
});

describe("parseGoalConditionVerdict", () => {
  it("parses a met verdict", () => {
    expect(parseGoalConditionVerdict("GOAL_CONDITION_VERDICT: met")).toEqual({ verdict: "met", reason: null });
  });

  it("parses a not_met verdict with its reason", () => {
    expect(parseGoalConditionVerdict("GOAL_CONDITION_VERDICT: not_met — still 0 strings converted")).toEqual({
      verdict: "not_met",
      reason: "still 0 strings converted",
    });
  });

  it("finds the verdict line anywhere in a longer comment", () => {
    const body = [
      "I checked the diff and ran the grep count.",
      "GOAL_CONDITION_VERDICT: not_met - gettext() wraps zero strings, count is still 0",
      "That's the whole reason.",
    ].join("\n");
    expect(parseGoalConditionVerdict(body)).toEqual({
      verdict: "not_met",
      reason: "gettext() wraps zero strings, count is still 0",
    });
  });

  it("is case-insensitive on the prefix and verdict word", () => {
    expect(parseGoalConditionVerdict("goal_condition_verdict: MET")).toEqual({ verdict: "met", reason: null });
  });

  it("returns null (never a silent pass) when there is no clear verdict line", () => {
    expect(parseGoalConditionVerdict("Looks good to me, done!")).toBeNull();
    expect(parseGoalConditionVerdict(null)).toBeNull();
    expect(parseGoalConditionVerdict("")).toBeNull();
  });

  it("the motivating case: a worker claiming success without a verdict line never reads as met", () => {
    // This is exactly the failure mode DUR-32 exists to catch: the gettext task where the
    // agent wired up plumbing, converted zero strings, and declared victory anyway.
    const workerNarrative =
      "Wired up the translation plumbing and the language switcher. Marking this done.";
    expect(parseGoalConditionVerdict(workerNarrative)).toBeNull();
  });
});

describe("evaluateGoalConditionBounds", () => {
  const now = new Date("2026-08-15T12:00:00Z");

  it("is not exceeded when under every bound", () => {
    const result = evaluateGoalConditionBounds({
      policy: { maxAttempts: 5, timeoutAt: null, spendCapCents: 1000 } as any,
      round: 2,
      now,
      spentCents: 100,
    });
    expect(result).toEqual({ exceeded: false });
  });

  it("stops on max_attempts_exhausted once the round exceeds the cap", () => {
    const result = evaluateGoalConditionBounds({
      policy: { maxAttempts: 3, timeoutAt: null, spendCapCents: null } as any,
      round: 4,
      now,
      spentCents: 0,
    });
    expect(result).toEqual({ exceeded: true, reason: "max_attempts_exhausted", detail: "3 rounds" });
  });

  it("stops on timeout_exceeded once timeoutAt has passed", () => {
    const result = evaluateGoalConditionBounds({
      policy: { maxAttempts: null, timeoutAt: "2026-08-15T11:00:00Z", spendCapCents: null } as any,
      round: 1,
      now,
      spentCents: 0,
    });
    expect(result.exceeded).toBe(true);
    expect((result as any).reason).toBe("timeout_exceeded");
  });

  it("stops on spend_cap_exceeded once spend reaches the cap", () => {
    const result = evaluateGoalConditionBounds({
      policy: { maxAttempts: null, timeoutAt: null, spendCapCents: 500 } as any,
      round: 1,
      now,
      spentCents: 500,
    });
    expect(result.exceeded).toBe(true);
    expect((result as any).reason).toBe("spend_cap_exceeded");
  });

  it("never stops when no bounds are configured (unbounded caps are the caller's choice, not silent)", () => {
    const result = evaluateGoalConditionBounds({
      policy: { maxAttempts: null, timeoutAt: null, spendCapCents: null } as any,
      round: 999,
      now,
      spentCents: 999_999,
    });
    expect(result).toEqual({ exceeded: false });
  });
});

describe("buildGoalConditionJudgeInstruction", () => {
  it("frames the judge as independent and demands evidence, not narrative", () => {
    const instruction = buildGoalConditionJudgeInstruction({
      issueIdentifier: "PAP-1",
      condition: "the strings are actually routed through gettext, not merely wired up",
      round: 1,
      maxAttempts: 3,
      priorVerdictReason: null,
    });
    expect(instruction).toContain("INDEPENDENT EVALUATOR");
    expect(instruction).toContain("not the agent who did the work");
    expect(instruction).toContain("not merely wired up");
    expect(instruction).toContain("Do not edit files");
    expect(instruction).toContain("GOAL_CONDITION_VERDICT:");
  });

  it("surfaces the prior round's gap so the next check is aimed at it", () => {
    const instruction = buildGoalConditionJudgeInstruction({
      issueIdentifier: "PAP-1",
      condition: "the count is nonzero",
      round: 2,
      maxAttempts: null,
      priorVerdictReason: "count is still 0",
    });
    expect(instruction).toContain("count is still 0");
  });
});

describe("buildGoalConditionEscalationSummary", () => {
  it("states the finish line, rounds spent, spend, and the judge's last reason in plain language", () => {
    const summary = buildGoalConditionEscalationSummary({
      condition: "the language switcher changes the Governance page text",
      round: 3,
      maxAttempts: 3,
      lastVerdictReason: "gettext() wraps zero strings",
      spentCents: 250,
      spendCapCents: null,
      boundReason: "max_attempts_exhausted",
    });
    expect(summary.plainSummary).toContain("the language switcher changes the Governance page text");
    expect(summary.plainSummary).toContain("3 of 3");
    expect(summary.plainSummary).toContain("$2.50");
    expect(summary.plainSummary).toContain("gettext() wraps zero strings");
    expect(summary.title).not.toMatch(/PR #|branch|commit/i);
  });
});

describe("buildGoalConditionVerdictMonitorPatch", () => {
  const monitorPolicy = {
    nextCheckAt: new Date().toISOString(),
    notes: null,
    scheduledBy: "assignee" as const,
    kind: "goal_condition" as const,
    condition: "the count is nonzero",
    evaluatorModelProfile: "cheap" as const,
    maxAttempts: 3,
    timeoutAt: null,
    spendCapCents: 1000,
  };

  it("a met verdict marks the monitor cleared with clearReason goal_condition_met and preserves other execution-state fields", () => {
    const existingExecutionState = {
      status: "idle" as const,
      currentStageId: null,
      currentStageIndex: "review-only" as unknown as null, // sentinel below asserts pass-through
      currentStageType: null,
      currentParticipant: null,
      returnAssignee: null,
      reviewRequest: null,
      completedStageIds: ["stage-1"],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      monitor: null,
    };
    const patch = buildGoalConditionVerdictMonitorPatch({
      existingExecutionState: existingExecutionState as any,
      monitorPolicy,
      round: 1,
      verdict: "met",
      verdictReason: null,
      judgeRunId: "run-1",
      spentCents: 100,
      clearReason: "goal_condition_met",
    });
    expect(patch.monitorAttemptCount).toBe(1);
    expect(patch.monitorNextCheckAt).toBeNull();
    const monitor = (patch.executionState as any).monitor;
    expect(monitor.status).toBe("cleared");
    expect(monitor.clearReason).toBe("goal_condition_met");
    expect(monitor.lastVerdict).toBe("met");
    expect(monitor.spentCentsAtLastVerdict).toBe(100);
    // Unrelated execution-state fields (e.g. review/approval stage progress) survive the merge.
    expect((patch.executionState as any).completedStageIds).toEqual(["stage-1"]);
  });

  it("a not-met verdict within bounds stays triggered (no clearReason) and records the judge's reason", () => {
    const patch = buildGoalConditionVerdictMonitorPatch({
      existingExecutionState: null,
      monitorPolicy,
      round: 1,
      verdict: "not_met",
      verdictReason: "count is still 0",
      judgeRunId: "run-1",
      spentCents: 50,
      clearReason: null,
    });
    const monitor = (patch.executionState as any).monitor;
    expect(monitor.status).toBe("triggered");
    expect(monitor.clearedAt).toBeNull();
    expect(monitor.lastVerdict).toBe("not_met");
    expect(monitor.lastVerdictReason).toBe("count is still 0");
  });

  it("an exhausted not-met verdict clears with the specific bound reason", () => {
    const patch = buildGoalConditionVerdictMonitorPatch({
      existingExecutionState: null,
      monitorPolicy,
      round: 4,
      verdict: "not_met",
      verdictReason: "still not done",
      judgeRunId: "run-9",
      spentCents: 1200,
      clearReason: "spend_cap_exceeded",
    });
    const monitor = (patch.executionState as any).monitor;
    expect(monitor.status).toBe("cleared");
    expect(monitor.clearReason).toBe("spend_cap_exceeded");
    expect(monitor.clearedAt).not.toBeNull();
  });
});

describe("mergeGoalConditionMonitorState", () => {
  it("fills in a blank idle execution state when none existed yet", () => {
    const merged = mergeGoalConditionMonitorState(null, { attemptCount: 1 } as any);
    expect(merged.status).toBe("idle");
    expect(merged.monitor).toEqual({ attemptCount: 1 });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres goal-condition-judge tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("goal-condition-judge DB-backed behavior", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-goal-condition-judge-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** Deliberately a NON-Claude adapter — DUR-32's explicit requirement is that the loop is model-agnostic. */
  async function seedGoalConditionIssueFixture(input?: {
    status?: string;
    adapterType?: string;
    monitor?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "OpencodeWorker",
      role: "engineer",
      status: "active",
      adapterType: input?.adapterType ?? "opencode_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Widgets",
      status: "active",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
    });

    const monitor = input?.monitor ?? {
      nextCheckAt: new Date().toISOString(),
      notes: null,
      scheduledBy: "assignee",
      kind: "goal_condition",
      condition: "the language switcher actually changes the text inside the Governance page",
      evaluatorModelProfile: "cheap",
      maxAttempts: 3,
    };

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Route Governance page strings through gettext",
      status: input?.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionPolicy: { mode: "normal", commentRequired: true, stages: [], monitor },
    });

    return { companyId, agentId, projectId, issueId, runId };
  }

  function makeRecordingWakeup(db: ReturnType<typeof createDb>, companyId: string) {
    const calls: Array<{ agentId: string; opts: Parameters<GoalConditionGateWakeup>[1] }> = [];
    const wakeup: GoalConditionGateWakeup = async (agentId, opts) => {
      calls.push({ agentId, opts });
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId,
        source: opts.source ?? "automation",
        triggerDetail: opts.triggerDetail ?? "system",
        reason: opts.reason ?? null,
        payload: opts.payload ?? {},
        status: "queued",
        idempotencyKey: opts.idempotencyKey ?? null,
        requestedByActorType: opts.requestedByActorType ?? "system",
        requestedByActorId: opts.requestedByActorId ?? null,
      });
      return { ok: true };
    };
    return { wakeup, calls };
  }

  it("blocks the transition and schedules an independent judge with a fresh session, on a non-Claude adapter", async () => {
    const { companyId, agentId, projectId, issueId, runId } = await seedGoalConditionIssueFixture({
      adapterType: "opencode_local",
    });
    const { wakeup, calls } = makeRecordingWakeup(db, companyId);
    const issueRow = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);

    const result = await evaluateGoalConditionDoneGate({
      db,
      wakeup,
      issue: {
        id: issueId,
        identifier: `T-1`,
        companyId,
        executionPolicy: issueRow.executionPolicy,
        executionState: issueRow.executionState,
      },
      actor: { actorType: "agent", agentId, runId },
      requestedStatus: "done",
      currentStatus: "in_progress",
    });

    expect(result).not.toBeNull();
    expect(calls).toHaveLength(1);
    // Independence: fresh, non-resumed session and a cheap model profile, regardless of the
    // worker's own adapter type (opencode_local here) — the gate never branches on it.
    expect(calls[0]?.opts.contextSnapshot?.forceFreshSession).toBe(true);
    expect(calls[0]?.opts.contextSnapshot?.modelProfile).toBe("cheap");
    expect(calls[0]?.opts.contextSnapshot?.[GOAL_CONDITION_JUDGE_CONTEXT_KEY]).toBe(true);
    expect(calls[0]?.agentId).toBe(agentId);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Governance page");
  });

  it("does not double-schedule the judge on a retried PATCH for the same round", async () => {
    const { companyId, agentId, projectId, issueId, runId } = await seedGoalConditionIssueFixture();
    const { wakeup } = makeRecordingWakeup(db, companyId);
    const issueRow = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);

    const gateInput = {
      db,
      wakeup,
      issue: {
        id: issueId,
        identifier: `T-1`,
        companyId,
        executionPolicy: issueRow.executionPolicy,
        executionState: issueRow.executionState,
      },
      actor: { actorType: "agent" as const, agentId, runId },
      requestedStatus: "done" as const,
      currentStatus: "in_progress" as const,
    };

    await evaluateGoalConditionDoneGate(gateInput);
    await evaluateGoalConditionDoneGate(gateInput);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
  });

  it("lets the judge's own run through without re-gating it (no infinite loop)", async () => {
    const { companyId, agentId, issueId } = await seedGoalConditionIssueFixture();
    const judgeRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: judgeRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "running",
      scheduledRetryReason: GOAL_CONDITION_JUDGE_REASON,
    });
    const { wakeup, calls } = makeRecordingWakeup(db, companyId);
    const issueRow = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);

    const result = await evaluateGoalConditionDoneGate({
      db,
      wakeup,
      issue: {
        id: issueId,
        identifier: `T-1`,
        companyId,
        executionPolicy: issueRow.executionPolicy,
        executionState: issueRow.executionState,
      },
      actor: { actorType: "agent", agentId, runId: judgeRunId },
      requestedStatus: "done",
      currentStatus: "in_progress",
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("acceptance criterion (e): behaves exactly as before when no goal condition is set", async () => {
    const { companyId, agentId, issueId, runId } = await seedGoalConditionIssueFixture({ monitor: undefined as any });
    // No monitor at all on this issue's executionPolicy.
    await db.update(issues).set({ executionPolicy: { mode: "normal", commentRequired: true, stages: [] } }).where(
      eq(issues.id, issueId),
    );
    const { wakeup, calls } = makeRecordingWakeup(db, companyId);
    const issueRow = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);

    const result = await evaluateGoalConditionDoneGate({
      db,
      wakeup,
      issue: {
        id: issueId,
        identifier: `T-1`,
        companyId,
        executionPolicy: issueRow.executionPolicy,
        executionState: issueRow.executionState,
      },
      actor: { actorType: "agent", agentId, runId },
      requestedStatus: "done",
      currentStatus: "in_progress",
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it("allows the transition through once a prior verdict already confirmed met for this round", async () => {
    const { companyId, agentId, issueId, runId } = await seedGoalConditionIssueFixture();
    await db
      .update(issues)
      .set({
        executionState: {
          status: "idle",
          currentStageId: null,
          currentStageIndex: null,
          currentStageType: null,
          currentParticipant: null,
          returnAssignee: null,
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
          monitor: {
            status: "cleared",
            nextCheckAt: null,
            lastTriggeredAt: new Date().toISOString(),
            attemptCount: 1,
            notes: null,
            scheduledBy: "assignee",
            kind: "goal_condition",
            clearedAt: new Date().toISOString(),
            clearReason: "goal_condition_met",
            condition: "the language switcher actually changes the text inside the Governance page",
            lastVerdict: "met",
            lastVerdictReason: null,
          },
        },
      })
      .where(eq(issues.id, issueId));
    const { wakeup, calls } = makeRecordingWakeup(db, companyId);
    const issueRow = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);

    const result = await evaluateGoalConditionDoneGate({
      db,
      wakeup,
      issue: {
        id: issueId,
        identifier: `T-1`,
        companyId,
        executionPolicy: issueRow.executionPolicy,
        executionState: issueRow.executionState,
      },
      actor: { actorType: "agent", agentId, runId },
      requestedStatus: "done",
      currentStatus: "in_progress",
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  describe("postGoalConditionJudgeNoticeComment / findExistingGoalConditionJudgeNoticeCommentForRun", () => {
    it("inserts a system comment and finds it again by company/issue/run/body", async () => {
      const { companyId, issueId, runId } = await seedGoalConditionIssueFixture();

      const before = await findExistingGoalConditionJudgeNoticeCommentForRun(db, {
        companyId,
        issueId,
        sourceRunId: runId,
        body: "Checking the finish line",
      });
      expect(before).toBeNull();

      await postGoalConditionJudgeNoticeComment(db, {
        companyId,
        issueId,
        sourceRunId: runId,
        body: "Checking the finish line",
      });

      const after = await findExistingGoalConditionJudgeNoticeCommentForRun(db, {
        companyId,
        issueId,
        sourceRunId: runId,
        body: "Checking the finish line",
      });
      expect(after).not.toBeNull();
    });
  });

  describe("computeGoalConditionSpendCents", () => {
    it("returns 0 with no cost_events for the issue", async () => {
      const { issueId } = await seedGoalConditionIssueFixture();
      expect(await computeGoalConditionSpendCents(db, issueId)).toBe(0);
    });
  });
});
