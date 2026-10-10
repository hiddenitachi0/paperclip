import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  companyHelperSettings,
  companyQualityLoopSettings,
  costEvents,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issues,
  modelDirectoryEntries,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import { QUALITY_CHECK_BILLING_CODE } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  DONE_GATE_ESCALATED_PREFIX,
  DONE_GATE_NEEDS_WORK_PREFIX,
  DONE_GATE_PASS_PREFIX,
  DONE_GATE_UNAVAILABLE_PREFIX,
  type DoneGateCritic,
} from "./done-gate-critic.js";
import {
  QUALITY_CHECK_FOLLOW_UP_REASON,
  applyDefaultReviewerPolicy,
  evaluateQualityDoneCheck,
  evaluateQualitySelfReviewGate,
  maybeScheduleQualityCheckFollowUp,
  qualityLoopSettingsService,
  resolveEffectiveQualityLoops,
} from "./quality-loops.js";
import { SELF_REVIEW_PASS_REASON, type SelfReviewGateWakeup } from "./self-review-gate.js";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";

describe("resolveEffectiveQualityLoops", () => {
  it("is all off without a company row", () => {
    expect(resolveEffectiveQualityLoops(null, null)).toEqual({ selfReviewPasses: 0, doneCheckEnabled: false, doneCheckMaxRounds: 2 });
  });

  it("lets the task override the company, and the old selfReview:false opt-out still wins", () => {
    const row = { selfReviewPasses: 1, doneCheckEnabled: true, doneCheckMaxRounds: 3 };
    expect(resolveEffectiveQualityLoops(row, { selfReviewPasses: 3, doneCheck: false })).toEqual({
      selfReviewPasses: 3,
      doneCheckEnabled: false,
      doneCheckMaxRounds: 3,
    });
    expect(resolveEffectiveQualityLoops(row, { selfReview: false, selfReviewPasses: 2 }).selfReviewPasses).toBe(0);
    expect(resolveEffectiveQualityLoops(null, { doneCheck: true, selfReviewPasses: 9 })).toMatchObject({
      doneCheckEnabled: true,
      selfReviewPasses: 3,
    });
  });

  it("keeps the per-task fields through the execution-policy normalizer", () => {
    expect(normalizeIssueExecutionPolicy({ selfReviewPasses: 2, doneCheck: false })).toMatchObject({
      selfReviewPasses: 2,
      doneCheck: false,
    });
    expect(() => normalizeIssueExecutionPolicy({ selfReviewPasses: 4 })).toThrow();
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres quality-loop tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent quality loops (DB-backed)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-quality-loops-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueComments);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companyQualityLoopSettings);
    await db.delete(companyHelperSettings);
    await db.delete(modelDirectoryEntries);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(input?: { settings?: Partial<typeof companyQualityLoopSettings.$inferInsert> | null; gitProject?: boolean }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const reviewerId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Acme", issuePrefix, requireBoardApprovalForNewAgents: false });
    for (const [id, name] of [[agentId, "Worker"], [reviewerId, "Reviewer"]] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "active",
        adapterType: "opencode_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
    await db.insert(projects).values({ id: projectId, companyId, name: "Site", status: "active" });
    if (input?.gitProject) {
      await db.insert(projectWorkspaces).values({
        id: randomUUID(),
        companyId,
        projectId,
        name: "main",
        sourceType: "git",
        repoUrl: "https://example.com/site.git",
        isPrimary: true,
      });
    }
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "assignment", status: "running" });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Convert the page texts to the translation system",
      description: "Acceptance: all 312 hard-coded texts on the site go through the translation system.",
      status: "in_progress",
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
      body: "Done. Set up the translation system.",
      createdByRunId: runId,
    });
    if (input?.settings !== null && input?.settings !== undefined) {
      await db.insert(companyQualityLoopSettings).values({ companyId, ...input.settings });
    }
    const issue = {
      id: issueId,
      identifier: `${issuePrefix}-1`,
      companyId,
      projectId,
      title: "Convert the page texts to the translation system",
      description: "Acceptance: all 312 hard-coded texts on the site go through the translation system.",
      executionPolicy: null as unknown,
    };
    return { companyId, agentId, reviewerId, projectId, issueId, runId, issue };
  }

  /** A wakeup that records what heartbeat.enqueueWakeup would store (deferred behind the current run). */
  function recordingWakeup(opts?: { skip?: string }) {
    const calls: Array<{ agentId: string; reason: string | null | undefined; payload: Record<string, unknown> | null | undefined }> = [];
    const wakeup: SelfReviewGateWakeup = async (agentId, o) => {
      calls.push({ agentId, reason: o.reason, payload: o.payload });
      const companyId = await db
        .select({ companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0]!.companyId);
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId,
        source: o.source ?? "automation",
        reason: o.reason ?? null,
        payload: o.payload ?? null,
        idempotencyKey: o.idempotencyKey ?? null,
        status: opts?.skip ? "skipped" : "deferred_issue_execution",
      });
      if (opts?.skip) o.onNotScheduled?.({ kind: "skipped", reason: opts.skip });
      return null;
    };
    return { wakeup, calls };
  }

  function agentActor(f: { agentId: string; runId: string }) {
    return { actorType: "agent", agentId: f.agentId, runId: f.runId };
  }

  async function newRun(f: { companyId: string; agentId: string }) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({ id, companyId: f.companyId, agentId: f.agentId, invocationSource: "automation", status: "running" });
    return id;
  }

  async function activityActions(issueId: string) {
    return db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
  }

  async function qualityComments(issueId: string) {
    return db
      .select({ body: issueComments.body, createdByRunId: issueComments.createdByRunId })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .then((rows) => rows.filter((row) => row.body.startsWith("Quality check")));
  }

  // -------------------------------------------------------------------------
  // Self-check pass
  // -------------------------------------------------------------------------

  it("self-check: re-wakes the agent once, logs it, refuses the retry, then lets the pass run finish", async () => {
    const f = await seed({ settings: { selfReviewPasses: 1 } });
    const w = recordingWakeup();
    const first = await evaluateQualitySelfReviewGate({
      db,
      wakeup: w.wakeup,
      issue: f.issue,
      actor: agentActor(f),
      requestedStatus: "done",
      currentStatus: "in_progress",
    });
    expect(first?.message).toMatch(/self-check \(1 of 1\)/);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]).toMatchObject({ agentId: f.agentId, reason: SELF_REVIEW_PASS_REASON });
    const actions = await activityActions(f.issueId);
    expect(actions.map((a) => a.action)).toContain("issue.quality_self_review_scheduled");
    const instruction = await db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.issueId, f.issueId));
    expect(instruction.some((c) => c.body.includes("compare it with what was actually done"))).toBe(true);

    // The same (declined) run retrying is refused, without scheduling another pass.
    const retry = await evaluateQualitySelfReviewGate({
      db,
      wakeup: w.wakeup,
      issue: f.issue,
      actor: agentActor(f),
      requestedStatus: "done",
      currentStatus: "in_progress",
    });
    expect(retry?.message).toMatch(/already scheduled/);
    expect(w.calls).toHaveLength(1);

    // The self-check run picks up the wake and finishes: let through, nothing new scheduled.
    const passRunId = await newRun(f);
    await db.update(agentWakeupRequests).set({ status: "claimed", runId: passRunId });
    const fromPass = await evaluateQualitySelfReviewGate({
      db,
      wakeup: w.wakeup,
      issue: f.issue,
      actor: { actorType: "agent", agentId: f.agentId, runId: passRunId },
      requestedStatus: "done",
      currentStatus: "in_progress",
    });
    expect(fromPass).toBeNull();

    // Once used, a later run (after the pass completed) is not held again.
    await db.update(agentWakeupRequests).set({ status: "completed" });
    const later = await evaluateQualitySelfReviewGate({
      db,
      wakeup: w.wakeup,
      issue: f.issue,
      actor: { actorType: "agent", agentId: f.agentId, runId: await newRun(f) },
      requestedStatus: "in_review",
      currentStatus: "in_progress",
    });
    expect(later).toBeNull();
    expect(w.calls).toHaveLength(1);
  });

  it("self-check: bounded by the configured number of passes (2), never more", async () => {
    const f = await seed({ settings: { selfReviewPasses: 2 } });
    const w = recordingWakeup();
    let runId = f.runId;
    const outcomes: Array<string | null> = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await evaluateQualitySelfReviewGate({
        db,
        wakeup: w.wakeup,
        issue: f.issue,
        actor: { actorType: "agent", agentId: f.agentId, runId },
        requestedStatus: "done",
        currentStatus: "in_progress",
      });
      outcomes.push(result ? "held" : "through");
      // The scheduled pass runs and completes; its run is the next attempt.
      runId = await newRun(f);
      await db.update(agentWakeupRequests).set({ status: "completed", runId });
    }
    expect(outcomes).toEqual(["held", "held", "through", "through"]);
    expect(w.calls).toHaveLength(2);
  });

  it("self-check: a person is never held, and a skipped wake (e.g. budget) lets the move through with a trace", async () => {
    const f = await seed({ settings: { selfReviewPasses: 1 } });
    const w = recordingWakeup();
    expect(
      await evaluateQualitySelfReviewGate({
        db,
        wakeup: w.wakeup,
        issue: f.issue,
        actor: { actorType: "user", agentId: null, runId: null },
        requestedStatus: "done",
        currentStatus: "in_progress",
      }),
    ).toBeNull();
    const skipped = recordingWakeup({ skip: "budget.blocked" });
    expect(
      await evaluateQualitySelfReviewGate({
        db,
        wakeup: skipped.wakeup,
        issue: f.issue,
        actor: agentActor(f),
        requestedStatus: "done",
        currentStatus: "in_progress",
      }),
    ).toBeNull();
    expect((await activityActions(f.issueId)).map((a) => a.action)).toContain("issue.quality_self_review_skipped");
  });

  it("self-check: the task can switch it off or on regardless of the company", async () => {
    const on = await seed({ settings: { selfReviewPasses: 1 } });
    const w = recordingWakeup();
    expect(
      await evaluateQualitySelfReviewGate({
        db,
        wakeup: w.wakeup,
        issue: { ...on.issue, executionPolicy: { selfReviewPasses: 0 } },
        actor: agentActor(on),
        requestedStatus: "done",
        currentStatus: "in_progress",
      }),
    ).toBeNull();
    const off = await seed({ settings: null });
    expect(
      await evaluateQualitySelfReviewGate({
        db,
        wakeup: w.wakeup,
        issue: { ...off.issue, executionPolicy: { selfReviewPasses: 1 } },
        actor: agentActor(off),
        requestedStatus: "done",
        currentStatus: "in_progress",
      }),
    ).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Opt-out: unchanged behaviour
  // -------------------------------------------------------------------------

  it("opt-out: a company with no settings row (every existing company) sees no change at all", async () => {
    const f = await seed({ settings: null });
    const w = recordingWakeup();
    const critic = vi.fn<DoneGateCritic>();
    expect(
      await evaluateQualitySelfReviewGate({
        db,
        wakeup: w.wakeup,
        issue: f.issue,
        actor: agentActor(f),
        requestedStatus: "done",
        currentStatus: "in_progress",
      }),
    ).toBeNull();
    const done = await evaluateQualityDoneCheck({
      db,
      issue: f.issue,
      actor: agentActor(f),
      requestedStatus: "done",
      currentStatus: "in_progress",
      critic,
    });
    expect(done).toEqual({ applies: false });
    await db.insert(issueComments).values({
      companyId: f.companyId,
      issueId: f.issueId,
      authorType: "system",
      body: `${DONE_GATE_NEEDS_WORK_PREFIX} (round 1 of 2).`,
      createdByRunId: f.runId,
    });
    expect(
      await maybeScheduleQualityCheckFollowUp({
        db,
        run: { id: f.runId, agentId: f.agentId, companyId: f.companyId },
        issue: { ...f.issue, status: "in_progress", assigneeAgentId: f.agentId, assigneeUserId: null },
        wakeup: w.wakeup,
      }),
    ).toBe(false);
    expect(critic).not.toHaveBeenCalled();
    expect(w.calls).toHaveLength(0);
    expect(await db.select().from(activityLog)).toHaveLength(0);
    expect(await db.select().from(costEvents)).toHaveLength(0);
    expect(await qualityComments(f.issueId)).toHaveLength(1); // only the one this test wrote
  });

  // -------------------------------------------------------------------------
  // Independent finish check
  // -------------------------------------------------------------------------

  function critic(verdict: "pass" | "needs_work", findings: string[]) {
    return vi.fn<DoneGateCritic>(async () => ({ verdict, findings, usage: null }));
  }

  it("finish check: met -> lets done through with a 'passed' note", async () => {
    const f = await seed({ settings: { doneCheckEnabled: true } });
    const c = critic("pass", ["All texts were converted."]);
    const outcome = await evaluateQualityDoneCheck({
      db,
      issue: f.issue,
      actor: agentActor(f),
      requestedStatus: "done",
      currentStatus: "in_progress",
      patchComment: "Converted all 312 texts; list attached.",
      critic: c,
    });
    expect(outcome).toEqual({ applies: true, result: null });
    expect(c.mock.calls[0]![0].finalComment).toContain("312 texts");
    const notes = await qualityComments(f.issueId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body.startsWith(DONE_GATE_PASS_PREFIX)).toBe(true);
    expect((await activityActions(f.issueId)).map((a) => a.action)).toContain("issue.quality_check_ran");
  });

  it("finish check: not met -> back to in progress with the missing items, then the agent is woken once", async () => {
    const f = await seed({ settings: { doneCheckEnabled: true } });
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, f.issueId));
    const c = critic("needs_work", ["None of the 312 texts were converted; only the setup was done."]);
    const outcome = await evaluateQualityDoneCheck({
      db,
      issue: f.issue,
      actor: agentActor(f),
      requestedStatus: "done",
      currentStatus: "in_review",
      critic: c,
    });
    expect(outcome.applies).toBe(true);
    const result = outcome.applies ? outcome.result : null;
    expect(result?.findings).toEqual(["None of the 312 texts were converted; only the setup was done."]);
    expect(result?.message).toMatch(/round 1 of 2/);
    const [row] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, f.issueId));
    expect(row!.status).toBe("in_progress");
    const notes = await qualityComments(f.issueId);
    expect(notes[0]!.body).toContain("None of the 312 texts");

    // The run ends without fixing it: one follow-up wake, and not a second for the same run.
    const w = recordingWakeup();
    const followUpInput = {
      db,
      run: { id: f.runId, agentId: f.agentId, companyId: f.companyId },
      issue: { ...f.issue, status: "in_progress", assigneeAgentId: f.agentId, assigneeUserId: null },
      wakeup: w.wakeup,
    };
    expect(await maybeScheduleQualityCheckFollowUp(followUpInput)).toBe(true);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.reason).toBe(QUALITY_CHECK_FOLLOW_UP_REASON);
    expect((await activityActions(f.issueId)).map((a) => a.action)).toContain("issue.quality_check_follow_up_scheduled");
    // A run that did NOT get sent back (or a task already done) wakes nobody.
    expect(
      await maybeScheduleQualityCheckFollowUp({ ...followUpInput, run: { ...followUpInput.run, id: await newRun(f) } }),
    ).toBe(false);
    expect(
      await maybeScheduleQualityCheckFollowUp({ ...followUpInput, issue: { ...followUpInput.issue, status: "done" } }),
    ).toBe(false);
  });

  it("finish check: bounded -- after the configured rounds it stops and asks the person", async () => {
    const f = await seed({ settings: { doneCheckEnabled: true, doneCheckMaxRounds: 1 } });
    const c = critic("needs_work", ["Texts not converted."]);
    const attempt = () =>
      evaluateQualityDoneCheck({
        db,
        issue: f.issue,
        actor: agentActor(f),
        requestedStatus: "done",
        currentStatus: "in_progress",
        critic: c,
      });
    const first = await attempt();
    expect(first.applies && first.result?.escalated).toBe(false);
    const second = await attempt();
    expect(second.applies && second.result?.escalated).toBe(true);
    const third = await attempt();
    expect(third.applies && third.result?.escalated).toBe(true);
    expect(c).toHaveBeenCalledTimes(1);
    const [row] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, f.issueId));
    expect(row!.status).toBe("blocked");
    const notes = await qualityComments(f.issueId);
    expect(notes.filter((n) => n.body.startsWith(DONE_GATE_ESCALATED_PREFIX))).toHaveLength(1);
    expect(await db.select().from(approvals)).toHaveLength(1);
  });

  it("finish check: no company model -> skipped, done goes through, one visible note per loop", async () => {
    const f = await seed({ settings: { doneCheckEnabled: true } });
    for (let i = 0; i < 2; i += 1) {
      const outcome = await evaluateQualityDoneCheck({
        db,
        issue: f.issue,
        actor: agentActor(f),
        requestedStatus: "done",
        currentStatus: "in_progress",
      });
      expect(outcome).toEqual({ applies: true, result: null });
    }
    const notes = await qualityComments(f.issueId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body.startsWith(DONE_GATE_UNAVAILABLE_PREFIX)).toBe(true);
    expect(notes[0]!.body).toContain("no saved model for the finish check");
    expect(await db.select().from(costEvents)).toHaveLength(0);
  });

  it("finish check: uses the company's saved model and records the cost as its own kind, on the agent", async () => {
    const f = await seed({ settings: { doneCheckEnabled: true } });
    const [entry] = await db
      .insert(modelDirectoryEntries)
      .values({ companyId: f.companyId, name: "Cheap Claude", provider: "anthropic", model: "claude-haiku-4-5" })
      .returning();
    // The helper's default model is the fallback when the check has no model of its own.
    await db.insert(companyHelperSettings).values({ companyId: f.companyId, defaultDirectoryEntryId: entry!.id });
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"verdict":"needs_work","findings":["The texts were not converted."]}' }],
      usage: { input_tokens: 900, output_tokens: 60 },
      stop_reason: "end_turn",
    });
    const outcome = await evaluateQualityDoneCheck({
      db,
      issue: f.issue,
      actor: agentActor(f),
      requestedStatus: "done",
      currentStatus: "in_progress",
      helperOptions: { createModelClient: () => ({ messages: { create } }) as never },
    });
    expect(outcome.applies && outcome.result?.findings).toEqual(["The texts were not converted."]);
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0]![0] as { model: string }).model).toBe("claude-haiku-4-5");
    const costs = await db.select().from(costEvents).where(eq(costEvents.companyId, f.companyId));
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({
      billingCode: QUALITY_CHECK_BILLING_CODE,
      agentId: f.agentId,
      issueId: f.issueId,
      provider: "anthropic",
      inputTokens: 900,
      outputTokens: 60,
    });
  });

  // -------------------------------------------------------------------------
  // Settings + default reviewer
  // -------------------------------------------------------------------------

  it("settings: off without a row, new companies get the suggested defaults, and foreign picks are refused", async () => {
    const f = await seed({ settings: null });
    const svc = qualityLoopSettingsService(db);
    expect(await svc.get(f.companyId)).toMatchObject({ configured: false, selfReviewPasses: 0, doneCheckEnabled: false });
    await svc.applyNewCompanyDefaults(f.companyId);
    expect(await svc.get(f.companyId)).toMatchObject({ configured: true, selfReviewPasses: 1, doneCheckEnabled: true, doneCheckMaxRounds: 2 });
    await svc.update(f.companyId, { selfReviewPasses: 0 }, { userId: "filip" });
    await svc.applyNewCompanyDefaults(f.companyId); // never overwrites a choice
    expect((await svc.get(f.companyId)).selfReviewPasses).toBe(0);
    const other = await seed({ settings: null });
    await expect(svc.update(f.companyId, { defaultReviewerAgentId: other.agentId }, { userId: "filip" })).rejects.toMatchObject({
      status: 422,
    });
  });

  it("default reviewer: only new code tasks without a policy, never the assignee reviewing itself", async () => {
    const f = await seed({ settings: { defaultReviewerAgentId: null }, gitProject: true });
    await db.update(companyQualityLoopSettings).set({ defaultReviewerAgentId: f.reviewerId });
    const base = {
      companyId: f.companyId,
      projectId: f.projectId,
      assigneeAgentId: f.agentId,
      requestedPolicy: undefined as unknown,
      normalizedPolicy: null as ReturnType<typeof normalizeIssueExecutionPolicy>,
      normalize: normalizeIssueExecutionPolicy,
    };
    const applied = await applyDefaultReviewerPolicy(db, base);
    expect(applied?.stages).toHaveLength(1);
    expect(applied?.stages[0]).toMatchObject({ type: "review", participants: [{ type: "agent", agentId: f.reviewerId }] });
    expect(await applyDefaultReviewerPolicy(db, { ...base, assigneeAgentId: f.reviewerId })).toBeNull();
    const explicit = normalizeIssueExecutionPolicy({ selfReview: false });
    expect(await applyDefaultReviewerPolicy(db, { ...base, requestedPolicy: { selfReview: false }, normalizedPolicy: explicit })).toBe(explicit);
    const nonCode = await seed({ settings: { defaultReviewerAgentId: null } });
    await db
      .update(companyQualityLoopSettings)
      .set({ defaultReviewerAgentId: nonCode.reviewerId })
      .where(eq(companyQualityLoopSettings.companyId, nonCode.companyId));
    expect(
      await applyDefaultReviewerPolicy(db, { ...base, companyId: nonCode.companyId, projectId: nonCode.projectId }),
    ).toBeNull();
  });
});
