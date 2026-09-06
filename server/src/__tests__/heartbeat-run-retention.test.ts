import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
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

  // drizzle wraps the driver error as "Failed query: ..." and keeps Postgres's
  // own message ("canceling statement due to statement timeout") on `cause`.
  async function expectStatementTimeout(promise: Promise<unknown>): Promise<void> {
    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    const cause = caught instanceof Error ? (caught.cause ?? caught) : caught;
    expect(String((cause as { message?: string })?.message)).toMatch(/statement timeout/i);
  }

  it("lifts the app pool's DUR-280 statement_timeout for its own batch transaction", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const staleCreatedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const runIds = await Promise.all(
      Array.from({ length: 4 }, () => seedRun(companyId, agentId, staleCreatedAt)),
    );

    // A pool whose per-statement ceiling (200ms) is far below what one batch
    // will take once every deleted row sleeps 150ms in a BEFORE DELETE trigger
    // (4 rows -> ~600ms). Built through createDb so the override travels the
    // same path production would use.
    const previousOverride = process.env.PAPERCLIP_DB_STATEMENT_TIMEOUT_MS;
    process.env.PAPERCLIP_DB_STATEMENT_TIMEOUT_MS = "200";
    const tightDb = createDb(tempDb!.connectionString, "paperclip-retention-test");
    if (previousOverride === undefined) delete process.env.PAPERCLIP_DB_STATEMENT_TIMEOUT_MS;
    else process.env.PAPERCLIP_DB_STATEMENT_TIMEOUT_MS = previousOverride;

    await db.execute(sql`
      CREATE OR REPLACE FUNCTION retention_test_slow_delete() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_sleep(0.15);
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.execute(sql`
      CREATE TRIGGER retention_test_slow_delete
      BEFORE DELETE ON heartbeat_runs FOR EACH ROW
      EXECUTE FUNCTION retention_test_slow_delete()
    `);

    try {
      // Control: the same DELETE issued directly on the 200ms pool is killed
      // by the ceiling -- proves the ceiling is real and the trigger is slow
      // enough that the sweep below only succeeds because it lifts it.
      await expectStatementTimeout(
        tightDb.execute(sql`DELETE FROM heartbeat_runs WHERE created_at < ${new Date().toISOString()}`),
      );
      const stillThere = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
      expect(stillThere).toHaveLength(runIds.length);

      const deleted = await pruneHeartbeatRuns(tightDb, 30, runIds.length);
      expect(deleted).toBe(runIds.length);
      const remaining = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
      expect(remaining).toHaveLength(0);

      // The lift was transaction-local: a fresh statement on the same pool is
      // back under the 200ms ceiling.
      await expectStatementTimeout(tightDb.execute(sql`SELECT pg_sleep(0.5)`));
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS retention_test_slow_delete ON heartbeat_runs`);
      await db.execute(sql`DROP FUNCTION IF EXISTS retention_test_slow_delete()`);
      await tightDb.$client.end({ timeout: 5 });
    }
  }, 20_000);
});
