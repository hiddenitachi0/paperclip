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
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  SELF_REVIEW_PASS_CONTEXT_KEY,
  SELF_REVIEW_PASS_NOTICE_COMMENT,
  SELF_REVIEW_PASS_REASON,
  buildSelfReviewPassIdempotencyKey,
  buildSelfReviewPassInstruction,
  evaluateSelfReviewDoneGate,
  findExistingSelfReviewPassNoticeCommentForRun,
  isSelfReviewPassContext,
  isSelfReviewPassRun,
  issueExecutionPolicyOptsOutOfSelfReview,
  postSelfReviewPassNoticeComment,
  type SelfReviewGateWakeup,
} from "./self-review-gate.js";

describe("isSelfReviewPassContext", () => {
  it("recognizes the explicit marker", () => {
    expect(isSelfReviewPassContext({ [SELF_REVIEW_PASS_CONTEXT_KEY]: true })).toBe(true);
  });

  it("recognizes a matching wakeReason", () => {
    expect(isSelfReviewPassContext({ wakeReason: SELF_REVIEW_PASS_REASON })).toBe(true);
  });

  it("returns false for unrelated context", () => {
    expect(isSelfReviewPassContext({ wakeReason: "something_else" })).toBe(false);
    expect(isSelfReviewPassContext(null)).toBe(false);
    expect(isSelfReviewPassContext(undefined)).toBe(false);
    expect(isSelfReviewPassContext("not an object")).toBe(false);
    expect(isSelfReviewPassContext([])).toBe(false);
  });
});

describe("isSelfReviewPassRun", () => {
  it("recognizes a run scheduled with the self-review retry reason", () => {
    expect(isSelfReviewPassRun({ scheduledRetryReason: SELF_REVIEW_PASS_REASON, contextSnapshot: null })).toBe(true);
  });

  it("recognizes a run via its contextSnapshot even without the retry reason column set", () => {
    expect(
      isSelfReviewPassRun({
        scheduledRetryReason: null,
        contextSnapshot: { [SELF_REVIEW_PASS_CONTEXT_KEY]: true },
      }),
    ).toBe(true);
  });

  it("returns false for an unrelated run", () => {
    expect(
      isSelfReviewPassRun({ scheduledRetryReason: "max_turn_continuation", contextSnapshot: { issueId: "issue-1" } }),
    ).toBe(false);
  });
});

describe("issueExecutionPolicyOptsOutOfSelfReview", () => {
  it("opts out only when selfReview is explicitly false", () => {
    expect(issueExecutionPolicyOptsOutOfSelfReview({ selfReview: false })).toBe(true);
  });

  it("defaults to on (no opt-out) when unset or missing", () => {
    expect(issueExecutionPolicyOptsOutOfSelfReview({ selfReview: true })).toBe(false);
    expect(issueExecutionPolicyOptsOutOfSelfReview({})).toBe(false);
    expect(issueExecutionPolicyOptsOutOfSelfReview(null)).toBe(false);
    expect(issueExecutionPolicyOptsOutOfSelfReview(undefined)).toBe(false);
  });
});

describe("buildSelfReviewPassIdempotencyKey", () => {
  it("is stable for the same issue/run pair and distinct across runs", () => {
    const key = buildSelfReviewPassIdempotencyKey({ issueId: "issue-1", sourceRunId: "run-1" });
    expect(key).toBe(`${SELF_REVIEW_PASS_REASON}:issue-1:run-1`);
    expect(buildSelfReviewPassIdempotencyKey({ issueId: "issue-1", sourceRunId: "run-2" })).not.toBe(key);
  });
});

describe("buildSelfReviewPassInstruction", () => {
  it("tells the agent to continue the normal handoff when not already handed off", () => {
    const instruction = buildSelfReviewPassInstruction({ issueIdentifier: "PAP-1", alreadyHandedOff: false });
    expect(instruction).toContain("PAP-1");
    expect(instruction).toContain("continue the normal handoff");
  });

  it("tells the agent nothing further is required if the review finds nothing when already handed off", () => {
    const instruction = buildSelfReviewPassInstruction({ issueIdentifier: "PAP-1", alreadyHandedOff: true });
    expect(instruction).toContain("no further action is required");
  });

  it("falls back to a generic label when no issue identifier is available", () => {
    const instruction = buildSelfReviewPassInstruction({ issueIdentifier: null, alreadyHandedOff: false });
    expect(instruction).toContain("this issue");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres self-review-gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("self-review-gate DB-backed behavior", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-self-review-gate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCodeIssueFixture(input?: { status?: string }) {
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
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
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

    await db.insert(projectWorkspaces).values({
      id: randomUUID(),
      companyId,
      projectId,
      name: "main",
      sourceType: "git",
      repoUrl: "https://example.com/widgets.git",
      isPrimary: true,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Fix the widget",
      status: input?.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, projectId, issueId, runId };
  }

  function makeRecordingWakeup(db: ReturnType<typeof createDb>, companyId: string) {
    const calls: Array<{ agentId: string; opts: Parameters<SelfReviewGateWakeup>[1] }> = [];
    const wakeup: SelfReviewGateWakeup = async (agentId, opts) => {
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

  it("posts the plain-language instruction as a system comment when scheduling a new self-review pass", async () => {
    const { companyId, agentId, projectId, issueId, runId } = await seedCodeIssueFixture();
    const { wakeup, calls } = makeRecordingWakeup(db, companyId);

    const result = await evaluateSelfReviewDoneGate({
      db,
      wakeup,
      issue: {
        id: issueId,
        identifier: `T-1`,
        companyId,
        projectId,
        executionPolicy: null,
      },
      actor: { actorType: "agent", agentId, runId },
      requestedStatus: "done",
      currentStatus: "in_progress",
    });

    expect(result).not.toBeNull();
    expect(calls).toHaveLength(1);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.authorType).toBe("system");
    expect(comments[0]?.createdByRunId).toBe(runId);
    // Plain-language, non-technical instruction (matches buildSelfReviewPassInstruction).
    expect(comments[0]?.body).toContain("Review your diff/changes against the task description");
    expect(comments[0]?.body).not.toContain("self_review_pass");
  });

  it("does not double-post the comment when a self-review wake already exists for this run chain", async () => {
    const { companyId, agentId, projectId, issueId, runId } = await seedCodeIssueFixture();
    const { wakeup } = makeRecordingWakeup(db, companyId);

    const gateInput = {
      db,
      wakeup,
      issue: {
        id: issueId,
        identifier: `T-1`,
        companyId,
        projectId,
        executionPolicy: null,
      },
      actor: { actorType: "agent" as const, agentId, runId },
      requestedStatus: "done" as const,
      currentStatus: "in_progress" as const,
    };

    await evaluateSelfReviewDoneGate(gateInput);
    await evaluateSelfReviewDoneGate(gateInput);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
  });

  it("lets the self-review pass run itself through without re-gating (no infinite loop)", async () => {
    const { companyId, agentId, projectId, issueId } = await seedCodeIssueFixture();
    const selfReviewRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: selfReviewRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "running",
      scheduledRetryReason: SELF_REVIEW_PASS_REASON,
    });
    const { wakeup, calls } = makeRecordingWakeup(db, companyId);

    const result = await evaluateSelfReviewDoneGate({
      db,
      wakeup,
      issue: {
        id: issueId,
        identifier: `T-1`,
        companyId,
        projectId,
        executionPolicy: null,
      },
      actor: { actorType: "agent", agentId, runId: selfReviewRunId },
      requestedStatus: "done",
      currentStatus: "in_progress",
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it("skips the gate (and posts no comment) when the issue's project has no git workspace", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
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
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId: null,
      title: "Write the launch memo",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    const { wakeup, calls } = makeRecordingWakeup(db, companyId);

    const result = await evaluateSelfReviewDoneGate({
      db,
      wakeup,
      issue: { id: issueId, identifier: `T-1`, companyId, projectId: null, executionPolicy: null },
      actor: { actorType: "agent", agentId, runId },
      requestedStatus: "done",
      currentStatus: "in_progress",
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  describe("postSelfReviewPassNoticeComment / findExistingSelfReviewPassNoticeCommentForRun", () => {
    it("inserts a system comment and finds it again by company/issue/run/body", async () => {
      const { companyId, issueId, runId } = await seedCodeIssueFixture();

      const before = await findExistingSelfReviewPassNoticeCommentForRun(db, {
        companyId,
        issueId,
        sourceRunId: runId,
        body: SELF_REVIEW_PASS_NOTICE_COMMENT,
      });
      expect(before).toBeNull();

      await postSelfReviewPassNoticeComment(db, {
        companyId,
        issueId,
        sourceRunId: runId,
        body: SELF_REVIEW_PASS_NOTICE_COMMENT,
      });

      const after = await findExistingSelfReviewPassNoticeCommentForRun(db, {
        companyId,
        issueId,
        sourceRunId: runId,
        body: SELF_REVIEW_PASS_NOTICE_COMMENT,
      });
      expect(after).not.toBeNull();

      const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.body).toBe(SELF_REVIEW_PASS_NOTICE_COMMENT);
      expect(rows[0]?.authorType).toBe("system");
    });
  });
});
