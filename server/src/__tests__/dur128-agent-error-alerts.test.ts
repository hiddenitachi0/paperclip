import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentErrorAlertsService } from "../services/agent-error-alerts.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

describeEmbeddedPostgres("DUR-128: agent error stall alerts", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dur128-error-alerts-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
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

  it("raises an alert once an agent has been in error longer than the threshold", async () => {
    const companyId = await seedCompany();
    const stalledId = randomUUID();
    const freshId = randomUUID();

    await db.insert(agents).values([
      {
        id: stalledId,
        companyId,
        name: "Stalled",
        role: "engineer",
        status: "error",
        errorReason: "Adapter crashed",
        errorAt: new Date(Date.now() - 60 * 60 * 1000),
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: freshId,
        companyId,
        name: "FreshlyFailed",
        role: "engineer",
        status: "error",
        errorReason: "Transient network blip",
        errorAt: new Date(),
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const svc = agentErrorAlertsService(db, { thresholdMs: 30 * 60 * 1000 });
    const result = await svc.tick(new Date());

    expect(result.alerted).toBe(1);

    const stalledActivity = await db.select().from(activityLog).where(eq(activityLog.entityId, stalledId));
    expect(stalledActivity).toHaveLength(1);
    expect(stalledActivity[0]).toMatchObject({
      action: "agent.error_stalled",
      actorType: "system",
      entityType: "agent",
    });

    const freshActivity = await db.select().from(activityLog).where(eq(activityLog.entityId, freshId));
    expect(freshActivity).toHaveLength(0);

    const [stalledAgent] = await db.select().from(agents).where(eq(agents.id, stalledId));
    expect(stalledAgent.errorAlertedAt).not.toBeNull();
  });

  it("does not raise the same alert twice for one error episode", async () => {
    const companyId = await seedCompany();
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Stalled",
      role: "engineer",
      status: "error",
      errorReason: "Adapter crashed",
      errorAt: new Date(Date.now() - 60 * 60 * 1000),
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const svc = agentErrorAlertsService(db, { thresholdMs: 30 * 60 * 1000 });
    await svc.tick(new Date());
    const second = await svc.tick(new Date());

    expect(second.alerted).toBe(0);
    const activityRows = await db.select().from(activityLog).where(eq(activityLog.entityId, agentId));
    expect(activityRows).toHaveLength(1);
  });

  it("never alerts on an agent with no recorded errorAt", async () => {
    const companyId = await seedCompany();
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "LegacyError",
      role: "engineer",
      status: "error",
      errorReason: "Predates the errorAt column",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const svc = agentErrorAlertsService(db, { thresholdMs: 0 });
    const result = await svc.tick(new Date());

    expect(result.alerted).toBe(0);
  });
});
