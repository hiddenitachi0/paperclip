import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";

/**
 * E2E: Signoff execution policy flow.
 *
 * Validates the full signoff lifecycle through the API and UI:
 *   1. Create a company with executor + reviewer + approver agents
 *   2. Create an issue with a two-stage execution policy (review → approval)
 *   3. Executor marks done → issue routes to reviewer (in_review)
 *   4. Reviewer approves → issue routes to approver
 *   5. Approver approves → execution completes, issue marked done
 *   6. Verify "changes requested" flow returns to executor
 *
 * Requires local_trusted deployment mode (set in playwright.config.ts webServer env).
 *
 * Agent auth flow:
 *   - Board request (local_trusted auto-auth) handles setup/teardown.
 *   - Agent-specific actions use API keys + heartbeat run IDs.
 *   - No agent starts a run of its own for a stage it takes part in. Every
 *     time the issue lands on an agent (creation, a stage advancing, a
 *     reviewer sending it back) the server wakes that agent, exactly as for a
 *     real agent. The stub processes stay alive so the test can act *inside*
 *     that wake run: wait for it to be running, PATCH with its run id, then
 *     cancel it so the next stage starts from a released issue. The executor
 *     additionally makes sure its run owns the issue checkout (an
 *     "issue_assigned" wake checks out by itself; an
 *     "execution_changes_requested" wake leaves that to the agent).
 *   - Why not simply start a fresh run per action, as this spec used to: two
 *     server behaviours then race the test. (a) A test-started executor run
 *     competed with the server's own wake run for the checkout lock, and
 *     which one won depended on how fast each stub exited -- the source of
 *     the random "Issue checkout conflict" on slow CI runners. (b) A
 *     reviewer/approver stub that exits without deciding ends a run woken
 *     with "execution_review_requested"/"execution_approval_requested", which
 *     the server rightly treats as a review participant that failed to act:
 *     it queues participant recovery and, when that also does nothing,
 *     escalates the issue away from the stage -- so a PATCH that arrived a
 *     little late (after a slow UI check) was refused. Acting inside the wake
 *     run, then cancelling it once the stage has moved on, removes both.
 */

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const COMPANY_NAME = `E2E-Signoff-${Date.now()}`;

// How long to wait for the server to reach a specific run/lock state. A wake
// run is claimed within a few hundred ms even on a loaded CI runner; this only
// bounds a genuinely broken server.
const RUN_STATE_TIMEOUT_MS = 20_000;
const RUN_STATE_POLL_INTERVALS_MS = [100, 250, 500];

// Every stub process stays alive until the test cancels its run, so the run
// is still active while the test acts as that agent. The timer is only a leak
// guard for a test that fails before it gets to cancel.
const STUB_MAX_LIFETIME_MS = 60_000;
const STUB_ARGS = ["-e", `setTimeout(() => process.stdout.write('done\\n'), ${STUB_MAX_LIFETIME_MS})`];

interface AgentAuth {
  name: string;
  agentId: string;
  token: string;
  keyId: string;
  request: APIRequestContext;
}

interface TestContext {
  companyId: string;
  companyPrefix: string;
  executor: AgentAuth;
  reviewer: AgentAuth;
  approver: AgentAuth;
  boardRequest: APIRequestContext;
  issueIds: string[];
}

interface IssueRunLockState {
  status: string;
  assigneeAgentId: string | null;
  checkoutRunId: string | null;
  executionRunId: string | null;
}

interface LiveRun {
  id: string;
  agentId: string;
  status: string;
  issueId: string | null;
}

/** Create an authenticated APIRequestContext for an agent (token set, no run ID yet). */
async function createAgentRequest(token: string): Promise<APIRequestContext> {
  return pwRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

/** Invoke an on-demand heartbeat run for an agent, returning the run ID. */
async function invokeHeartbeat(board: APIRequestContext, agentId: string): Promise<string> {
  const res = await board.post(`${BASE_URL}/api/agents/${agentId}/heartbeat/invoke`);
  expect(res.ok(), await res.text()).toBe(true);
  const run = await res.json();
  return run.id;
}

async function getIssueRunLockState(board: APIRequestContext, issueId: string): Promise<IssueRunLockState> {
  const res = await board.get(`${BASE_URL}/api/issues/${issueId}`);
  expect(res.ok(), await res.text()).toBe(true);
  const issue = await res.json();
  return {
    status: issue.status,
    assigneeAgentId: issue.assigneeAgentId ?? null,
    checkoutRunId: issue.checkoutRunId ?? null,
    executionRunId: issue.executionRunId ?? null,
  };
}

/** The company's live (queued/running) runs. */
async function listLiveRuns(ctx: TestContext): Promise<LiveRun[]> {
  const res = await ctx.boardRequest.get(`${BASE_URL}/api/companies/${ctx.companyId}/live-runs`);
  expect(res.ok(), await res.text()).toBe(true);
  const runs: Array<{ id: string; agentId: string; status: string; issueId?: string | null }> = await res.json();
  return runs.map((run) => ({ id: run.id, agentId: run.agentId, status: run.status, issueId: run.issueId ?? null }));
}

async function getRun(board: APIRequestContext, runId: string): Promise<{ status: string } | null> {
  const res = await board.get(`${BASE_URL}/api/heartbeat-runs/${runId}`);
  if (res.status() === 404) return null;
  expect(res.ok(), await res.text()).toBe(true);
  const run = await res.json();
  return { status: run.status };
}

/**
 * Wait for the run the server woke `agent` with for this issue, and return
 * its id. Handing the issue to an agent (creation, a stage advancing, a
 * reviewer sending it back) queues a wake for it; once claimed it shows up as
 * a running run whose context names the issue.
 */
async function awaitWakeRun(ctx: TestContext, agent: AgentAuth, issueId: string): Promise<string> {
  let runId: string | null = null;
  await expect
    .poll(
      async () => {
        const lock = await getIssueRunLockState(ctx.boardRequest, issueId);
        if (lock.assigneeAgentId !== agent.agentId) return `issue assigned to ${lock.assigneeAgentId}, not ${agent.name}`;
        const running = (await listLiveRuns(ctx)).filter(
          (run) => run.agentId === agent.agentId && run.issueId === issueId && run.status === "running",
        );
        if (running.length === 0) return `no running ${agent.name} run for this issue`;
        // Prefer the run that already holds the checkout so we never fight
        // it for the lock.
        runId = running.find((run) => run.id === lock.checkoutRunId)?.id ?? running[0].id;
        return "running";
      },
      {
        message: `${agent.name} should be woken for issue ${issueId}`,
        timeout: RUN_STATE_TIMEOUT_MS,
        intervals: RUN_STATE_POLL_INTERVALS_MS,
      },
    )
    .toBe("running");
  return runId!;
}

/**
 * Cancel an agent's run and wait until that agent has no live run left for
 * the issue and holds none of its locks. Cancelling releases the issue, which
 * also promotes any wake that was parked behind the run (the next stage's
 * participant, or a second wake for the same agent coalesced onto the issue);
 * a promoted run for the *same* agent is cancelled too, so every stage starts
 * from a released issue and an idle agent.
 */
async function endAgentRun(ctx: TestContext, agent: AgentAuth, issueId: string, runId: string) {
  const res = await ctx.boardRequest.post(`${BASE_URL}/api/heartbeat-runs/${runId}/cancel`);
  expect(res.ok(), await res.text()).toBe(true);
  await expect
    .poll(
      async () => {
        const live = (await listLiveRuns(ctx)).filter((run) => run.agentId === agent.agentId && run.issueId === issueId);
        for (const run of live) {
          await ctx.boardRequest.post(`${BASE_URL}/api/heartbeat-runs/${run.id}/cancel`);
        }
        if (live.length > 0) return `${agent.name} still has ${live.length} live run(s) for the issue`;
        const lock = await getIssueRunLockState(ctx.boardRequest, issueId);
        if (lock.checkoutRunId === runId || lock.executionRunId === runId) return `run ${runId} still holds a lock`;
        return "released";
      },
      {
        message: `${agent.name} run ${runId} should release issue ${issueId}`,
        timeout: RUN_STATE_TIMEOUT_MS,
        intervals: RUN_STATE_POLL_INTERVALS_MS,
      },
    )
    .toBe("released");
}

/**
 * Act as the executor from inside the run the server woke it with: wait for
 * that run, make sure it owns the issue checkout, PATCH with its run id, then
 * end the run.
 *
 * An "issue_assigned" wake checks the issue out by itself as soon as it is
 * claimed; an "execution_changes_requested" wake (a reviewer sending the
 * issue back) by design leaves that to the agent -- the explicit checkout
 * below covers the second case and is a no-op for the first.
 */
async function executorPatch(ctx: TestContext, issueId: string, data: Record<string, unknown>) {
  const runId = await awaitWakeRun(ctx, ctx.executor, issueId);
  const lock = await getIssueRunLockState(ctx.boardRequest, issueId);
  if (lock.checkoutRunId !== runId) {
    const checkoutRes = await ctx.executor.request.post(`${BASE_URL}/api/issues/${issueId}/checkout`, {
      headers: { "X-Paperclip-Run-Id": runId },
      data: { agentId: ctx.executor.agentId, expectedStatuses: ["in_progress"] },
    });
    expect(checkoutRes.ok(), `executor run ${runId} could not check out issue ${issueId}: ${await checkoutRes.text()}`).toBe(true);
  }
  const res = await ctx.executor.request.patch(`${BASE_URL}/api/issues/${issueId}`, {
    headers: { "X-Paperclip-Run-Id": runId },
    data,
  });
  await endAgentRun(ctx, ctx.executor, issueId, runId);
  return res;
}

/**
 * Act as a stage participant (reviewer/approver) from inside the run the
 * stage transition woke it with: wait for that run, PATCH with its run id,
 * then end the run. No checkout: the issue is in_review, and a checkout would
 * force it to in_progress, which is not the state the signoff policy expects
 * a decision from.
 */
async function participantPatch(ctx: TestContext, agent: AgentAuth, issueId: string, data: Record<string, unknown>) {
  const runId = await awaitWakeRun(ctx, agent, issueId);
  const res = await agent.request.patch(`${BASE_URL}/api/issues/${issueId}`, {
    headers: { "X-Paperclip-Run-Id": runId },
    data,
  });
  await endAgentRun(ctx, agent, issueId, runId);
  return res;
}

/**
 * PATCH an issue as an agent the server has *not* woken for it, from an
 * on-demand run of that agent. Used to prove that being an agent with a valid
 * run id is not enough to act on a stage one is not a participant of.
 */
async function outsiderPatch(ctx: TestContext, agent: AgentAuth, issueId: string, data: Record<string, unknown>) {
  const runId = await invokeHeartbeat(ctx.boardRequest, agent.agentId);
  await expect
    .poll(async () => (await getRun(ctx.boardRequest, runId))?.status ?? "missing", {
      message: `${agent.name} on-demand run ${runId} should start`,
      timeout: RUN_STATE_TIMEOUT_MS,
      intervals: RUN_STATE_POLL_INTERVALS_MS,
    })
    .toBe("running");
  const res = await agent.request.patch(`${BASE_URL}/api/issues/${issueId}`, {
    headers: { "X-Paperclip-Run-Id": runId },
    data,
  });
  const cancelRes = await ctx.boardRequest.post(`${BASE_URL}/api/heartbeat-runs/${runId}/cancel`);
  expect(cancelRes.ok(), await cancelRes.text()).toBe(true);
  return res;
}

/**
 * Cancel every live run in the company and wait until none is left, so a
 * test never inherits a stub process (or a recovery run the server queued
 * for an earlier issue) from the test before it.
 */
async function quiesceCompany(ctx: TestContext) {
  await expect
    .poll(
      async () => {
        const live = await listLiveRuns(ctx);
        for (const run of live) {
          await ctx.boardRequest.post(`${BASE_URL}/api/heartbeat-runs/${run.id}/cancel`);
        }
        return live.length;
      },
      {
        message: "the company should have no live runs left",
        timeout: RUN_STATE_TIMEOUT_MS,
        intervals: RUN_STATE_POLL_INTERVALS_MS,
      },
    )
    .toBe(0);
}

async function setupCompany(boardRequest: APIRequestContext): Promise<TestContext> {
  // Verify server is in local_trusted mode
  const healthRes = await boardRequest.get(`${BASE_URL}/api/health`);
  expect(healthRes.ok()).toBe(true);
  const health = await healthRes.json();
  if (health.deploymentMode !== "local_trusted") {
    throw new Error(
      `Signoff e2e tests require local_trusted deployment mode, ` +
        `but server is in "${health.deploymentMode}" mode. ` +
        `Set PAPERCLIP_DEPLOYMENT_MODE=local_trusted or use the webServer config.`,
    );
  }

  // Create company
  const companyRes = await boardRequest.post(`${BASE_URL}/api/companies`, {
    data: { name: COMPANY_NAME },
  });
  if (!companyRes.ok()) {
    const errBody = await companyRes.text();
    throw new Error(`POST /api/companies → ${companyRes.status()}: ${errBody}`);
  }
  const company = await companyRes.json();
  const companyId = company.id;
  const companyPrefix = company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E";

  // Helper: hire/approve agent + API key + request context
  async function createAgent(name: string, role: string, title: string): Promise<AgentAuth> {
    const agentRes = await boardRequest.post(`${BASE_URL}/api/companies/${companyId}/agent-hires`, {
      data: {
        name,
        role,
        title,
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: STUB_ARGS,
        },
      },
    });
    expect(agentRes.ok(), await agentRes.text()).toBe(true);
    const hire = await agentRes.json();
    const agent = hire.agent;
    if (hire.approval) {
      const approvalRes = await boardRequest.post(`${BASE_URL}/api/approvals/${hire.approval.id}/approve`, {
        data: { decisionNote: "Approved for signoff e2e setup." },
      });
      expect(approvalRes.ok(), await approvalRes.text()).toBe(true);
    }

    const keyRes = await boardRequest.post(`${BASE_URL}/api/agents/${agent.id}/keys`, {
      data: { name: `e2e-${name.toLowerCase()}` },
    });
    expect(keyRes.ok(), await keyRes.text()).toBe(true);
    const keyData = await keyRes.json();

    return {
      name,
      agentId: agent.id,
      token: keyData.token,
      keyId: keyData.id,
      request: await createAgentRequest(keyData.token),
    };
  }

  const executor = await createAgent("Executor", "engineer", "Software Engineer");
  const reviewer = await createAgent("Reviewer", "qa", "QA Engineer");
  const approver = await createAgent("Approver", "cto", "CTO");

  return {
    companyId,
    companyPrefix,
    executor,
    reviewer,
    approver,
    boardRequest,
    issueIds: [],
  };
}

async function createIssueWithPolicy(ctx: TestContext, title: string, stages?: unknown[]) {
  const defaultStages = [
    { type: "review", participants: [{ type: "agent", agentId: ctx.reviewer.agentId }] },
    { type: "approval", participants: [{ type: "agent", agentId: ctx.approver.agentId }] },
  ];
  const res = await ctx.boardRequest.post(`${BASE_URL}/api/companies/${ctx.companyId}/issues`, {
    data: {
      title,
      status: "in_progress",
      assigneeAgentId: ctx.executor.agentId,
      executionPolicy: { stages: stages ?? defaultStages },
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
  const issue = await res.json();
  ctx.issueIds.push(issue.id);
  return issue;
}

test.describe("Signoff execution policy", () => {
  let ctx: TestContext;

  test.beforeAll(async () => {
    const boardRequest = await pwRequest.newContext({ baseURL: BASE_URL });
    ctx = await setupCompany(boardRequest);
  });

  test.afterEach(async () => {
    if (ctx) await quiesceCompany(ctx);
  });

  test.afterAll(async () => {
    if (!ctx) return;
    const board = ctx.boardRequest;

    // Dispose agent request contexts
    for (const agent of [ctx.executor, ctx.reviewer, ctx.approver]) {
      await agent.request.dispose();
    }

    // Stop any stub still alive (a test that failed before ending its run)
    const liveRunsRes = await board.get(`${BASE_URL}/api/companies/${ctx.companyId}/live-runs`).catch(() => null);
    const liveRuns: Array<{ id: string }> = liveRunsRes?.ok() ? await liveRunsRes.json() : [];
    for (const run of liveRuns) {
      await board.post(`${BASE_URL}/api/heartbeat-runs/${run.id}/cancel`).catch(() => {});
    }

    // Clean up issues, keys, agents, company (best-effort)
    for (const issueId of ctx.issueIds) {
      await board.patch(`${BASE_URL}/api/issues/${issueId}`, {
        data: { status: "cancelled", comment: "E2E test cleanup." },
      }).catch(() => {});
    }
    for (const agent of [ctx.executor, ctx.reviewer, ctx.approver]) {
      await board.delete(`${BASE_URL}/api/agents/${agent.agentId}/keys/${agent.keyId}`).catch(() => {});
      await board.delete(`${BASE_URL}/api/agents/${agent.agentId}`).catch(() => {});
    }
    await board.delete(`${BASE_URL}/api/companies/${ctx.companyId}`).catch(() => {});
    await board.dispose();
  });

  test("happy path: executor → review → approval → done", async ({ page }) => {
    const issue = await createIssueWithPolicy(ctx, "Signoff happy path");
    const issueId = issue.id;

    // Verify policy was saved
    expect(issue.executionPolicy).toBeTruthy();
    expect(issue.executionPolicy.stages).toHaveLength(2);
    expect(issue.executionPolicy.stages[0].type).toBe("review");
    expect(issue.executionPolicy.stages[1].type).toBe("approval");

    // Step 1: Executor marks done → should route to reviewer
    const step1Res = await executorPatch(ctx, issueId, {
      status: "done",
      comment: "Implemented the feature, ready for review.",
    });
    expect(step1Res.ok(), await step1Res.text()).toBe(true);
    const step1Issue = await step1Res.json();

    expect(step1Issue.status).toBe("in_review");
    expect(step1Issue.assigneeAgentId).toBe(ctx.reviewer.agentId);
    expect(step1Issue.executionState).toBeTruthy();
    expect(step1Issue.executionState.status).toBe("pending");
    expect(step1Issue.executionState.currentStageType).toBe("review");
    expect(step1Issue.executionState.returnAssignee).toMatchObject({
      type: "agent",
      agentId: ctx.executor.agentId,
    });

    // Step 2: Navigate to issue in UI and verify execution label
    await page.goto(`/${ctx.companyPrefix}/issues/${issue.identifier}`);
    await expect(page.locator("text=Review pending")).toBeVisible({ timeout: 10_000 });

    // Step 3: Reviewer approves → should route to approver
    const step3Res = await participantPatch(ctx, ctx.reviewer, issueId, {
      status: "done",
      comment: "QA signoff complete. Looks good.",
    });
    expect(step3Res.ok(), await step3Res.text()).toBe(true);
    const step3Issue = await step3Res.json();

    expect(step3Issue.status).toBe("in_review");
    expect(step3Issue.assigneeAgentId).toBe(ctx.approver.agentId);
    expect(step3Issue.executionState.status).toBe("pending");
    expect(step3Issue.executionState.currentStageType).toBe("approval");
    expect(step3Issue.executionState.completedStageIds).toHaveLength(1);

    // Step 4: Verify UI shows approval pending
    await page.reload();
    await expect(page.locator("text=Approval pending")).toBeVisible({ timeout: 10_000 });

    // Step 5: Approver approves → should complete
    const step5Res = await participantPatch(ctx, ctx.approver, issueId, {
      status: "done",
      comment: "Approved. Ship it.",
    });
    expect(step5Res.ok(), await step5Res.text()).toBe(true);
    const step5Issue = await step5Res.json();

    expect(step5Issue.status).toBe("done");
    expect(step5Issue.executionState.status).toBe("completed");
    expect(step5Issue.executionState.completedStageIds).toHaveLength(2);
    expect(step5Issue.executionState.lastDecisionOutcome).toBe("approved");
  });

  test("changes requested: reviewer bounces back to executor", async () => {
    const issue = await createIssueWithPolicy(ctx, "Signoff changes requested");
    const issueId = issue.id;

    // Executor marks done → routes to reviewer
    const doneRes = await executorPatch(ctx, issueId, { status: "done", comment: "Ready for review." });
    expect(doneRes.ok(), await doneRes.text()).toBe(true);
    expect((await doneRes.json()).status).toBe("in_review");

    // Reviewer requests changes → returns to executor
    const changesRes = await participantPatch(ctx, ctx.reviewer, issueId, {
      status: "in_progress",
      comment: "Needs another pass on edge cases.",
    });
    expect(changesRes.ok(), await changesRes.text()).toBe(true);
    const changesIssue = await changesRes.json();

    expect(changesIssue.status).toBe("in_progress");
    expect(changesIssue.assigneeAgentId).toBe(ctx.executor.agentId);
    expect(changesIssue.executionState.status).toBe("changes_requested");
    expect(changesIssue.executionState.lastDecisionOutcome).toBe("changes_requested");

    // Executor re-submits (from the run the bounce-back woke it with) → goes back to reviewer (same stage)
    const resubmitRes = await executorPatch(ctx, issueId, { status: "done", comment: "Fixed the edge cases." });
    expect(resubmitRes.ok(), await resubmitRes.text()).toBe(true);
    const resubmitIssue = await resubmitRes.json();

    expect(resubmitIssue.status).toBe("in_review");
    expect(resubmitIssue.assigneeAgentId).toBe(ctx.reviewer.agentId);
    expect(resubmitIssue.executionState.status).toBe("pending");
    expect(resubmitIssue.executionState.currentStageType).toBe("review");
  });

  test("comment required: approval without comment fails", async () => {
    const issue = await createIssueWithPolicy(ctx, "Signoff comment required");
    const issueId = issue.id;

    // Executor marks done → routes to reviewer
    const doneRes = await executorPatch(ctx, issueId, { status: "done", comment: "Done." });
    expect(doneRes.ok(), await doneRes.text()).toBe(true);

    // Reviewer tries to approve without comment → should fail
    const noCommentRes = await participantPatch(ctx, ctx.reviewer, issueId, { status: "done" });
    expect(noCommentRes.ok()).toBe(false);
    const errorBody = await noCommentRes.json();
    expect(JSON.stringify(errorBody)).toContain("comment");
  });

  test("non-participant cannot advance stage", async () => {
    const issue = await createIssueWithPolicy(ctx, "Signoff access control");
    const issueId = issue.id;

    // Executor marks done → routes to reviewer
    const doneRes = await executorPatch(ctx, issueId, { status: "done", comment: "Done." });
    expect(doneRes.ok(), await doneRes.text()).toBe(true);

    // Verify issue is in_review with reviewer
    const issueRes = await ctx.boardRequest.get(`${BASE_URL}/api/issues/${issueId}`);
    const inReviewIssue = await issueRes.json();
    expect(inReviewIssue.status).toBe("in_review");
    expect(inReviewIssue.assigneeAgentId).toBe(ctx.reviewer.agentId);
    expect(inReviewIssue.executionState.currentStageType).toBe("review");

    // Non-participant (approver at this stage) tries to advance → should be rejected
    const advanceRes = await outsiderPatch(ctx, ctx.approver, issueId, {
      status: "done",
      comment: "I'm the approver, not the reviewer.",
    });
    expect(advanceRes.ok()).toBe(false);
    expect(advanceRes.status()).toBeGreaterThanOrEqual(400);
  });

  test("review-only policy: reviewer approval completes execution", async () => {
    const issue = await createIssueWithPolicy(ctx, "Signoff review-only", [
      { type: "review", participants: [{ type: "agent", agentId: ctx.reviewer.agentId }] },
    ]);

    // Executor marks done → routes to reviewer
    const doneRes = await executorPatch(ctx, issue.id, { status: "done", comment: "Ready for review." });
    expect(doneRes.ok(), await doneRes.text()).toBe(true);
    expect((await doneRes.json()).status).toBe("in_review");

    // Reviewer approves → should complete immediately (no approval stage)
    const approveRes = await participantPatch(ctx, ctx.reviewer, issue.id, { status: "done", comment: "LGTM." });
    expect(approveRes.ok(), await approveRes.text()).toBe(true);
    const doneIssue = await approveRes.json();
    expect(doneIssue.status).toBe("done");
    expect(doneIssue.executionState.status).toBe("completed");
    expect(doneIssue.executionState.completedStageIds).toHaveLength(1);
  });
});
