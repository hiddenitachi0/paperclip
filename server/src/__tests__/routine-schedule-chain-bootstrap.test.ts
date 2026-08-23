import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  projects,
  routineRevisions,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { routineService } from "../services/routines.ts";
import {
  formatScheduleChainBootstrapReport,
  logScheduleChainBootstrapVerification,
  verifyScheduleChainBootstrap,
} from "../services/routines.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres schedule-chain-bootstrap tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("schedule chain bootstrap verification (DUR-100)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-schedule-chain-bootstrap-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(routineTriggers);
    await db.delete(routineRevisions);
    await db.delete(routines);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Routines",
      status: "in_progress",
    });

    const svc = routineService(db, { heartbeat: { wakeup: async () => null } });
    return { companyId, agentId, projectId, svc };
  }

  /** Creates an active routine with a live, healthy schedule trigger and a matching revision snapshot. */
  async function seedScheduledChain(
    svc: ReturnType<typeof routineService>,
    companyId: string,
    agentId: string,
    projectId: string,
    title: string,
  ) {
    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title,
        description: null,
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );
    const { trigger } = await svc.createTrigger(
      routine.id,
      { kind: "schedule", cronExpression: "0 * * * *", timezone: "UTC", enabled: true },
      {},
    );
    return { routineId: routine.id, triggerId: trigger.id };
  }

  it("reports a genuinely healthy chain as verified and running normally", async () => {
    const { companyId, agentId, projectId, svc } = await seedCompany();
    await seedScheduledChain(svc, companyId, agentId, projectId, "healthy chain");

    const result = await verifyScheduleChainBootstrap(db);
    expect(result.totalDeclaredChains).toBe(1);
    expect(result.verifiedChains).toHaveLength(1);
    expect(result.orphanedChains).toHaveLength(0);
    expect(result.missingChains).toHaveLength(0);
    expect(result.indeterminateRoutines).toHaveLength(0);

    const report = formatScheduleChainBootstrapReport(result);
    expect(report.healthy).toBe(true);
    expect(report.summary).toBe("1/1 scheduled chains verified healthy");
  });

  it("reproduces the 22 August incident: 9 declared chains, 4 orphaned, 5 missing, none reported healthy", async () => {
    const { companyId, agentId, projectId, svc } = await seedCompany();

    const chains = [];
    for (let i = 0; i < 9; i++) {
      chains.push(await seedScheduledChain(svc, companyId, agentId, projectId, `chain ${i}`));
    }

    // 4 orphaned: the live registry row exists but its schedule data was lost
    // (this is exactly the bug tickScheduledTriggers already has — a trigger
    // whose cronExpression/timezone went null never advances nextRunAt again).
    for (const chain of chains.slice(0, 4)) {
      await db
        .update(routineTriggers)
        .set({ cronExpression: null, timezone: null, nextRunAt: null })
        .where(eq(routineTriggers.id, chain.triggerId));
    }

    // 5 missing: the live registry row is gone entirely, even though the
    // routine's own last-saved config still declares it.
    for (const chain of chains.slice(4, 9)) {
      await db.delete(routineTriggers).where(eq(routineTriggers.id, chain.triggerId));
    }

    const result = await verifyScheduleChainBootstrap(db);
    expect(result.totalDeclaredChains).toBe(9);
    expect(result.verifiedChains).toHaveLength(0);
    expect(result.orphanedChains).toHaveLength(4);
    expect(result.missingChains).toHaveLength(5);
    expect(result.indeterminateRoutines).toHaveLength(0);

    const report = formatScheduleChainBootstrapReport(result);
    expect(report.healthy).toBe(false);
    expect(report.summary).not.toContain("9/9");
    expect(report.summary).toContain("0/9 scheduled chains verified healthy");
    expect(report.summary).toContain("4 orphaned");
    expect(report.summary).toContain("5 missing");
  });

  it("never reports an indeterminate routine as verified", async () => {
    const { companyId, agentId, projectId, svc } = await seedCompany();
    const { routineId } = await seedScheduledChain(svc, companyId, agentId, projectId, "undeterminable chain");

    // Simulate a revision snapshot that cannot be resolved (e.g. corrupted
    // FK) by pointing latestRevisionId at a non-existent revision.
    await db.update(routines).set({ latestRevisionId: randomUUID() }).where(eq(routines.id, routineId));

    const result = await verifyScheduleChainBootstrap(db);
    expect(result.totalDeclaredChains).toBe(0);
    expect(result.verifiedChains).toHaveLength(0);
    expect(result.indeterminateRoutines).toHaveLength(1);

    const report = formatScheduleChainBootstrapReport(result);
    expect(report.healthy).toBe(false);
    expect(report.summary).toContain("could not be determined");
  });

  it("logScheduleChainBootstrapVerification logs error (not info) when chains are unhealthy, and never claims N/N", async () => {
    const { companyId, agentId, projectId, svc } = await seedCompany();
    const chain = await seedScheduledChain(svc, companyId, agentId, projectId, "broken chain");
    await db.delete(routineTriggers).where(eq(routineTriggers.id, chain.triggerId));

    const infoCalls: unknown[] = [];
    const errorCalls: unknown[] = [];
    const fakeLog = {
      info: (...args: unknown[]) => infoCalls.push(args),
      error: (...args: unknown[]) => errorCalls.push(args),
    } as unknown as typeof import("../middleware/logger.ts").logger;

    const result = await logScheduleChainBootstrapVerification(db, { log: fakeLog });
    expect(result.missingChains).toHaveLength(1);
    expect(infoCalls).toHaveLength(0);
    expect(errorCalls).toHaveLength(1);
    const [, message] = errorCalls[0] as [unknown, string];
    expect(message).not.toMatch(/1\/1.*ran|already scheduled/i);
    expect(message).toContain("unhealthy");
  });

  it("logs info (not error) when every declared chain verifies healthy", async () => {
    const { companyId, agentId, projectId, svc } = await seedCompany();
    await seedScheduledChain(svc, companyId, agentId, projectId, "healthy chain");

    const infoCalls: unknown[] = [];
    const errorCalls: unknown[] = [];
    const fakeLog = {
      info: (...args: unknown[]) => infoCalls.push(args),
      error: (...args: unknown[]) => errorCalls.push(args),
    } as unknown as typeof import("../middleware/logger.ts").logger;

    await logScheduleChainBootstrapVerification(db, { log: fakeLog });
    expect(errorCalls).toHaveLength(0);
    expect(infoCalls).toHaveLength(1);
  });
});
