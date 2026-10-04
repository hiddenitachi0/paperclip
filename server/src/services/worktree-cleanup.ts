import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq, like, ne, or } from "drizzle-orm";
import { companies, executionWorkspaces, issueComments, issues, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { issueService } from "./issues.js";
import { serverChildProcessEnv } from "./runtime-env.js";

const execFileAsync = promisify(execFile);

/** Days a task must have been done/cancelled before its worktree is eligible. */
export const DEFAULT_WORKTREE_CLEANUP_RETENTION_DAYS = 7;
export const DEFAULT_WORKTREE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;

const GIT_TIMEOUT_MS = 60_000;
const GIT_FETCH_TIMEOUT_MS = 120_000;

/** First line of the "has unsaved work" flag comment; also the de-dupe key. */
export const WORKTREE_UNSAVED_WORK_MARKER = "<!-- worktree-cleanup:unsaved-work -->";

const TERMINAL_STATUSES = new Set(["done", "cancelled"]);

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
 *     The branch ref is never deleted.
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
export async function evaluateWorktreeForRemoval(
  cwd: string,
  branchName: string | null,
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
    try {
      await git(["fetch", "--prune", "--quiet", "origin"], worktreePath, GIT_FETCH_TIMEOUT_MS);
    } catch (err) {
      return {
        action: "keep",
        reason: `could not refresh origin to verify pushed commits (${firstLine(err)})`,
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

export interface WorktreeCleanupCandidate {
  executionWorkspaceId: string;
  companyId: string;
  /** Issue the flag comment is posted on. */
  flagIssueId: string;
  flagIssueIdentifier: string | null;
  cwd: string;
  branchName: string | null;
}

export interface WorktreeCleanupDeps {
  listCandidates(now: Date, defaultRetentionDays: number): Promise<WorktreeCleanupCandidate[]>;
  flagUnsavedWork(candidate: WorktreeCleanupCandidate, reason: string): Promise<void>;
  markCleaned(candidate: WorktreeCleanupCandidate, worktreePath: string): Promise<void>;
  evaluate?: typeof evaluateWorktreeForRemoval;
  remove?: typeof removeApprovedWorktree;
}

export interface WorktreeCleanupResult {
  considered: number;
  removed: number;
  kept: number;
  failed: number;
}

export async function runWorktreeCleanup(
  deps: WorktreeCleanupDeps,
  opts: { now?: Date; defaultRetentionDays?: number } = {},
): Promise<WorktreeCleanupResult> {
  const now = opts.now ?? new Date();
  const candidates = await deps.listCandidates(now, opts.defaultRetentionDays ?? DEFAULT_WORKTREE_CLEANUP_RETENTION_DAYS);
  const evaluate = deps.evaluate ?? evaluateWorktreeForRemoval;
  const remove = deps.remove ?? removeApprovedWorktree;
  const result: WorktreeCleanupResult = { considered: candidates.length, removed: 0, kept: 0, failed: 0 };

  for (const candidate of candidates) {
    try {
      const verdict = await evaluate(candidate.cwd, candidate.branchName);
      if (verdict.action === "keep") {
        result.kept += 1;
        await deps.flagUnsavedWork(candidate, verdict.reason);
        continue;
      }
      try {
        await remove(verdict);
      } catch (err) {
        // git refused (e.g. raced with new changes) -> keep + flag, never force.
        result.kept += 1;
        await deps.flagUnsavedWork(candidate, `git refused to remove the worktree (${firstLine(err)})`);
        continue;
      }
      result.removed += 1;
      await deps.markCleaned(candidate, verdict.worktreePath);
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

  return {
    async listCandidates(now, defaultRetentionDays) {
      const workspaces = await db
        .select({
          id: executionWorkspaces.id,
          companyId: executionWorkspaces.companyId,
          sourceIssueId: executionWorkspaces.sourceIssueId,
          cwd: executionWorkspaces.cwd,
          branchName: executionWorkspaces.branchName,
          retentionDays: companies.worktreeCleanupRetentionDays,
        })
        .from(executionWorkspaces)
        .innerJoin(companies, eq(companies.id, executionWorkspaces.companyId))
        .where(
          and(
            eq(executionWorkspaces.strategyType, "git_worktree"),
            eq(executionWorkspaces.providerType, "local_fs"),
            ne(executionWorkspaces.status, "archived"),
            like(executionWorkspaces.cwd, "%/.paperclip/worktrees/%"),
          ),
        );

      const out: WorktreeCleanupCandidate[] = [];
      for (const ws of workspaces) {
        if (!ws.cwd) continue;
        const linked = await db
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
        // No linked task => cannot prove it is finished => leave alone.
        if (linked.length === 0) continue;
        // Any non-terminal linked task => never touch.
        if (linked.some((i) => !TERMINAL_STATUSES.has(i.status))) continue;

        const retentionDays = ws.retentionDays ?? defaultRetentionDays;
        const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1_000;
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
        });
      }
      return out;
    },

    async flagUnsavedWork(candidate, reason) {
      const existing = await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.issueId, candidate.flagIssueId),
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
      await issuesSvc.addComment(candidate.flagIssueId, body, {}, { authorType: "system" });
      await logActivity(db, {
        companyId: candidate.companyId,
        actorType: "system",
        actorId: "worktree-cleanup",
        action: "worktree.cleanup_skipped_unsaved_work",
        entityType: "issue",
        entityId: candidate.flagIssueId,
        details: { executionWorkspaceId: candidate.executionWorkspaceId, reason, cwd: candidate.cwd },
      });
    },

    async markCleaned(candidate, worktreePath) {
      const now = new Date();
      await db
        .update(executionWorkspaces)
        .set({
          status: "archived",
          closedAt: now,
          cleanupReason: "auto_cleanup_finished_task",
          updatedAt: now,
        })
        .where(
          and(
            eq(executionWorkspaces.id, candidate.executionWorkspaceId),
            eq(executionWorkspaces.companyId, candidate.companyId),
          ),
        );
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
        },
      });
    },
  };
}

export function startWorktreeCleanup(
  db: Db,
  intervalMs: number = DEFAULT_WORKTREE_CLEANUP_INTERVAL_MS,
  defaultRetentionDays: number = DEFAULT_WORKTREE_CLEANUP_RETENTION_DAYS,
): () => void {
  const deps = createDbWorktreeCleanupDeps(db);
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    runWorktreeCleanup(deps, { defaultRetentionDays })
      .then((r) => logger.info(r, "Worktree cleanup sweep finished"))
      .catch((err) => logger.warn({ err }, "Worktree cleanup sweep failed"))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, intervalMs);
  // First sweep a bit after boot so it never competes with startup.
  const initial = setTimeout(tick, 5 * 60 * 1_000);
  return () => {
    clearInterval(timer);
    clearTimeout(initial);
  };
}
