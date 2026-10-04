import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  evaluateWorktreeForRemoval,
  runWorktreeCleanup,
  type WorktreeCleanupCandidate,
  type WorktreeCleanupDeps,
} from "../services/worktree-cleanup.js";

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

describe("worktree cleanup (DUR-4497)", () => {
  let root: string;
  let repo: string;
  let origin: string;

  function addWorktree(name: string, pushed = true): string {
    const wt = path.join(repo, ".paperclip", "worktrees", name);
    sh(repo, "worktree", "add", "-b", name, wt, "origin/main");
    if (pushed) sh(wt, "push", "-q", "origin", name);
    return wt;
  }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wt-cleanup-")));
    origin = path.join(root, "origin.git");
    repo = path.join(root, "repo");
    sh(root, "init", "-q", "--bare", "-b", "main", origin);
    sh(root, "clone", "-q", origin, repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-q", "-m", "init");
    sh(repo, "push", "-q", "origin", "HEAD:main");
    sh(repo, "fetch", "-q", "origin");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("removes a clean, fully pushed worktree", async () => {
    const wt = addWorktree("done-clean");
    const verdict = await evaluateWorktreeForRemoval(wt, "done-clean");
    expect(verdict.action).toBe("remove");
  });

  it("keeps a worktree with uncommitted tracked changes", async () => {
    const wt = addWorktree("dirty");
    fs.writeFileSync(path.join(wt, "a.txt"), "changed\n");
    const verdict = await evaluateWorktreeForRemoval(wt, "dirty");
    expect(verdict).toMatchObject({ action: "keep" });
  });

  it("keeps a worktree with untracked files", async () => {
    const wt = addWorktree("untracked");
    fs.writeFileSync(path.join(wt, "new.txt"), "x\n");
    const verdict = await evaluateWorktreeForRemoval(wt, "untracked");
    expect(verdict).toMatchObject({ action: "keep" });
  });

  it("keeps a worktree with commits not on origin", async () => {
    const wt = addWorktree("unpushed");
    fs.writeFileSync(path.join(wt, "b.txt"), "b\n");
    sh(wt, "add", ".");
    sh(wt, "commit", "-q", "-m", "local only");
    const verdict = await evaluateWorktreeForRemoval(wt, "unpushed");
    expect(verdict).toMatchObject({ action: "keep" });
    expect((verdict as { reason: string }).reason).toMatch(/not present on origin/);
  });

  it("keeps when the branch (not HEAD) has unpushed commits", async () => {
    const wt = addWorktree("branch-ahead");
    fs.writeFileSync(path.join(wt, "b.txt"), "b\n");
    sh(wt, "add", ".");
    sh(wt, "commit", "-q", "-m", "local only");
    sh(wt, "checkout", "-q", "--detach", "origin/main");
    const verdict = await evaluateWorktreeForRemoval(wt, "branch-ahead");
    expect(verdict).toMatchObject({ action: "keep" });
  });

  it("keeps when origin cannot be reached (fail closed)", async () => {
    const wt = addWorktree("offline");
    sh(repo, "remote", "set-url", "origin", path.join(root, "does-not-exist.git"));
    const verdict = await evaluateWorktreeForRemoval(wt, "offline");
    expect(verdict).toMatchObject({ action: "keep" });
  });

  it("refuses the main checkout and paths outside .paperclip/worktrees", async () => {
    expect(await evaluateWorktreeForRemoval(repo, null)).toMatchObject({ action: "keep" });
    const outside = path.join(root, "outside");
    sh(repo, "worktree", "add", "-b", "outside", outside, "origin/main");
    expect(await evaluateWorktreeForRemoval(outside, "outside")).toMatchObject({ action: "keep" });
    expect(await evaluateWorktreeForRemoval("relative/path", null)).toMatchObject({ action: "keep" });
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("refuses a worktree whose .git pointer resolves outside the repo", async () => {
    const wt = addWorktree("bad-pointer");
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(root, "nowhere")}\n`);
    expect(await evaluateWorktreeForRemoval(wt, "bad-pointer")).toMatchObject({ action: "keep" });
  });

  describe("runWorktreeCleanup", () => {
    function setup(candidates: WorktreeCleanupCandidate[]) {
      const flagged: Array<{ id: string; reason: string }> = [];
      const cleaned: string[] = [];
      const deps: WorktreeCleanupDeps = {
        listCandidates: async () => candidates,
        flagUnsavedWork: async (c, reason) => {
          flagged.push({ id: c.executionWorkspaceId, reason });
        },
        markCleaned: async (c) => {
          cleaned.push(c.executionWorkspaceId);
        },
      };
      return { deps, flagged, cleaned };
    }
    const cand = (id: string, cwd: string, branch: string): WorktreeCleanupCandidate => ({
      executionWorkspaceId: id,
      companyId: "c1",
      flagIssueId: `i-${id}`,
      flagIssueIdentifier: `DUR-${id}`,
      cwd,
      branchName: branch,
    });

    it("removes done+clean, keeps and flags dirty and unpushed", async () => {
      const clean = addWorktree("clean");
      const dirty = addWorktree("dirty2");
      fs.writeFileSync(path.join(dirty, "a.txt"), "changed\n");
      const ahead = addWorktree("ahead");
      fs.writeFileSync(path.join(ahead, "c.txt"), "c\n");
      sh(ahead, "add", ".");
      sh(ahead, "commit", "-q", "-m", "local");

      const { deps, flagged, cleaned } = setup([
        cand("1", clean, "clean"),
        cand("2", dirty, "dirty2"),
        cand("3", ahead, "ahead"),
      ]);
      const result = await runWorktreeCleanup(deps);

      expect(result).toMatchObject({ considered: 3, removed: 1, kept: 2, failed: 0 });
      expect(cleaned).toEqual(["1"]);
      expect(flagged.map((f) => f.id).sort()).toEqual(["2", "3"]);
      expect(fs.existsSync(clean)).toBe(false);
      expect(fs.existsSync(dirty)).toBe(true);
      expect(fs.existsSync(ahead)).toBe(true);
      // The branch itself is never deleted.
      expect(sh(repo, "branch", "--list", "clean")).toContain("clean");
    });

    it("never touches a worktree that listCandidates did not return (open task)", async () => {
      const open = addWorktree("open-task");
      const { deps, flagged, cleaned } = setup([]);
      const result = await runWorktreeCleanup(deps);
      expect(result).toMatchObject({ considered: 0, removed: 0 });
      expect(flagged).toEqual([]);
      expect(cleaned).toEqual([]);
      expect(fs.existsSync(open)).toBe(true);
    });
  });
});
