/**
 * DUR-4182: covers the parts of jobService that are specific to Jobs rather
 * than copied from routines -- position-based dispatch (a job has no single
 * assignee; "position jobs appear for every agent hired into that position"),
 * run idempotency, and the schedule-trigger tick rolling nextRunAt forward.
 * Mirrors routines-service.test.ts's embedded-Postgres fixture shape.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyAgentRoles,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  jobPositions,
  jobRuns,
  jobs,
  jobTriggers,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { jobService } from "../services/jobs.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres jobs service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("job service dispatch (DUR-4182)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-jobs-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(jobRuns);
    await db.delete(jobTriggers);
    await db.delete(jobPositions);
    await db.delete(jobs);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companyAgentRoles);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    const positionId = randomUUID();
    await db.insert(companyAgentRoles).values({
      id: positionId,
      companyId,
      name: "Legal Advisor",
      key: "legal-advisor",
      isBuiltin: true,
    });

    const holderAgentId = randomUUID();
    await db.insert(agents).values({
      id: holderAgentId,
      companyId,
      name: "Legal Advisor Agent",
      role: "legal_advisor",
      roleId: positionId,
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Jobs", status: "in_progress" });

    const wakeups: Array<{ agentId: string }> = [];
    const svc = jobService(db, {
      heartbeat: {
        wakeup: async (agentId) => {
          wakeups.push({ agentId });
          return null;
        },
      },
    });

    const jobDetail = await svc.create(
      companyId,
      {
        title: "Revise contract",
        instructions: "Revise {{counterparty}}'s contract.",
        status: "active",
        variables: [],
        runMode: "full_agent",
        requiresApproval: false,
        positionIds: [positionId],
      } as never,
      {},
    );

    return { companyId, positionId, holderAgentId, projectId, jobDetail, svc, wakeups };
  }

  it("links the job to its position and dispatches a run assigned to the position holder", async () => {
    const { companyId, holderAgentId, jobDetail, svc } = await seedFixture();
    expect(jobDetail.positions.map((p) => p.id)).toEqual([expect.any(String)]);

    const run = await svc.runJob(jobDetail.id, { runAgentId: holderAgentId, source: "manual" } as never, {});
    expect(run.status).toBe("dispatched");
    expect((run as { linkedIssueId?: string }).linkedIssueId).toBeTruthy();

    const [issueRow] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, (run as { linkedIssueId: string }).linkedIssueId));
    expect(issueRow.assigneeAgentId).toBe(holderAgentId);
    expect(issueRow.originKind).toBe("job_execution");
    expect(issueRow.originId).toBe(jobDetail.id);
    void companyId;
  });

  it("returns the same run for a repeated idempotency key instead of dispatching twice", async () => {
    const { holderAgentId, jobDetail, svc } = await seedFixture();

    const first = await svc.runJob(
      jobDetail.id,
      { runAgentId: holderAgentId, source: "manual", idempotencyKey: "telegram:maja:1" } as never,
      {},
    );
    const second = await svc.runJob(
      jobDetail.id,
      { runAgentId: holderAgentId, source: "manual", idempotencyKey: "telegram:maja:1" } as never,
      {},
    );

    expect(second.id).toBe(first.id);
    const allRuns = await db.select().from(jobRuns).where(eq(jobRuns.jobId, jobDetail.id));
    expect(allRuns).toHaveLength(1);
  });

  it("tickScheduledJobTriggers dispatches a due schedule trigger and rolls nextRunAt forward", async () => {
    const { holderAgentId, jobDetail, svc } = await seedFixture();
    const created = await svc.createTrigger(
      jobDetail.id,
      { kind: "schedule", cronExpression: "* * * * *", timezone: "UTC", enabled: true } as never,
      {},
    );
    // Force the trigger into the past so this tick treats it as due.
    await db
      .update(jobTriggers)
      .set({ nextRunAt: new Date(Date.now() - 60_000) })
      .where(eq(jobTriggers.id, created.trigger.id));

    const result = await svc.tickScheduledJobTriggers(new Date());
    expect(result.enqueued).toBe(1);

    const [updatedTrigger] = await db.select().from(jobTriggers).where(eq(jobTriggers.id, created.trigger.id));
    expect(updatedTrigger.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect(updatedTrigger.lastFiredAt).not.toBeNull();

    const runs = await db.select().from(jobRuns).where(eq(jobRuns.jobId, jobDetail.id));
    expect(runs).toHaveLength(1);
    expect(runs[0].runAgentId).toBe(holderAgentId);
    expect(runs[0].source).toBe("schedule");
  });
});
