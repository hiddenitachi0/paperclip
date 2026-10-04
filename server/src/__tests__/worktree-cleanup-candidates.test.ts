import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, executionWorkspaces, issues, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createDbWorktreeCleanupDeps } from "../services/worktree-cleanup.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const DAY = 24 * 60 * 60 * 1000;

// DUR-4497: only done/cancelled tasks older than N days may become candidates;
// open tasks are never returned regardless of age.
describeEmbeddedPostgres("worktree cleanup candidate selection", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-worktree-cleanup-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns only terminal-for-N-days tasks, honouring the company override", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const now = new Date("2026-10-04T12:00:00Z");
    await db.insert(companies).values({ id: companyId, name: "Co", issuePrefix: "TST", requireBoardApprovalForNewAgents: false });
    await db.insert(projects).values({ id: projectId, companyId, name: "P", status: "in_progress" });

    const cases: Array<{ key: string; status: string; ageDays: number | null }> = [
      { key: "done-old", status: "done", ageDays: 10 },
      { key: "cancelled-old", status: "cancelled", ageDays: 10 },
      { key: "done-recent", status: "done", ageDays: 2 },
      { key: "done-no-timestamp", status: "done", ageDays: null },
      { key: "in_progress-old", status: "in_progress", ageDays: 400 },
      { key: "in_review-old", status: "in_review", ageDays: 400 },
      { key: "blocked-old", status: "blocked", ageDays: 400 },
      { key: "todo-old", status: "todo", ageDays: 400 },
    ];
    const wsByKey = new Map<string, string>();
    for (const c of cases) {
      const wsId = randomUUID();
      const issueId = randomUUID();
      wsByKey.set(c.key, wsId);
      await db.insert(executionWorkspaces).values({
        id: wsId, companyId, projectId, mode: "isolated_workspace", strategyType: "git_worktree",
        name: c.key, status: "active", providerType: "local_fs", sourceIssueId: null,
        cwd: `/paperclip/x/repo/.paperclip/worktrees/${c.key}`, branchName: c.key,
      });
      const at = c.ageDays === null ? null : new Date(now.getTime() - c.ageDays * DAY);
      await db.insert(issues).values({
        id: issueId, companyId, title: c.key, status: c.status, executionWorkspaceId: wsId,
        completedAt: c.status === "done" ? at : null,
        cancelledAt: c.status === "cancelled" ? at : null,
      });
    }
    // A worktree shared with a still-open task must be left alone even if another linked task is old+done.
    const sharedWs = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: sharedWs, companyId, projectId, mode: "isolated_workspace", strategyType: "git_worktree",
      name: "shared", status: "active", providerType: "local_fs",
      cwd: "/paperclip/x/repo/.paperclip/worktrees/shared", branchName: "shared",
    });
    await db.insert(issues).values([
      { id: randomUUID(), companyId, title: "s1", status: "done", executionWorkspaceId: sharedWs, completedAt: new Date(now.getTime() - 30 * DAY) },
      { id: randomUUID(), companyId, title: "s2", status: "todo", executionWorkspaceId: sharedWs },
    ]);

    const deps = createDbWorktreeCleanupDeps(db);
    const names = async () => (await deps.listCandidates(now, 7)).map((c) => c.cwd.split("/").pop()).sort();
    expect(await names()).toEqual(["cancelled-old", "done-old"]);

    // Company override of 1 day pulls in the 2-day-old done task; open tasks still never appear.
    await db.update(companies).set({ worktreeCleanupRetentionDays: 1 });
    expect(await names()).toEqual(["cancelled-old", "done-old", "done-recent"]);
  });
});
