import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Instance concurrency test run.",
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
    `Skipping embedded Postgres heartbeat instance-concurrency tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

describeEmbeddedPostgres("heartbeat instance-wide concurrency ceiling", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-instance-concurrency-");
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
      summary: "Instance concurrency test run.",
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
    await db.delete(instanceSettings);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("caps total running runs across two companies below the sum of their per-agent limits", async () => {
    await instanceSettingsService(db).updateGeneral({ instanceConcurrencyCap: 1 });

    const companyAId = randomUUID();
    const companyBId = randomUUID();
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
        summary: "First company run completed.",
        provider: "test",
        model: "test-model",
      };
    });

    await db.insert(companies).values([
      {
        id: companyAId,
        name: "Company A",
        issuePrefix: `A${companyAId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: companyBId,
        name: "Company B",
        issuePrefix: `B${companyBId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    // Each agent's own per-agent limit is generous (5) -- proves the
    // instance-wide cap, not the per-agent one, is what holds the second
    // company's run back.
    await db.insert(agents).values([
      {
        id: agentAId,
        companyId: companyAId,
        name: "AgentA",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 5 } },
        permissions: {},
      },
      {
        id: agentBId,
        companyId: companyBId,
        name: "AgentB",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 5 } },
        permissions: {},
      },
    ]);
    await db.insert(issues).values([
      {
        id: issueAId,
        companyId: companyAId,
        title: "Company A work",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentAId,
      },
      {
        id: issueBId,
        companyId: companyBId,
        title: "Company B work",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentBId,
      },
    ]);

    try {
      const wakeA = await heartbeat.wakeup(agentAId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: issueAId },
        contextSnapshot: { issueId: issueAId, wakeReason: "issue_assigned" },
      });
      expect(wakeA).not.toBeNull();
      await db.insert(issueComments).values({
        companyId: companyAId,
        issueId: issueAId,
        authorAgentId: agentAId,
        authorType: "agent",
        createdByRunId: wakeA!.id,
        body: "Company A run completed.",
      });

      const runAStarted = await waitForCondition(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, wakeA!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "running";
      });
      expect(runAStarted).toBe(true);
      const adapterAStarted = await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 1, 30_000);
      expect(adapterAStarted).toBe(true);

      const wakeB = await heartbeat.wakeup(agentBId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: issueBId },
        contextSnapshot: { issueId: issueBId, wakeReason: "issue_assigned" },
      });
      expect(wakeB).not.toBeNull();
      await db.insert(issueComments).values({
        companyId: companyBId,
        issueId: issueBId,
        authorAgentId: agentBId,
        authorType: "agent",
        createdByRunId: wakeB!.id,
        body: "Company B run completed.",
      });

      // Company B's own agent has plenty of per-agent headroom (5), but the
      // instance cap (1) is already spent by company A's running run -- B's
      // run must stay queued, not be spawned and risk getting lost.
      const runBStaysQueued = await waitForCondition(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status, capacityWaitSince: heartbeatRuns.capacityWaitSince })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, wakeB!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "queued" && run.capacityWaitSince !== null;
      }, 2_000);
      expect(runBStaysQueued).toBe(true);
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);

      finishFirstRun();

      const runASucceeded = await waitForCondition(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, wakeA!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "succeeded";
      });
      expect(runASucceeded).toBe(true);

      // Once the instance frees up, B's run is claimed and its capacity-wait
      // marker is cleared -- distinguishing "was waiting, now running" from
      // "still waiting".
      const runBClaimed = await waitForCondition(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status, capacityWaitSince: heartbeatRuns.capacityWaitSince })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, wakeB!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "succeeded" && run.capacityWaitSince === null;
      }, 10_000);
      expect(runBClaimed).toBe(true);
      expect(mockAdapterExecute.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      finishFirstRun();
    }
  }, 40_000);
});
