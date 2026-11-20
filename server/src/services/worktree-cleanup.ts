import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq, inArray, like, ne, or, sql } from "drizzle-orm";
import { companies, executionWorkspaces, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { issueService } from "./issues.js";
import { serverChildProcessEnv } from "./runtime-env.js";

const execFileAsync = promisify(execFile);

/** Days a task must have been done/cancelled before its worktree is eligible. */
export const DEFAULT_WORKTREE_CLEANUP_RETENTION_DAYS = 7;
export const DEFAULT_WORKTREE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;
/** DUR-5184: how often worktrees of merged branches are looked for. */
export const DEFAULT_MERGED_WORKTREE_SWEEP_INTERVAL_MS = 15 * 60 * 1_000;
/** DUR-5184: a worktree used more recently than this is never removed by the merged pass. */
export const MERGED_WORKTREE_IDLE_MS = 30 * 60 * 1_000;

/**
 * DUR-5236: most worktrees one sweep may remove. Production holds ~1,000 worktree rows that
 * were never selected before, so the first live sweeps would otherwise delete all of them at
 * once. The rest wait for the next sweep. Kept (not removed) worktrees do not count.
 */
export const DEFAULT_WORKTREE_CLEANUP_MAX_REMOVALS_PER_SWEEP = 25;

const GIT_TIMEOUT_MS = 60_000;
const GIT_FETCH_TIMEOUT_MS = 120_000;

/** First line of the "has unsaved work" flag comment; also the de-dupe key. */
export const WORKTREE_UNSAVED_WORK_MARKER = "<!-- worktree-cleanup:unsaved-work -->";

/** DUR-5236: execution_workspaces.provider_type values that can back a managed worktree. */
export const WORKTREE_PROVIDER_TYPES = ["git_worktree", "local_fs"];

const TERMINAL_STATUSES = new Set(["done", "cancelled"]);
/**
 * Statuses where no run is expected to still need the worktree once its PR merged.
 * in_review is deliberately NOT here: an in_review task can still be woken (monitor,
 * reviewer comment) and its next run needs its folder.
 */
const MERGED_PASS_SAFE_STATUSES = new Set(["done", "cancelled"]);

/**
 * DUR-4497. Automatic cleanup of finished-task agent worktrees.
 *
 * SAFETY MODEL -- a bug here can delete the only copy of a task's unpushed
 * work, so every decision fails CLOSED (keep + flag) on any ambiguity:
 *
 *  1. Only worktrees whose every linked issue is done/cancelled for >= N days
 *     are even looked at (non-terminal tasks are never touched).
 *  2. The worktree path must be exactly `<repo>/.paperclip/worktrees/<name>`
 *     (after realpath), and its `.git` file must be a gitdir pointer that
 *     resolves to `<repo>/.git/worktrees/<x>` of that same repo. Anything else
 *     (symlink games, the main checkout, a path outside the worktrees dir, a
 *     host-path pointer that does not exist in this container) is refused.
 *  3. `git status --porcelain --untracked-files=all` must be empty, no
 *     merge/rebase/cherry-pick/revert/bisect may be in progress.
 *  4. After `git fetch --prune origin` (live check; a failed fetch means
 *     "cannot verify" => keep), neither HEAD nor the recorded branch may have
 *     any commit that is not reachable from an `origin/*` ref.
 *  5. Removal is plain `git worktree remove` WITHOUT --force, so git itself
 *     re-refuses a dirty/untracked tree if something raced the checks above.
 *  6. (DUR-5184) After the worktree is gone its local branch is deleted with
 *     `git branch -d` ONLY -- never `-D` -- so git itself keeps any branch
 *     that is not fully merged. A kept branch is not an error.
 *
 * DUR-5184 adds a second, faster pass ("merged_pr"): a worktree whose branch
 * has already been merged into an origin branch is removed within one sweep
 * interval instead of waiting out the retention days. It applies the same
 * safety checks plus (a) every linked issue must be done/cancelled/in_review
 * (never one a run may still be working on), (b) the worktree must have been
 * idle for a while, and (c) the branch tip must be an ancestor of an origin
 * branch. A worktree that does not meet that is silently kept (no flag
 * comment: an unmerged in-review branch is normal, not unsaved work).
 *
 * Ignored files (node_modules, build output) are intentionally not "work":
 * they are removed with the worktree.
 */

export type WorktreeVerdict =
  | { action: "remove"; repoRoot: string; worktreePath: string }
  | { action: "keep"; reason: string };

async function git(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: serverChildProcessEnv({ GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }),
  });
  return stdout;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolve and validate that `cwd` is a linked git worktree living directly
 * under `<repo>/.paperclip/worktrees/`. Throws (=> caller keeps) otherwise.
 */
export async function resolveManagedWorktree(
  cwd: string,
): Promise<{ repoRoot: string; worktreePath: string }> {
  if (!cwd || !path.isAbsolute(cwd)) throw new Error("worktree path is not absolute");
  const worktreePath = await fs.realpath(cwd);
  const worktreesDir = path.dirname(worktreePath);
  if (path.basename(worktreesDir) !== "worktrees") {
    throw new Error("path is not directly inside a 'worktrees' directory");
  }
  const dotPaperclip = path.dirname(worktreesDir);
  if (path.basename(dotPaperclip) !== ".paperclip") {
    throw new Error("worktrees directory is not inside '.paperclip'");
  }
  const repoRoot = path.dirname(dotPaperclip);

  const repoGit = await fs.lstat(path.join(repoRoot, ".git"));
  if (!repoGit.isDirectory()) throw new Error("repo root has no .git directory");

  // `.git` of a linked worktree is a *file* holding `gitdir: <pointer>`. The
  // pointer is a container path (/paperclip/...); resolve it, never assume.
  const dotGit = path.join(worktreePath, ".git");
  const dotGitStat = await fs.lstat(dotGit);
  if (!dotGitStat.isFile()) throw new Error(".git is not a gitdir pointer file");
  const pointer = (await fs.readFile(dotGit, "utf8")).trim();
  const match = /^gitdir:\s*(.+)$/.exec(pointer);
  if (!match) throw new Error(".git pointer is malformed");
  const gitdir = await fs.realpath(path.resolve(worktreePath, match[1]!.trim()));
  const adminDir = await fs.realpath(path.join(repoRoot, ".git", "worktrees"));
  if (path.dirname(gitdir) !== adminDir) {
    throw new Error("gitdir pointer does not resolve into this repo's .git/worktrees");
  }

  const toplevel = await fs.realpath((await git(["rev-parse", "--show-toplevel"], worktreePath)).trim());
  if (toplevel !== worktreePath) throw new Error("git toplevel does not match worktree path");

  return { repoRoot, worktreePath };
}

const IN_PROGRESS_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "BISECT_LOG",
  "rebase-merge",
  "rebase-apply",
];

/**
 * Decide whether a worktree may be removed. Never throws: every error becomes
 * a `keep` verdict with a human-readable reason.
 */
export interface EvaluateWorktreeOptions {
  /** DUR-5184: also require the branch tip to be merged into an origin branch. */
  requireMerged?: boolean;
  /** DUR-5184: keep unless the branch has no commit beyond the one it was created from (an unused `run-<id>` folder). */
  requireUntouched?: boolean;
  /** DUR-5184: share one `git fetch` per repo across a sweep. Value is the error text, or null on success. */
  fetchCache?: Map<string, Promise<string | null>>;
}

/**
 * True only when the branch has at least one commit of its own, i.e. its tip is not
 * the commit it was created from. A branch with no commits of its own is trivially
 * an "ancestor of origin" and must not count as merged. Uses the branch reflog's
 * oldest entry as the creation point; an unreadable reflog fails closed (false).
 */
async function branchCreationState(
  worktreePath: string,
  branchRef: string,
): Promise<"own_commits" | "untouched" | "unknown"> {
  try {
    const shas = (await git(["reflog", "show", "--format=%H", branchRef], worktreePath))
      .split("\n").map((l) => l.trim()).filter(Boolean);
    const creation = shas[shas.length - 1];
    if (!creation) return "unknown";
    const tip = (await git(["rev-parse", "--verify", branchRef], worktreePath)).trim();
    return tip !== creation ? "own_commits" : "untouched";
  } catch {
    return "unknown";
  }
}

/** Origin branches a finished branch is allowed to have been merged into. */
async function mergedIntoOrigin(worktreePath: string, tipRef: string): Promise<string | null> {
  const names = new Set<string>();
  const head = await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], worktreePath)
    .then((out) => out.trim(), () => "");
  if (head) names.add(head);
  for (const fallback of ["origin/custom", "origin/main", "origin/master"]) names.add(fallback);
  for (const name of names) {
    const exists = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/${name}`], worktreePath)
      .then((out) => out.trim().length > 0, () => false);
    if (!exists) continue;
    const merged = await git(["merge-base", "--is-ancestor", tipRef, `refs/remotes/${name}`], worktreePath)
      .then(() => true, () => false);
    if (merged) return name;
  }
  return null;
}

export async function evaluateWorktreeForRemoval(
  cwd: string,
  branchName: string | null,
  options: EvaluateWorktreeOptions = {},
): Promise<WorktreeVerdict> {
  try {
    const { repoRoot, worktreePath } = await resolveManagedWorktree(cwd);

    const status = await git(["status", "--porcelain=v1", "--untracked-files=all"], worktreePath);
    if (status.trim().length > 0) {
      return { action: "keep", reason: "the working tree has uncommitted or untracked changes" };
    }

    const gitDir = (await git(["rev-parse", "--absolute-git-dir"], worktreePath)).trim();
    for (const marker of IN_PROGRESS_MARKERS) {
      const exists = await fs.access(path.join(gitDir, marker)).then(() => true, () => false);
      if (exists) return { action: "keep", reason: `a git operation is in progress (${marker})` };
    }

    const remotes = (await git(["remote"], worktreePath)).split("\n").map((r) => r.trim());
    if (!remotes.includes("origin")) {
      return { action: "keep", reason: "the repository has no 'origin' remote to verify against" };
    }
    const doFetch = () =>
      git(["fetch", "--prune", "--quiet", "origin"], worktreePath, GIT_FETCH_TIMEOUT_MS).then(
        () => null,
        (err: unknown) => firstLine(err),
      );
    let fetchError: string | null;
    if (options.fetchCache) {
      let pending = options.fetchCache.get(repoRoot);
      if (!pending) {
        pending = doFetch();
        options.fetchCache.set(repoRoot, pending);
      }
      fetchError = await pending;
    } else {
      fetchError = await doFetch();
    }
    if (fetchError !== null) {
      return {
        action: "keep",
        reason: `could not refresh origin to verify pushed commits (${fetchError})`,
      };
    }

    const refs = ["HEAD"];
    if (branchName) {
      const branchRef = `refs/heads/${branchName}`;
      const exists = await git(["rev-parse", "--verify", "--quiet", branchRef], worktreePath)
        .then((out) => out.trim().length > 0, () => false);
      if (exists) refs.push(branchRef);
    }
    for (const ref of refs) {
      const raw = (await git(["rev-list", "--count", ref, "--not", "--remotes=origin"], worktreePath)).trim();
      const unpushed = Number.parseInt(raw, 10);
      if (!Number.isInteger(unpushed)) {
        return { action: "keep", reason: `could not count unpushed commits for ${ref}` };
      }
      if (unpushed > 0) {
        return {
          action: "keep",
          reason: `${ref === "HEAD" ? "the worktree HEAD" : `branch ${branchName}`} has ${unpushed} commit(s) not present on origin`,
        };
      }
    }

    if (options.requireUntouched) {
      if (!branchName) return { action: "keep", reason: "the worktree has no recorded branch to check" };
      const state = await branchCreationState(worktreePath, `refs/heads/${branchName}`);
      if (state !== "untouched") {
        return { action: "keep", reason: `branch ${branchName} has commits of its own (or its history cannot be read), so it is not an unused run folder` };
      }
    }

    if (options.requireMerged) {
      if (!branchName) return { action: "keep", reason: "the worktree has no recorded branch to check for a merge" };
      if ((await branchCreationState(worktreePath, `refs/heads/${branchName}`)) !== "own_commits") {
        return { action: "keep", reason: `branch ${branchName} has no commits of its own, so a merge cannot be told apart from an untouched branch` };
      }
      const mergedInto = await mergedIntoOrigin(worktreePath, `refs/heads/${branchName}`);
      if (!mergedInto) return { action: "keep", reason: `branch ${branchName} is not merged into an origin branch yet` };
    }

    return { action: "remove", repoRoot, worktreePath };
  } catch (err) {
    return { action: "keep", reason: `safety check failed, keeping to be safe (${firstLine(err)})` };
  }
}

function firstLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return (msg.split("\n").find((l) => l.trim().length > 0) ?? "unknown error").slice(0, 200);
}

/** Remove a worktree that was approved by `evaluateWorktreeForRemoval`. */
export async function removeApprovedWorktree(verdict: Extract<WorktreeVerdict, { action: "remove" }>) {
  // Re-assert containment immediately before the destructive call.
  const worktreesDir = path.join(verdict.repoRoot, ".paperclip", "worktrees");
  if (!isInside(worktreesDir, verdict.worktreePath) || path.dirname(verdict.worktreePath) !== worktreesDir) {
    throw new Error("refusing to remove a path outside the worktrees directory");
  }
  // No --force: git re-refuses dirty/untracked/locked worktrees on its own.
  await git(["worktree", "remove", verdict.worktreePath], verdict.repoRoot);
  const stillThere = await fs.access(verdict.worktreePath).then(() => true, () => false);
  if (stillThere) throw new Error("worktree directory still exists after removal");
}

export type BranchDeletion = { deleted: true } | { deleted: false; reason: string };

/**
 * DUR-5184: delete a local branch after its worktree was removed. ONLY
 * `git branch -d`: git refuses unless the branch is fully merged (into its
 * upstream, else into the main checkout's HEAD), so an unmerged branch -- the
 * only copy of someone's commits if origin lacks them -- is always kept.
 * Never `-D`, never `--force`. Never throws.
 */
export async function deleteMergedLocalBranch(repoRoot: string, branchName: string | null): Promise<BranchDeletion> {
  if (!branchName) return { deleted: false, reason: "no branch recorded" };
  try {
    // Reject anything that is not a plain branch name (also blocks option injection like "-D").
    await git(["check-ref-format", "--branch", branchName], repoRoot);
    if (branchName.startsWith("-")) return { deleted: false, reason: "invalid branch name" };
    const exists = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`], repoRoot)
      .then((out) => out.trim().length > 0, () => false);
    if (!exists) return { deleted: false, reason: "branch does not exist locally" };
    await git(["branch", "-d", "--", branchName], repoRoot);
    return { deleted: true };
  } catch (err) {
    return { deleted: false, reason: firstLine(err) };
  }
}

export type WorktreeCleanupMode = "finished_task" | "merged_pr" | "idle_run";

export interface WorktreeCleanupCandidate {
  executionWorkspaceId: string;
  companyId: string;
  /** Issue the flag comment is posted on. Null for a run that never had an issue (nothing to comment on). */
  flagIssueId: string | null;
  flagIssueIdentifier: string | null;
  cwd: string;
  branchName: string | null;
  /** DUR-5184. Defaults to "finished_task". "merged_pr" keeps silently instead of flagging. */
  mode?: WorktreeCleanupMode;
}

export interface WorktreeCleanupDeps {
  listCandidates(now: Date, defaultRetentionDays: number): Promise<WorktreeCleanupCandidate[]>;
  /** DUR-5184: DB-backed deps only. */
  listMergedCandidates?(now: Date): Promise<WorktreeCleanupCandidate[]>;
  flagUnsavedWork(candidate: WorktreeCleanupCandidate, reason: string): Promise<void>;
  markCleaned(candidate: WorktreeCleanupCandidate, worktreePath: string, mode?: WorktreeCleanupMode): Promise<void>;
  evaluate?: typeof evaluateWorktreeForRemoval;
  remove?: typeof removeApprovedWorktree;
  deleteBranch?: typeof deleteMergedLocalBranch;
}

export interface WorktreeCleanupResult {
  considered: number;
  removed: number;
  kept: number;
  failed: number;
  /** DUR-5184: local branches deleted with `git branch -d` after their worktree was removed. */
  branchesDeleted: number;
  /** DUR-5236: dry run only -- worktrees that passed every safety check and would have been removed. */
  wouldRemove: number;
  /** DUR-5236: true when the per-sweep removal cap stopped the sweep early. */
  capped: boolean;
  dryRun: boolean;
}

export async function runWorktreeCleanup(
  deps: WorktreeCleanupDeps,
  opts: {
    now?: Date;
    defaultRetentionDays?: number;
    /** DUR-5236: evaluate everything but remove, flag, or mark nothing; report `wouldRemove`. */
    dryRun?: boolean;
    /** DUR-5236: stop after this many removals (default 25). */
    maxRemovals?: number;
  } = {},
): Promise<WorktreeCleanupResult> {
  const dryRun = opts.dryRun === true;
  const maxRemovals = Math.max(1, opts.maxRemovals ?? DEFAULT_WORKTREE_CLEANUP_MAX_REMOVALS_PER_SWEEP);
  const now = opts.now ?? new Date();
  const candidates = await deps.listCandidates(now, opts.defaultRetentionDays ?? DEFAULT_WORKTREE_CLEANUP_RETENTION_DAYS);
  const evaluate = deps.evaluate ?? evaluateWorktreeForRemoval;
  const remove = deps.remove ?? removeApprovedWorktree;
  const deleteBranch = deps.deleteBranch ?? deleteMergedLocalBranch;
  const fetchCache = new Map<string, Promise<string | null>>();
  const result: WorktreeCleanupResult = {
    considered: candidates.length,
    removed: 0,
    kept: 0,
    failed: 0,
    branchesDeleted: 0,
    wouldRemove: 0,
    capped: false,
    dryRun,
  };

  for (const candidate of candidates) {
    if (!dryRun && result.removed >= maxRemovals) {
      result.capped = true;
      break;
    }
    try {
      const mergedPass = candidate.mode === "merged_pr" || candidate.mode === "idle_run";
      const verdict = await evaluate(candidate.cwd, candidate.branchName, {
        requireMerged: candidate.mode === "merged_pr",
        requireUntouched: candidate.mode === "idle_run",
        fetchCache,
      });
      if (verdict.action === "keep") {
        result.kept += 1;
        if (!mergedPass && !dryRun) await deps.flagUnsavedWork(candidate, verdict.reason);
        continue;
      }
      if (dryRun) {
        result.wouldRemove += 1;
        continue;
      }
      try {
        await remove(verdict);
      } catch (err) {
        // git refused (e.g. raced with new changes) -> keep + flag, never force.
        result.kept += 1;
        if (!mergedPass) await deps.flagUnsavedWork(candidate, `git refused to remove the worktree (${firstLine(err)})`);
        continue;
      }
      result.removed += 1;
      const branch = await deleteBranch(verdict.repoRoot, candidate.branchName);
      if (branch.deleted) result.branchesDeleted += 1;
      else logger.info({ branchName: candidate.branchName, reason: branch.reason }, "Worktree removed; local branch kept");
      await deps.markCleaned(candidate, verdict.worktreePath, candidate.mode ?? "finished_task");
    } catch (err) {
      result.failed += 1;
      logger.warn({ err, executionWorkspaceId: candidate.executionWorkspaceId }, "Worktree cleanup failed for one workspace");
    }
  }
  return result;
}

/**
 * DB-backed deps. Bypass-scoped (plain Db) like the other retention sweeps:
 * one cross-company pass, with every row still carrying its own companyId.
 */
export function createDbWorktreeCleanupDeps(db: Db): WorktreeCleanupDeps {
  const issuesSvc = issueService(db);

  async function loadWorkspaceRows() {
    return db
      .select({
        id: executionWorkspaces.id,
        companyId: executionWorkspaces.companyId,
        sourceIssueId: executionWorkspaces.sourceIssueId,
        cwd: executionWorkspaces.cwd,
        branchName: executionWorkspaces.branchName,
        lastUsedAt: executionWorkspaces.lastUsedAt,
        retentionDays: companies.worktreeCleanupRetentionDays,
      })
      .from(executionWorkspaces)
      .innerJoin(companies, eq(companies.id, executionWorkspaces.companyId))
      .where(
        and(
          eq(executionWorkspaces.strategyType, "git_worktree"),
          // DUR-5236: heartbeat writes "git_worktree" for every worktree it creates; "local_fs"
          // is the column default and may exist on older rows. Accept both.
          inArray(executionWorkspaces.providerType, WORKTREE_PROVIDER_TYPES),
          ne(executionWorkspaces.status, "archived"),
          like(executionWorkspaces.cwd, "%/.paperclip/worktrees/%"),
        ),
      );
  }

  async function loadLinkedIssues(ws: { id: string; companyId: string; sourceIssueId: string | null }) {
    return db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        status: issues.status,
        completedAt: issues.completedAt,
        cancelledAt: issues.cancelledAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, ws.companyId),
          ws.sourceIssueId
            ? or(eq(issues.executionWorkspaceId, ws.id), eq(issues.id, ws.sourceIssueId))
            : eq(issues.executionWorkspaceId, ws.id),
        ),
      );
  }

  /**
   * DUR-5228: true when a queued or running heartbeat run is using this
   * workspace, either directly (its context names the workspace) or through a
   * linked issue it holds the checkout / execution lock on. `lastUsedAt` is only
   * stamped when a run starts, so it cannot prove a long run is finished.
   */
  async function hasLiveRun(
    ws: { id: string; companyId: string },
    linked: Array<{ id: string }>,
  ): Promise<boolean> {
    const live = ["queued", "running"];
    const direct = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, ws.companyId),
          inArray(heartbeatRuns.status, live),
          sql`${heartbeatRuns.contextSnapshot} ->> 'executionWorkspaceId' = ${ws.id}`,
        ),
      )
      .limit(1);
    if (direct.length > 0) return true;
    if (linked.length === 0) return false;
    const viaIssue = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .innerJoin(
        issues,
        or(eq(issues.executionRunId, heartbeatRuns.id), eq(issues.checkoutRunId, heartbeatRuns.id)),
      )
      .where(
        and(
          eq(heartbeatRuns.companyId, ws.companyId),
          inArray(heartbeatRuns.status, live),
          inArray(
            issues.id,
            linked.map((i) => i.id),
          ),
        ),
      )
      .limit(1);
    return viaIssue.length > 0;
  }

  async function listFinishedCandidates(now: Date, defaultRetentionDays: number): Promise<WorktreeCleanupCandidate[]> {
    const workspaces = await loadWorkspaceRows();
    const out: WorktreeCleanupCandidate[] = [];
    for (const ws of workspaces) {
      if (!ws.cwd) continue;
      const linked = await loadLinkedIssues(ws);
      const retentionDays = ws.retentionDays ?? defaultRetentionDays;
      const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1_000;

      if (linked.length === 0) {
        // DUR-5184: a run with no issue gets a private `run-<id>` worktree and nothing
        // else will ever mark it finished. Once it has sat unused for the retention
        // period it is eligible; every safety check still applies. Any other
        // worktree with no linked task still cannot be proven finished => left alone.
        if (ws.branchName?.startsWith("run-") && ws.lastUsedAt.getTime() <= cutoff) {
          out.push({
            executionWorkspaceId: ws.id,
            companyId: ws.companyId,
            flagIssueId: null,
            flagIssueIdentifier: null,
            cwd: ws.cwd,
            branchName: ws.branchName,
            mode: "finished_task",
          });
        }
        continue;
      }
      // Any non-terminal linked task => never touch.
      if (linked.some((i) => !TERMINAL_STATUSES.has(i.status))) continue;

      let eligible = true;
      for (const i of linked) {
        const terminalAt = i.status === "done" ? i.completedAt : i.cancelledAt;
        // Missing timestamp => cannot prove age => leave alone.
        if (!terminalAt || terminalAt.getTime() > cutoff) {
          eligible = false;
          break;
        }
      }
      if (!eligible) continue;

      const flagIssue = linked.find((i) => i.id === ws.sourceIssueId) ?? linked[0]!;
      out.push({
        executionWorkspaceId: ws.id,
        companyId: ws.companyId,
        flagIssueId: flagIssue.id,
        flagIssueIdentifier: flagIssue.identifier ?? null,
        cwd: ws.cwd,
        branchName: ws.branchName,
        mode: "finished_task",
      });
    }
    return out;
  }

  /**
   * DUR-5184: worktrees whose issues no longer need them (done/cancelled)
   * and that have been idle a while. Whether the branch is actually merged is
   * decided by git in `evaluateWorktreeForRemoval({ requireMerged })`, which keeps
   * everything else silently.
   */
  async function listMergedCandidates(now: Date): Promise<WorktreeCleanupCandidate[]> {
    const workspaces = await loadWorkspaceRows();
    const idleCutoff = now.getTime() - MERGED_WORKTREE_IDLE_MS;
    const out: WorktreeCleanupCandidate[] = [];
    for (const ws of workspaces) {
      if (!ws.cwd || !ws.branchName) continue;
      if (ws.lastUsedAt.getTime() > idleCutoff) continue;
      const linked = await loadLinkedIssues(ws);
      if (linked.length === 0) {
        // A private `run-<id>` folder of a run with no issue. Once its run has finished
        // and it has sat idle, it is removed if (and only if) it is clean and the
        // branch has no commit of its own; one with work in it waits for the retention pass.
        if (ws.branchName.startsWith("run-") && !(await hasLiveRun(ws, []))) {
          out.push({
            executionWorkspaceId: ws.id,
            companyId: ws.companyId,
            flagIssueId: null,
            flagIssueIdentifier: null,
            cwd: ws.cwd,
            branchName: ws.branchName,
            mode: "idle_run",
          });
        }
        continue;
      }
      if (linked.some((i) => !MERGED_PASS_SAFE_STATUSES.has(i.status))) continue;
      // A long run can outlive the idle window; never remove a folder a live run is still using.
      if (await hasLiveRun(ws, linked)) continue;
      const flagIssue = linked.find((i) => i.id === ws.sourceIssueId) ?? linked[0]!;
      out.push({
        executionWorkspaceId: ws.id,
        companyId: ws.companyId,
        flagIssueId: flagIssue.id,
        flagIssueIdentifier: flagIssue.identifier ?? null,
        cwd: ws.cwd,
        branchName: ws.branchName,
        mode: "merged_pr",
      });
    }
    return out;
  }

  return {
    listCandidates: listFinishedCandidates,
    listMergedCandidates,

    async flagUnsavedWork(candidate, reason) {
      if (!candidate.flagIssueId) {
        logger.info(
          { executionWorkspaceId: candidate.executionWorkspaceId, reason, cwd: candidate.cwd },
          "Worktree of an issue-less run kept; nothing to comment on",
        );
        return;
      }
      const flagIssueId = candidate.flagIssueId;
      const existing = await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.issueId, flagIssueId),
            like(issueComments.body, `${WORKTREE_UNSAVED_WORK_MARKER}%`),
          ),
        )
        .limit(1);
      if (existing.length > 0) return;
      const body = [
        WORKTREE_UNSAVED_WORK_MARKER,
        "**Has unsaved work — worktree kept.** The automatic cleanup of finished-task worktrees skipped this task's worktree so nothing is lost.",
        "",
        `- Reason: ${reason}`,
        `- Worktree: \`${candidate.cwd}\``,
        candidate.branchName ? `- Branch: \`${candidate.branchName}\`` : null,
        "",
        "A person needs to decide: push or commit the work, or discard it and remove the worktree manually. The cleanup re-checks daily and will remove it automatically once it is clean and fully pushed.",
      ].filter((l): l is string => l !== null).join("\n");
      await issuesSvc.addComment(flagIssueId, body, {}, { authorType: "system" });
      await logActivity(db, {
        companyId: candidate.companyId,
        actorType: "system",
        actorId: "worktree-cleanup",
        action: "worktree.cleanup_skipped_unsaved_work",
        entityType: "issue",
        entityId: flagIssueId,
        details: { executionWorkspaceId: candidate.executionWorkspaceId, reason, cwd: candidate.cwd },
      });
    },

    async markCleaned(candidate, worktreePath, mode = "finished_task") {
      const now = new Date();
      await db
        .update(executionWorkspaces)
        .set({
          status: "archived",
          closedAt: now,
          cleanupReason:
            mode === "merged_pr"
              ? "auto_cleanup_merged_pr"
              : mode === "idle_run"
                ? "auto_cleanup_idle_run"
                : "auto_cleanup_finished_task",
          updatedAt: now,
        })
        .where(
          and(
            eq(executionWorkspaces.id, candidate.executionWorkspaceId),
            eq(executionWorkspaces.companyId, candidate.companyId),
          ),
        );
      if (!candidate.flagIssueId) return;
      await logActivity(db, {
        companyId: candidate.companyId,
        actorType: "system",
        actorId: "worktree-cleanup",
        action: "worktree.cleanup_removed",
        entityType: "issue",
        entityId: candidate.flagIssueId,
        details: {
          executionWorkspaceId: candidate.executionWorkspaceId,
          worktreePath,
          branchName: candidate.branchName,
          reason: mode,
        },
      });
    },
  };
}

/** DUR-5184: the prompt pass -- same safety checks, candidates are worktrees of merged branches. */
export function createDbMergedWorktreeCleanupDeps(db: Db): WorktreeCleanupDeps {
  const base = createDbWorktreeCleanupDeps(db);
  return {
    ...base,
    listCandidates: (now) => base.listMergedCandidates!(now),
  };
}

export function startWorktreeCleanup(
  db: Db,
  intervalMs: number = DEFAULT_WORKTREE_CLEANUP_INTERVAL_MS,
  defaultRetentionDays: number = DEFAULT_WORKTREE_CLEANUP_RETENTION_DAYS,
  mergedIntervalMs: number = DEFAULT_MERGED_WORKTREE_SWEEP_INTERVAL_MS,
  options: { dryRun?: boolean; maxRemovals?: number } = {},
): () => void {
  const deps = createDbWorktreeCleanupDeps(db);
  const mergedDeps = createDbMergedWorktreeCleanupDeps(db);
  // One shared lock: the two passes never run at the same time.
  let running = false;
  const guarded = (label: string, run: () => Promise<WorktreeCleanupResult>) => () => {
    if (running) return;
    running = true;
    run()
      .then((r) => logger.info(r, `${label} finished`))
      .catch((err) => logger.warn({ err }, `${label} failed`))
      .finally(() => {
        running = false;
      });
  };
  const tick = guarded("Worktree cleanup sweep", () => runWorktreeCleanup(deps, { defaultRetentionDays, ...options }));
  const mergedTick = guarded("Merged-branch worktree sweep", () =>
    runWorktreeCleanup(mergedDeps, { defaultRetentionDays, ...options }),
  );
  const timer = setInterval(tick, intervalMs);
  const mergedTimer = setInterval(mergedTick, mergedIntervalMs);
  // First sweeps a bit after boot so they never compete with startup.
  const initial = setTimeout(tick, 5 * 60 * 1_000);
  const mergedInitial = setTimeout(mergedTick, 8 * 60 * 1_000);
  return () => {
    clearInterval(timer);
    clearInterval(mergedTimer);
    clearTimeout(initial);
    clearTimeout(mergedInitial);
  };
}
