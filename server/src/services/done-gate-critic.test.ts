import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issues,
  projects,
} from "@paperclipai/db";
import { DEFAULT_DONE_GATE_SETTINGS, type InstanceGeneralSettings } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  DONE_GATE_DRY_RUN_NEEDS_WORK_PREFIX,
  DONE_GATE_ESCALATED_PREFIX,
  DONE_GATE_NEEDS_WORK_PREFIX,
  DONE_GATE_PASS_PREFIX,
  buildDoneGateCriticUserMessage,
  buildDoneGateNeedsWorkComment,
  countDoneGateNeedsWorkRounds,
  evaluateDoneGateCritic,
  findDoneGateLoopResetAt,
  findLastDoneGateFindings,
  parseDoneGateCriticReply,
  resolveDoneGateConfig,
  type DoneGateCritic,
  type DoneGateCriticInput,
} from "./done-gate-critic.js";

describe("resolveDoneGateConfig", () => {
  it("defaults to off with 2 rounds when nothing is configured", () => {
    expect(resolveDoneGateConfig(null, "c1")).toEqual({ mode: "off", maxRounds: 2 });
    expect(resolveDoneGateConfig({ doneGate: DEFAULT_DONE_GATE_SETTINGS }, "c1")).toEqual({ mode: "off", maxRounds: 2 });
  });

  it("lets a per-company override win over the instance default, field by field", () => {
    const general = {
      doneGate: {
        mode: "enforce" as const,
        maxRounds: 3,
        companyOverrides: {
          quiet: { mode: "off" as const },
          strict: { maxRounds: 1 },
        },
      },
    };
    expect(resolveDoneGateConfig(general, "quiet")).toEqual({ mode: "off", maxRounds: 3 });
    expect(resolveDoneGateConfig(general, "strict")).toEqual({ mode: "enforce", maxRounds: 1 });
    expect(resolveDoneGateConfig(general, "other")).toEqual({ mode: "enforce", maxRounds: 3 });
  });
});

describe("parseDoneGateCriticReply", () => {
  it("reads a clean verdict and caps findings at three", () => {
    expect(parseDoneGateCriticReply('{"verdict":"pass","findings":[]}')).toEqual({ verdict: "pass", findings: [] });
    const parsed = parseDoneGateCriticReply(
      'Sure: {"verdict":"needs_work","findings":["a","b","c","d"]} done',
    );
    expect(parsed?.verdict).toBe("needs_work");
    expect(parsed?.findings).toEqual(["a", "b", "c"]);
  });

  it("returns null for anything that is not clearly a verdict (fail open, never needs_work)", () => {
    expect(parseDoneGateCriticReply("I think it's fine")).toBeNull();
    expect(parseDoneGateCriticReply('{"verdict":"maybe"}')).toBeNull();
    expect(parseDoneGateCriticReply("{not json")).toBeNull();
  });

  it("fills in one plain finding when needs_work comes back with none", () => {
    const parsed = parseDoneGateCriticReply('{"verdict":"needs_work","findings":[]}');
    expect(parsed?.findings).toHaveLength(1);
  });
});

describe("prompt and comment text", () => {
  it("tells the critic when the agent left no final comment and no description", () => {
    const text = buildDoneGateCriticUserMessage({
      issueIdentifier: "T-1",
      title: "Add a button",
      description: null,
      finalComment: null,
      mergeSummary: null,
      changedFilePaths: null,
      diffExcerpt: null,
      round: 1,
      maxRounds: 2,
    });
    expect(text).toContain("no description was written");
    expect(text).toContain("left no final comment");
  });

  it("writes the needs-work comment in plain language and says when it is the last round", () => {
    const comment = buildDoneGateNeedsWorkComment({ round: 2, maxRounds: 2, findings: ["Tests were not run."], dryRun: false });
    expect(comment.startsWith(DONE_GATE_NEEDS_WORK_PREFIX)).toBe(true);
    expect(comment).toContain("1. Tests were not run.");
    expect(comment).toContain("last automatic round");
    const dry = buildDoneGateNeedsWorkComment({ round: 1, maxRounds: 2, findings: ["x"], dryRun: true });
    expect(dry.startsWith(DONE_GATE_DRY_RUN_NEEDS_WORK_PREFIX)).toBe(true);
    expect(dry).toContain("dry run");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres done-gate-critic tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("evaluateDoneGateCritic (DB-backed, mocked critic)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-done-gate-critic-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(input?: { status?: string }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "active",
      adapterType: "opencode_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Widgets", status: "active" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "assignment", status: "running" });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Add a language switcher to the Governance page",
      description: "Acceptance: the switcher changes the page text, and there is a test for it.",
      status: input?.status ?? "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorType: "agent",
      authorAgentId: agentId,
      body: "Done: added the switcher and a test.",
      createdByRunId: runId,
    });
    return { companyId, agentId, projectId, issueId, runId };
  }

  function settings(mode: "off" | "dry_run" | "enforce", maxRounds = 2): () => Promise<Pick<InstanceGeneralSettings, "doneGate">> {
    return async () => ({ doneGate: { mode, maxRounds, companyOverrides: {} } });
  }

  function recordingCritic(verdict: "pass" | "needs_work", findings: string[]) {
    const calls: DoneGateCriticInput[] = [];
    const critic: DoneGateCritic = async (input) => {
      calls.push(input);
      return { verdict, findings, usage: { inputTokens: 1200, outputTokens: 80, model: "test-critic" } };
    };
    return { critic, calls };
  }

  async function issueStatus(issueId: string) {
    return db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]?.status ?? null);
  }

  async function systemComments(issueId: string) {
    return db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .then((rows) => rows.map((row) => row.body).filter((body) => body.startsWith("Quality check")));
  }

  function agentActor(f: { agentId: string; runId: string }) {
    return { actorType: "agent", agentId: f.agentId, runId: f.runId };
  }

  /**
   * What PATCH /issues/:id leaves behind when a board user changes the status: the new
   * status on the issue and an `issue.updated` activity row whose details carry the
   * PATCH's fields (routes/issues.ts spreads `updateFields` into details).
   */
  async function operatorMovesIssueTo(f: { companyId: string; issueId: string }, status: string, previous: string) {
    await db.update(issues).set({ status, updatedAt: new Date() }).where(eq(issues.id, f.issueId));
    await db.insert(activityLog).values({
      companyId: f.companyId,
      actorType: "user",
      actorId: "local-board",
      action: "issue.updated",
      entityType: "issue",
      entityId: f.issueId,
      details: { status, identifier: "T-1", source: "comment", _previous: { status: previous } },
    });
  }

  /** The same activity row, but written by the agent itself -- must NOT reset the loop. */
  async function agentMovesIssueTo(f: { companyId: string; issueId: string; agentId: string; runId: string }, status: string) {
    await db.update(issues).set({ status, updatedAt: new Date() }).where(eq(issues.id, f.issueId));
    await db.insert(activityLog).values({
      companyId: f.companyId,
      actorType: "agent",
      actorId: f.agentId,
      agentId: f.agentId,
      runId: f.runId,
      action: "issue.updated",
      entityType: "issue",
      entityId: f.issueId,
      details: { status, identifier: "T-1" },
    });
  }

  async function filedCards(companyId: string) {
    return db.select().from(approvals).where(eq(approvals.companyId, companyId)).orderBy(approvals.createdAt);
  }

  it("off: never calls the critic and lets done through", async () => {
    const f = await seedFixture();
    const { critic, calls } = recordingCritic("needs_work", ["x"]);
    const result = await evaluateDoneGateCritic({
      db,
      issue: { id: f.issueId, identifier: "T-1", companyId: f.companyId, title: "t", description: null },
      actor: agentActor(f),
      requestedStatus: "done",
      currentStatus: "in_review",
      readGeneralSettings: settings("off"),
      critic,
    });
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await systemComments(f.issueId)).toEqual([]);
  });

  it("never gates a board/human actor, even in enforce mode", async () => {
    const f = await seedFixture();
    const { critic, calls } = recordingCritic("needs_work", ["x"]);
    const result = await evaluateDoneGateCritic({
      db,
      issue: { id: f.issueId, identifier: "T-1", companyId: f.companyId, title: "t", description: null },
      actor: { actorType: "board", agentId: null, runId: null },
      requestedStatus: "done",
      currentStatus: "in_review",
      readGeneralSettings: settings("enforce"),
      critic,
    });
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("pass: lets done through, posts a short passed comment, records the critic's cost against the agent", async () => {
    const f = await seedFixture();
    const { critic, calls } = recordingCritic("pass", ["Covers both acceptance points."]);
    const result = await evaluateDoneGateCritic({
      db,
      issue: {
        id: f.issueId,
        identifier: "T-1",
        companyId: f.companyId,
        title: "Add a language switcher to the Governance page",
        description: "Acceptance: the switcher changes the page text, and there is a test for it.",
      },
      actor: agentActor(f),
      requestedStatus: "done",
      currentStatus: "in_review",
      readGeneralSettings: settings("enforce"),
      critic,
    });
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
    // The agent's latest comment on the issue is what the critic sees as the final word.
    expect(calls[0]!.finalComment).toBe("Done: added the switcher and a test.");
    expect(calls[0]!.round).toBe(1);
    const comments = await systemComments(f.issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.startsWith(DONE_GATE_PASS_PREFIX)).toBe(true);
    expect(await issueStatus(f.issueId)).toBe("in_review");
    const cost = await db.select().from(costEvents).where(eq(costEvents.issueId, f.issueId));
    expect(cost).toHaveLength(1);
    expect(cost[0]!.agentId).toBe(f.agentId);
    expect(cost[0]!.model).toBe("test-critic");
  });

  it("needs_work (enforce): refuses with the findings, posts them, sends the issue back to in_progress", async () => {
    const f = await seedFixture();
    const { critic, calls } = recordingCritic("needs_work", ["No test was added for the switcher.", "The comment does not say the page text actually changes."]);
    const result = await evaluateDoneGateCritic({
      db,
      issue: { id: f.issueId, identifier: "T-1", companyId: f.companyId, title: "t", description: "d" },
      actor: agentActor(f),
      requestedStatus: "done",
      currentStatus: "in_review",
      patchComment: "Finished, see PR.",
      readGeneralSettings: settings("enforce"),
      critic,
    });
    expect(result).not.toBeNull();
    expect(result!.escalated).toBe(false);
    expect(result!.findings).toHaveLength(2);
    expect(result!.message).toContain("can't move to done yet");
    expect(result!.message).toContain("1. No test was added for the switcher.");
    // The PATCH's own comment beats older comments as the agent's final word.
    expect(calls[0]!.finalComment).toBe("Finished, see PR.");
    expect(await issueStatus(f.issueId)).toBe("in_progress");
    const comments = await systemComments(f.issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.startsWith(DONE_GATE_NEEDS_WORK_PREFIX)).toBe(true);
    expect(comments[0]).toContain("2. The comment does not say the page text actually changes.");
    expect(await countDoneGateNeedsWorkRounds(db, { companyId: f.companyId, issueId: f.issueId })).toBe(1);
    expect(await findLastDoneGateFindings(db, { companyId: f.companyId, issueId: f.issueId })).toEqual([
      "No test was added for the switcher.",
      "The comment does not say the page text actually changes.",
    ]);
  });

  it("dry_run: only comments -- never blocks, never moves the issue, never escalates", async () => {
    const f = await seedFixture();
    const { critic, calls } = recordingCritic("needs_work", ["Something is missing."]);
    const evaluate = () =>
      evaluateDoneGateCritic({
        db,
        issue: { id: f.issueId, identifier: "T-1", companyId: f.companyId, title: "t", description: "d" },
        actor: agentActor(f),
        requestedStatus: "done",
        currentStatus: "in_review",
        readGeneralSettings: settings("dry_run", 2),
        critic,
      });
    expect(await evaluate()).toBeNull();
    expect(await evaluate()).toBeNull();
    // Past the round cap the dry run stops spending on the critic, and still lets done through.
    expect(await evaluate()).toBeNull();
    expect(calls).toHaveLength(2);
    expect(await issueStatus(f.issueId)).toBe("in_review");
    const comments = await systemComments(f.issueId);
    expect(comments).toHaveLength(2);
    expect(comments.every((c) => c.startsWith(DONE_GATE_DRY_RUN_NEEDS_WORK_PREFIX))).toBe(true);
    expect(comments.some((c) => c.startsWith(DONE_GATE_ESCALATED_PREFIX))).toBe(false);
    const filed = await db.select().from(approvals).where(eq(approvals.companyId, f.companyId));
    expect(filed).toHaveLength(0);
  });

  it("escalates after N needs_work rounds: no further critic call, issue parked as blocked, one plain question filed for the board", async () => {
    const f = await seedFixture();
    const { critic, calls } = recordingCritic("needs_work", ["Still no test."]);
    const evaluate = () =>
      evaluateDoneGateCritic({
        db,
        issue: {
          id: f.issueId,
          identifier: "T-1",
          companyId: f.companyId,
          title: "Add a language switcher to the Governance page",
          description: "d",
        },
        actor: agentActor(f),
        requestedStatus: "done",
        currentStatus: "in_progress",
        readGeneralSettings: settings("enforce", 2),
        critic,
      });

    const first = await evaluate();
    expect(first?.escalated).toBe(false);
    const second = await evaluate();
    expect(second?.escalated).toBe(false);
    expect(second?.message).toContain("last automatic round");

    const third = await evaluate();
    expect(third).not.toBeNull();
    expect(third!.escalated).toBe(true);
    expect(third!.message).toContain("operator has been asked to decide");
    expect(third!.findings).toEqual(["Still no test."]);
    // Round cap reached: the critic is not called a third time.
    expect(calls).toHaveLength(2);
    expect(await issueStatus(f.issueId)).toBe("blocked");

    const comments = await systemComments(f.issueId);
    const escalation = comments.filter((c) => c.startsWith(DONE_GATE_ESCALATED_PREFIX));
    expect(escalation).toHaveLength(1);
    expect(escalation[0]).toContain("disagreed 2 times");
    expect(escalation[0]).toContain("1. Still no test.");

    const filed = await db.select().from(approvals).where(eq(approvals.companyId, f.companyId));
    expect(filed).toHaveLength(1);
    expect(filed[0]!.status).toBe("pending");
    const payload = filed[0]!.payload as Record<string, unknown>;
    expect(payload.kind).toBe("done_gate_exhausted");
    expect(String(payload.title)).toContain("Add a language switcher to the Governance page");
    expect(String(payload.title)).not.toMatch(/\b(PR|409|needs_work)\b/);
    expect(String(payload.recommendedAction)).toContain("mark the task done yourself");
    // The board card renders payload.summary -- the findings must be on it, not only in plainSummary.
    expect(String(payload.summary)).toContain("1. Still no test.");
    expect(String(payload.summary)).toContain("disagreed 2 times");
    expect(payload.plainSummary).toBe(payload.summary);
    const links = await db.select().from(issueApprovals).where(eq(issueApprovals.approvalId, filed[0]!.id));
    expect(links.map((l) => l.issueId)).toEqual([f.issueId]);

    // A fourth attempt (operator has not acted yet) is still refused but does not file a
    // second question or comment -- and the agent moving it out of blocked itself does not
    // count as the operator acting.
    await agentMovesIssueTo(f, "in_progress");
    const fourth = await evaluate();
    expect(fourth?.escalated).toBe(true);
    expect(calls).toHaveLength(2);
    expect((await systemComments(f.issueId)).filter((c) => c.startsWith(DONE_GATE_ESCALATED_PREFIX))).toHaveLength(1);
    expect(await filedCards(f.companyId)).toHaveLength(1);
  });

  it("recovers after escalation: the operator moves the task back to in progress, the agent gets fresh rounds, and a second escalation files a new card", async () => {
    const f = await seedFixture({ status: "in_progress" });
    const { critic, calls } = recordingCritic("needs_work", ["Still no test."]);
    const evaluate = (currentStatus = "in_progress") =>
      evaluateDoneGateCritic({
        db,
        issue: { id: f.issueId, identifier: "T-1", companyId: f.companyId, title: "Add a language switcher", description: "d" },
        actor: agentActor(f),
        requestedStatus: "done",
        currentStatus,
        readGeneralSettings: settings("enforce", 2),
        critic,
      });

    // Loop 1: two rounds, then the operator is asked and the task is parked.
    await evaluate();
    await evaluate();
    expect((await evaluate())?.escalated).toBe(true);
    expect(calls).toHaveLength(2);
    expect(await issueStatus(f.issueId)).toBe("blocked");
    expect(await filedCards(f.companyId)).toHaveLength(1);
    expect(await findDoneGateLoopResetAt(db, { companyId: f.companyId, issueId: f.issueId })).toBeNull();

    // The operator follows the card's own advice: back to in progress with guidance.
    await operatorMovesIssueTo(f, "in_progress", "blocked");
    const resetAt = await findDoneGateLoopResetAt(db, { companyId: f.companyId, issueId: f.issueId });
    expect(resetAt).toBeInstanceOf(Date);
    expect(await countDoneGateNeedsWorkRounds(db, { companyId: f.companyId, issueId: f.issueId, since: resetAt, mode: "enforce" })).toBe(0);

    // Loop 2, round 1: the critic runs again instead of a permanent "wait for the operator".
    const fresh = await evaluate();
    expect(fresh).not.toBeNull();
    expect(fresh!.escalated).toBe(false);
    expect(fresh!.message).toContain("round 1 of 2");
    expect(calls).toHaveLength(3);
    expect(calls[2]!.round).toBe(1);
    expect(await issueStatus(f.issueId)).toBe("in_progress");

    // Round 2, then a SECOND escalation: new comment, new card, parked again.
    const second = await evaluate();
    expect(second!.escalated).toBe(false);
    expect(second!.message).toContain("round 2 of 2");
    const again = await evaluate();
    expect(again!.escalated).toBe(true);
    expect(calls).toHaveLength(4);
    expect(await issueStatus(f.issueId)).toBe("blocked");
    expect((await systemComments(f.issueId)).filter((c) => c.startsWith(DONE_GATE_ESCALATED_PREFIX))).toHaveLength(2);
    const cards = await filedCards(f.companyId);
    expect(cards).toHaveLength(2);
    expect(cards.every((card) => card.status === "pending")).toBe(true);

    // Until the operator acts again, further attempts are refused without a third card.
    expect((await evaluate())?.escalated).toBe(true);
    expect(await filedCards(f.companyId)).toHaveLength(2);
  });

  it("recovers after escalation when the operator decides the board question instead of touching the status", async () => {
    const f = await seedFixture({ status: "in_progress" });
    const { critic, calls } = recordingCritic("needs_work", ["Still no test."]);
    const evaluate = () =>
      evaluateDoneGateCritic({
        db,
        issue: { id: f.issueId, identifier: "T-1", companyId: f.companyId, title: "t", description: "d" },
        actor: agentActor(f),
        requestedStatus: "done",
        currentStatus: "blocked",
        readGeneralSettings: settings("enforce", 1),
        critic,
      });

    await evaluate();
    expect((await evaluate())?.escalated).toBe(true);
    const [card] = await filedCards(f.companyId);
    expect(card).toBeDefined();
    expect(await findDoneGateLoopResetAt(db, { companyId: f.companyId, issueId: f.issueId })).toBeNull();

    // The operator rejects the card ("not finished") without changing the status.
    await db
      .update(approvals)
      .set({ status: "rejected", decidedByUserId: "local-board", decidedAt: new Date(), decisionNote: "Add the test first." })
      .where(eq(approvals.id, card!.id));
    expect(await findDoneGateLoopResetAt(db, { companyId: f.companyId, issueId: f.issueId })).toBeInstanceOf(Date);

    const fresh = await evaluate();
    expect(fresh!.escalated).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.round).toBe(1);
  });

  it("rounds from a 'Comment only' trial do not count once the check is switched to 'On'", async () => {
    const f = await seedFixture({ status: "in_progress" });
    const { critic, calls } = recordingCritic("needs_work", ["Still no test."]);
    const evaluate = (mode: "dry_run" | "enforce") =>
      evaluateDoneGateCritic({
        db,
        issue: { id: f.issueId, identifier: "T-1", companyId: f.companyId, title: "t", description: "d" },
        actor: agentActor(f),
        requestedStatus: "done",
        currentStatus: "in_progress",
        readGeneralSettings: settings(mode, 2),
        critic,
      });

    expect(await evaluate("dry_run")).toBeNull();
    expect(await evaluate("dry_run")).toBeNull();
    // Switched to "On": this is round 1, not an immediate escalation.
    const first = await evaluate("enforce");
    expect(first!.escalated).toBe(false);
    expect(first!.message).toContain("round 1 of 2");
    expect(calls).toHaveLength(3);
    expect(await filedCards(f.companyId)).toHaveLength(0);
    // Counting without a mode still sees every needs-work round the gate ever wrote.
    expect(await countDoneGateNeedsWorkRounds(db, { companyId: f.companyId, issueId: f.issueId })).toBe(3);
    expect(await countDoneGateNeedsWorkRounds(db, { companyId: f.companyId, issueId: f.issueId, mode: "enforce" })).toBe(1);
  });

  it("only counts comments the gate wrote itself, never same-looking comments with an author", async () => {
    const f = await seedFixture({ status: "in_progress" });
    // An agent-authored comment that happens to start with the gate's prefix (the comment
    // route would stamp authorType agent + authorAgentId for an agent actor).
    await db.insert(issueComments).values({
      companyId: f.companyId,
      issueId: f.issueId,
      authorType: "agent",
      authorAgentId: f.agentId,
      body: `${DONE_GATE_NEEDS_WORK_PREFIX} (round 1 of 2).\n\n1. forged`,
      createdByRunId: f.runId,
    });
    expect(await countDoneGateNeedsWorkRounds(db, { companyId: f.companyId, issueId: f.issueId })).toBe(0);
    expect(await findLastDoneGateFindings(db, { companyId: f.companyId, issueId: f.issueId })).toEqual([]);
  });

  it("a critic that cannot run never blocks the transition", async () => {
    const f = await seedFixture();
    const critic: DoneGateCritic = async () => {
      throw new Error("ANTHROPIC_API_KEY unset");
    };
    const result = await evaluateDoneGateCritic({
      db,
      issue: { id: f.issueId, identifier: "T-1", companyId: f.companyId, title: "t", description: "d" },
      actor: agentActor(f),
      requestedStatus: "done",
      currentStatus: "in_review",
      readGeneralSettings: settings("enforce"),
      critic,
    });
    expect(result).toBeNull();
    expect(await issueStatus(f.issueId)).toBe("in_review");
    expect(await systemComments(f.issueId)).toEqual([]);
  });

  it("ignores transitions that are not an agent moving to done", async () => {
    const f = await seedFixture();
    const { critic, calls } = recordingCritic("needs_work", ["x"]);
    const base = {
      db,
      issue: { id: f.issueId, identifier: "T-1", companyId: f.companyId, title: "t", description: "d" },
      actor: agentActor(f),
      readGeneralSettings: settings("enforce"),
      critic,
    };
    expect(await evaluateDoneGateCritic({ ...base, requestedStatus: "in_review", currentStatus: "in_progress" })).toBeNull();
    expect(await evaluateDoneGateCritic({ ...base, requestedStatus: "done", currentStatus: "done" })).toBeNull();
    expect(await evaluateDoneGateCritic({ ...base, requestedStatus: undefined, currentStatus: "in_progress" })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
