import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteMergedLocalBranch,
  evaluateWorktreeForRemoval,
  runWorktreeCleanup,
  worktreeCleanupDryRunFromEnv,
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
      // DUR-5184: the removed worktree's branch (fully merged: it is at origin/main) is
      // deleted with `git branch -d`; the kept ones keep theirs.
      expect(result.branchesDeleted).toBe(1);
      expect(sh(repo, "branch", "--list", "clean")).toBe("");
      expect(sh(repo, "branch", "--list", "dirty2")).toContain("dirty2");
      expect(sh(repo, "branch", "--list", "ahead")).toContain("ahead");
    });

    it("removes the worktree of an unmerged branch but keeps the branch (git branch -d refuses)", async () => {
      const wt = addWorktree("unmerged-pushed");
      fs.writeFileSync(path.join(wt, "feature.txt"), "f\n");
      sh(wt, "add", ".");
      sh(wt, "commit", "-q", "-m", "feature");
      sh(wt, "push", "-q", "origin", "unmerged-pushed");
      const { deps, cleaned } = setup([cand("9", wt, "unmerged-pushed")]);
      const result = await runWorktreeCleanup(deps);
      expect(result).toMatchObject({ removed: 1, branchesDeleted: 0 });
      expect(cleaned).toEqual(["9"]);
      expect(fs.existsSync(wt)).toBe(false);
      expect(sh(repo, "branch", "--list", "unmerged-pushed")).toContain("unmerged-pushed");
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

    it("DUR-5236: a worktree folder that is already gone is kept silently, not flagged as unsaved work", async () => {
      const gone = path.join(repo, ".paperclip", "worktrees", "never-existed");
      const { deps, flagged, cleaned } = setup([cand("1", gone, "never-existed")]);
      const result = await runWorktreeCleanup(deps);
      expect(result).toMatchObject({ considered: 1, removed: 0, kept: 1, missing: 1 });
      expect(flagged).toEqual([]);
      expect(cleaned).toEqual([]);
    });

    it("DUR-5236: dry run reports what it would remove and touches nothing", async () => {
      const clean = addWorktree("dry-clean");
      const dirty = addWorktree("dry-dirty");
      fs.writeFileSync(path.join(dirty, "scratch.txt"), "x\n");
      const { deps, flagged, cleaned } = setup([cand("1", clean, "dry-clean"), cand("2", dirty, "dry-dirty")]);
      const result = await runWorktreeCleanup(deps, { dryRun: true });
      expect(result).toMatchObject({ considered: 2, removed: 0, kept: 1, wouldRemove: 1, dryRun: true, capped: false });
      expect(cleaned).toEqual([]);
      expect(flagged).toEqual([]); // no comments posted in a dry run
      expect(fs.existsSync(clean)).toBe(true);
      expect(sh(repo, "branch", "--list", "dry-clean")).toContain("dry-clean");
    });

    it("DUR-5236: removal is opt-in -- only LIVE=true goes live, DRY_RUN=true wins, anything else previews", () => {
      expect(worktreeCleanupDryRunFromEnv({})).toBe(true);
      expect(worktreeCleanupDryRunFromEnv({ PAPERCLIP_WORKTREE_CLEANUP_LIVE: "1" })).toBe(true);
      expect(worktreeCleanupDryRunFromEnv({ PAPERCLIP_WORKTREE_CLEANUP_DRY_RUN: "false" })).toBe(true);
      expect(worktreeCleanupDryRunFromEnv({ PAPERCLIP_WORKTREE_CLEANUP_LIVE: "true" })).toBe(false);
      expect(
        worktreeCleanupDryRunFromEnv({ PAPERCLIP_WORKTREE_CLEANUP_LIVE: "true", PAPERCLIP_WORKTREE_CLEANUP_DRY_RUN: "true" }),
      ).toBe(true);
    });

    it("DUR-5236: the preview lists each folder with path, branch, task and reason, and removes nothing", async () => {
      const clean = addWorktree("plan-clean");
      const dirty = addWorktree("plan-dirty");
      fs.writeFileSync(path.join(dirty, "x.txt"), "x\n");
      const { deps } = setup([
        { ...cand("1", clean, "plan-clean"), mode: "finished_task" },
        cand("2", dirty, "plan-dirty"),
      ]);
      const result = await runWorktreeCleanup(deps, { dryRun: true });
      expect(result.plan).toEqual([
        {
          executionWorkspaceId: "1",
          cwd: clean,
          branchName: "plan-clean",
          issue: "DUR-1",
          mode: "finished_task",
          reason: expect.stringContaining("clean"),
        },
      ]);
      expect(result.wouldFlag).toBe(1);
      expect(fs.existsSync(clean)).toBe(true);
    });

    it("DUR-5236: never removes a folder another run or task is using, in either mode", async () => {
      const busy = addWorktree("busy");
      const free = addWorktree("free");
      const { deps, cleaned } = setup([cand("1", busy, "busy"), cand("2", free, "free")]);
      deps.isInUse = async (c) => c.executionWorkspaceId === "1";
      const dry = await runWorktreeCleanup(deps, { dryRun: true });
      expect(dry).toMatchObject({ wouldRemove: 1, inUse: 1 });
      expect(dry.plan.map((p) => p.executionWorkspaceId)).toEqual(["2"]);
      const live = await runWorktreeCleanup(deps);
      expect(live).toMatchObject({ removed: 1, inUse: 1, kept: 1 });
      expect(cleaned).toEqual(["2"]);
      expect(fs.existsSync(busy)).toBe(true);
      expect(fs.existsSync(free)).toBe(false);
    });

    it("DUR-5236: a failing in-use check keeps the folder (fail closed)", async () => {
      const wt = addWorktree("check-fails");
      const { deps } = setup([cand("1", wt, "check-fails")]);
      deps.isInUse = async () => {
        throw new Error("db down");
      };
      expect(await runWorktreeCleanup(deps)).toMatchObject({ removed: 0, inUse: 1 });
      expect(fs.existsSync(wt)).toBe(true);
    });

    it("DUR-5236: evaluates a folder once even when two candidates share it", async () => {
      const wt = addWorktree("shared-folder");
      const { deps, cleaned } = setup([cand("1", wt, "shared-folder"), cand("2", wt, "shared-folder")]);
      const result = await runWorktreeCleanup(deps);
      expect(result).toMatchObject({ removed: 1, kept: 1, failed: 0 });
      expect(cleaned).toEqual(["1"]);
    });

    it("DUR-5236: posts at most maxFlags 'unsaved work' comments per sweep; already-flagged ones do not count", async () => {
      const dirty = ["a", "b", "c", "d"].map((n) => {
        const wt = addWorktree(`flood-${n}`);
        fs.writeFileSync(path.join(wt, "x.txt"), "x\n");
        return wt;
      });
      const { deps, flagged } = setup(dirty.map((wt, i) => cand(String(i), wt, path.basename(wt))));
      const first = await runWorktreeCleanup(deps, { maxFlags: 2 });
      expect(first).toMatchObject({ kept: 4, flagged: 2, flagSuppressed: 2 });
      expect(flagged.map((f) => f.id)).toEqual(["0", "1"]);

      // The first folder was flagged on an earlier day (flag returns false): it must not use up the cap.
      const calls: string[] = [];
      const second = setup(dirty.map((wt, i) => cand(String(i), wt, path.basename(wt))));
      second.deps.flagUnsavedWork = async (c) => {
        calls.push(c.executionWorkspaceId);
        return c.executionWorkspaceId !== "0";
      };
      const result = await runWorktreeCleanup(second.deps, { maxFlags: 2 });
      expect(result).toMatchObject({ flagged: 2, flagSuppressed: 1 });
      expect(calls).toEqual(["0", "1", "2"]);
    });

    it("DUR-5236: stops at the daily cap, counting what earlier sweeps already removed", async () => {
      const wts = ["day-a", "day-b", "day-c"].map((n) => addWorktree(n));
      const { deps, cleaned } = setup(wts.map((wt, i) => cand(String(i), wt, path.basename(wt))));
      let removedToday = 48;
      deps.removedSince = async () => removedToday;
      const first = await runWorktreeCleanup(deps, { maxRemovalsPerDay: 50 });
      expect(first).toMatchObject({ removed: 2, capped: true, dailyCapped: true });
      expect(cleaned).toEqual(["0", "1"]);
      removedToday = 50;
      const second = await runWorktreeCleanup(setup([cand("2", wts[2]!, "day-c")]).deps, { maxRemovalsPerDay: 50 });
      expect(second.removed).toBe(1); // no removedSince dep => no daily cap, so the per-sweep cap rules
      const third = setup([cand("2", wts[2]!, "day-c")]);
      third.deps.removedSince = async () => removedToday;
      expect(await runWorktreeCleanup(third.deps, { maxRemovalsPerDay: 50 })).toMatchObject({ removed: 0, dailyCapped: true, capped: true });
    });

    it("DUR-5236: stops after maxRemovals and leaves the rest for the next sweep", async () => {
      const wts = ["cap-a", "cap-b", "cap-c"].map((n) => addWorktree(n));
      const { deps, cleaned } = setup(wts.map((wt, i) => cand(String(i), wt, path.basename(wt))));
      const first = await runWorktreeCleanup(deps, { maxRemovals: 2 });
      expect(first).toMatchObject({ considered: 3, removed: 2, capped: true });
      expect(cleaned).toEqual(["0", "1"]);
      expect(fs.existsSync(wts[2]!)).toBe(true);
      const second = await runWorktreeCleanup(setup([cand("2", wts[2]!, "cap-c")]).deps, { maxRemovals: 2 });
      expect(second).toMatchObject({ removed: 1, capped: false });
      expect(fs.existsSync(wts[2]!)).toBe(false);
    });

    describe("after a PR merges", () => {
      function mergeIntoMain(branch: string) {
        // What GitHub's "Create a merge commit" does, done through a scratch clone of origin.
        const scratch = path.join(root, `scratch-${branch}`);
        sh(root, "clone", "-q", origin, scratch);
        sh(scratch, "merge", "-q", "--no-ff", "-m", `Merge ${branch}`, `origin/${branch}`);
        sh(scratch, "push", "-q", "origin", "HEAD:main");
      }
      const mergedCand = (id: string, cwd: string, branch: string): WorktreeCleanupCandidate => ({
        ...cand(id, cwd, branch),
        mode: "merged_pr",
      });

      it("removes the worktree and deletes the merged branch", async () => {
        const wt = addWorktree("pr-merged");
        fs.writeFileSync(path.join(wt, "feature.txt"), "f\n");
        sh(wt, "add", ".");
        sh(wt, "commit", "-q", "-m", "feature");
        sh(wt, "push", "-q", "origin", "pr-merged");
        mergeIntoMain("pr-merged");
        // The main checkout follows main, as it does in production, so `branch -d` sees the merge.
        sh(repo, "pull", "-q", "--ff-only", "origin", "main");

        const { deps, cleaned, flagged } = setup([mergedCand("1", wt, "pr-merged")]);
        const result = await runWorktreeCleanup(deps);
        expect(result).toMatchObject({ removed: 1, kept: 0, branchesDeleted: 1 });
        expect(cleaned).toEqual(["1"]);
        expect(flagged).toEqual([]);
        expect(fs.existsSync(wt)).toBe(false);
        expect(sh(repo, "branch", "--list", "pr-merged")).toBe("");
      });

      it("keeps an unmerged branch's worktree and does not flag it", async () => {
        const wt = addWorktree("pr-open");
        fs.writeFileSync(path.join(wt, "feature.txt"), "f\n");
        sh(wt, "add", ".");
        sh(wt, "commit", "-q", "-m", "feature");
        sh(wt, "push", "-q", "origin", "pr-open");
        const { deps, cleaned, flagged } = setup([mergedCand("2", wt, "pr-open")]);
        const result = await runWorktreeCleanup(deps);
        expect(result).toMatchObject({ removed: 0, kept: 1 });
        expect(cleaned).toEqual([]);
        expect(flagged).toEqual([]);
        expect(fs.existsSync(wt)).toBe(true);
        expect(sh(repo, "branch", "--list", "pr-open")).toContain("pr-open");
      });

      it("keeps the worktree of a branch with no commits of its own (a no-code task is not 'merged')", async () => {
        const wt = addWorktree("pr-no-commits");
        const { deps, cleaned, flagged } = setup([mergedCand("4", wt, "pr-no-commits")]);
        const result = await runWorktreeCleanup(deps);
        expect(result).toMatchObject({ removed: 0, kept: 1 });
        expect(cleaned).toEqual([]);
        expect(flagged).toEqual([]);
        expect(fs.existsSync(wt)).toBe(true);
      });

      it("removes an unused run-<id> folder at the idle-run pass but keeps one with a commit of its own", async () => {
        const unused = addWorktree("run-unused01");
        const used = addWorktree("run-used0002");
        fs.writeFileSync(path.join(used, "feature.txt"), "f\n");
        sh(used, "add", ".");
        sh(used, "commit", "-q", "-m", "work");
        sh(used, "push", "-q", "origin", "run-used0002");
        const idleCand = (id: string, cwd: string, branch: string): WorktreeCleanupCandidate => ({
          ...cand(id, cwd, branch),
          flagIssueId: null,
          flagIssueIdentifier: null,
          mode: "idle_run",
        });
        const { deps, cleaned, flagged } = setup([idleCand("5", unused, "run-unused01"), idleCand("6", used, "run-used0002")]);
        const result = await runWorktreeCleanup(deps);
        expect(result).toMatchObject({ removed: 1, kept: 1 });
        expect(cleaned).toEqual(["5"]);
        expect(flagged).toEqual([]);
        expect(fs.existsSync(unused)).toBe(false);
        expect(sh(repo, "branch", "--list", "run-unused01")).toBe("");
        expect(fs.existsSync(used)).toBe(true);
        expect(sh(repo, "branch", "--list", "run-used0002")).toContain("run-used0002");
      });

      it("keeps a merged branch that still has uncommitted work", async () => {
        const wt = addWorktree("pr-merged-dirty");
        fs.writeFileSync(path.join(wt, "feature.txt"), "f\n");
        sh(wt, "add", ".");
        sh(wt, "commit", "-q", "-m", "feature");
        sh(wt, "push", "-q", "origin", "pr-merged-dirty");
        mergeIntoMain("pr-merged-dirty");
        fs.writeFileSync(path.join(wt, "later.txt"), "after the merge\n");
        const { deps, cleaned } = setup([mergedCand("3", wt, "pr-merged-dirty")]);
        const result = await runWorktreeCleanup(deps);
        expect(result).toMatchObject({ removed: 0, kept: 1 });
        expect(cleaned).toEqual([]);
        expect(fs.existsSync(path.join(wt, "later.txt"))).toBe(true);
      });
    });
  });

  describe("deleteMergedLocalBranch (git branch -d, never -D)", () => {
    it("refuses an unmerged branch and keeps it", async () => {
      sh(repo, "checkout", "-q", "-b", "wip");
      fs.writeFileSync(path.join(repo, "w.txt"), "w\n");
      sh(repo, "add", ".");
      sh(repo, "commit", "-q", "-m", "wip");
      sh(repo, "checkout", "-q", "main");
      const result = await deleteMergedLocalBranch(repo, "wip");
      expect(result.deleted).toBe(false);
      expect(sh(repo, "branch", "--list", "wip")).toContain("wip");
    });

    it("deletes a fully merged branch", async () => {
      sh(repo, "branch", "merged-already", "main");
      expect(await deleteMergedLocalBranch(repo, "merged-already")).toEqual({ deleted: true });
      expect(sh(repo, "branch", "--list", "merged-already")).toBe("");
    });

    it("never deletes the checked-out branch and rejects option-like names", async () => {
      expect((await deleteMergedLocalBranch(repo, "main")).deleted).toBe(false);
      expect((await deleteMergedLocalBranch(repo, "-D")).deleted).toBe(false);
      expect((await deleteMergedLocalBranch(repo, null)).deleted).toBe(false);
      expect(sh(repo, "branch", "--list", "main")).toContain("main");
    });
  });
});
