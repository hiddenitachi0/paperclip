import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Global concurrency test run.",
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

import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { runningProcesses } from "../adapters/index.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres global concurrency tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("heartbeat whole-instance concurrency ceiling (DUR-151)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-global-concurrency-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Global concurrency test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
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
    await db.delete(companies);
    await instanceSettingsService(db).updateGeneral({
      globalMaxConcurrentRuns: 4,
    });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyWithAgent(opts: { agentId: string; issueId: string; agentName: string }) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Paperclip ${opts.agentName}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: opts.agentId,
      companyId,
      name: opts.agentName,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      // Per-agent cap is generous so only the whole-instance cap binds below.
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 5 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: opts.issueId,
      companyId,
      title: `${opts.agentName} assignment`,
      status: "todo",
      priority: "high",
      assigneeAgentId: opts.agentId,
    });
    return companyId;
  }

  it("caps simultaneously running runs across different agents and queues the excess instead of losing it", async () => {
    await instanceSettingsService(db).updateGeneral({ globalMaxConcurrentRuns: 1 });

    const agentAId = randomUUID();
    const agentBId = randomUUID();
    const issueAId = randomUUID();
    const issueBId = randomUUID();

    let finishFirstRun!: () => void;
    const firstRunFinished = new Promise<void>((resolve) => {
      finishFirstRun = resolve;
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await firstRunFinished;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "First agent's run completed.",
        provider: "test",
        model: "test-model",
      };
    });

    await seedCompanyWithAgent({ agentId: agentAId, issueId: issueAId, agentName: "AgentA" });
    await seedCompanyWithAgent({ agentId: agentBId, issueId: issueBId, agentName: "AgentB" });

    try {
      const wakeA = await heartbeat.wakeup(agentAId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: issueAId },
        contextSnapshot: { issueId: issueAId, wakeReason: "issue_assigned" },
      });
      expect(wakeA).not.toBeNull();

      const firstRunStarted = await waitForCondition(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, wakeA!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "running";
      });
      expect(firstRunStarted).toBe(true);
      const firstAdapterStarted = await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 1, 30_000);
      expect(firstAdapterStarted).toBe(true);

      // Agent B has full per-agent headroom (maxConcurrentRuns: 5) but the
      // whole-instance cap (1) is already spent by Agent A's running run.
      const wakeB = await heartbeat.wakeup(agentBId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: issueBId },
        contextSnapshot: { issueId: issueBId, wakeReason: "issue_assigned" },
      });
      expect(wakeB).not.toBeNull();

      // Give the dispatcher a moment, then assert B stayed queued rather
      // than starting (and rather than being lost/failed).
      await new Promise((resolve) => setTimeout(resolve, 200));
      const secondRunWhileFirstRunning = await db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, wakeB!.id))
        .then((rows) => rows[0] ?? null);
      expect(secondRunWhileFirstRunning?.status).toBe("queued");
      expect(secondRunWhileFirstRunning?.errorCode).not.toBe("process_lost");
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);

      // A capacity-blocked queued run must never be mistaken for a lost
      // process by the watchdog reaper.
      await heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 });
      const afterReap = await db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, wakeB!.id))
        .then((rows) => rows[0] ?? null);
      expect(afterReap?.status).toBe("queued");
      expect(afterReap?.errorCode).not.toBe("process_lost");

      // Freeing Agent A's slot must let Agent B's queued run start, even
      // though it belongs to a different agent than the one that finished.
      finishFirstRun();

      const firstRunSucceeded = await waitForCondition(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, wakeA!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "succeeded";
      });
      expect(firstRunSucceeded).toBe(true);

      const secondRunSucceeded = await waitForCondition(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, wakeB!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "succeeded";
      }, 10_000);
      expect(secondRunSucceeded).toBe(true);
      expect(mockAdapterExecute.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      finishFirstRun();
    }
  }, 40_000);

  it("lets runs proceed immediately when under the whole-instance cap", async () => {
    await instanceSettingsService(db).updateGeneral({ globalMaxConcurrentRuns: 4 });

    const agentId = randomUUID();
    const issueId = randomUUID();
    await seedCompanyWithAgent({ agentId, issueId, agentName: "AgentSolo" });

    const wake = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    expect(wake).not.toBeNull();

    const succeeded = await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, wake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });
    expect(succeeded).toBe(true);
  }, 20_000);
});
