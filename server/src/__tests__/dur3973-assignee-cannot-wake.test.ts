import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
  companySkills,
  costEvents,
  createDb,
  documents,
  environmentLeases,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issueAttachments,
  issueComments,
  issueDocuments,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import {
  ASSIGNEE_UNAVAILABLE_NOTICE_ACTION,
  ASSIGNEE_UNAVAILABLE_REASONS,
  ASSIGNEE_UNAVAILABLE_RECORDED_ACTION,
} from "@paperclipai/shared";
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
    summary: "done",
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
import { classifyAssigneePickup, readHeartbeatWakeFlags } from "../services/assignee-pickup.ts";
import { evaluateAgentInvokability, evaluateAgentInvokabilityFromDb } from "../services/agent-invokability.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { loadFleetWaitingOnUnavailableAgents, summarizeFleetHealth, computeFleetSlotUsage } from "../services/fleet-health.ts";
import {
  buildAssigneeUnavailableNotice,
  buildAssigneeUnavailableTaskSentence,
  buildFleetWaitingOnUnavailableAgentsNote,
  describeAssigneeUnavailableFix,
} from "../services/operator-notices.ts";

// DUR-3973. NOR-1289 was assigned on 5 Sep to "Automations", an agent
// switched off since the 25 Aug wind-down (heartbeat enabled=false,
// wakeOnDemand=false). The recovery sweep queued a wake-up for it every ~30
// seconds, the heartbeat rejected each one, and in five days that one task
// produced 10,178 rejected wake-up rows -- and not a single word to the
// operator, who found out by asking.

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SWITCHED_OFF = { heartbeat: { enabled: false, wakeOnDemand: false } };
const QUIET_MODE_OFF = { active: false, snapshot: null };

function agentRow(overrides: Partial<{ id: string; status: string; pauseReason: string | null; runtimeConfig: unknown }> = {}) {
  return { id: "agent-1", status: "idle", pauseReason: null, runtimeConfig: {}, ...overrides };
}

function orgRow(id: string, status: string, reportsTo: string | null = null) {
  return { id, companyId: "company-1", name: id, reportsTo, status };
}

describe("classifyAssigneePickup (DUR-3973)", () => {
  const invokable = { invokable: true } as const;

  it("an agent with default settings is woken on demand", () => {
    expect(
      classifyAssigneePickup({ agent: agentRow(), invokability: invokable, companyActive: true, quietMode: QUIET_MODE_OFF }),
    ).toEqual({ kind: "wake_on_demand" });
  });

  it("the NOR-1289 shape: heartbeat and wake-on-demand both off is switched off", () => {
    expect(
      classifyAssigneePickup({
        agent: agentRow({ runtimeConfig: SWITCHED_OFF }),
        invokability: invokable,
        companyActive: true,
        quietMode: QUIET_MODE_OFF,
      }),
    ).toEqual({ kind: "unavailable", reason: "switched_off" });
  });

  it("an agent with only its timer on is left to its timer (it does pick the work up)", () => {
    expect(
      classifyAssigneePickup({
        agent: agentRow({ runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300, wakeOnDemand: false } } }),
        invokability: invokable,
        companyActive: true,
        quietMode: QUIET_MODE_OFF,
      }),
    ).toEqual({ kind: "on_timer" });
  });

  it("a timer that is 'on' with no interval never ticks, so that agent is switched off", () => {
    expect(
      classifyAssigneePickup({
        agent: agentRow({ runtimeConfig: { heartbeat: { enabled: true, intervalSec: 0, wakeOnDemand: false } } }),
        invokability: invokable,
        companyActive: true,
        quietMode: QUIET_MODE_OFF,
      }),
    ).toEqual({ kind: "unavailable", reason: "switched_off" });
  });

  it("reads the legacy wake-on-assignment spelling the same way the heartbeat does", () => {
    expect(readHeartbeatWakeFlags({ heartbeat: { wakeOnAssignment: false } }).wakeOnDemand).toBe(false);
    expect(readHeartbeatWakeFlags({ heartbeat: { wakeOnDemand: "false" } }).wakeOnDemand).toBe(true);
    expect(readHeartbeatWakeFlags(null)).toEqual({ enabled: false, intervalSec: 0, wakeOnDemand: true });
  });

  it("names why a non-invokable agent cannot take the work", () => {
    const classify = (status: string, pauseReason: string | null = null, companyAgents = [orgRow("agent-1", status)]) =>
      classifyAssigneePickup({
        agent: agentRow({ status, pauseReason }),
        invokability: evaluateAgentInvokability(companyAgents[0]!, companyAgents),
        companyActive: true,
        quietMode: QUIET_MODE_OFF,
      });
    expect(classify("paused")).toEqual({ kind: "unavailable", reason: "paused" });
    expect(classify("paused", "budget")).toEqual({ kind: "unavailable", reason: "paused_for_budget" });
    expect(classify("terminated")).toEqual({ kind: "unavailable", reason: "terminated" });
    expect(classify("pending_approval")).toEqual({ kind: "unavailable", reason: "pending_approval" });
    expect(
      classify("idle", null, [orgRow("agent-1", "idle", "boss"), orgRow("boss", "terminated")]),
    ).toEqual({ kind: "unavailable", reason: "reporting_line_broken" });
  });

  it("a paused or archived company is silent, including the agents archiving paused", () => {
    const paused = { invokable: false as const, reason: "paused" as const, message: "", details: {}, invalidOrgChain: false };
    expect(
      classifyAssigneePickup({ agent: agentRow({ status: "paused" }), invokability: paused, companyActive: false, quietMode: QUIET_MODE_OFF }),
    ).toEqual({ kind: "company_inactive" });
    expect(
      classifyAssigneePickup({
        agent: agentRow({ status: "paused", pauseReason: "company_archived" }),
        invokability: paused,
        companyActive: true,
        quietMode: QUIET_MODE_OFF,
      }),
    ).toEqual({ kind: "company_inactive" });
  });

  describe("quiet mode switches every agent's flags off most nights -- that must never read as 'switched off'", () => {
    const quietOffFlags = agentRow({ runtimeConfig: SWITCHED_OFF });

    it("an agent that was on before quiet mode is held by quiet mode", () => {
      expect(
        classifyAssigneePickup({
          agent: quietOffFlags,
          invokability: invokable,
          companyActive: true,
          quietMode: { active: true, snapshot: [{ agentId: "agent-1", companyId: "c", enabled: false, wakeOnDemand: true }] },
        }),
      ).toEqual({ kind: "held_by_quiet_mode" });
    });

    it("an agent that was already switched off before quiet mode is still switched off", () => {
      expect(
        classifyAssigneePickup({
          agent: quietOffFlags,
          invokability: invokable,
          companyActive: true,
          quietMode: { active: true, snapshot: [{ agentId: "agent-1", companyId: "c", enabled: false, wakeOnDemand: false }] },
        }),
      ).toEqual({ kind: "unavailable", reason: "switched_off" });
    });

    it("an agent created during quiet mode keeps its own flags", () => {
      expect(
        classifyAssigneePickup({ agent: quietOffFlags, invokability: invokable, companyActive: true, quietMode: { active: true, snapshot: [] } }),
      ).toEqual({ kind: "unavailable", reason: "switched_off" });
    });

    it("quiet mode with no snapshot to compare against is quiet mode's doing", () => {
      expect(
        classifyAssigneePickup({ agent: quietOffFlags, invokability: invokable, companyActive: true, quietMode: { active: true, snapshot: null } }),
      ).toEqual({ kind: "held_by_quiet_mode" });
    });

    it("if quiet mode cannot be read, nothing is dispatched and nothing is claimed", () => {
      expect(
        classifyAssigneePickup({ agent: quietOffFlags, invokability: invokable, companyActive: true, quietMode: null }),
      ).toEqual({ kind: "cannot_wake_unconfirmed" });
    });
  });
});

describe("waiting-task wording (DUR-3973)", () => {
  it("names the task, the agent, why, and what to do -- in one plain sentence", () => {
    expect(
      buildAssigneeUnavailableTaskSentence({
        task: { identifier: "NOR-1289", title: "Add a supplier filter" },
        agentName: "Automations",
        reason: "switched_off",
      }),
    ).toBe(
      'NOR-1289 "Add a supplier filter" is assigned to Automations, but Automations is switched off ' +
        '("Heartbeat on interval" and "Wake on demand" are both off in its settings), so nobody will start it. ' +
        'Switch Automations back on (turn on "Wake on demand" in its settings), or give the task to another agent.',
    );
  });

  it("never tells the operator to switch on an agent that cannot be switched on", () => {
    expect(describeAssigneeUnavailableFix("Old Bot", "terminated", 1)).toBe("Give the task to another agent.");
    expect(describeAssigneeUnavailableFix("Old Bot", "unknown_status", 2)).toBe("Give the tasks to another agent.");
  });

  it.each(ASSIGNEE_UNAVAILABLE_REASONS)("has a plain sentence for %s with no internal code or id in it", (reason) => {
    const sentence = buildAssigneeUnavailableTaskSentence({ task: { identifier: "NOR-7", title: "Task" }, agentName: "CEO", reason });
    expect(sentence).not.toContain(reason.includes("_") ? reason : " ");
    expect(sentence).not.toContain("_");
    expect(sentence).not.toMatch(UUID_PATTERN);
    expect(sentence).toContain("CEO");
    expect(sentence).toContain("NOR-7");
  });

  it("a backlog on one agent is ONE line with a few task keys, not one alarm per task", () => {
    const entries = [1, 2, 3, 4, 5].map((n) => ({
      task: { identifier: `DUR-${n}`, title: `Task ${n}` },
      agentId: "ceo",
      agentName: "CEO",
      reason: "paused" as const,
    }));
    expect(buildAssigneeUnavailableNotice(entries)).toBe(
      "5 tasks are assigned to CEO, but CEO is paused, so nobody will start them: DUR-1, DUR-2, DUR-3 and 2 more. " +
        "Resume CEO, or give the tasks to another agent. If that is deliberate, nothing needs doing.",
    );
  });

  it("several agents read as counts per agent, and a terminated one is not offered a switch", () => {
    const message = buildAssigneeUnavailableNotice([
      { task: { identifier: "NOR-1", title: "a" }, agentId: "a", agentName: "Automations", reason: "switched_off" },
      { task: { identifier: "NOR-2", title: "b" }, agentId: "o", agentName: "Old Bot", reason: "terminated" },
      { task: { identifier: "NOR-3", title: "c" }, agentId: "o", agentName: "Old Bot", reason: "terminated" },
    ]);
    expect(message).toBe(
      "3 tasks are waiting on agents that cannot pick them up, so nobody will start them: " +
        "Old Bot (terminated, 2 tasks), Automations (switched off, 1 task). " +
        "Switch those agents back on, or give their tasks to other agents. " +
        "A terminated agent cannot be switched back on, so its tasks need another agent.",
    );
  });

  it("the fleet strip line is informational and never raises the level on its own", () => {
    const runs = {
      windowMinutes: 15, startedInWindow: 3, succeededInWindow: 3, failedInWindow: 0, cancelledInWindow: 0,
      running: 1, queued: 0, queuedWithNoRunningAgent: 0, oldestQueuedWaitMs: null, zombieCandidates: 0, zombieSilenceMinutes: 30,
    };
    const summary = summarizeFleetHealth({
      runs,
      slots: computeFleetSlotUsage(4, 1),
      agents: { inError: 0, inErrorSample: [] },
      scheduler: {
        enabled: true, intervalMs: 30_000, lastTickStartedAt: null, lastTickFinishedAt: null,
        lastTickResult: null, lastTickError: null, sinceLastTickMs: 1_000, stale: false,
      },
      requests: {
        inFlight: 0, streaming: 0, peakInFlight: 0, peakInFlightAt: null, longestInFlightMs: 0, slowInFlight: 0,
        slowThresholdMs: 10_000, overloadThreshold: 50, overloaded: false, totalStarted: 0, totalFinished: 0,
      },
      database: { available: true, poolMax: 20, connections: 2, active: 1, idleInTransaction: 0, waitingOnLocks: 0 },
      quietMode: { active: false, activatedAt: null, activeForMs: null, activatedReason: null, stuckAfterMinutes: 30, stuck: false, activatedForDeploy: false },
      waitingOnUnavailableAgents: {
        tasks: 12,
        agents: 6,
        sample: [
          { id: "1", name: "CEO", companyId: "d", tasks: 5, reason: "paused", urlKey: "ceo", reasonText: "Paused, with 5 tasks waiting. Resume CEO, or give the tasks to another agent." },
          { id: "2", name: "CTO", companyId: "d", tasks: 3, reason: "paused", urlKey: "cto", reasonText: "Paused, with 3 tasks waiting. Resume CTO, or give the tasks to another agent." },
        ],
      },
    });
    expect(summary.level).toBe("ok");
    expect(summary.notes).toContain(
      buildFleetWaitingOnUnavailableAgentsNote({
        tasks: 12,
        agents: 6,
        sample: [
          { agentName: "CEO", reason: "paused", tasks: 5 },
          { agentName: "CTO", reason: "paused", tasks: 3 },
        ],
      }),
    );
    expect(summary.notes.join("\n")).toContain(
      "12 open tasks are assigned to agents that cannot pick them up, so nobody will start them: " +
        "CEO (paused, 5 tasks), CTO (paused, 3 tasks) and 4 more agents.",
    );
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("recovery sweep with an assignee that cannot be woken (DUR-3973)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dur3973-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  const cleanupTables = [
    activityLog,
    heartbeatRunEvents,
    workspaceOperations,
    environmentLeases,
    issueComments,
    issueAttachments,
    issueDocuments,
    documents,
    costEvents,
    heartbeatRuns,
    agentWakeupRequests,
    executionWorkspaces,
    issues,
    companySkills,
    agentRuntimeState,
    agents,
    instanceSettings,
    companies,
  ];

  async function waitForNoActiveRuns(timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["queued", "running"]));
      if (active.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  afterEach(async () => {
    await waitForNoActiveRuns();
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (let pass = 0; pass < 8; pass += 1) {
      let failed: unknown = null;
      for (const table of cleanupTables) {
        try {
          await db.delete(table);
        } catch (error) {
          failed = error;
        }
      }
      if (!failed) return;
      if (pass === 7) throw failed;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(input: { name?: string; status?: string } = {}) {
    const companyId = randomUUID();
    const prefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: input.name ?? "Nordstrand",
      status: input.status ?? "active",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    return { companyId, prefix, nextIssueNumber: 1 };
  }

  async function seedAgent(
    companyId: string,
    input: { name: string; status?: string; pauseReason?: string | null; runtimeConfig?: Record<string, unknown>; lastHeartbeatAt?: Date },
  ) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: input.name,
      role: "engineer",
      status: input.status ?? "idle",
      pauseReason: input.pauseReason ?? null,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: input.runtimeConfig ?? {},
      permissions: {},
      lastHeartbeatAt: input.lastHeartbeatAt ?? null,
    });
    return id;
  }

  async function seedIssue(
    company: { companyId: string; prefix: string; nextIssueNumber: number },
    agentId: string | null,
    input: { title: string; status?: string; hidden?: boolean; checkoutRunId?: string | null },
  ) {
    const id = randomUUID();
    const number = company.nextIssueNumber;
    company.nextIssueNumber += 1;
    await db.insert(issues).values({
      id,
      companyId: company.companyId,
      title: input.title,
      status: input.status ?? "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      issueNumber: number,
      identifier: `${company.prefix}-${number}`,
      hiddenAt: input.hidden ? new Date() : null,
      checkoutRunId: input.checkoutRunId ?? null,
      startedAt: input.status === "in_progress" ? new Date("2026-09-05T10:00:00.000Z") : null,
    });
    return { id, identifier: `${company.prefix}-${number}` };
  }

  async function wakeRowsFor(agentId: string) {
    return db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
  }

  async function notices() {
    return db.select().from(activityLog).where(eq(activityLog.action, ASSIGNEE_UNAVAILABLE_NOTICE_ACTION));
  }

  async function records() {
    return db.select().from(activityLog).where(eq(activityLog.action, ASSIGNEE_UNAVAILABLE_RECORDED_ACTION));
  }

  it("NOR-1289: stops re-dispatching to a switched-off agent and tells the operator exactly once, in plain words", async () => {
    const company = await seedCompany();
    const agentId = await seedAgent(company.companyId, { name: "Automations", runtimeConfig: SWITCHED_OFF });
    const task = await seedIssue(company, agentId, { title: "Add a supplier filter" });

    const first = await heartbeatService(db).reconcileStrandedAssignedIssues();
    expect(first.assignmentDispatched).toBe(0);
    expect(first.assigneeUnavailableNoticed).toBe(1);

    const heartbeat = heartbeatService(db);
    for (let sweep = 0; sweep < 4; sweep += 1) {
      const next = await heartbeat.reconcileStrandedAssignedIssues();
      expect(next.assignmentDispatched).toBe(0);
      expect(next.assigneeUnavailableNoticed).toBe(0);
    }

    // Five sweeps used to be five rejected wake-up rows ("heartbeat.wakeOnDemand.disabled").
    expect(await wakeRowsFor(agentId)).toEqual([]);

    const written = await notices();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      companyId: company.companyId,
      actorType: "system",
      entityType: "issue",
      entityId: task.id,
      agentId,
    });
    const message = (written[0]!.details as Record<string, unknown>).message as string;
    expect(message).toBe(
      `${task.identifier} "Add a supplier filter" is assigned to Automations, but Automations is switched off ` +
        '("Heartbeat on interval" and "Wake on demand" are both off in its settings), so nobody will start it. ' +
        'Switch Automations back on (turn on "Wake on demand" in its settings), or give the task to another agent.',
    );
    expect(message).not.toMatch(UUID_PATTERN);

    // Nothing reassigned, nothing moved.
    const [after] = await db.select().from(issues).where(eq(issues.id, task.id));
    expect(after).toMatchObject({ assigneeAgentId: agentId, status: "todo" });
  });

  it("picks the task up on the very next sweep once the agent is switched back on", async () => {
    const company = await seedCompany();
    const agentId = await seedAgent(company.companyId, { name: "Automations", runtimeConfig: SWITCHED_OFF });
    await seedIssue(company, agentId, { title: "Add a supplier filter" });
    const heartbeat = heartbeatService(db);

    expect((await heartbeat.reconcileStrandedAssignedIssues()).assignmentDispatched).toBe(0);

    await db
      .update(agents)
      .set({ runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } })
      .where(eq(agents.id, agentId));
    const next = await heartbeat.reconcileStrandedAssignedIssues();
    expect(next.assignmentDispatched).toBe(1);

    // One accepted wake-up -- and no rejected one left behind from the switched-off sweep.
    const rows = await wakeRowsFor(agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "issue_assigned" });
    expect(rows[0]!.status).not.toBe("skipped");
    await waitForNoActiveRuns();
  });

  it("stops the same storm on in-progress work whose run died (continuation retries)", async () => {
    const company = await seedCompany();
    const agentId = await seedAgent(company.companyId, { name: "Automations", runtimeConfig: SWITCHED_OFF });
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const task = await seedIssue(company, agentId, { title: "Half-done import", status: "in_progress" });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: company.companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: task.id },
      status: "failed",
      runId,
      finishedAt: new Date("2026-09-05T10:05:00.000Z"),
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: company.companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      wakeupRequestId,
      contextSnapshot: { issueId: task.id, taskId: task.id, wakeReason: "issue_assigned" },
      startedAt: new Date("2026-09-05T10:00:00.000Z"),
      finishedAt: new Date("2026-09-05T10:05:00.000Z"),
      errorCode: "process_lost",
      error: "run failed before issue advanced",
    });
    await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, task.id));

    const heartbeat = heartbeatService(db);
    for (let sweep = 0; sweep < 3; sweep += 1) {
      const result = await heartbeat.reconcileStrandedAssignedIssues();
      expect(result.continuationRequeued).toBe(0);
    }
    // Only the seeded row: no rejected continuation wake-up per sweep.
    expect(await wakeRowsFor(agentId)).toHaveLength(1);
    expect(await notices()).toHaveLength(1);
  });

  it("a deliberately paused fleet with a backlog gets ONE line, never repeated, and the fleet count agrees with it", async () => {
    const durkan = await seedCompany({ name: "Durkan" });
    const ceo = await seedAgent(durkan.companyId, { name: "CEO", status: "paused", pauseReason: "manual" });
    const cto = await seedAgent(durkan.companyId, { name: "CTO", status: "paused", pauseReason: "manual" });
    await seedAgent(durkan.companyId, { name: "Designer", status: "paused", pauseReason: "manual" });
    const waiting = [
      await seedIssue(durkan, ceo, { title: "Plan Q4" }),
      await seedIssue(durkan, ceo, { title: "Hire a writer" }),
      await seedIssue(durkan, ceo, { title: "Review pricing", status: "in_progress" }),
      await seedIssue(durkan, cto, { title: "Upgrade database" }),
      await seedIssue(durkan, cto, { title: "Rotate keys" }),
    ];
    // Not waiting on anyone: finished, blocked, or hidden.
    await seedIssue(durkan, ceo, { title: "Old work", status: "done" });
    await seedIssue(durkan, cto, { title: "Waiting on a vendor", status: "blocked" });
    await seedIssue(durkan, cto, { title: "Hidden draft", hidden: true });

    const heartbeat = heartbeatService(db);
    const first = await heartbeat.reconcileStrandedAssignedIssues();
    expect(first.assigneeUnavailableNoticed).toBe(5);

    const written = await notices();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ entityType: "company", entityId: durkan.companyId, agentId: null });
    expect((written[0]!.details as Record<string, unknown>).message).toBe(
      "5 tasks are waiting on agents that cannot pick them up, so nobody will start them: " +
        "CEO (paused, 3 tasks), CTO (paused, 2 tasks). " +
        "Switch those agents back on, or give their tasks to other agents. If that is deliberate, nothing needs doing.",
    );
    const perTask = await records();
    expect(perTask.map((row) => row.entityId).sort()).toEqual(waiting.map((task) => task.id).sort());

    // Later sweeps, and a restarted server, say nothing more.
    await heartbeat.reconcileStrandedAssignedIssues();
    await heartbeat.reconcileStrandedAssignedIssues();
    expect((await heartbeatService(db).reconcileStrandedAssignedIssues()).assigneeUnavailableNoticed).toBe(0);
    expect(await notices()).toHaveLength(1);
    expect(await records()).toHaveLength(5);

    // A NEW task given to a paused agent is the surprise case: one line, for that task.
    const fresh = await seedIssue(durkan, ceo, { title: "Answer the auditor" });
    const afterAssign = await heartbeat.reconcileStrandedAssignedIssues();
    expect(afterAssign.assigneeUnavailableNoticed).toBe(1);
    const allNotices = await notices();
    expect(allNotices).toHaveLength(2);
    expect(allNotices.find((row) => row.entityId === fresh.id)).toBeDefined();

    // Nothing was ever dispatched to them.
    expect(await db.select().from(agentWakeupRequests)).toEqual([]);

    // The at-a-glance count reads the same classifier and agrees.
    const fleet = await loadFleetWaitingOnUnavailableAgents(db, (await instanceSettingsService(db).getGeneral()).quietMode);
    // DUR-4001: each row also carries the key its page is linked with and one
    // plain line, so the Now page can name the agent and say what to do.
    expect(fleet).toEqual({
      tasks: 6,
      agents: 2,
      sample: [
        {
          id: ceo,
          name: "CEO",
          companyId: durkan.companyId,
          tasks: 4,
          reason: "paused",
          urlKey: "ceo",
          reasonText: "Paused, with 4 tasks waiting. Resume CEO, or give the tasks to another agent.",
        },
        {
          id: cto,
          name: "CTO",
          companyId: durkan.companyId,
          tasks: 2,
          reason: "paused",
          urlKey: "cto",
          reasonText: "Paused, with 2 tasks waiting. Resume CTO, or give the tasks to another agent.",
        },
      ],
    });
  });

  it("the nightly quiet mode is silent: no dispatch storm, no 'switched off' notices, and work resumes after", async () => {
    const company = await seedCompany();
    const writer = await seedAgent(company.companyId, { name: "Writer" });
    const automations = await seedAgent(company.companyId, { name: "Automations", runtimeConfig: SWITCHED_OFF });
    const writerTask = await seedIssue(company, writer, { title: "Write the newsletter" });
    const automationsTask = await seedIssue(company, automations, { title: "Add a supplier filter" });

    const settings = instanceSettingsService(db);
    await settings.activateQuietMode({ actorType: "user", actorId: "filip", agentId: null });

    const heartbeat = heartbeatService(db);
    for (let sweep = 0; sweep < 3; sweep += 1) await heartbeat.reconcileStrandedAssignedIssues();

    // Quiet mode switched Writer's flags off; the sweep used to queue (and
    // have rejected) a wake-up for its task on every pass all night.
    expect(await wakeRowsFor(writer)).toEqual([]);
    // Automations was switched off BEFORE quiet mode, so that one is true and said once.
    const written = await notices();
    expect(written.map((row) => row.entityId)).toEqual([automationsTask.id]);
    expect(written.some((row) => row.entityId === writerTask.id)).toBe(false);

    const fleetDuringQuiet = await loadFleetWaitingOnUnavailableAgents(db, (await settings.getGeneral()).quietMode);
    expect(fleetDuringQuiet.tasks).toBe(1);
    expect(fleetDuringQuiet.sample.map((row) => row.name)).toEqual(["Automations"]);

    await settings.deactivateQuietMode({ actorType: "user", actorId: "filip", agentId: null });
    const morning = await heartbeat.reconcileStrandedAssignedIssues();
    expect(morning.assignmentDispatched).toBe(1);
    expect(await wakeRowsFor(writer)).toHaveLength(1);
    expect(await wakeRowsFor(automations)).toEqual([]);
    expect(await notices()).toHaveLength(1);
    await waitForNoActiveRuns();
  });

  it("a timer-only agent is not re-dispatched and not reported, because its own timer does pick the work up", async () => {
    const company = await seedCompany();
    const reporter = await seedAgent(company.companyId, {
      name: "Nightly Reporter",
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300, wakeOnDemand: false } },
      lastHeartbeatAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await seedIssue(company, reporter, { title: "Weekly numbers" });

    const heartbeat = heartbeatService(db);
    for (let sweep = 0; sweep < 3; sweep += 1) await heartbeat.reconcileStrandedAssignedIssues();
    expect(await wakeRowsFor(reporter)).toEqual([]);
    expect(await notices()).toEqual([]);

    // The silence is honest: the timer tick wakes it.
    const tick = await heartbeat.tickTimers(new Date());
    expect(tick.enqueued).toBe(1);
    const rows = await wakeRowsFor(reporter);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "timer" });
    expect(rows[0]!.status).not.toBe("skipped");
    await waitForNoActiveRuns();
  });

  // Two lists that must agree: the sweep's "can this agent be woken now?"
  // and the heartbeat's own wake gate. A false "cannot" would hold real work
  // AND tell the operator something untrue; a false "can" is the retry storm.
  // So drive the REAL enqueueWakeup for every setup and compare.
  it.each([
    { label: "default settings", runtimeConfig: {} },
    { label: "wake on demand on, timer off", runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } },
    { label: "switched off", runtimeConfig: SWITCHED_OFF },
    { label: "timer only", runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300, wakeOnDemand: false } } },
    { label: "timer on with no interval", runtimeConfig: { heartbeat: { enabled: true, intervalSec: 0, wakeOnDemand: false } } },
    { label: "legacy wakeOnAssignment off", runtimeConfig: { heartbeat: { wakeOnAssignment: false } } },
    { label: "non-boolean wakeOnDemand", runtimeConfig: { heartbeat: { wakeOnDemand: "false" } } },
    { label: "paused", status: "paused" },
    { label: "paused by budget", status: "paused", pauseReason: "budget" },
    { label: "terminated", status: "terminated" },
    { label: "pending approval", status: "pending_approval" },
    { label: "archived company", companyStatus: "archived" },
  ])("agrees with the real wake gate: $label", async (setup: {
    label: string;
    runtimeConfig?: Record<string, unknown>;
    status?: string;
    pauseReason?: string;
    companyStatus?: string;
  }) => {
    const company = await seedCompany({ status: setup.companyStatus ?? "active" });
    const agentId = await seedAgent(company.companyId, {
      name: "Probe",
      status: setup.status,
      pauseReason: setup.pauseReason ?? null,
      runtimeConfig: setup.runtimeConfig,
    });
    const task = await seedIssue(company, agentId, { title: "Probe task" });
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const pickup = classifyAssigneePickup({
      agent: agent!,
      invokability: await evaluateAgentInvokabilityFromDb(db, agent!),
      companyActive: (setup.companyStatus ?? "active") === "active",
      quietMode: QUIET_MODE_OFF,
    });

    const heartbeat = heartbeatService(db);
    let accepted = false;
    try {
      const run = await heartbeat.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: task.id, mutation: "assigned_todo_liveness_dispatch" },
        requestedByActorType: "system",
        requestedByActorId: null,
        contextSnapshot: { issueId: task.id, taskId: task.id, wakeReason: "issue_assigned", source: "issue.assigned_todo_liveness_dispatch" },
      });
      accepted = run !== null;
    } catch {
      accepted = false;
    }
    expect({ label: setup.label, accepted }).toEqual({ label: setup.label, accepted: pickup.kind === "wake_on_demand" });
    await waitForNoActiveRuns();
  });

  it("never counts a hidden, finished or user-assigned task, or an agent in an archived company", async () => {
    const archived = await seedCompany({ name: "Old Co", status: "archived" });
    const archivedAgent = await seedAgent(archived.companyId, { name: "Ghost", status: "paused", pauseReason: "company_archived" });
    await seedIssue(archived, archivedAgent, { title: "Left behind" });
    const live = await seedCompany();
    const off = await seedAgent(live.companyId, { name: "Automations", runtimeConfig: SWITCHED_OFF });
    await seedIssue(live, off, { title: "Hidden", hidden: true });
    await seedIssue(live, off, { title: "Done", status: "done" });
    const counted = await seedIssue(live, off, { title: "Counted" });

    const heartbeat = heartbeatService(db);
    await heartbeat.reconcileStrandedAssignedIssues();
    expect((await notices()).map((row) => row.entityId)).toEqual([counted.id]);
    const fleet = await loadFleetWaitingOnUnavailableAgents(db, (await instanceSettingsService(db).getGeneral()).quietMode);
    expect(fleet.tasks).toBe(1);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, archived.companyId)))).toEqual([]);
  });
});
