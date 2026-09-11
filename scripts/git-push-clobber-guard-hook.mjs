#!/usr/bin/env node
/**
 * git-push-clobber-guard-hook.mjs
 *
 * Claude Code PreToolUse hook (matcher: Bash). Wired via .claude/settings.json.
 *
 * WHAT AND WHY (see DUR-3975 for the incident this came from). Agents do not
 * push through any Paperclip code — `scripts/check-no-git-push.mjs` forbids
 * `git push` anywhere in adapter or runtime source, so the only push path is the
 * agent typing `git push` into its own shell, authenticated by the image-wide
 * github.com credential helper. The four guards already wired around that
 * (pr-base-branch-guard, pr-open-merge-approval, github-workflow-scope-guard,
 * branch-push-duplicate-check) are all *PostToolUse*: they run after the push
 * and can only leave a comment. Nothing ever checked whether a push was a
 * fast-forward.
 *
 * The mechanism that leaves commits unreachable (this part is verified by the
 * test suite, which reproduces it): two agents work one branch from separate
 * checkouts, git rejects the second plain push as non-fast-forward, the agent
 * reads the rejection and reaches for `--force`, and the first agent's commits
 * stop being reachable from the branch. Anything that depended on one of those
 * commits — a migration whose parent lived there, for instance — is then broken
 * on a branch that still looks complete.
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

const GIT_PUSH_RE = /(^|[|&;()]|\s)git(\s+-[^\s]+(\s+[^\s-][^\s]*)?)*\s+push(\s|$)/;
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
not throwing away another agent's commits never gets a say. Commits another
agent pushed would stop being reachable, and the branch would still look
complete — anything that depended on one of them is quietly broken. See
DUR-3975.

Push with git instead, so the check runs.

${RECOVERY}`,

  no_verify: `BLOCKED: this push skips git's pre-push hooks (--no-verify).

That hook is the one thing standing between this push and silently discarding
commits another agent already put on the branch (that is the DUR-3975 failure).

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

Moving a shared branch to a history that does not contain what is already on it
leaves those commits unreachable while the branch still looks complete — see
DUR-3975.

${RECOVERY}

If the branch is genuinely yours alone and the rewrite is intended, say so on
the ticket and let the operator decide — do not force it from a run.`,
};

/**
 * Positions of the *unquoted* shell separators in `text` — the points where one
 * command ends and the next begins: `;` `\n` `&&` `||` `|` `&` `(` `)`.
 *
 * This exists because the flags above must only be read off the `git push`
 * command itself. Matching them against the whole line is wrong in both
 * directions, and both directions were live bugs:
 *
 *   * false negative — `head -n 20 log && git push --no-verify origin main`:
 *     grep/head/sed `-n` read as git push's `--dry-run` short flag, so the push
 *     was waved through and --no-verify (the one thing only this hook catches)
 *     went unchecked.
 *   * false positive — `rm -f /tmp/x && git push origin main`, or a
 *     `gh pr create -f` chained after the push: the unrelated `-f` read as
 *     `--force`, so an ordinary push was refused *and* told something untrue
 *     about why. That wedges normal work, which is worse than not guarding.
 *
 * Quoting is honoured so a separator inside `git commit -m "a && b"` does not
 * split the line.
 *
 * Known gap, unchanged by this scoping and left alone on purpose: GIT_PUSH_RE
 * only recognises `git push` at the start of a word, so a push wrapped in a
 * quoted subshell string (`sh -c 'git push --no-verify …'`) is not seen here.
 * Matching inside quotes would also match prose about pushing, and refusing an
 * innocent command with a false explanation is the worse failure. The pre-push
 * hook still covers the quoted case for everything except `--no-verify`.
 *
 * @param {string} text
 * @returns {Array<[number, number]>} [start, end) of each separator
 */
/**
 * The spans of `text` that sit inside single or double quotes.
 *
 * A `git push --force` inside quotes is TEXT ABOUT a push, not a push: a commit
 * message, a PR body, a heredoc line, a grep pattern. Refusing those blocks
 * ordinary work and tells the agent something untrue about what it just ran —
 * and this branch's own commit messages and docs are full of the literal string
 * `git push --force`, so the guard would have refused the work that built it.
 *
 * A false refusal is worse than a gap: the gap loses a guard, the false refusal
 * wedges the fleet and teaches agents the tool is lying to them.
 */
function quotedRanges(text) {
  const ranges = [];
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (quote === '"' && ch === "\\") i += 1;
      else if (ch === quote) {
        ranges.push([start, i + 1]);
        quote = null;
      }
      continue;
    }
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      start = i;
    }
  }
  // An unterminated quote runs to the end of the command.
  if (quote !== null) ranges.push([start, text.length]);
  return ranges;
}

function isInside(ranges, index) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function separatorRanges(text) {
  const ranges = [];
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (quote === '"' && ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "(" || ch === ")") {
      ranges.push([i, i + 1]);
      continue;
    }
    if (ch === "&" || ch === "|") {
      const width = text[i + 1] === ch ? 2 : 1;
      ranges.push([i, i + width]);
      i += width - 1;
    }
  }
  return ranges;
}

/**
 * The single shell command containing the `git` at `gitIndex`: from the end of
 * the preceding unquoted separator to the start of the following one.
 *
 * It starts at the command, not at the word `git`, so a `GIT_CONFIG_*=…` env
 * prefix and a `git -c core.hooksPath=… push` flag are both inside the slice —
 * those legitimately sit before the word `push` and must still be checked.
 */
function commandSegment(text, separators, gitIndex) {
  let start = 0;
  let end = text.length;
  for (const [sepStart, sepEnd] of separators) {
    if (sepEnd <= gitIndex) start = Math.max(start, sepEnd);
    else if (sepStart >= gitIndex) {
      end = sepStart;
      break;
    }
  }
  return text.slice(start, end);
}

/** Classify one `git push` command, with nothing else on the line in scope. */
function classifyPushSegment(segment, context) {
  // `-n` is git push's short flag for --dry-run (--no-verify has no short
  // form). A dry run changes nothing on the remote, so nothing below applies.
  if (DRY_RUN_RE.test(segment)) return { blocked: false, reason: null };

  if (NO_VERIFY_RE.test(segment)) return { blocked: true, reason: "no_verify" };
  if (HOOKS_PATH_OVERRIDE_RE.test(segment)) return { blocked: true, reason: "hooks_path_override" };

  const forceShaped = FORCE_SHAPED_RES.some((pattern) => pattern.test(segment));
  if (forceShaped && context.prePushGuardActive !== true) {
    return { blocked: true, reason: "force_without_guard" };
  }

  return { blocked: false, reason: null };
}

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

  const separators = separatorRanges(text);
  const quoted = quotedRanges(text);
  const pushRe = new RegExp(GIT_PUSH_RE.source, "g");
  // A line can chain more than one push (`git push --dry-run … && git push
  // --force …`); each is judged on its own, and the first refusal wins.
  for (let match = pushRe.exec(text); match !== null; match = pushRe.exec(text)) {
    const gitIndex = match.index + match[1].length;
    // Inside quotes it is text about a push, not a push. See quotedRanges.
    if (isInside(quoted, gitIndex)) {
      if (pushRe.lastIndex <= match.index) pushRe.lastIndex = match.index + 1;
      continue;
    }
    const verdict = classifyPushSegment(commandSegment(text, separators, gitIndex), context);
    if (verdict.blocked) return verdict;
    if (pushRe.lastIndex <= match.index) pushRe.lastIndex = match.index + 1;
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
