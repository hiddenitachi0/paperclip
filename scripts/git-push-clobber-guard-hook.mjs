#!/usr/bin/env node
/**
 * git-push-clobber-guard-hook.mjs
 *
 * Claude Code PreToolUse hook (matcher: Bash). Wired via .claude/settings.json.
 *
 * WHAT AND WHY (DUR-3975). Agents do not push through any Paperclip code —
 * `scripts/check-no-git-push.mjs` forbids `git push` anywhere in adapter or
 * runtime source, so the only push path is the agent typing `git push` into its
 * own shell, authenticated by the image-wide github.com credential helper. The
 * four guards already wired around that (pr-base-branch-guard,
 * pr-open-merge-approval, github-workflow-scope-guard,
 * branch-push-duplicate-check) are all *PostToolUse*: they run after the push
 * and can only leave a comment. Nothing ever checked whether a push was a
 * fast-forward, so when two agents worked one branch from separate checkouts,
 * git rejected the second plain push, the agent reached for `--force`, and the
 * first agent's commits stopped being reachable — including the parent of a
 * Django migration, which is why an approved deploy rolled back with
 * NodeNotFoundError.
 *
 * The real fix is the git `pre-push` guard installed image-wide via
 * core.hooksPath (scripts/paperclip-git-pre-push-guard.sh, wired in the
 * Dockerfile): `--force` and `--force-with-lease` do not skip pre-push hooks,
 * so it cannot be argued with. This hook closes the ways around it, which are
 * all things the agent types and can therefore be stopped before they run:
 *
 *   1. `git push --no-verify`, which skips every pre-push hook.
 *   2. `git push -c core.hooksPath=...` / GIT_CONFIG_* overrides, which point
 *      git at a different (empty) hooks directory.
 *   3. `gh api --method PATCH .../git/refs/heads/<b> -F force=true`, which moves
 *      the branch without git running at all.
 *   4. A force-shaped push in a checkout where no pre-push guard is installed
 *      (outside the agent image, or a repo that sets its own core.hooksPath):
 *      refuse rather than trust a safety net that is not there.
 *
 * Exit 2 on a PreToolUse hook blocks the tool call and feeds stderr back to the
 * agent, so every refusal below ends with the commands that make the push
 * legal. Any other exit code lets the command run.
 *
 * Written in Node rather than bash like its PostToolUse siblings so the
 * decision is a pure function the test suite can exercise directly (and so the
 * hook does not depend on `jq` being installed).
 */

import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import process from "node:process";

const RECOVERY = `Integrate what is already on the branch, then push normally:
  git fetch <remote>
  git rebase <remote>/<branch>      # or: git merge <remote>/<branch>
  # resolve any conflicts, re-run the tests, then:
  git push <remote> HEAD:<branch>`;

const GIT_PUSH_RE = /(^|[|&;(]|\s)git(\s+-[^\s]+(\s+[^\s-][^\s]*)?)*\s+push(\s|$)/;
const DRY_RUN_RE = /(^|\s)(--dry-run|-n)(\s|$)/;
const NO_VERIFY_RE = /(^|\s)--no-verify(\s|$)/;
const HOOKS_PATH_OVERRIDE_RE = /core\.hookspath|GIT_CONFIG_COUNT=|GIT_CONFIG_KEY_\d/i;
const FORCE_SHAPED_RES = [
  /(^|\s)(--force|--force-with-lease(=\S*)?|--force-if-includes|-f|--mirror|--delete|-d)(\s|$)/,
  /(^|\s)\+[A-Za-z0-9_.\/-]+:/,
  /(^|\s):[A-Za-z0-9_.\/-]+(\s|$)/,
];
const GH_API_RE = /(^|[|&;(]|\s)gh\s+api(\s|$)/;
const GH_REF_RE = /git\/refs?\/heads\//;
const GH_FORCE_RE = /force[^A-Za-z0-9]+(true|1)\b|"force"\s*:\s*true/i;

export const BLOCK_REASONS = {
  gh_api_force_ref: `BLOCKED: this updates a branch through the GitHub API with force=true.

That moves the branch without git ever running, so the guard that checks you are
not throwing away another agent's commits never gets a say. DUR-3975 is exactly
that outcome: a migration's parent commit vanished from a shared branch, and the
deploy approved on top of it could not apply.

Push with git instead, so the check runs.

${RECOVERY}`,

  no_verify: `BLOCKED: this push skips git's pre-push hooks (--no-verify).

That hook is the one thing standing between this push and silently discarding
commits another agent already put on the branch (DUR-3975 — a migration's parent
commit was lost that way, and the deploy built on it rolled back).

Run the push without --no-verify. If it is then refused, the refusal text names
the commits you would have dropped and how to keep them.

${RECOVERY}`,

  hooks_path_override: `BLOCKED: this push changes where git looks for hooks, which turns off the
pre-push guard that stops one agent discarding another agent's commits
(DUR-3975).

Run the push without touching core.hooksPath / GIT_CONFIG_*.

${RECOVERY}`,

  force_without_guard: `BLOCKED: this is a force push (or a branch delete), and this checkout has no
pre-push guard installed — so nothing here can tell whether it would throw away
commits another agent already pushed.

That is the DUR-3975 failure: a shared branch was moved to a history missing a
migration's parent commit, and the deploy approved on top of it rolled back.

${RECOVERY}

If the branch is genuinely yours alone and the rewrite is intended, say so on
the ticket and let the operator decide — do not force it from a run.`,
};

/**
 * Decide what to do with one Bash command.
 *
 * @param {string} command raw Bash command the agent is about to run
 * @param {{ prePushGuardActive?: boolean }} context
 * @returns {{ blocked: boolean, reason: string | null }}
 */
export function classifyPushCommand(command, context = {}) {
  const text = typeof command === "string" ? command : "";
  if (!text.trim()) return { blocked: false, reason: null };

  // The GitHub-API path is not a git push at all, so it is checked first and
  // independently of the git-push shape below.
  if (GH_API_RE.test(text) && GH_REF_RE.test(text) && GH_FORCE_RE.test(text)) {
    return { blocked: true, reason: "gh_api_force_ref" };
  }

  if (!GIT_PUSH_RE.test(text)) return { blocked: false, reason: null };

  // `-n` is git push's short flag for --dry-run (--no-verify has no short
  // form). A dry run changes nothing on the remote, so nothing below applies.
  if (DRY_RUN_RE.test(text)) return { blocked: false, reason: null };

  if (NO_VERIFY_RE.test(text)) return { blocked: true, reason: "no_verify" };
  if (HOOKS_PATH_OVERRIDE_RE.test(text)) return { blocked: true, reason: "hooks_path_override" };

  const forceShaped = FORCE_SHAPED_RES.some((pattern) => pattern.test(text));
  if (forceShaped && context.prePushGuardActive !== true) {
    return { blocked: true, reason: "force_without_guard" };
  }

  return { blocked: false, reason: null };
}

/**
 * Is a pre-push hook actually installed for the checkout at `cwd`?
 *
 * `git rev-parse --git-path hooks/pre-push` honours core.hooksPath at every
 * level, so this answers "would a pre-push hook run here", not "does
 * .git/hooks/pre-push exist".
 */
export function detectPrePushGuard(cwd, run = defaultGitRun) {
  let hookPath;
  try {
    hookPath = run(["rev-parse", "--git-path", "hooks/pre-push"], cwd).trim();
  } catch {
    return false;
  }
  if (!hookPath) return false;
  try {
    accessSync(path.resolve(cwd, hookPath), constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultGitRun(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function isMainModule() {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("git-push-clobber-guard-hook.mjs");
}

if (isMainModule()) {
  const raw = await readStdin();
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  if (!payload || typeof payload !== "object" || payload.tool_name !== "Bash") process.exit(0);

  const command = payload.tool_input?.command;
  if (typeof command !== "string" || command.trim().length === 0) process.exit(0);

  const cwd = typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : process.cwd();
  const verdict = classifyPushCommand(command, {
    prePushGuardActive: detectPrePushGuard(cwd),
  });
  if (!verdict.blocked) process.exit(0);

  process.stderr.write(`${BLOCK_REASONS[verdict.reason]}\n`);
  process.exit(2);
}
