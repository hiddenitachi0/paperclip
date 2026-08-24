import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, isNull } from "drizzle-orm";
import { activityLog, companies, createDb, untrackedWriteIncidents } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { untrackedWriteAlertsService } from "../services/untracked-write-alerts.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

// DUR-130: the trigger that populates untracked_write_incidents is tested
// against real Postgres in packages/db/src/untracked-write-trigger.test.ts.
// This exercises the other half -- turning a pending incident row into an
// operator-visible alert -- mirroring dur128-agent-error-alerts.test.ts.
describeEmbeddedPostgres("DUR-130: untracked-write alert sweep", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dur130-untracked-write-alerts-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(untrackedWriteIncidents);
    await db.delete(activityLog);
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

  it("raises an operator-visible alert for a pending incident and does not re-alert it", async () => {
    const companyId = await seedCompany();
    const rowId = randomUUID();
    await db.insert(untrackedWriteIncidents).values({
      tableName: "agents",
      operation: "UPDATE",
      rowId,
      companyId,
      applicationName: "psql",
      sessionUserName: "postgres",
    });

    const svc = untrackedWriteAlertsService(db);
    const first = await svc.tick(new Date());
    expect(first.alerted).toBe(1);

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "db.untracked_write_detected"));
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      companyId,
      actorType: "system",
      entityType: "agents",
      entityId: rowId,
    });
    expect(activity[0].details).toMatchObject({ operation: "UPDATE", applicationName: "psql" });

    const second = await svc.tick(new Date());
    expect(second.alerted).toBe(0);
    const stillOne = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "db.untracked_write_detected"));
    expect(stillOne).toHaveLength(1);

    const unalerted = await db
      .select()
      .from(untrackedWriteIncidents)
      .where(isNull(untrackedWriteIncidents.alertedAt));
    expect(unalerted).toHaveLength(0);
  });

  it("fans a company-less incident (e.g. instance_settings) out to every existing company", async () => {
    const companyIdA = await seedCompany();
    const companyIdB = await seedCompany();
    await db.insert(untrackedWriteIncidents).values({
      tableName: "instance_settings",
      operation: "UPDATE",
      rowId: randomUUID(),
      companyId: null,
      applicationName: null,
      sessionUserName: "postgres",
    });

    const svc = untrackedWriteAlertsService(db);
    await svc.tick(new Date());

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "db.untracked_write_detected"));
    expect(activity.map((row) => row.companyId).sort()).toEqual([companyIdA, companyIdB].sort());
  });

  it("uses the affected row's own id as the company scope for a companies-table incident", async () => {
    const companyId = await seedCompany();
    await db.insert(untrackedWriteIncidents).values({
      tableName: "companies",
      operation: "UPDATE",
      rowId: companyId,
      companyId: null,
      applicationName: "psql",
      sessionUserName: "postgres",
    });

    const svc = untrackedWriteAlertsService(db);
    await svc.tick(new Date());

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "db.untracked_write_detected"));
    expect(activity).toHaveLength(1);
    expect(activity[0].companyId).toBe(companyId);
  });
});
