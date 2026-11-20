import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { isWorktreeInUseByAnotherRun } from "../services/worktree-in-use.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const PATH = "/work/tree/DUR-1";

// DUR-5237: the "another run works in this folder" check must also see a run that
// is running but still setting up (it has not saved its folder yet). Queued runs
// have not touched the folder and must not block it.
describeEmbeddedPostgres("worktree in-use check", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-worktree-in-use-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Co", issuePrefix: "TST", requireBoardApprovalForNewAgents: false });
    await db.insert(projects).values({ id: projectId, companyId, name: "P", status: "in_progress" });
    await db.insert(agents).values({ id: agentId, companyId, name: "A", role: "engineer", adapterType: "claude_local", adapterConfig: {} });
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "ws",
      status: "active",
      cwd: PATH,
      providerType: "git_worktree",
      providerRef: PATH,
    });
    return { companyId, projectId, agentId, workspaceId };
  }

  async function addRun(
    ctx: { companyId: string; agentId: string },
    status: string,
    contextSnapshot: Record<string, unknown>,
  ) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId: ctx.companyId,
      agentId: ctx.agentId,
      invocationSource: "assignment",
      status,
      contextSnapshot,
    });
    return id;
  }

  it("sees a running run that saved this folder, but not itself", async () => {
    const ctx = await seed();
    const other = await addRun(ctx, "running", { paperclipWorkspace: { cwd: PATH } });
    const me = randomUUID();
    expect(await isWorktreeInUseByAnotherRun(db, { companyId: ctx.companyId, runId: me, worktreePath: PATH })).toBe(true);
    expect(await isWorktreeInUseByAnotherRun(db, { companyId: ctx.companyId, runId: other, worktreePath: PATH })).toBe(false);
  });

  it("sees a running run still setting up, bound to this folder by workspace id", async () => {
    const ctx = await seed();
    await addRun(ctx, "running", { executionWorkspaceId: ctx.workspaceId });
    expect(
      await isWorktreeInUseByAnotherRun(db, { companyId: ctx.companyId, runId: randomUUID(), worktreePath: PATH }),
    ).toBe(true);
  });

  it("does not count queued runs, even ones bound to this folder or to the same task", async () => {
    const ctx = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      title: "T",
      status: "in_progress",
      executionWorkspaceId: ctx.workspaceId,
    });
    await addRun(ctx, "queued", { executionWorkspaceId: ctx.workspaceId });
    await addRun(ctx, "queued", { issueId });
    await addRun(ctx, "queued", { paperclipWorkspace: { cwd: PATH } });
    expect(
      await isWorktreeInUseByAnotherRun(db, { companyId: ctx.companyId, runId: randomUUID(), worktreePath: PATH }),
    ).toBe(false);
  });

  it("sees a running run that has not saved its folder yet, bound through its task", async () => {
    const ctx = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      title: "T",
      status: "in_progress",
      executionWorkspaceId: ctx.workspaceId,
    });
    await addRun(ctx, "running", { issueId });
    expect(
      await isWorktreeInUseByAnotherRun(db, { companyId: ctx.companyId, runId: randomUUID(), worktreePath: PATH }),
    ).toBe(true);
  });

  it("ignores finished runs, runs on other folders and other companies", async () => {
    const ctx = await seed();
    await addRun(ctx, "succeeded", { executionWorkspaceId: ctx.workspaceId, paperclipWorkspace: { cwd: PATH } });
    await addRun(ctx, "queued", { executionWorkspaceId: randomUUID() });
    await addRun(ctx, "running", { paperclipWorkspace: { cwd: "/somewhere/else" } });
    expect(
      await isWorktreeInUseByAnotherRun(db, { companyId: ctx.companyId, runId: randomUUID(), worktreePath: PATH }),
    ).toBe(false);
    expect(
      await isWorktreeInUseByAnotherRun(db, { companyId: randomUUID(), runId: randomUUID(), worktreePath: PATH }),
    ).toBe(false);
  });
});
