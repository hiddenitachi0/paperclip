/**
 * DUR-4142: the real (DB-backed) half of start_job -- createDbLaneAToolDeps's
 * `startJob` wiring plus the executor, end to end. lane-a-tools.test.ts
 * already covers the tool's own logic against fake deps; this file proves
 * the fake's contract matches the real jobService/issueService composition:
 * the position gate is jobService.list's own `agentId` filter (the same
 * check routes/jobs.ts's run endpoint makes for a non-board caller), the
 * dispatched run is tagged `source: "telegram"`, and an optional note lands
 * as a comment rather than inside the job's own instructions. The heartbeat
 * wakeup itself is stubbed, same as jobs-service.test.ts -- this proves job
 * run/issue/comment dispatch, not that an agent actually executes.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyAgentRoles,
  createDb,
  executionWorkspaces,
  issueComments,
  issues,
  jobPositions,
  jobRuns,
  jobs,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { jobService } from "../services/jobs.ts";
import {
  createDbLaneAToolDeps,
  createLaneABuiltinToolExecutor,
  type LaneAToolContext,
} from "../services/lane-a-tools.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres start_job tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("start_job (DUR-4142)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-lane-a-start-job-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(jobRuns);
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
    const otherAgentId = randomUUID();
    const quickAgentId = randomUUID();
    await db.insert(agents).values([
      {
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
      },
      {
        id: otherAgentId,
        companyId,
        name: "Bob",
        role: "engineer",
        roleId: null,
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: quickAgentId,
        companyId,
        name: "Maja",
        role: "secretary",
        roleId: null,
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Jobs", status: "in_progress" });

    const jobDetail = await jobService(db).create(
      companyId,
      {
        title: "Revise contract",
        instructions: "Revise the attached contract for the stated goal.",
        status: "active",
        variables: [],
        runMode: "full_agent",
        requiresApproval: false,
        positionIds: [positionId],
      } as never,
      {},
    );

    return { companyId, holderAgentId, otherAgentId, quickAgentId, jobDetail };
  }

  function ctxFor(companyId: string, quickAgentId: string): LaneAToolContext {
    return {
      companyId,
      agent: { id: quickAgentId, name: "Maja" },
      requester: { userId: "operator-1", agentId: null },
      actor: { type: "board", userId: "operator-1", companyIds: [companyId], source: "local_implicit" },
      conversationId: randomUUID(),
    };
  }

  it("dispatches the job on the position holder as a telegram-sourced run, and logs a note as a comment", async () => {
    const { companyId, holderAgentId, quickAgentId, jobDetail } = await seedFixture();
    const deps = createDbLaneAToolDeps(db, { jobServiceOptions: { heartbeat: { wakeup: async () => null } } });
    const execute = createLaneABuiltinToolExecutor(deps);

    const result = await execute(
      "start_job",
      { colleague: "Legal Advisor Agent", job: "Revise contract", note: "the Acme NDA, focus on indemnification" },
      ctxFor(companyId, quickAgentId),
    );

    expect(result.ok).toBe(true);
    expect(result.task?.issueId).toBeTruthy();

    const [run] = await db.select().from(jobRuns).where(eq(jobRuns.jobId, jobDetail.id));
    expect(run.source).toBe("telegram");
    expect(run.runAgentId).toBe(holderAgentId);
    expect(run.status).toBe("dispatched");

    const [issueRow] = await db.select().from(issues).where(eq(issues.id, run.linkedIssueId!));
    expect(issueRow.assigneeAgentId).toBe(holderAgentId);
    // The note is a comment, not folded into the job's own instructions.
    expect(issueRow.description).not.toContain("Acme NDA");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueRow.id));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("Acme NDA");
    expect(comments[0].authorAgentId).toBe(quickAgentId);

    const logged = await db.select().from(activityLog).where(eq(activityLog.action, "job.run_triggered"));
    expect(logged).toHaveLength(1);
    expect(logged[0].details).toMatchObject({ jobId: jobDetail.id, source: "telegram", runAgentId: holderAgentId });
  });

  it("refuses when the named colleague does not hold a linked position for that job", async () => {
    const { companyId, otherAgentId, quickAgentId } = await seedFixture();
    const deps = createDbLaneAToolDeps(db, { jobServiceOptions: { heartbeat: { wakeup: async () => null } } });
    const execute = createLaneABuiltinToolExecutor(deps);

    const result = await execute(
      "start_job",
      { colleague: "Bob", job: "Revise contract" },
      ctxFor(companyId, quickAgentId),
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain("has no one-press jobs set up");
    const runs = await db.select().from(jobRuns);
    expect(runs).toHaveLength(0);
    void otherAgentId;
  });
});
