import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, executionWorkspaces, heartbeatRuns, issues, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  createDbMergedWorktreeCleanupDeps,
  createDbWorktreeCleanupDeps,
  runWorktreeCleanup,
} from "../services/worktree-cleanup.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const DAY = 24 * 60 * 60 * 1000;

function sh(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

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
    await db.delete(activityLog);
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
        name: c.key, status: "active", providerType: "git_worktree", sourceIssueId: null,
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
      name: "shared", status: "active", providerType: "git_worktree",
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

  it("selects idle worktrees of done/cancelled tasks for the merged pass, never open or in_review ones (DUR-5184)", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const now = new Date("2026-10-04T12:00:00Z");
    await db.insert(companies).values({ id: companyId, name: "Co", issuePrefix: "TST", requireBoardApprovalForNewAgents: false });
    await db.insert(projects).values({ id: projectId, companyId, name: "P", status: "in_progress" });

    const cases: Array<{ key: string; status: string; idleMinutes: number }> = [
      { key: "review-idle", status: "in_review", idleMinutes: 120 },
      { key: "done-just-now", status: "done", idleMinutes: 120 },
      { key: "review-busy", status: "in_review", idleMinutes: 5 },
      { key: "progress-idle", status: "in_progress", idleMinutes: 600 },
      { key: "blocked-idle", status: "blocked", idleMinutes: 600 },
      { key: "todo-idle", status: "todo", idleMinutes: 600 },
    ];
    for (const c of cases) {
      const wsId = randomUUID();
      await db.insert(executionWorkspaces).values({
        id: wsId, companyId, projectId, mode: "isolated_workspace", strategyType: "git_worktree",
        name: c.key, status: "active", providerType: "git_worktree", sourceIssueId: null,
        cwd: `/paperclip/x/repo/.paperclip/worktrees/${c.key}`, branchName: c.key,
        lastUsedAt: new Date(now.getTime() - c.idleMinutes * 60_000),
      });
      await db.insert(issues).values({
        id: randomUUID(), companyId, title: c.key, status: c.status, executionWorkspaceId: wsId,
        completedAt: c.status === "done" ? now : null,
      });
    }
    const deps = createDbWorktreeCleanupDeps(db);
    const merged = await deps.listMergedCandidates!(now);
    expect(merged.map((c) => c.cwd.split("/").pop()).sort()).toEqual(["done-just-now"]);
    expect(merged.every((c) => c.mode === "merged_pr")).toBe(true);
    // The retention-days pass is unchanged: the 'done' task was completed just now, so it is not eligible yet.
    expect(await deps.listCandidates(now, 7)).toEqual([]);
  });

  it("makes an idle issue-less run-<id> worktree eligible after the retention period, and nothing else without an issue (DUR-5184)", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const now = new Date("2026-10-04T12:00:00Z");
    await db.insert(companies).values({ id: companyId, name: "Co", issuePrefix: "TST", requireBoardApprovalForNewAgents: false });
    await db.insert(projects).values({ id: projectId, companyId, name: "P", status: "in_progress" });
    for (const [branch, ageDays] of [["run-aaaa1111", 10], ["run-bbbb2222", 2], ["hand-made", 400]] as const) {
      await db.insert(executionWorkspaces).values({
        id: randomUUID(), companyId, projectId, mode: "isolated_workspace", strategyType: "git_worktree",
        name: branch, status: "active", providerType: "git_worktree",
        cwd: `/paperclip/x/repo/.paperclip/worktrees/${branch}`, branchName: branch,
        lastUsedAt: new Date(now.getTime() - ageDays * DAY),
      });
    }
    const deps = createDbWorktreeCleanupDeps(db);
    const found = await deps.listCandidates(now, 7);
    expect(found.map((c) => c.branchName)).toEqual(["run-aaaa1111"]);
    expect(found[0]!.flagIssueId).toBeNull();
    // Keeping it must not throw for lack of an issue to comment on.
    await expect(deps.flagUnsavedWork(found[0]!, "has changes")).resolves.toBeUndefined();
  });

  it("puts an idle issue-less run-<id> folder in the prompt pass unless a run is live on it (DUR-5184)", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const now = new Date("2026-10-04T12:00:00Z");
    await db.insert(companies).values({ id: companyId, name: "Co", issuePrefix: "TST", requireBoardApprovalForNewAgents: false });
    await db.insert(projects).values({ id: projectId, companyId, name: "P", status: "in_progress" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "A", role: "engineer", status: "idle", adapterType: "process",
      adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const cases = [
      { branch: "run-idle0001", idleMinutes: 120, live: false },
      { branch: "run-fresh002", idleMinutes: 5, live: false },
      { branch: "run-live0003", idleMinutes: 120, live: true },
      { branch: "hand-made", idleMinutes: 120, live: false },
    ];
    for (const c of cases) {
      const wsId = randomUUID();
      await db.insert(executionWorkspaces).values({
        id: wsId, companyId, projectId, mode: "isolated_workspace", strategyType: "git_worktree",
        name: c.branch, status: "active", providerType: "git_worktree",
        cwd: `/paperclip/x/repo/.paperclip/worktrees/${c.branch}`, branchName: c.branch,
        lastUsedAt: new Date(now.getTime() - c.idleMinutes * 60_000),
      });
      if (c.live) {
        await db.insert(heartbeatRuns).values({
          id: randomUUID(), companyId, agentId, status: "running", contextSnapshot: { executionWorkspaceId: wsId },
        });
      }
    }
    const found = await createDbWorktreeCleanupDeps(db).listMergedCandidates!(now);
    expect(found.map((c) => [c.branchName, c.mode])).toEqual([["run-idle0001", "idle_run"]]);
  });

  it("keeps a worktree out of the merged pass while a run is live on it or on a linked issue (DUR-5228)", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const now = new Date("2026-10-04T12:00:00Z");
    await db.insert(companies).values({ id: companyId, name: "Co", issuePrefix: "TST", requireBoardApprovalForNewAgents: false });
    await db.insert(projects).values({ id: projectId, companyId, name: "P", status: "in_progress" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "A", role: "engineer", status: "idle", adapterType: "process",
      adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const cases = [
      { key: "run-on-issue", runStatus: "running", via: "issue" },
      { key: "run-on-workspace", runStatus: "queued", via: "context" },
      { key: "run-finished", runStatus: "succeeded", via: "issue" },
      { key: "no-run", runStatus: null, via: null },
    ] as const;
    for (const c of cases) {
      const wsId = randomUUID();
      const issueId = randomUUID();
      const runId = randomUUID();
      await db.insert(executionWorkspaces).values({
        id: wsId, companyId, projectId, mode: "isolated_workspace", strategyType: "git_worktree",
        name: c.key, status: "active", providerType: "git_worktree",
        cwd: `/paperclip/x/repo/.paperclip/worktrees/${c.key}`, branchName: c.key,
        lastUsedAt: new Date(now.getTime() - 120 * 60_000),
      });
      if (c.runStatus) {
        await db.insert(heartbeatRuns).values({
          id: runId, companyId, agentId, status: c.runStatus,
          contextSnapshot: c.via === "context" ? { executionWorkspaceId: wsId } : {},
        });
      }
      await db.insert(issues).values({
        id: issueId, companyId, title: c.key, status: "done", completedAt: now, executionWorkspaceId: wsId,
        executionRunId: c.runStatus && c.via === "issue" ? runId : null,
      });
    }
    const deps = createDbWorktreeCleanupDeps(db);
    const merged = await deps.listMergedCandidates!(now);
    expect(merged.map((c) => c.cwd.split("/").pop()).sort()).toEqual(["no-run", "run-finished"]);
  });
  it("selects worktrees by the providerType production writes (git_worktree) and still accepts legacy local_fs, never other types (DUR-5236)", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const now = new Date("2026-10-04T12:00:00Z");
    await db.insert(companies).values({ id: companyId, name: "Co", issuePrefix: "TST", requireBoardApprovalForNewAgents: false });
    await db.insert(projects).values({ id: projectId, companyId, name: "P", status: "in_progress" });
    for (const providerType of ["git_worktree", "local_fs", "remote_sandbox"]) {
      const wsId = randomUUID();
      await db.insert(executionWorkspaces).values({
        id: wsId, companyId, projectId, mode: "isolated_workspace", strategyType: "git_worktree",
        name: providerType, status: "active", providerType,
        cwd: `/paperclip/x/repo/.paperclip/worktrees/${providerType}`, branchName: providerType,
      });
      await db.insert(issues).values({
        id: randomUUID(), companyId, title: providerType, status: "done", executionWorkspaceId: wsId,
        completedAt: new Date(now.getTime() - 10 * DAY),
      });
    }
    const found = await createDbWorktreeCleanupDeps(db).listCandidates(now, 7);
    expect(found.map((c) => c.branchName).sort()).toEqual(["git_worktree", "local_fs"]);
  });

  it("removes a merged, idle git_worktree workspace and keeps an unmerged one, end to end (DUR-5236)", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wt-cleanup-e2e-")));
    try {
      const origin = path.join(root, "origin.git");
      const repo = path.join(root, "repo");
      sh(root, "init", "-q", "--bare", "-b", "main", origin);
      sh(root, "clone", "-q", origin, repo);
      fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
      sh(repo, "add", ".");
      sh(repo, "commit", "-q", "-m", "init");
      sh(repo, "push", "-q", "origin", "HEAD:main");
      sh(repo, "fetch", "-q", "origin");

      const addBranchWorktree = (name: string) => {
        const wt = path.join(repo, ".paperclip", "worktrees", name);
        sh(repo, "worktree", "add", "-b", name, wt, "origin/main");
        fs.writeFileSync(path.join(wt, `${name}.txt`), "f\n");
        sh(wt, "add", ".");
        sh(wt, "commit", "-q", "-m", name);
        sh(wt, "push", "-q", "origin", name);
        return wt;
      };
      const mergedWt = addBranchWorktree("pr-merged");
      const openWt = addBranchWorktree("pr-open");
      const scratch = path.join(root, "scratch");
      sh(root, "clone", "-q", origin, scratch);
      sh(scratch, "merge", "-q", "--no-ff", "-m", "Merge pr-merged", "origin/pr-merged");
      sh(scratch, "push", "-q", "origin", "HEAD:main");
      sh(repo, "pull", "-q", "--ff-only", "origin", "main");

      const companyId = randomUUID();
      const projectId = randomUUID();
      const now = new Date();
      await db.insert(companies).values({ id: companyId, name: "Co", issuePrefix: "TST", requireBoardApprovalForNewAgents: false });
      await db.insert(projects).values({ id: projectId, companyId, name: "P", status: "in_progress" });
      const wsIds: Record<string, string> = {};
      for (const [branch, cwd] of [["pr-merged", mergedWt], ["pr-open", openWt]] as const) {
        const wsId = randomUUID();
        wsIds[branch] = wsId;
        await db.insert(executionWorkspaces).values({
          id: wsId, companyId, projectId, mode: "isolated_workspace", strategyType: "git_worktree",
          name: branch, status: "active", providerType: "git_worktree", cwd, branchName: branch,
          lastUsedAt: new Date(now.getTime() - 2 * 60 * 60_000),
        });
        await db.insert(issues).values({
          id: randomUUID(), companyId, title: branch, status: "done", completedAt: now, executionWorkspaceId: wsId,
        });
      }

      const deps = createDbMergedWorktreeCleanupDeps(db);
      const dry = await runWorktreeCleanup(deps, { now, dryRun: true });
      expect(dry).toMatchObject({ considered: 2, wouldRemove: 1, kept: 1, removed: 0 });
      expect(fs.existsSync(mergedWt)).toBe(true);

      const result = await runWorktreeCleanup(deps, { now });
      expect(result).toMatchObject({ considered: 2, removed: 1, kept: 1, branchesDeleted: 1 });
      expect(fs.existsSync(mergedWt)).toBe(false);
      expect(sh(repo, "branch", "--list", "pr-merged")).toBe("");
      expect(fs.existsSync(openWt)).toBe(true);
      expect(sh(repo, "branch", "--list", "pr-open")).toContain("pr-open");
      const rows = await db.select().from(executionWorkspaces);
      const status = (b: string) => rows.find((r) => r.id === wsIds[b])!.status;
      expect(status("pr-merged")).toBe("archived");
      expect(status("pr-open")).toBe("active");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
