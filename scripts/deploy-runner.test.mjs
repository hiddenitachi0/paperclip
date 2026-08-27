import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// DUR-44 regression coverage: scripts/deploy-runner.sh must never mark an
// approval "processed" without either delivering a comment for it (success,
// failure, or "superseded") or deliberately leaving it unprocessed so the
// next poll cycle retries it. Silent loss — processed with zero comment,
// zero retry — is the bug this guards against.
//
// The script is sourceable (guarded by a `BASH_SOURCE` check at the bottom)
// so these tests run its real functions directly rather than reimplementing
// their logic. The only thing stubbed out is `docker` itself — the true
// I/O boundary — via a fake `docker` on PATH that serves canned CLI
// responses and can be told to fail specific calls, so `comment()`'s real
// retry/backoff logic runs unmodified against a simulated "docker exec
// hiccup" (the mechanism that actually dropped 5bd025d5 in DUR-42's own
// deploy).

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SCRIPT = path.join(repoRoot, "scripts", "deploy-runner.sh");

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", ...options });
}

function assertSuccess(result, label) {
  assert.equal(result.status, 0, `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

// Fake `docker` that intercepts `docker exec [-e K=V ...] <container> sh -lc "<cmd>"`.
// Dispatches on substrings of <cmd> against canned JSON fixtures in
// $SCENARIO_DIR, and can be told to fail specific `approval comment <id>`
// calls a controllable number of times via $SCENARIO_DIR/fail-count-<id>.
// Built from plain (non-template) strings, not a template literal — the
// script is full of bash `${...}` expansions that a JS template literal
// would try to interpolate itself.
const FAKE_DOCKER = [
  '#!/usr/bin/env bash',
  'set -uo pipefail',
  '',
  // DUR-163: capture_failure_diagnostics() calls `docker logs --tail N
  // <container>` directly (this runner runs on-box, outside any container,
  // so it talks to the host docker daemon here — unlike everything else in
  // this fake, which intercepts `docker exec` into the server container).
  // Serves canned output from $SCENARIO_DIR/docker-logs-<container>.txt.
  'if [ "${1:-}" = "logs" ]; then',
  '  shift',
  '  container="${@: -1}"',
  '  fixture="$SCENARIO_DIR/docker-logs-$container.txt"',
  '  if [ -f "$fixture" ]; then cat "$fixture"; else echo "fake docker: no logs fixture for $container" >&2; exit 1; fi',
  '  exit 0',
  'fi',
  '',
  '[ "${1:-}" = "exec" ] || exit 1',
  'shift',
  '',
  'args=("$@")',
  'n=${#args[@]}',
  'cmd="${args[$((n - 1))]}"',
  '',
  'i=0',
  'while [ "$i" -lt "$n" ]; do',
  '  if [ "${args[$i]}" = "-e" ]; then',
  '    export "${args[$((i + 1))]}"',
  '    i=$((i + 2))',
  '  else',
  '    i=$((i + 1))',
  '  fi',
  'done',
  '',
  'case "$cmd" in',
  '  *"approval comment "*)',
  "    aid=\"$(printf '%s' \"$cmd\" | sed -n 's/.*approval comment \\([^ ]*\\).*/\\1/p')\"",
  '    fail_count_file="$SCENARIO_DIR/fail-count-$aid"',
  '    if [ -f "$fail_count_file" ]; then',
  '      remaining="$(cat "$fail_count_file")"',
  '      if [ "$remaining" -gt 0 ]; then',
  '        echo $((remaining - 1)) > "$fail_count_file"',
  '        exit 1',
  '      fi',
  '    fi',
  '    printf \'%s\\n\' "${BODY:-}" >> "$SCENARIO_DIR/comment-$aid.log"',
  '    exit 0',
  '    ;;',
  '  *"mkdir -p"*"STATUS_LINE"*|*"STATUS_PATH"*)',
  '    eval "$cmd"',
  '    ;;',
  '  *"company list"*)',
  '    cat "$SCENARIO_DIR/company_list.json"',
  '    ;;',
  '  *"approval list "*)',
  '    cat "$SCENARIO_DIR/approval_list.json"',
  '    ;;',
  '  *"approval get "*)',
  "    aid=\"$(printf '%s' \"$cmd\" | sed -n 's/.*approval get \\([^ ]*\\).*/\\1/p')\"",
  '    cat "$SCENARIO_DIR/approval-$aid.json"',
  '    ;;',
  '  *"approval issues "*)',
  "    aid=\"$(printf '%s' \"$cmd\" | sed -n 's/.*approval issues \\([^ ]*\\).*/\\1/p')\"",
  '    fixture="$SCENARIO_DIR/approval-issues-$aid.json"',
  '    if [ -f "$fixture" ]; then cat "$fixture"; else printf \'[]\'; fi',
  '    ;;',
  '  *"issue comment "*)',
  "    iid=\"$(printf '%s' \"$cmd\" | sed -n 's/.*issue comment \\([^ ]*\\).*/\\1/p')\"",
  '    fail_count_file="$SCENARIO_DIR/fail-count-issue-comment-$iid"',
  '    if [ -f "$fail_count_file" ]; then',
  '      remaining="$(cat "$fail_count_file")"',
  '      if [ "$remaining" -gt 0 ]; then',
  '        echo $((remaining - 1)) > "$fail_count_file"',
  '        exit 1',
  '      fi',
  '    fi',
  '    printf \'%s\\n\' "${BODY:-}" >> "$SCENARIO_DIR/issue-comment-$iid.log"',
  '    exit 0',
  '    ;;',
  '  *"project get "*)',
  "    pid=\"$(printf '%s' \"$cmd\" | sed -n 's/.*project get \\([^ ]*\\).*/\\1/p')\"",
  '    cat "$SCENARIO_DIR/project-$pid.json"',
  '    ;;',
  '  *)',
  '    echo "fake docker: unhandled command: $cmd" >&2',
  '    exit 1',
  '    ;;',
  'esac',
  '',
].join("\n");

function makeScenario() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-test-"));
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const dockerPath = path.join(binDir, "docker");
  writeFileSync(dockerPath, FAKE_DOCKER, { mode: 0o755 });

  return {
    dir,
    binDir,
    processed: path.join(dir, "processed"),
    log: path.join(dir, "runner.log"),
    writeJson(name, value) {
      writeFileSync(path.join(dir, name), JSON.stringify(value));
    },
    setFailCount(aid, count) {
      writeFileSync(path.join(dir, `fail-count-${aid}`), String(count));
    },
    commentsFor(aid) {
      const file = path.join(dir, `comment-${aid}.log`);
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8").split("\n").filter(Boolean);
    },
    issueCommentsFor(iid) {
      const file = path.join(dir, `issue-comment-${iid}.log`);
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8").split("\n").filter(Boolean);
    },
    processedIds() {
      if (!existsSync(this.processed)) return [];
      return readFileSync(this.processed, "utf8").split("\n").filter(Boolean);
    },
    readLog() {
      return existsSync(this.log) ? readFileSync(this.log, "utf8") : "";
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function runMain(scenario, extraEnv = {}) {
  return run("bash", ["-c", `set -uo pipefail\nsource "${SCRIPT}"\nmain`], {
    env: {
      ...process.env,
      PATH: `${scenario.binDir}:${process.env.PATH}`,
      SCENARIO_DIR: scenario.dir,
      PAPERCLIP_DEPLOY_RUNNER_PROCESSED: scenario.processed,
      PAPERCLIP_DEPLOY_RUNNER_LOG: scenario.log,
      PAPERCLIP_DEPLOY_RUNNER_COMMENT_RETRIES: "3",
      PAPERCLIP_DEPLOY_RUNNER_COMMENT_RETRY_SLEEP: "0",
      ...extraEnv,
    },
  });
}

const DISABLED_POLICY_PROJECT = { id: "proj-1", deployPolicy: { enabled: false } };

test("deploy-runner.sh passes bash syntax validation", () => {
  assertSuccess(run("bash", ["-n", SCRIPT]), "bash -n");
});

test("two approved deploy approvals for the same project in one poll cycle both end up with a comment", () => {
  const scenario = makeScenario();
  try {
    scenario.writeJson("company_list.json", [{ id: "co-1" }]);
    scenario.writeJson("approval_list.json", [
      {
        id: "aid-older",
        type: "request_board_approval",
        status: "approved",
        decidedAt: "2026-08-20T20:48:05Z",
        payload: { kind: "deploy", projectId: "proj-1", workspaceId: "ws-1" },
      },
      {
        id: "aid-newer",
        type: "request_board_approval",
        status: "approved",
        decidedAt: "2026-08-20T20:48:20Z",
        payload: { kind: "deploy", projectId: "proj-1", workspaceId: "ws-1" },
      },
    ]);
    scenario.writeJson("approval-aid-newer.json", {
      id: "aid-newer",
      payload: { kind: "deploy", projectId: "proj-1", workspaceId: "ws-1" },
    });
    scenario.writeJson("project-proj-1.json", DISABLED_POLICY_PROJECT);

    const result = runMain(scenario);
    assertSuccess(result, "main()");

    const olderComments = scenario.commentsFor("aid-older");
    const newerComments = scenario.commentsFor("aid-newer");

    assert.equal(olderComments.length, 1, `expected exactly one comment for the superseded approval, got: ${JSON.stringify(olderComments)}`);
    assert.match(olderComments[0], /Skipped.*aid-newer/, "superseded approval should reference the one that ran instead");

    assert.equal(newerComments.length, 1, `expected exactly one comment for the kept approval, got: ${JSON.stringify(newerComments)}`);
    assert.match(newerComments[0], /Deploy failed/, "kept approval should still resolve to a definite outcome comment");

    assert.deepEqual(scenario.processedIds().sort(), ["aid-newer", "aid-older"], "both approvals must be marked processed since both got a comment");
  } finally {
    scenario.cleanup();
  }
});

test("comment() retries through a transient docker-exec hiccup and still delivers within the same cycle", () => {
  const scenario = makeScenario();
  try {
    scenario.writeJson("company_list.json", [{ id: "co-1" }]);
    scenario.writeJson("approval_list.json", [
      {
        id: "aid-flaky",
        type: "request_board_approval",
        status: "approved",
        decidedAt: "2026-08-20T20:48:05Z",
        payload: { kind: "deploy", projectId: "proj-1", workspaceId: "ws-1" },
      },
    ]);
    scenario.writeJson("approval-aid-flaky.json", {
      id: "aid-flaky",
      payload: { kind: "deploy", projectId: "proj-1", workspaceId: "ws-1" },
    });
    scenario.writeJson("project-proj-1.json", DISABLED_POLICY_PROJECT);
    // Fail the first 2 of 3 allowed comment attempts, then let the 3rd through
    // — simulates the server container being briefly unreachable mid-recreate.
    scenario.setFailCount("aid-flaky", 2);

    const result = runMain(scenario);
    assertSuccess(result, "main()");

    assert.equal(scenario.commentsFor("aid-flaky").length, 1, "the comment must eventually be delivered exactly once");
    assert.deepEqual(scenario.processedIds(), ["aid-flaky"]);
    assert.match(scenario.readLog(), /comment attempt 1\/3 failed/);
    assert.match(scenario.readLog(), /comment attempt 2\/3 failed/);
  } finally {
    scenario.cleanup();
  }
});

test("an approval whose comment can never be delivered is left unprocessed for the next poll cycle, never silently dropped", () => {
  const scenario = makeScenario();
  try {
    scenario.writeJson("company_list.json", [{ id: "co-1" }]);
    scenario.writeJson("approval_list.json", [
      {
        id: "aid-unreachable",
        type: "request_board_approval",
        status: "approved",
        decidedAt: "2026-08-20T20:48:05Z",
        payload: { kind: "deploy", projectId: "proj-1", workspaceId: "ws-1" },
      },
    ]);
    scenario.writeJson("approval-aid-unreachable.json", {
      id: "aid-unreachable",
      payload: { kind: "deploy", projectId: "proj-1", workspaceId: "ws-1" },
    });
    scenario.writeJson("project-proj-1.json", DISABLED_POLICY_PROJECT);
    // Fail every attempt — the container never comes back this cycle.
    scenario.setFailCount("aid-unreachable", 999);

    const result = runMain(scenario);
    assertSuccess(result, "main()");

    assert.equal(scenario.commentsFor("aid-unreachable").length, 0, "no comment could ever be delivered");
    assert.deepEqual(
      scenario.processedIds(),
      [],
      "the approval must NOT be marked processed — it must stay eligible for retry next poll cycle",
    );
    assert.match(scenario.readLog(), /could not deliver a comment after 3 attempts/);
  } finally {
    scenario.cleanup();
  }
});

// DUR-136 regression: a deploy outcome comment must not be visible only on
// the approval object — an approval whose payload has a bad projectId can
// fail loudly on the approval while the issue it was deploying for (e.g. a
// ticket sitting in_review) never shows any sign the deploy didn't happen.
test("a deploy failure comment is mirrored onto every issue linked to the approval, not just the approval", () => {
  const scenario = makeScenario();
  try {
    scenario.writeJson("company_list.json", [{ id: "co-1" }]);
    scenario.writeJson("approval_list.json", [
      {
        id: "aid-bad-project",
        type: "request_board_approval",
        status: "approved",
        decidedAt: "2026-08-23T14:18:37Z",
        payload: { kind: "deploy", projectId: "ws-not-a-real-project", workspaceId: "ws-not-a-real-project" },
      },
    ]);
    scenario.writeJson("approval-aid-bad-project.json", {
      id: "aid-bad-project",
      payload: { kind: "deploy", projectId: "ws-not-a-real-project", workspaceId: "ws-not-a-real-project" },
    });
    scenario.writeJson("approval-issues-aid-bad-project.json", [
      { id: "issue-1" },
      { id: "issue-2" },
    ]);
    // Deliberately no project-ws-not-a-real-project.json fixture — `project get`
    // hits the fake docker's unhandled-command fallback and fails, same as the
    // real server 404ing on a projectId that's actually a workspace id.

    const result = runMain(scenario);
    assertSuccess(result, "main()");

    const approvalComments = scenario.commentsFor("aid-bad-project");
    assert.equal(approvalComments.length, 1);
    assert.match(approvalComments[0], /Deploy failed/);

    for (const iid of ["issue-1", "issue-2"]) {
      const issueComments = scenario.issueCommentsFor(iid);
      assert.equal(issueComments.length, 1, `expected the failure comment mirrored onto ${iid}`);
      assert.equal(issueComments[0], approvalComments[0], `${iid}'s comment must match the approval's comment body`);
    }

    assert.deepEqual(scenario.processedIds(), ["aid-bad-project"]);
  } finally {
    scenario.cleanup();
  }
});

test("a failure to mirror onto a linked issue is logged but never blocks marking the approval processed", () => {
  const scenario = makeScenario();
  try {
    scenario.writeJson("company_list.json", [{ id: "co-1" }]);
    scenario.writeJson("approval_list.json", [
      {
        id: "aid-mirror-fails",
        type: "request_board_approval",
        status: "approved",
        decidedAt: "2026-08-23T14:18:37Z",
        payload: { kind: "deploy", projectId: "proj-1", workspaceId: "ws-1" },
      },
    ]);
    scenario.writeJson("approval-aid-mirror-fails.json", {
      id: "aid-mirror-fails",
      payload: { kind: "deploy", projectId: "proj-1", workspaceId: "ws-1" },
    });
    scenario.writeJson("project-proj-1.json", DISABLED_POLICY_PROJECT);
    scenario.writeJson("approval-issues-aid-mirror-fails.json", [{ id: "issue-unreachable" }]);
    writeFileSync(path.join(scenario.dir, "fail-count-issue-comment-issue-unreachable"), "999");

    const result = runMain(scenario);
    assertSuccess(result, "main()");

    assert.equal(scenario.commentsFor("aid-mirror-fails").length, 1, "approval comment must still be delivered");
    assert.equal(scenario.issueCommentsFor("issue-unreachable").length, 0, "the mirrored comment never got through");
    assert.deepEqual(
      scenario.processedIds(),
      ["aid-mirror-fails"],
      "the approval must still be marked processed — mirroring is best-effort and never gates processing",
    );
    assert.match(scenario.readLog(), /could not mirror comment onto issue issue-unreachable/);
  } finally {
    scenario.cleanup();
  }
});

// DUR-53 regression: when payload.commit is unset, target_ref falls back to
// the branch name (e.g. "custom"). A long-lived deploy checkout already has
// a local branch of that same name, which `git fetch origin custom` never
// moves — only `refs/remotes/origin/custom` advances. The old code resolved
// bare "$ref" first, silently resetting to the stale local branch tip (a
// no-op) while still reporting success at the old commit.
test("git_fetch_reset advances a branch-name deploy to the freshly fetched commit, not a stale same-named local branch", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-git-test-"));
  try {
    const originDir = path.join(dir, "origin.git");
    const targetDir = path.join(dir, "target");
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const g = (repoDir, args) => {
      const result = spawnSync("git", args, { cwd: repoDir, encoding: "utf8", env: gitEnv });
      assert.equal(result.status, 0, `git ${args.join(" ")} failed in ${repoDir}\n${result.stderr}`);
      return result.stdout.trim();
    };

    mkdirSync(originDir, { recursive: true });
    g(originDir, ["init", "--quiet", "-b", "custom"]);
    writeFileSync(path.join(originDir, "f.txt"), "A");
    g(originDir, ["add", "f.txt"]);
    g(originDir, ["commit", "--quiet", "-m", "A"]);

    g(dir, ["clone", "--quiet", "-b", "custom", originDir, targetDir]);
    const commitA = g(targetDir, ["rev-parse", "HEAD"]);

    // origin advances past what the target checkout has cloned/cached locally.
    writeFileSync(path.join(originDir, "f.txt"), "B");
    g(originDir, ["add", "f.txt"]);
    g(originDir, ["commit", "--quiet", "-m", "B"]);
    const commitB = g(originDir, ["rev-parse", "HEAD"]);
    assert.notEqual(commitA, commitB);

    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset "${targetDir}" "${originDir}" "custom" ""
    `;
    const result = run("bash", ["-c", script], { env: { ...process.env, PAPERCLIP_DEPLOY_RUNNER_LOG: path.join(dir, "log") } });
    assertSuccess(result, "git_fetch_reset");

    const targetHead = g(targetDir, ["rev-parse", "HEAD"]);
    assert.equal(targetHead, commitB, "target checkout must advance to origin's new tip, not stay pinned to the stale local branch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git_fetch_reset refuses to reset backward when the target commit is an ancestor of the current HEAD", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-git-backward-test-"));
  try {
    const originDir = path.join(dir, "origin.git");
    const targetDir = path.join(dir, "target");
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const g = (repoDir, args) => {
      const result = spawnSync("git", args, { cwd: repoDir, encoding: "utf8", env: gitEnv });
      assert.equal(result.status, 0, `git ${args.join(" ")} failed in ${repoDir}\n${result.stderr}`);
      return result.stdout.trim();
    };

    mkdirSync(originDir, { recursive: true });
    g(originDir, ["init", "--quiet", "-b", "custom"]);
    writeFileSync(path.join(originDir, "f.txt"), "A");
    g(originDir, ["add", "f.txt"]);
    g(originDir, ["commit", "--quiet", "-m", "A"]);
    const commitA = g(originDir, ["rev-parse", "HEAD"]);

    writeFileSync(path.join(originDir, "f.txt"), "B");
    g(originDir, ["add", "f.txt"]);
    g(originDir, ["commit", "--quiet", "-m", "B"]);
    const commitB = g(originDir, ["rev-parse", "HEAD"]);

    // Deploy target is already live on the newer commit B (simulating a
    // separate, already-processed approval that shipped it in an earlier
    // poll cycle).
    g(dir, ["clone", "--quiet", "-b", "custom", originDir, targetDir]);
    assert.equal(g(targetDir, ["rev-parse", "HEAD"]), commitB);

    // DUR-137 scenario: a stale approval targeting the older commit A gets
    // approved after B is already live and processed, so it's alone in its
    // group and would trivially become "KEEP" — this must still refuse.
    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset "${targetDir}" "${originDir}" "${commitA}" ""
    `;
    const result = run("bash", ["-c", script], { env: { ...process.env, PAPERCLIP_DEPLOY_RUNNER_LOG: path.join(dir, "log") } });
    assert.equal(result.status, 2, `expected refusal exit code 2\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const targetHead = g(targetDir, ["rev-parse", "HEAD"]);
    assert.equal(targetHead, commitB, "target checkout must stay on the newer live commit, never reset backward to an ancestor");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git_fetch_reset allows an explicit backward reset when payload.allowBackwardDeploy opted in", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-git-backward-override-test-"));
  try {
    const originDir = path.join(dir, "origin.git");
    const targetDir = path.join(dir, "target");
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const g = (repoDir, args) => {
      const result = spawnSync("git", args, { cwd: repoDir, encoding: "utf8", env: gitEnv });
      assert.equal(result.status, 0, `git ${args.join(" ")} failed in ${repoDir}\n${result.stderr}`);
      return result.stdout.trim();
    };

    mkdirSync(originDir, { recursive: true });
    g(originDir, ["init", "--quiet", "-b", "custom"]);
    writeFileSync(path.join(originDir, "f.txt"), "A");
    g(originDir, ["add", "f.txt"]);
    g(originDir, ["commit", "--quiet", "-m", "A"]);
    const commitA = g(originDir, ["rev-parse", "HEAD"]);

    writeFileSync(path.join(originDir, "f.txt"), "B");
    g(originDir, ["add", "f.txt"]);
    g(originDir, ["commit", "--quiet", "-m", "B"]);
    const commitB = g(originDir, ["rev-parse", "HEAD"]);

    g(dir, ["clone", "--quiet", "-b", "custom", originDir, targetDir]);
    assert.equal(g(targetDir, ["rev-parse", "HEAD"]), commitB);

    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset "${targetDir}" "${originDir}" "${commitA}" "" "1"
    `;
    const result = run("bash", ["-c", script], { env: { ...process.env, PAPERCLIP_DEPLOY_RUNNER_LOG: path.join(dir, "log") } });
    assertSuccess(result, "git_fetch_reset with allow_backward");

    assert.equal(g(targetDir, ["rev-parse", "HEAD"]), commitA, "an explicit allow_backward opt-in must still be able to roll back intentionally");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git_fetch_reset refuses a sideways reset to a commit that only exists on a different branch than the configured deploy branch", () => {
  // DUR-229 / DUR-221 regression: the DUR-137 backward guard only compares
  // target_commit against whatever is currently checked out, so a commit
  // that lives on an unrelated branch (never an ancestor OR a descendant of
  // the current HEAD) sails straight through it. This must be caught by an
  // independent check against the *configured* deploy branch's remote tip.
  const dir = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-git-sideways-test-"));
  try {
    const originDir = path.join(dir, "origin.git");
    const targetDir = path.join(dir, "target");
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const g = (repoDir, args) => {
      const result = spawnSync("git", args, { cwd: repoDir, encoding: "utf8", env: gitEnv });
      assert.equal(result.status, 0, `git ${args.join(" ")} failed in ${repoDir}\n${result.stderr}`);
      return result.stdout.trim();
    };

    mkdirSync(originDir, { recursive: true });
    g(originDir, ["init", "--quiet", "-b", "custom"]);
    writeFileSync(path.join(originDir, "f.txt"), "A");
    g(originDir, ["add", "f.txt"]);
    g(originDir, ["commit", "--quiet", "-m", "A"]);

    // master diverges from custom right after A: master gets a commit of its
    // own, custom independently advances with a different commit — neither
    // is an ancestor of the other, simulating DUR-221's "custom has 244
    // commits master doesn't, and vice versa" situation.
    g(originDir, ["branch", "master"]);
    g(originDir, ["checkout", "--quiet", "master"]);
    writeFileSync(path.join(originDir, "f.txt"), "M");
    g(originDir, ["add", "f.txt"]);
    g(originDir, ["commit", "--quiet", "-m", "only on master"]);
    const commitM = g(originDir, ["rev-parse", "HEAD"]);

    g(originDir, ["checkout", "--quiet", "custom"]);
    writeFileSync(path.join(originDir, "f.txt"), "C");
    g(originDir, ["add", "f.txt"]);
    g(originDir, ["commit", "--quiet", "-m", "only on custom"]);

    g(dir, ["clone", "--quiet", "-b", "custom", originDir, targetDir]);
    const targetHeadBefore = g(targetDir, ["rev-parse", "HEAD"]);

    // A deploy approval pinned to master's commit (DV_COMMIT), while this
    // project's configured deploy branch (DV_REPO_REF) is "custom" — exactly
    // the DUR-221 near-miss shape.
    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset "${targetDir}" "${originDir}" "${commitM}" "" "" "" "custom"
    `;
    const result = run("bash", ["-c", script], { env: { ...process.env, PAPERCLIP_DEPLOY_RUNNER_LOG: path.join(dir, "log") } });
    assert.equal(result.status, 3, `expected refusal exit code 3\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(result.stdout.trim(), commitM, "refusal path should still print the resolved (refused) commit, matching the DUR-137 refusal convention");

    const targetHeadAfter = g(targetDir, ["rev-parse", "HEAD"]);
    assert.equal(targetHeadAfter, targetHeadBefore, "target checkout must never be reset onto a commit from an unrelated branch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git_fetch_reset still allows a pinned-commit deploy that is genuinely on the configured deploy branch", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-git-sideways-ok-test-"));
  try {
    const originDir = path.join(dir, "origin.git");
    const targetDir = path.join(dir, "target");
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const g = (repoDir, args) => {
      const result = spawnSync("git", args, { cwd: repoDir, encoding: "utf8", env: gitEnv });
      assert.equal(result.status, 0, `git ${args.join(" ")} failed in ${repoDir}\n${result.stderr}`);
      return result.stdout.trim();
    };

    mkdirSync(originDir, { recursive: true });
    g(originDir, ["init", "--quiet", "-b", "custom"]);
    writeFileSync(path.join(originDir, "f.txt"), "A");
    g(originDir, ["add", "f.txt"]);
    g(originDir, ["commit", "--quiet", "-m", "A"]);
    const commitA = g(originDir, ["rev-parse", "HEAD"]);

    writeFileSync(path.join(originDir, "f.txt"), "B");
    g(originDir, ["add", "f.txt"]);
    g(originDir, ["commit", "--quiet", "-m", "B"]);

    g(dir, ["clone", "--quiet", "-b", "custom", originDir, targetDir]);

    // Pinned to A, an ancestor of custom's (now-advanced) tip B — a
    // legitimate forward-pinned deploy that must not be caught by the new
    // sideways guard just because it isn't equal to the branch tip.
    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset "${targetDir}" "${originDir}" "${commitA}" "" "1" "" "custom"
    `;
    const result = run("bash", ["-c", script], { env: { ...process.env, PAPERCLIP_DEPLOY_RUNNER_LOG: path.join(dir, "log") } });
    assertSuccess(result, "git_fetch_reset for an on-branch pinned commit");
    assert.equal(g(targetDir, ["rev-parse", "HEAD"]), commitA);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("process_approval posts a skip comment (not a false success) when the backward-deploy guard fires", () => {
  const scenario = makeScenario();
  try {
    const targetPath = path.join(scenario.dir, "target-repo");
    mkdirSync(path.join(targetPath, ".git"), { recursive: true });
    const project = {
      id: "proj-1",
      deployPolicy: {
        enabled: true,
        workspaceId: "ws-1",
        deployKind: "custom",
        deployTargetPath: targetPath,
        healthCheckUrl: "http://example.invalid/health",
      },
      workspaces: [{ id: "ws-1", repoUrl: "https://example.invalid/repo.git", repoRef: "custom" }],
    };
    scenario.writeJson("project-proj-1.json", project);
    scenario.writeJson("approval-aid-1.json", {
      id: "aid-1",
      payload: { projectId: "proj-1", workspaceId: "ws-1", commit: "deadbeef", kind: "deploy" },
    });

    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { return 2; }
      process_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], {
      env: {
        ...process.env,
        PATH: `${scenario.binDir}:${process.env.PATH}`,
        SCENARIO_DIR: scenario.dir,
        PAPERCLIP_DEPLOY_RUNNER_LOG: scenario.log,
      },
    });
    assertSuccess(result, "process_approval");

    const comments = scenario.commentsFor("aid-1");
    assert.equal(comments.length, 1);
    assert.match(comments[0], /Deploy skipped/);
    assert.match(comments[0], /backward/);
    assert.doesNotMatch(comments[0], /is live and healthy/, "a refused backward deploy must never read like a successful one");
  } finally {
    scenario.cleanup();
  }
});

test("process_approval posts a failure comment (not a false success) when the sideways-lineage guard fires", () => {
  const scenario = makeScenario();
  try {
    const targetPath = path.join(scenario.dir, "target-repo");
    mkdirSync(path.join(targetPath, ".git"), { recursive: true });
    const project = {
      id: "proj-1",
      deployPolicy: {
        enabled: true,
        workspaceId: "ws-1",
        deployKind: "custom",
        deployTargetPath: targetPath,
        healthCheckUrl: "http://example.invalid/health",
      },
      workspaces: [{ id: "ws-1", repoUrl: "https://example.invalid/repo.git", repoRef: "custom" }],
    };
    scenario.writeJson("project-proj-1.json", project);
    scenario.writeJson("approval-aid-1.json", {
      id: "aid-1",
      payload: { projectId: "proj-1", workspaceId: "ws-1", commit: "deadbeef", kind: "deploy" },
    });

    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { return 3; }
      process_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], {
      env: {
        ...process.env,
        PATH: `${scenario.binDir}:${process.env.PATH}`,
        SCENARIO_DIR: scenario.dir,
        PAPERCLIP_DEPLOY_RUNNER_LOG: scenario.log,
      },
    });
    assertSuccess(result, "process_approval");

    const comments = scenario.commentsFor("aid-1");
    assert.equal(comments.length, 1);
    assert.match(comments[0], /Deploy failed/);
    assert.match(comments[0], /not reachable from/);
    assert.match(comments[0], /"custom"/);
    assert.doesNotMatch(comments[0], /is live and healthy/, "a refused sideways deploy must never read like a successful one");
  } finally {
    scenario.cleanup();
  }
});

// DUR-152 regression: a stale deploy approval whose commit already shipped (as an ancestor of
// what's live) never got a runner-log entry deploy-completion-gate.ts could recognize as
// "completed" -- its comment could only ever say "skipped", never the literal success sentence
// (see the guardrail test just above), so whoever was waiting on it stayed stuck indefinitely.
// This checks the structured `outcome`/`commit` fields the backward-deploy-guard path now
// records alongside that honest "skipped" comment.
test("DUR-152: process_approval records outcome=carried with the resolved commit when the backward-deploy guard fires", () => {
  const scenario = makeScenario();
  try {
    const targetPath = path.join(scenario.dir, "target-repo");
    mkdirSync(path.join(targetPath, ".git"), { recursive: true });
    const project = {
      id: "proj-1",
      deployPolicy: {
        enabled: true,
        workspaceId: "ws-1",
        deployKind: "custom",
        deployTargetPath: targetPath,
        healthCheckUrl: "http://example.invalid/health",
      },
      workspaces: [{ id: "ws-1", repoUrl: "https://example.invalid/repo.git", repoRef: "custom" }],
    };
    scenario.writeJson("project-proj-1.json", project);
    scenario.writeJson("approval-aid-1.json", {
      id: "aid-1",
      payload: { projectId: "proj-1", workspaceId: "ws-1", commit: "deadbeef", kind: "deploy" },
    });

    const statusPath = path.join(scenario.dir, "status.jsonl");
    const carriedCommit = "cafef00dcafef00dcafef00dcafef00dcafef00d";
    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { printf '%s' "${carriedCommit}"; return 2; }
      process_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], {
      env: {
        ...process.env,
        PATH: `${scenario.binDir}:${process.env.PATH}`,
        SCENARIO_DIR: scenario.dir,
        PAPERCLIP_DEPLOY_RUNNER_LOG: scenario.log,
        PAPERCLIP_DEPLOY_RUNNER_STATUS_PATH: statusPath,
      },
    });
    assertSuccess(result, "process_approval");

    const comments = scenario.commentsFor("aid-1");
    assert.equal(comments.length, 1);
    assert.match(comments[0], /Deploy skipped/);
    assert.match(comments[0], /backward/);
    assert.match(comments[0], new RegExp(carriedCommit), "the outcome comment should name the commit that's already live");
    assert.doesNotMatch(comments[0], /is live and healthy/, "a refused backward deploy must never read like a successful one");

    const statusLines = readFileSync(statusPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const entry = statusLines.find((e) => e.approvalId === "aid-1");
    assert.ok(entry, "expected a status-log entry for aid-1");
    assert.equal(entry.outcome, "carried", "deploy-completion-gate.ts keys off this to confirm a superseded approval by commit, not comment text");
    assert.equal(entry.commit, carriedCommit);
  } finally {
    scenario.cleanup();
  }
});

// DUR-237: a plain successful deploy (not superseded/carried) previously only ever named its
// commit in the free-text comment body -- deploy-completion-gate.ts's broader "did this commit
// ship under ANY project deploy approval" check needs the structured field populated here too,
// not only on the "carried" outcome.
test("DUR-237: a successful deploy also records the deployed commit as a structured status-log field", () => {
  const scenario = makeScenario();
  const dir = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-success-commit-test-"));
  try {
    const targetPath = path.join(dir, "target");
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const g = (args) => {
      const result = spawnSync("git", args, { cwd: targetPath, encoding: "utf8", env: gitEnv });
      assert.equal(result.status, 0, `git ${args.join(" ")} failed\n${result.stderr}`);
      return result.stdout.trim();
    };
    mkdirSync(targetPath, { recursive: true });
    g(["init", "--quiet", "-b", "custom"]);
    writeFileSync(path.join(targetPath, "f.txt"), "A");
    g(["add", "f.txt"]);
    g(["commit", "--quiet", "-m", "A"]);
    const expectedCommit = g(["rev-parse", "--short", "HEAD"]);

    const project = {
      id: "proj-1",
      deployPolicy: {
        enabled: true,
        workspaceId: "ws-1",
        deployKind: "custom",
        deployTargetPath: targetPath,
        healthCheckUrl: "http://example.invalid/health",
      },
      workspaces: [{ id: "ws-1", repoUrl: "https://example.invalid/repo.git", repoRef: "custom" }],
    };
    scenario.writeJson("project-proj-1.json", project);
    scenario.writeJson("approval-aid-1.json", {
      id: "aid-1",
      payload: { projectId: "proj-1", workspaceId: "ws-1", commit: "irrelevant", kind: "deploy" },
    });

    const statusPath = path.join(scenario.dir, "status.jsonl");
    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { return 0; }
      run_recipe() { return 0; }
      health_check() { return 0; }
      process_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], {
      env: {
        ...process.env,
        PATH: `${scenario.binDir}:${process.env.PATH}`,
        SCENARIO_DIR: scenario.dir,
        PAPERCLIP_DEPLOY_RUNNER_LOG: scenario.log,
        PAPERCLIP_DEPLOY_RUNNER_STATUS_PATH: statusPath,
      },
    });
    assertSuccess(result, "process_approval");

    const comments = scenario.commentsFor("aid-1");
    assert.equal(comments.length, 1);
    assert.match(comments[0], /is live and healthy/);

    const statusLines = readFileSync(statusPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const entry = statusLines.find((e) => e.approvalId === "aid-1");
    assert.ok(entry, "expected a status-log entry for aid-1");
    assert.equal(
      entry.commit,
      expectedCommit,
      "deploy-completion-gate.ts needs the structured commit field on a plain success too, not only 'carried' (DUR-237)",
    );
  } finally {
    scenario.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// DUR-152: the same-cycle SUPERSEDED path (two deploy approvals for the same project approved
// in one poll cycle) using real git repos end-to-end through main(), proving the ancestry check
// against the checkout's ACTUAL post-KEEP state, not a stub.
test("DUR-152: a same-cycle superseded approval whose commit already shipped via the kept approval's deploy is recorded as carried", () => {
  const scenario = makeScenario();
  const dir = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-carried-test-"));
  try {
    const originDir = path.join(dir, "origin.git");
    const targetDir = path.join(dir, "target");
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const g = (repoDir, args) => {
      const result = spawnSync("git", args, { cwd: repoDir, encoding: "utf8", env: gitEnv });
      assert.equal(result.status, 0, `git ${args.join(" ")} failed in ${repoDir}\n${result.stderr}`);
      return result.stdout.trim();
    };

    mkdirSync(originDir, { recursive: true });
    g(originDir, ["init", "--quiet", "-b", "custom"]);
    writeFileSync(path.join(originDir, "f.txt"), "A");
    g(originDir, ["add", "f.txt"]);
    g(originDir, ["commit", "--quiet", "-m", "A"]);
    const commitA = g(originDir, ["rev-parse", "HEAD"]);

    writeFileSync(path.join(originDir, "f.txt"), "B");
    g(originDir, ["add", "f.txt"]);
    g(originDir, ["commit", "--quiet", "-m", "B"]);
    const commitB = g(originDir, ["rev-parse", "HEAD"]);

    // Deploy target starts checked out at the OLDER commit A -- KEEP (targeting B) fetches +
    // resets it forward during this poll cycle.
    g(dir, ["clone", "--quiet", "-b", "custom", originDir, targetDir]);
    g(targetDir, ["reset", "--hard", "--quiet", commitA]);

    const statusPath = path.join(scenario.dir, "status.jsonl");

    scenario.writeJson("company_list.json", [{ id: "co-1" }]);
    scenario.writeJson("approval_list.json", [
      {
        id: "aid-older",
        type: "request_board_approval",
        status: "approved",
        decidedAt: "2026-08-24T02:00:00Z",
        payload: { kind: "deploy", projectId: "proj-1", workspaceId: "ws-1", commit: commitA },
      },
      {
        id: "aid-newer",
        type: "request_board_approval",
        status: "approved",
        decidedAt: "2026-08-24T02:00:10Z",
        payload: { kind: "deploy", projectId: "proj-1", workspaceId: "ws-1", commit: commitB },
      },
    ]);
    const project = {
      id: "proj-1",
      deployPolicy: {
        enabled: true,
        workspaceId: "ws-1",
        deployKind: "custom",
        deployTargetPath: targetDir,
        deployCommand: "true",
        // Fails fast (connection refused) so health_check exhausts its one retry immediately --
        // KEEP's outcome comment doesn't matter for this test, only that the checkout actually
        // advanced to commitB (rollback: none leaves it there even though health "failed").
        healthCheckUrl: "http://127.0.0.1:1/health",
        rollback: "none",
      },
      workspaces: [{ id: "ws-1", repoUrl: originDir, repoRef: "custom" }],
    };
    scenario.writeJson("project-proj-1.json", project);
    scenario.writeJson("approval-aid-newer.json", {
      id: "aid-newer",
      payload: { kind: "deploy", projectId: "proj-1", workspaceId: "ws-1", commit: commitB },
    });
    scenario.writeJson("approval-aid-older.json", {
      id: "aid-older",
      payload: { kind: "deploy", projectId: "proj-1", workspaceId: "ws-1", commit: commitA },
    });

    const result = runMain(scenario, {
      PAPERCLIP_DEPLOY_RUNNER_STATUS_PATH: statusPath,
      PAPERCLIP_DEPLOY_RUNNER_HEALTH_RETRIES: "1",
      PAPERCLIP_DEPLOY_RUNNER_HEALTH_SLEEP: "0",
      // The health check here is deliberately pointed at a refused port to
      // fail fast (rollback: none — only the checkout advancing matters) —
      // without this the DUR-163 port-open pre-wait would burn its full
      // default budget treating "refused" as "maybe still booting".
      PAPERCLIP_DEPLOY_RUNNER_PORT_WAIT_SECONDS: "0",
    });
    assertSuccess(result, "main()");

    assert.equal(g(targetDir, ["rev-parse", "HEAD"]), commitB, "KEEP must have actually advanced the checkout to the newer commit");

    const olderComments = scenario.commentsFor("aid-older");
    assert.equal(olderComments.length, 1);
    assert.match(olderComments[0], /already reachable from what's now live/);
    assert.match(olderComments[0], new RegExp(commitA));

    assert.deepEqual(scenario.processedIds().sort(), ["aid-newer", "aid-older"]);

    const statusLines = readFileSync(statusPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const olderEntry = statusLines.find((e) => e.approvalId === "aid-older");
    assert.ok(olderEntry, "expected a status-log entry for the superseded approval");
    assert.equal(olderEntry.outcome, "carried");
    assert.equal(olderEntry.commit, commitA);
  } finally {
    scenario.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run_one_approval's crash-fallback comment does not double-comment when the real outcome comment already delivered", () => {
  const scenario = makeScenario();
  try {
    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      comment() { printf '%s\\n' "$3" >> "${path.join(scenario.dir, "comments.log")}"; return 0; }
      process_approval() { comment "$1" "$2" "handled normally"; }
      run_one_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], {
      env: { ...process.env, PAPERCLIP_DEPLOY_RUNNER_PROCESSED: scenario.processed, PAPERCLIP_DEPLOY_RUNNER_LOG: scenario.log },
    });
    assertSuccess(result, "run_one_approval");

    const comments = readFileSync(path.join(scenario.dir, "comments.log"), "utf8").split("\n").filter(Boolean);
    assert.deepEqual(comments, ["handled normally"], "the EXIT trap fallback must not post a second comment");
    assert.deepEqual(scenario.processedIds(), ["aid-1"]);
  } finally {
    scenario.cleanup();
  }
});

// DUR-163 regression coverage: a failed deploy used to destroy its own
// evidence (rollback recreates the container before anyone reads its logs)
// and a health check under load couldn't tell "server refused/timed out"
// from "server responded and just isn't healthy yet" — both read identically
// as "not 200" and both silently ate into the same 22-commit-batch deploy
// that got blamed on a startup bug it never had.

test("probe_verdict distinguishes a real HTTP response from a refused connection and a timeout", () => {
  const script = `
    source "${SCRIPT}"
    probe_verdict 0 200
    probe_verdict 0 503
    probe_verdict 7 000
    probe_verdict 28 000
    probe_verdict 6 000
  `;
  const result = run("bash", ["-c", script]);
  assertSuccess(result, "probe_verdict");
  assert.deepEqual(
    result.stdout.trim().split("\n"),
    ["ok", "http_error", "refused", "timeout", "unreachable"],
    "curl exit 7 (refused) and 28 (timeout) must not collapse into the same verdict as each other or as a real HTTP response",
  );
});

function withListener(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// health_check shells out to `curl` via spawnSync, which BLOCKS this test
// process's event loop until curl exits. An in-process http.createServer()
// listener can accept the TCP connection (handled by the OS) but can never
// run its own JS request handler to write a response while this process is
// itself blocked waiting on that same curl call — a self-deadlock, broken
// only by curl's own --max-time. So the "server actually answers 200" half
// of these tests needs a REAL separate process — a tiny stdlib-only Python
// HTTP server — not an in-process Node listener.
function startPythonHttpServer(dir) {
  return new Promise((resolve, reject) => {
    const script = [
      "import http.server, socketserver, sys",
      "class H(http.server.SimpleHTTPRequestHandler):",
      "    def __init__(self, *a, **kw): super().__init__(*a, directory=sys.argv[1], **kw)",
      "    def log_message(self, *a): pass",
      "with socketserver.TCPServer(('127.0.0.1', 0), H) as httpd:",
      "    print(httpd.server_address[1], flush=True)",
      "    httpd.serve_forever()",
    ].join("\n");
    const child = spawn("python3", ["-c", script, dir], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    let settled = false;
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      buf += chunk.toString();
      const match = /^(\d+)/.exec(buf);
      if (match) {
        settled = true;
        resolve({ child, port: Number(match[1]) });
      }
    });
    child.on("error", (err) => {
      if (!settled) { settled = true; reject(err); }
    });
    child.on("exit", (code) => {
      if (!settled) { settled = true; reject(new Error(`python3 http server exited early (code ${code})`)); }
    });
  });
}

test("health_check logs every probe's http code and load average, and succeeds as soon as a 200 arrives", async () => {
  const webRoot = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-health-root-"));
  writeFileSync(path.join(webRoot, "health"), "ok");
  const { child, port } = await startPythonHttpServer(webRoot);
  const scenario = makeScenario();
  try {
    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      health_check "http://127.0.0.1:${port}/health"
    `;
    const result = run("bash", ["-c", script], {
      env: {
        ...process.env,
        PAPERCLIP_DEPLOY_RUNNER_LOG: scenario.log,
        PAPERCLIP_DEPLOY_RUNNER_HEALTH_RETRIES: "3",
        PAPERCLIP_DEPLOY_RUNNER_HEALTH_SLEEP: "0",
        PAPERCLIP_DEPLOY_RUNNER_PORT_WAIT_SECONDS: "5",
      },
    });
    assertSuccess(result, "health_check");
    assert.match(
      scenario.readLog(),
      /health probe 1\/3 ok \(http_code=200 load=\S+\)/,
      "a successful probe must record its own http code and the load average at the time",
    );
  } finally {
    child.kill();
    scenario.cleanup();
    rmSync(webRoot, { recursive: true, force: true });
  }
});

test("health_check reports a refused connection as its own verdict, distinct from a real HTTP error, and fails once retries are exhausted", async () => {
  // Bind then immediately release a port so nothing is listening on it —
  // the connection is actively refused, not merely slow. No response body
  // is ever needed for a refusal, so the event-loop deadlock above doesn't
  // apply here — a plain in-process listener is fine.
  const probe = await withListener((_req, res) => res.end());
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const scenario = makeScenario();
  try {
    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      health_check "http://127.0.0.1:${port}/health"
    `;
    const result = run("bash", ["-c", script], {
      env: {
        ...process.env,
        PAPERCLIP_DEPLOY_RUNNER_LOG: scenario.log,
        PAPERCLIP_DEPLOY_RUNNER_HEALTH_RETRIES: "2",
        PAPERCLIP_DEPLOY_RUNNER_HEALTH_SLEEP: "0",
        PAPERCLIP_DEPLOY_RUNNER_PORT_WAIT_SECONDS: "1",
      },
    });
    assert.equal(result.status, 1, "health_check must fail once every probe is refused and retries are exhausted");
    const log = scenario.readLog();
    assert.match(log, /never accepted a TCP connection within 1s/, "a port that never opens must be called out separately from a probe that connected");
    assert.match(log, /health probe 1\/2 refused \(curl_status=7 http_code=000 load=\S+\)/);
    assert.match(log, /health probe 2\/2 refused \(curl_status=7 http_code=000 load=\S+\)/);
    assert.doesNotMatch(log, /health probe \d+\/2 ok/, "a refused connection must never be logged as if it were a real (if unhealthy) HTTP response");
  } finally {
    scenario.cleanup();
  }
});

test("maybe_rollback captures the failing container's logs to a durable file before the rollback would recreate it", () => {
  const scenario = makeScenario();
  try {
    writeFileSync(path.join(scenario.dir, "docker-logs-docker-server-1.txt"), "FATAL: crashed during boot\n");
    const failureLogDir = path.join(scenario.dir, "failure-logs");

    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      DV_ROLLBACK=git_previous
      DV_DEPLOY_KIND=custom
      DV_DEPLOY_TARGET_PATH=/nonexistent
      DV_DEPLOY_SERVICES=
      DV_DEPLOY_COMMAND=true
      DV_COMPOSE_FILES=
      DV_ENV_FILE=
      maybe_rollback "aid-1" "unknown" "deadbeef"
    `;
    const result = run("bash", ["-c", script], {
      env: {
        ...process.env,
        PATH: `${scenario.binDir}:${process.env.PATH}`,
        SCENARIO_DIR: scenario.dir,
        PAPERCLIP_DEPLOY_RUNNER_LOG: scenario.log,
        PAPERCLIP_DEPLOY_RUNNER_FAILURE_LOG_DIR: failureLogDir,
      },
    });
    assertSuccess(result, "maybe_rollback");

    const diagPath = result.stdout.trim();
    assert.ok(diagPath, "maybe_rollback must print the diagnostics file path it captured");
    assert.ok(existsSync(diagPath), `expected the captured diagnostics file to exist at ${diagPath}`);
    const contents = readFileSync(diagPath, "utf8");
    assert.match(contents, /FATAL: crashed during boot/, "the failing container's actual log output must be captured, not just a marker that capture ran");
    assert.match(scenario.readLog(), /captured pre-rollback failure diagnostics to/);
  } finally {
    scenario.cleanup();
  }
});

test("maybe_rollback is a no-op — no diagnostics captured, nothing printed — when rollback isn't configured", () => {
  const scenario = makeScenario();
  try {
    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      DV_ROLLBACK=none
      DV_DEPLOY_KIND=custom
      DV_DEPLOY_TARGET_PATH=/nonexistent
      maybe_rollback "aid-1" "before123" "after456"
    `;
    const result = run("bash", ["-c", script], {
      env: {
        ...process.env,
        PATH: `${scenario.binDir}:${process.env.PATH}`,
        SCENARIO_DIR: scenario.dir,
        PAPERCLIP_DEPLOY_RUNNER_LOG: scenario.log,
        PAPERCLIP_DEPLOY_RUNNER_FAILURE_LOG_DIR: path.join(scenario.dir, "failure-logs"),
      },
    });
    assertSuccess(result, "maybe_rollback");
    assert.equal(result.stdout.trim(), "", "no rollback configured means no diagnostics path to report");
    assert.ok(!existsSync(path.join(scenario.dir, "failure-logs")), "capture_failure_diagnostics must never run when DV_ROLLBACK isn't git_previous");
  } finally {
    scenario.cleanup();
  }
});
