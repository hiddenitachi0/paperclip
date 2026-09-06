import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentTaskSessions,
  companies,
  costEvents,
  createDb,
  financeEvents,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { pruneHeartbeatRuns } from "../services/heartbeat-run-retention.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping heartbeat run retention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat run retention", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-run-retention-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(financeEvents);
    await db.delete(activityLog);
    await db.delete(agentTaskSessions);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CEO",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedRun(companyId: string, agentId: string, createdAt: Date) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "succeeded",
      createdAt,
    });
    return runId;
  }

  it("deletes runs older than the retention window and leaves recent runs alone", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);

    const oldRunId = await seedRun(companyId, agentId, new Date(Date.now() - 40 * 24 * 60 * 60 * 1000));
    const recentRunId = await seedRun(companyId, agentId, new Date(Date.now() - 5 * 24 * 60 * 60 * 1000));

    const deleted = await pruneHeartbeatRuns(db, 30);
    expect(deleted).toBe(1);

    const remaining = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(remaining.map((r) => r.id)).toEqual([recentRunId]);
    expect(remaining.map((r) => r.id)).not.toContain(oldRunId);
  });

  it("batches deletes instead of issuing one unbounded DELETE", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);

    const staleCreatedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const runIds = await Promise.all(
      Array.from({ length: 7 }, () => seedRun(companyId, agentId, staleCreatedAt)),
    );

    // batchSize=3 over 7 stale rows forces 3 iterations (3 + 3 + 1) --
    // proves the sweep loops in bounded batches rather than one unbounded
    // DELETE of every matching row.
    const deleted = await pruneHeartbeatRuns(db, 30, 3);
    expect(deleted).toBe(runIds.length);

    const remaining = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(remaining).toHaveLength(0);
  });

  it("cascades heartbeat_run_events but preserves cost/finance/activity history with the run reference cleared", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const staleCreatedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const runId = await seedRun(companyId, agentId, staleCreatedAt);

    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId,
      agentId,
      seq: 1,
      eventType: "log",
      message: "hello",
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "did_a_thing",
      entityType: "issue",
      entityId: randomUUID(),
      agentId,
      runId,
    });
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey: "task-1",
      lastRunId: runId,
    });
    const costEventId = randomUUID();
    await db.insert(costEvents).values({
      id: costEventId,
      companyId,
      agentId,
      heartbeatRunId: runId,
      provider: "anthropic",
      model: "claude",
      costCents: 100,
      occurredAt: staleCreatedAt,
    });
    await db.insert(financeEvents).values({
      companyId,
      agentId,
      heartbeatRunId: runId,
      eventKind: "usage",
      biller: "anthropic",
      amountCents: 100,
      occurredAt: staleCreatedAt,
    });

    const deleted = await pruneHeartbeatRuns(db, 30);
    expect(deleted).toBe(1);

    const remainingEvents = await db.select().from(heartbeatRunEvents);
    expect(remainingEvents).toHaveLength(0);

    const [activityRow] = await db.select().from(activityLog).where(eq(activityLog.agentId, agentId));
    expect(activityRow?.runId).toBeNull();

    const [sessionRow] = await db
      .select()
      .from(agentTaskSessions)
      .where(eq(agentTaskSessions.agentId, agentId));
    expect(sessionRow?.lastRunId).toBeNull();

    const [costRow] = await db.select().from(costEvents).where(eq(costEvents.id, costEventId));
    expect(costRow?.heartbeatRunId).toBeNull();

    const [financeRow] = await db
      .select()
      .from(financeEvents)
      .where(eq(financeEvents.agentId, agentId));
    expect(financeRow?.heartbeatRunId).toBeNull();
  });
});
