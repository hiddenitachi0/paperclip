import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  documents,
  environmentLeases,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issueDocuments,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildAgentEnteredErrorNotice,
  buildFrozenRunErrorMessage,
  buildReapedRunOperatorNotice,
  buildStoppedRunOperatorNotice,
  formatOperatorDuration,
} from "../services/operator-notices.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "retry run finished",
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

import { heartbeatService, resolveFrozenRunCaps } from "../services/heartbeat.ts";

// DUR-98: "something broke, the system knew, and nobody was told." The two
// cases below are the platform's own detections -- the watchdog ending a run
// whose process is gone, and an agent dropping into "error" -- and each must
// leave an operator-readable activity entry, not only a server log line.
describe("operator notice wording (DUR-98)", () => {
  it("formats durations the way a person would say them", () => {
    expect(formatOperatorDuration(0)).toBe("under a minute");
    expect(formatOperatorDuration(59_000)).toBe("under a minute");
    expect(formatOperatorDuration(60_000)).toBe("1 minute");
    expect(formatOperatorDuration(42 * 60_000)).toBe("42 minutes");
    expect(formatOperatorDuration(60 * 60_000)).toBe("1 hour");
    expect(formatOperatorDuration(125 * 60_000)).toBe("2 hours 5 minutes");
    expect(formatOperatorDuration(null)).toBe("an unknown amount of time");
    expect(formatOperatorDuration(-5)).toBe("an unknown amount of time");
  });

  it("describes a reaped run with a retry in plain language", () => {
    expect(
      buildReapedRunOperatorNotice({
        agentName: "CodexCoder",
        silentForMs: 42 * 60_000,
        processWasKnown: true,
        retryQueued: true,
        agentMarkedError: false,
      }),
    ).toBe(
      "CodexCoder's run stopped: its process was no longer running after 42 minutes without any output. Paperclip ended it and queued a fresh run to pick the work up again.",
    );
  });

  it("says when the agent now needs a person, and when it is simply free again", () => {
    expect(
      buildReapedRunOperatorNotice({
        agentName: "CodexCoder",
        silentForMs: 30_000,
        processWasKnown: true,
        retryQueued: false,
        agentMarkedError: true,
      }),
    ).toBe(
      "CodexCoder's run stopped: its process was no longer running. Paperclip ended it. CodexCoder is now marked as needing attention and will not take new work until someone clears the error.",
    );
    expect(
      buildReapedRunOperatorNotice({
        agentName: null,
        silentForMs: null,
        processWasKnown: false,
        retryQueued: false,
        agentMarkedError: false,
      }),
    ).toBe(
      "An agent's run stopped: its process could not be found (most likely the server restarted). Paperclip ended it. An agent is free to take work again.",
    );
  });

  it("tells the operator what to do when an agent enters error", () => {
    expect(buildAgentEnteredErrorNotice({ agentName: "Reviewer", reason: "Process lost -- child pid 4 is no longer running" })).toBe(
      'Reviewer stopped taking work after a failed run and needs attention. Open the agent and use "Clear error" once the cause is fixed. Last error: Process lost -- child pid 4 is no longer running',
    );
    expect(buildAgentEnteredErrorNotice({ agentName: "  ", reason: null })).toBe(
      'An agent stopped taking work after a failed run and needs attention. Open the agent and use "Clear error" once the cause is fixed.',
    );
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres DUR-98 watchdog notice tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("watchdog and agent-error operator notices (DUR-98)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const dispatchedRuns: Promise<unknown>[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dur98-watchdog-notices-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  // The queued retry is dispatched fire-and-forget and keeps writing
  // (company_skills, runtime state) briefly after the run row settles, so
  // the cleanup retries on FK races instead of trying to out-order it --
  // same shape as heartbeat-global-concurrency.test.ts.
  async function deleteAllTestDataWithRetry(maxAttempts = 5) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(activityLog);
        await db.delete(companySkills);
        await db.delete(issueDocuments);
        await db.delete(issueAttachments);
        await db.delete(documents);
        await db.delete(issueComments);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(workspaceOperations);
        await db.delete(executionWorkspaces);
        await db.delete(companySkills);
        await db.delete(companies);
        return;
      } catch (err) {
        const isForeignKeyRace = err instanceof Error && /violates foreign key constraint/.test(err.message);
        if (!isForeignKeyRace || attempt === maxAttempts) throw err;
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      }
    }
  }

  afterEach(async () => {
    await Promise.allSettled(dispatchedRuns.splice(0));
    await deleteAllTestDataWithRetry();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedDeadRun(input: { processLossRetryCount: number; processPid?: number | null }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const fortyMinutesAgo = new Date(Date.now() - 40 * 60 * 1000);

    await db.insert(companies).values({
      id: companyId,
      name: "Notices Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: {},
      status: "claimed",
      runId,
      claimedAt: anHourAgo,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "running",
      wakeupRequestId,
      contextSnapshot: {},
      // A pid that cannot exist on this host, so the watchdog finds it gone.
      processPid: input.processPid === undefined ? 999_999_999 : input.processPid,
      processGroupId: null,
      processLossRetryCount: input.processLossRetryCount,
      startedAt: anHourAgo,
      processStartedAt: anHourAgo,
      lastOutputAt: fortyMinutesAgo,
      updatedAt: new Date(),
    });

    return { companyId, agentId, runId };
  }

  function makeHeartbeat() {
    return heartbeatService(db, {
      timerJitter: { ratio: 0 },
      onRunDispatched: (run) => {
        dispatchedRuns.push(run);
      },
    });
  }

  it("writes a plain-language notice when the watchdog reaps a run and queues a retry", async () => {
    const { companyId, agentId, runId } = await seedDeadRun({ processLossRetryCount: 0 });
    const heartbeat = makeHeartbeat();

    const result = await heartbeat.reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 });
    expect(result.runIds).toEqual([runId]);

    const notices = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "heartbeat.run_reaped")));
    expect(notices).toHaveLength(1);
    const notice = notices[0]!;
    expect(notice).toMatchObject({
      actorType: "system",
      actorId: "run-watchdog",
      entityType: "heartbeat_run",
      entityId: runId,
      agentId,
      runId,
    });
    const details = notice.details as Record<string, unknown>;
    expect(details.agentId).toBe(agentId);
    expect(details.agentName).toBe("CodexCoder");
    expect(details.retryQueued).toBe(true);
    expect(typeof details.retryRunId).toBe("string");
    expect(details.agentMarkedError).toBe(false);
    expect(details.processWasKnown).toBe(true);
    expect(details.message).toBe(
      "CodexCoder's run stopped: its process was no longer running after 40 minutes without any output. Paperclip ended it and queued a fresh run to pick the work up again.",
    );

    // A retry was queued, so the agent must not have been flagged as needing attention.
    const errorNotices = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "agent.entered_error")));
    expect(errorNotices).toHaveLength(0);
  });

  it("writes both the reap notice and an agent-needs-attention notice when the retry is exhausted", async () => {
    const { companyId, agentId, runId } = await seedDeadRun({ processLossRetryCount: 1 });
    const heartbeat = makeHeartbeat();

    const result = await heartbeat.reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 });
    expect(result.runIds).toEqual([runId]);

    const agent = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]);
    expect(agent?.status).toBe("error");

    const errorNotices = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "agent.entered_error")));
    expect(errorNotices).toHaveLength(1);
    expect(errorNotices[0]).toMatchObject({
      actorType: "system",
      entityType: "agent",
      entityId: agentId,
      agentId,
    });
    const errorDetails = errorNotices[0]!.details as Record<string, unknown>;
    expect(errorDetails.agentName).toBe("CodexCoder");
    expect(String(errorDetails.message)).toContain("CodexCoder stopped taking work after a failed run and needs attention.");
    expect(String(errorDetails.message)).toContain('use "Clear error"');
    expect(typeof errorDetails.errorAt).toBe("string");

    const reapNotices = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "heartbeat.run_reaped")));
    expect(reapNotices).toHaveLength(1);
    const reapDetails = reapNotices[0]!.details as Record<string, unknown>;
    expect(reapDetails.retryQueued).toBe(false);
    expect(reapDetails.agentMarkedError).toBe(true);
    expect(String(reapDetails.message)).toContain("CodexCoder is now marked as needing attention");
  });

  it("does not write a second agent-needs-attention notice while the agent is already in error", async () => {
    const first = await seedDeadRun({ processLossRetryCount: 1 });
    const heartbeat = makeHeartbeat();
    await heartbeat.reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 });

    // A second dead run for the same, already-errored agent (e.g. one that
    // was still in flight when the first was reaped) must not spam the feed.
    const secondRunId = randomUUID();
    const secondWakeupId = randomUUID();
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(agentWakeupRequests).values({
      id: secondWakeupId,
      companyId: first.companyId,
      agentId: first.agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: {},
      status: "claimed",
      runId: secondRunId,
      claimedAt: anHourAgo,
    });
    await db.insert(heartbeatRuns).values({
      id: secondRunId,
      companyId: first.companyId,
      agentId: first.agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "running",
      wakeupRequestId: secondWakeupId,
      contextSnapshot: {},
      processPid: 999_999_998,
      processGroupId: null,
      processLossRetryCount: 1,
      startedAt: anHourAgo,
      processStartedAt: anHourAgo,
      lastOutputAt: anHourAgo,
      updatedAt: new Date(),
    });

    await heartbeat.reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 });

    const errorNotices = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, first.companyId), eq(activityLog.action, "agent.entered_error")));
    expect(errorNotices).toHaveLength(1);
    const reapNotices = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, first.companyId), eq(activityLog.action, "heartbeat.run_reaped")));
    expect(reapNotices).toHaveLength(2);
  });
});

// DUR-3940 item 2 / run cap: the frozen-run watchdog's wording and its
// limit precedence (agent adapterConfig > instance setting > default).
describe("frozen-run watchdog wording and limits (DUR-3940 item 2)", () => {
  it("states the limit and what happens next on the run itself", () => {
    expect(buildFrozenRunErrorMessage({ reason: "too_long", limitMs: 150 * 60_000, retryQueued: true })).toBe(
      "Stopped after 2 hours 30 minutes with no result; it will be retried.",
    );
    expect(buildFrozenRunErrorMessage({ reason: "silent", limitMs: 45 * 60_000, retryQueued: true })).toBe(
      "Stopped after 45 minutes without any output; it will be retried.",
    );
    expect(buildFrozenRunErrorMessage({ reason: "silent", limitMs: 45 * 60_000, retryQueued: false })).toBe(
      "Stopped after 45 minutes without any output; this was already the retry, so the agent has been flagged for attention.",
    );
  });

  it("tells the operator why the run was stopped and what Paperclip did about it", () => {
    expect(
      buildStoppedRunOperatorNotice({
        agentName: "Backend Engineer",
        reason: "too_long",
        limitMs: 150 * 60_000,
        ranForMs: 155 * 60_000,
        silentForMs: 2 * 60_000,
        retryQueued: true,
        agentMarkedError: false,
      }),
    ).toBe(
      "Backend Engineer's run was stopped: it had been going for 2 hours 35 minutes without finishing (the limit is 2 hours 30 minutes). Paperclip ended it and queued a fresh run to pick the work up again.",
    );
    expect(
      buildStoppedRunOperatorNotice({
        agentName: "  ",
        reason: "silent",
        limitMs: 45 * 60_000,
        ranForMs: 80 * 60_000,
        silentForMs: 47 * 60_000,
        retryQueued: false,
        agentMarkedError: true,
      }),
    ).toBe(
      "An agent's run was stopped: its process was still running but had shown no output for 47 minutes (the limit is 45 minutes). Paperclip ended it. That was already the retry, so An agent is now marked as needing attention and will not take new work until someone clears the error.",
    );
    expect(
      buildStoppedRunOperatorNotice({
        agentName: "Scout",
        reason: "silent",
        limitMs: 45 * 60_000,
        ranForMs: null,
        silentForMs: 46 * 60_000,
        retryQueued: false,
        agentMarkedError: false,
      }),
    ).toBe(
      "Scout's run was stopped: its process was still running but had shown no output for 46 minutes (the limit is 45 minutes). Paperclip ended it. Scout is free to take work again.",
    );
  });

  it("resolves the limits: agent adapterConfig beats the instance setting, 0 switches a limit off, junk falls back", () => {
    const general = { maxRunDurationMinutes: 150, silentRunTimeoutMinutes: 45 };
    expect(resolveFrozenRunCaps({}, general)).toEqual({
      maxRunDurationMs: 150 * 60_000,
      silentRunTimeoutMs: 45 * 60_000,
    });
    expect(resolveFrozenRunCaps(null, { maxRunDurationMinutes: 90, silentRunTimeoutMinutes: 20 })).toEqual({
      maxRunDurationMs: 90 * 60_000,
      silentRunTimeoutMs: 20 * 60_000,
    });
    expect(resolveFrozenRunCaps({ maxRunDurationMinutes: 30, silentRunTimeoutMinutes: "15" }, general)).toEqual({
      maxRunDurationMs: 30 * 60_000,
      silentRunTimeoutMs: 15 * 60_000,
    });
    expect(resolveFrozenRunCaps({ maxRunDurationMinutes: 0, silentRunTimeoutMinutes: 0 }, general)).toEqual({
      maxRunDurationMs: 0,
      silentRunTimeoutMs: 0,
    });
    expect(resolveFrozenRunCaps({ maxRunDurationMinutes: "soon", silentRunTimeoutMinutes: -3 }, general)).toEqual({
      maxRunDurationMs: 150 * 60_000,
      silentRunTimeoutMs: 45 * 60_000,
    });
  });
});
