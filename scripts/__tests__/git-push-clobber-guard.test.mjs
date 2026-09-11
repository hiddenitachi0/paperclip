/**
 * Tests for the DUR-3975 push-clobber guards.
 *
 * Two layers are under test:
 *   1. scripts/paperclip-git-pre-push-guard.sh — the git pre-push hook installed
 *      image-wide via core.hooksPath (Dockerfile). This is the layer that makes
 *      losing another agent's commits unrepresentable, so it is tested against
 *      real repositories and real pushes, including a negative control that
 *      shows the clobber happening when the guard is not installed.
 *   2. scripts/git-push-clobber-guard-hook.mjs — the Claude Code PreToolUse hook
 *      that closes the ways around the pre-push hook.
 *
 * Plus the wiring: a guard that exists but is not installed protects nothing,
 * and "a list of scripts" and "a list of places that reference them" drifting
 * apart with nothing enforcing it is the exact bug class this repo keeps
 * hitting — so the install points are asserted against the files on disk.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BLOCK_REASONS, classifyPushCommand } from "../git-push-clobber-guard-hook.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const PRE_PUSH_GUARD = path.join(REPO_ROOT, "scripts", "paperclip-git-pre-push-guard.sh");
const PRETOOL_HOOK = path.join(REPO_ROOT, "scripts", "git-push-clobber-guard-hook.mjs");
const SETTINGS_PATH = path.join(REPO_ROOT, ".claude", "settings.json");
const DOCKERFILE_PATH = path.join(REPO_ROOT, "Dockerfile");
const PR_WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "pr.yml");

const tempRoots = [];
test.after(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

function gitEnv(root) {
  return {
    ...process.env,
    // Isolate from the developer's own git config, and use the *system* config
    // file for the hooks path so the test exercises the same precedence level
    // the Dockerfile installs at.
    GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
    GIT_CONFIG_SYSTEM: path.join(root, "systemconfig"),
    GIT_AUTHOR_NAME: "Test Agent",
    GIT_AUTHOR_EMAIL: "agent@example.invalid",
    GIT_COMMITTER_NAME: "Test Agent",
    GIT_COMMITTER_EMAIL: "agent@example.invalid",
  };
}

function git(root, cwd, args) {
  return execFileSync("git", args, {
    cwd,
    env: gitEnv(root),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitAttempt(root, cwd, args) {
  try {
    const stdout = git(root, cwd, args);
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

/**
 * Two agents, two checkouts, one shared branch — the DUR-3975 shape.
 *
 * `guard` decides whether the pre-push hook is installed, so the same scenario
 * can be run with and without it.
 */
function buildWorld({ guard }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-push-clobber-"));
  tempRoots.push(root);
  writeFileSync(path.join(root, "gitconfig"), "");
  writeFileSync(path.join(root, "systemconfig"), "");

  if (guard) {
    const hooksDir = path.join(root, "githooks");
    mkdirSync(hooksDir, { recursive: true });
    const installed = path.join(hooksDir, "pre-push");
    copyFileSync(PRE_PUSH_GUARD, installed);
    chmodSync(installed, 0o755);
    git(root, root, ["config", "--system", "core.hooksPath", hooksDir]);
  }

  const origin = path.join(root, "origin.git");
  git(root, root, ["init", "--quiet", "--bare", "--initial-branch", "main", origin]);

  const alice = path.join(root, "alice");
  git(root, root, ["clone", "--quiet", origin, alice]);
  writeFileSync(path.join(alice, "README"), "base\n");
  git(root, alice, ["add", "-A"]);
  git(root, alice, ["commit", "--quiet", "-m", "base"]);
  git(root, alice, ["push", "--quiet", "-u", "origin", "main"]);

  // Alice opens the shared branch and lands the parent migration on it.
  git(root, alice, ["checkout", "--quiet", "-b", "shared"]);
  writeFileSync(path.join(alice, "0022_parent.py"), "parent\n");
  git(root, alice, ["add", "-A"]);
  git(root, alice, ["commit", "--quiet", "-m", "Alice: migration 0022"]);
  git(root, alice, ["push", "--quiet", "-u", "origin", "shared"]);
  const aliceCommit = git(root, alice, ["rev-parse", "HEAD"]).trim();

  // Bob clones and checks the branch out, then Alice pushes once more — so
  // Bob's checkout is a working copy that has never seen Alice's latest commit.
  const bob = path.join(root, "bob");
  git(root, root, ["clone", "--quiet", origin, bob]);
  git(root, bob, ["checkout", "--quiet", "shared"]);

  writeFileSync(path.join(alice, "0022_parent_fix.py"), "fix\n");
  git(root, alice, ["add", "-A"]);
  git(root, alice, ["commit", "--quiet", "-m", "Alice: fix migration 0022"]);
  git(root, alice, ["push", "--quiet", "origin", "shared"]);
  const aliceLatest = git(root, alice, ["rev-parse", "HEAD"]).trim();

  // Bob rebuilds the branch from the base and writes a migration whose parent
  // is the migration Alice pushed — the commit that must not be lost.
  git(root, bob, ["reset", "--quiet", "--hard", "origin/main"]);
  writeFileSync(path.join(bob, "0023_child.py"), "depends_on 0022\n");
  git(root, bob, ["add", "-A"]);
  git(root, bob, ["commit", "--quiet", "-m", "Bob: migration 0023"]);

  return { root, origin, alice, bob, aliceCommit, aliceLatest };
}

function originBranchContains(world, commit) {
  const result = gitAttempt(world.root, world.origin, [
    "merge-base",
    "--is-ancestor",
    commit,
    "refs/heads/shared",
  ]);
  return result.ok;
}

test("negative control: with no pre-push guard, a force push silently deletes the other agent's commits", () => {
  const world = buildWorld({ guard: false });
  const push = gitAttempt(world.root, world.bob, ["push", "--force", "origin", "shared"]);

  assert.equal(push.ok, true, "without the guard the clobbering push succeeds");
  assert.equal(
    originBranchContains(world, world.aliceLatest),
    false,
    "and Alice's commit is no longer reachable from the shared branch — the DUR-3975 outcome",
  );
});

test("guard refuses a force push that would drop commits this checkout has never seen", () => {
  const world = buildWorld({ guard: true });
  const push = gitAttempt(world.root, world.bob, ["push", "--force", "origin", "shared"]);

  assert.equal(push.ok, false, "the push must be refused");
  assert.match(push.stderr, /REFUSED/);
  assert.match(push.stderr, /has never seen that commit/);
  assert.match(push.stderr, /git fetch origin/);
  assert.match(push.stderr, /git rebase origin\/shared/);
  assert.equal(
    originBranchContains(world, world.aliceLatest),
    true,
    "the other agent's commit is still on the branch",
  );
});

test("guard refuses --force-with-lease too, and names the commits that would be lost", () => {
  const world = buildWorld({ guard: true });
  git(world.root, world.bob, ["fetch", "--quiet", "origin"]);

  const push = gitAttempt(world.root, world.bob, ["push", "--force-with-lease", "origin", "shared"]);

  assert.equal(push.ok, false);
  assert.match(push.stderr, /would stop being reachable/);
  assert.match(push.stderr, /Alice: fix migration 0022/);
  assert.match(push.stderr, /Alice: migration 0022/);
  assert.equal(originBranchContains(world, world.aliceLatest), true);
});

test("guard refuses a +refspec force push", () => {
  const world = buildWorld({ guard: true });
  git(world.root, world.bob, ["fetch", "--quiet", "origin"]);

  const push = gitAttempt(world.root, world.bob, ["push", "origin", "+HEAD:refs/heads/shared"]);

  assert.equal(push.ok, false);
  assert.match(push.stderr, /REFUSED/);
  assert.equal(originBranchContains(world, world.aliceLatest), true);
});

test("integrating first turns the refused push into an accepted one, keeping both agents' work", () => {
  const world = buildWorld({ guard: true });

  git(world.root, world.bob, ["fetch", "--quiet", "origin"]);
  git(world.root, world.bob, ["rebase", "--quiet", "origin/shared"]);
  const push = gitAttempt(world.root, world.bob, ["push", "origin", "HEAD:shared"]);

  assert.equal(push.ok, true, `the fast-forward push must be accepted: ${push.stderr}`);
  assert.equal(originBranchContains(world, world.aliceLatest), true, "Alice's work survived");
  const log = git(world.root, world.origin, ["log", "--oneline", "--no-decorate", "refs/heads/shared"]);
  assert.match(log, /Bob: migration 0023/, "Bob's work landed");
});

test("guard allows a brand-new branch: there is nothing on the remote to lose", () => {
  const world = buildWorld({ guard: true });
  const push = gitAttempt(world.root, world.bob, ["push", "origin", "HEAD:refs/heads/bob-only"]);
  assert.equal(push.ok, true, push.stderr);
});

test("guard refuses deleting a shared branch", () => {
  const world = buildWorld({ guard: true });
  const push = gitAttempt(world.root, world.bob, ["push", "origin", "--delete", "shared"]);

  assert.equal(push.ok, false);
  assert.match(push.stderr, /REFUSED: deleting branch "shared"/);
  assert.equal(originBranchContains(world, world.aliceLatest), true);
});

test("guard still runs a repository's own pre-push hook instead of hiding it", () => {
  const world = buildWorld({ guard: true });
  const marker = path.join(world.root, "local-hook-ran");
  const localHook = path.join(world.bob, ".git", "hooks", "pre-push");
  mkdirSync(path.dirname(localHook), { recursive: true });
  writeFileSync(localHook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 0\n`);
  chmodSync(localHook, 0o755);

  const push = gitAttempt(world.root, world.bob, ["push", "origin", "HEAD:refs/heads/bob-only"]);

  assert.equal(push.ok, true, push.stderr);
  assert.equal(existsSync(marker), true, "the repository's own pre-push hook must still run");
});

test("a repository's own pre-push hook can still refuse a push the guard allows", () => {
  const world = buildWorld({ guard: true });
  const localHook = path.join(world.bob, ".git", "hooks", "pre-push");
  mkdirSync(path.dirname(localHook), { recursive: true });
  writeFileSync(localHook, `#!/bin/sh\necho "local hook says no" >&2\nexit 1\n`);
  chmodSync(localHook, 0o755);

  const push = gitAttempt(world.root, world.bob, ["push", "origin", "HEAD:refs/heads/bob-only"]);

  assert.equal(push.ok, false);
  assert.match(push.stderr, /local hook says no/);
});

test("classifier: ordinary pushes and unrelated commands are left alone", () => {
  for (const command of [
    "git push origin main",
    "git push -u origin build/dur3975-push-clobber",
    "echo hi && git push origin HEAD:shared",
    "ls -la",
    "npm run build",
    "git fetch origin && git rebase origin/shared",
  ]) {
    assert.deepEqual(
      classifyPushCommand(command, { prePushGuardActive: true }),
      { blocked: false, reason: null },
      `expected to allow: ${command}`,
    );
  }
});

test("classifier: blocks the ways around the pre-push guard", () => {
  const cases = [
    ["git push --no-verify origin shared", "no_verify"],
    ["git -c core.hooksPath=/tmp/empty push --force origin shared", "hooks_path_override"],
    ["GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/tmp/x git push origin shared", "hooks_path_override"],
    [
      "gh api --method PATCH repos/o/r/git/refs/heads/shared -f sha=deadbeef -F force=true",
      "gh_api_force_ref",
    ],
    ['gh api -X PATCH /repos/o/r/git/refs/heads/shared --input - <<< \'{"sha":"x","force":true}\'', "gh_api_force_ref"],
  ];
  for (const [command, reason] of cases) {
    assert.deepEqual(
      classifyPushCommand(command, { prePushGuardActive: true }),
      { blocked: true, reason },
      `expected to block: ${command}`,
    );
  }
});

test("classifier: a force push is blocked when no pre-push guard is installed, allowed when one is", () => {
  const command = "git push --force origin shared";
  assert.deepEqual(classifyPushCommand(command, { prePushGuardActive: false }), {
    blocked: true,
    reason: "force_without_guard",
  });
  assert.deepEqual(classifyPushCommand(command, { prePushGuardActive: true }), {
    blocked: false,
    reason: null,
  });
});

test("classifier: --dry-run changes nothing on the remote, so it is never blocked", () => {
  for (const command of ["git push --dry-run --force origin shared", "git push -n --force origin shared"]) {
    assert.deepEqual(classifyPushCommand(command, { prePushGuardActive: false }), {
      blocked: false,
      reason: null,
    });
  }
});

// --- the flags must be read off the `git push` command, not off the whole line -

test("classifier: -n belonging to another command is not git push's --dry-run", () => {
  // The serious one. `-n` is grep's/head's/sed's flag far more often than it is
  // git push's, and reading it as --dry-run waved the push through — including
  // --no-verify, which is the only thing this layer catches at all.
  assert.deepEqual(
    classifyPushCommand("head -n 20 log && git push --no-verify origin main", {
      prePushGuardActive: true,
    }),
    { blocked: true, reason: "no_verify" },
  );
  assert.deepEqual(
    classifyPushCommand("grep -n foo file && git push --force origin main", {
      prePushGuardActive: false,
    }),
    { blocked: true, reason: "force_without_guard" },
  );
  assert.deepEqual(
    classifyPushCommand("sed -n '1,5p' notes.txt; git push --no-verify origin main", {
      prePushGuardActive: true,
    }),
    { blocked: true, reason: "no_verify" },
  );
});

test("classifier: a -f or --delete belonging to another command is not a force push", () => {
  // Blocking a legitimate push *and* telling the agent "this is a force push"
  // when it is not is worse than not guarding: it wedges ordinary work with a
  // false explanation. Checked with no pre-push guard installed, which is the
  // state every checkout is in between merge and the image rebuild.
  for (const command of [
    "git commit -m x && git push -u origin HEAD && gh pr create -f",
    "rm -f /tmp/x && git push origin main",
    "git push origin main && rm -rf node_modules/.cache",
    "kubectl delete pod x || git push origin HEAD:shared",
    'git commit -m "drop -f support" && git push origin main',
  ]) {
    assert.deepEqual(
      classifyPushCommand(command, { prePushGuardActive: false }),
      { blocked: false, reason: null },
      `expected to allow: ${command}`,
    );
  }
});

test("classifier: each push on a chained line is judged on its own", () => {
  // A harmless dry run earlier on the line must not excuse a real force push
  // later on it.
  assert.deepEqual(
    classifyPushCommand("git push --dry-run origin main && git push --force origin main", {
      prePushGuardActive: false,
    }),
    { blocked: true, reason: "force_without_guard" },
  );
  assert.deepEqual(
    classifyPushCommand("git push origin main || git push --no-verify --force origin main", {
      prePushGuardActive: true,
    }),
    { blocked: true, reason: "no_verify" },
  );
});

test("classifier: a separator inside quotes does not split the command", () => {
  assert.deepEqual(
    classifyPushCommand('git commit -m "a && b" && git push --no-verify origin main', {
      prePushGuardActive: true,
    }),
    { blocked: true, reason: "no_verify" },
  );
  assert.deepEqual(
    classifyPushCommand("git commit -m 'x; y' ; git push --force origin main", {
      prePushGuardActive: false,
    }),
    { blocked: true, reason: "force_without_guard" },
  );
});

test("classifier: an env/-c hooks-path override still counts, sitting before the word push", () => {
  // These legitimately appear before `git`, so the slice has to start at the
  // command, not at the word `git push`.
  assert.deepEqual(
    classifyPushCommand("echo hi && GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/tmp/x git push origin shared", {
      prePushGuardActive: true,
    }),
    { blocked: true, reason: "hooks_path_override" },
  );
  assert.deepEqual(
    classifyPushCommand("cd repo && git -c core.hooksPath=/tmp/empty push origin shared", {
      prePushGuardActive: true,
    }),
    { blocked: true, reason: "hooks_path_override" },
  );
  // But the same words in an unrelated command on the line are not a push.
  assert.deepEqual(
    classifyPushCommand("git config --get core.hooksPath && git push origin main", {
      prePushGuardActive: false,
    }),
    { blocked: false, reason: null },
  );
});

test("every block reason tells the agent what to run instead", () => {
  for (const [reason, text] of Object.entries(BLOCK_REASONS)) {
    assert.match(text, /BLOCKED/, `${reason} must say it was blocked`);
    assert.match(text, /git fetch/, `${reason} must tell the agent to integrate first`);
    assert.match(text, /git push/, `${reason} must end with a push that would work`);
  }
});

function runPreToolHook(payload, cwd, world = null) {
  try {
    execFileSync(process.execPath, [PRETOOL_HOOK], {
      cwd,
      // The hook shells out to git, so it has to see the same (fake system)
      // config that decides whether a pre-push hook is installed here.
      env: world ? gitEnv(world.root) : process.env,
      input: JSON.stringify(payload),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { status: 0, stderr: "" };
  } catch (error) {
    return { status: error.status, stderr: error.stderr ?? "" };
  }
}

test("PreToolUse hook exits 2 and explains itself when a push skips the guard", () => {
  const world = buildWorld({ guard: true });
  const result = runPreToolHook(
    {
      tool_name: "Bash",
      cwd: world.bob,
      tool_input: { command: "git push --no-verify origin shared" },
    },
    world.bob,
    world,
  );

  assert.equal(result.status, 2, "exit 2 is what blocks the tool call and shows stderr to the agent");
  assert.match(result.stderr, /BLOCKED/);
  assert.match(result.stderr, /git fetch/);
});

test("PreToolUse hook lets an ordinary push through", () => {
  const world = buildWorld({ guard: true });
  const result = runPreToolHook(
    { tool_name: "Bash", cwd: world.bob, tool_input: { command: "git push origin HEAD:shared" } },
    world.bob,
    world,
  );
  assert.equal(result.status, 0);
});

test("PreToolUse hook ignores non-Bash tools and malformed payloads", () => {
  const world = buildWorld({ guard: true });
  assert.equal(
    runPreToolHook({ tool_name: "Read", tool_input: { file_path: "git push" } }, world.bob, world).status,
    0,
  );
  try {
    execFileSync(process.execPath, [PRETOOL_HOOK], { input: "not json", encoding: "utf8" });
  } catch (error) {
    assert.fail(`malformed payload must not block anything: ${error.message}`);
  }
});

test("PreToolUse hook blocks a force push in a checkout with no pre-push guard installed", () => {
  const world = buildWorld({ guard: false });
  const result = runPreToolHook(
    { tool_name: "Bash", cwd: world.bob, tool_input: { command: "git push --force origin shared" } },
    world.bob,
    world,
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /no\s*\n?pre-push guard installed/);
});

test("PreToolUse hook trusts the checkout once the guard is installed", () => {
  const world = buildWorld({ guard: true });
  const result = runPreToolHook(
    { tool_name: "Bash", cwd: world.bob, tool_input: { command: "git push --force origin shared" } },
    world.bob,
    world,
  );
  assert.equal(result.status, 0, "the pre-push hook refuses this one itself, with the better message");
});

// --- wiring: the guards only work if they are actually installed ------------

test("every hook wired in .claude/settings.json exists and is executable", () => {
  const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  const commands = [];
  for (const group of Object.values(settings.hooks ?? {})) {
    for (const matcher of group) {
      for (const hook of matcher.hooks ?? []) commands.push(hook.command);
    }
  }
  assert.ok(commands.length > 0, "settings.json must wire at least one hook");

  for (const command of commands) {
    const match = /\$CLAUDE_PROJECT_DIR\/([^"\s]+)/.exec(command);
    assert.ok(match, `hook command must be a $CLAUDE_PROJECT_DIR-relative script: ${command}`);
    const scriptPath = path.join(REPO_ROOT, match[1]);
    assert.ok(existsSync(scriptPath), `wired hook script is missing on disk: ${match[1]}`);
    const mode = execFileSync("git", ["ls-files", "--stage", "--", match[1]], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.match(mode, /^100755 /, `wired hook script must be committed executable: ${match[1]}`);
  }
});

test("every hook script in scripts/ is wired in .claude/settings.json", () => {
  const settingsText = readFileSync(SETTINGS_PATH, "utf8");
  const hookScripts = readdirSync(path.join(REPO_ROOT, "scripts")).filter((name) =>
    /-hook\.(sh|mjs)$/.test(name),
  );
  assert.ok(hookScripts.length > 0);
  for (const name of hookScripts) {
    assert.ok(
      settingsText.includes(`scripts/${name}`),
      `scripts/${name} looks like a Claude Code hook but nothing wires it in .claude/settings.json`,
    );
  }
});

test("the Dockerfile installs the pre-push guard at exactly the path core.hooksPath points at", () => {
  const dockerfile = readFileSync(DOCKERFILE_PATH, "utf8");

  const copy = /COPY\s+scripts\/paperclip-git-pre-push-guard\.sh\s+(\S+)/.exec(dockerfile);
  assert.ok(copy, "Dockerfile must COPY the pre-push guard into the image");
  const installedPath = copy[1];
  assert.equal(
    path.basename(installedPath),
    "pre-push",
    "git only runs a hook file named exactly pre-push",
  );

  const hooksPath = /git config --system core\.hooksPath (\S+)/.exec(dockerfile);
  assert.ok(hooksPath, "Dockerfile must point core.hooksPath at the installed guard");
  assert.equal(
    hooksPath[1],
    path.posix.dirname(installedPath),
    "core.hooksPath must be the directory the guard was copied into",
  );

  assert.match(
    dockerfile,
    new RegExp(`chmod \\+x ${installedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    "the hook must be executable or git silently ignores it",
  );
});

test("the policy CI job runs this test file", () => {
  const workflow = readFileSync(PR_WORKFLOW_PATH, "utf8");
  assert.ok(
    workflow.includes("scripts/__tests__/git-push-clobber-guard.test.mjs"),
    "the push-clobber guard tests must run in the required policy job, or they protect nothing",
  );
});

/**
 * Text ABOUT a push is not a push.
 *
 * A `git push --force` inside quotes is a commit message, a PR body, a heredoc
 * line or a grep pattern. Refusing those blocks ordinary work and tells the
 * agent something untrue about the command it just ran — and this branch's own
 * commit messages and docs contain the literal string, so the guard would have
 * refused the work that built it.
 *
 * There was no test in this direction, which is why the false positive survived
 * a full round of review. A false refusal is worse than a gap: the gap loses a
 * guard, the false refusal wedges the fleet and teaches agents that the tool
 * lies to them.
 */
test("quoted text mentioning a push is allowed — it is prose, not a push", () => {
  for (const command of [
    `git commit -m "DUR-3975: refuse git push --force on shared branches"`,
    `git commit -m 'never git push --no-verify a shared branch'`,
    `gh pr create --body "Agents can no longer git push --force a shared branch"`,
    `echo "Never run git push --force on a shared branch." >> FORK.md`,
    `grep -rn "git push --force" docs/`,
    `git commit -m "docs: explain why git push --force is refused" && git push origin HEAD`,
  ]) {
    assert.deepEqual(
      classifyPushCommand(command, { prePushGuardActive: true }),
      { blocked: false, reason: null },
      `expected to allow (prose about pushing, not a push): ${command}`,
    );
  }
});

/**
 * The true positives must survive the quote-skipping above.
 *
 * Note which context each case needs. With a pre-push hook installed, git
 * itself refuses a plain `--force`, so this layer deliberately allows it and
 * only blocks the ways AROUND the hook. A bare force is therefore tested with
 * no guard installed, and the bypasses with one — testing them the other way
 * round asserts the opposite of the design, which is the mistake that produced
 * this comment.
 */
test("the bypasses are still refused after the quoted-text fix", () => {
  for (const command of [
    "ls && git -c core.hooksPath=/tmp/empty push origin main",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/tmp/empty git push origin main",
    "git push --no-verify origin main",
    "head -n 20 log && git push --no-verify origin main",
  ]) {
    const verdict = classifyPushCommand(command, { prePushGuardActive: true });
    assert.equal(verdict.blocked, true, `expected to block: ${command}`);
    assert.ok(verdict.reason in BLOCK_REASONS, `no operator message for reason ${verdict.reason}: ${command}`);
  }
});

test("a force-shaped push with no guard installed is still refused", () => {
  for (const command of [
    "git push --force origin main",
    "git push -f origin main",
    "git push --delete origin some-branch",
    "grep -n foo file && git push --force origin main",
  ]) {
    const verdict = classifyPushCommand(command, { prePushGuardActive: false });
    assert.equal(verdict.blocked, true, `expected to block: ${command}`);
    assert.ok(verdict.reason in BLOCK_REASONS, `no operator message for reason ${verdict.reason}: ${command}`);
  }
});
