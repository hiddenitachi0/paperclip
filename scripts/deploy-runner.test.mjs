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

// spawnSync blocks this whole process's event loop until the child exits.
// That's fine for every other test here (the child only ever talks to files
// on disk via the fake `docker`), but the health_check HTTP-error test below
// runs a real HTTP server IN this same process for curl to hit — with
// spawnSync, the event loop that server needs to accept/answer the
// connection is exactly what's frozen waiting for curl, deadlocking both
// sides. Use a real (async) child process there instead so the server can
// still run while curl is in flight.
function runAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: repoRoot, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

// Fake `docker` that intercepts `docker exec [-e K=V ...] <container> sh -lc "<cmd>"`.
// Dispatches on substrings of <cmd> against canned JSON fixtures in
// $SCENARIO_DIR, and can be told to fail specific `approval comment <id>`
// calls a controllable number of times via $SCENARIO_DIR/fail-count-<id>.
// Built from plain (non-template) strings, not a template literal — the
// script is full of bash `${...}` expansions that a JS template literal
// would try to interpolate itself.
// DUR-163: `docker compose ...` invocations (run_recipe()/capture_failure_logs(),
// the true I/O boundary for the recipe and pre-rollback log-capture code paths)
// are dispatched separately from `docker exec` below, keyed off canned exit
// codes/output in $SCENARIO_DIR (compose-{build,up,logs}-exit,
// compose-logs-output.txt) so a test can force a recipe failure and control
// what "docker compose logs" returns for it, without needing a real docker.
const FAKE_DOCKER = [
  '#!/usr/bin/env bash',
  'set -uo pipefail',
  '',
  'if [ "${1:-}" = "compose" ]; then',
  '  shift',
  '  # Skip any leading --env-file/-f flag pairs run_recipe()/capture_failure_logs()',
  '  # build ahead of the actual subcommand, so this still finds `logs`/`build`/`up`',
  '  # regardless of whether a test configures composeFiles/envFile.',
  '  while [ "$#" -gt 0 ]; do',
  '    case "$1" in',
  '      --env-file|-f) shift 2 ;;',
  '      *) break ;;',
  '    esac',
  '  done',
  '  sub="${1:-}"',
  '  case "$sub" in',
  '    logs)',
  '      cat "$SCENARIO_DIR/compose-logs-output.txt" 2>/dev/null',
  '      exit "$(cat "$SCENARIO_DIR/compose-logs-exit" 2>/dev/null || echo 0)"',
  '      ;;',
  '    build)',
  '      exit "$(cat "$SCENARIO_DIR/compose-build-exit" 2>/dev/null || echo 0)"',
  '      ;;',
  '    up)',
  '      exit "$(cat "$SCENARIO_DIR/compose-up-exit" 2>/dev/null || echo 0)"',
  '      ;;',
  '    *)',
  '      exit 0',
  '      ;;',
  '  esac',
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

// DUR-163: on an overloaded host, health probes can intermittently come back
// as a curl connect failure/timeout ("000") even though the server is
// healthy -- e.g. mid `docker build` -- and the old health_check() logged
// nothing per-probe, so there was no way to tell that apart after the fact
// from an actual HTTP error response. This proves the two are now logged
// distinctly (never conflated) and that each probe line carries the host
// load average when it's cheaply available (/proc/loadavg, present on any
// Linux CI box).
test("health_check logs each probe with its HTTP code and load average, and distinguishes a connect failure from an HTTP error response", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-health-test-"));
  try {
    const log = path.join(dir, "log");
    const healthEnv = {
      ...process.env,
      PAPERCLIP_DEPLOY_RUNNER_LOG: log,
      PAPERCLIP_DEPLOY_RUNNER_HEALTH_RETRIES: "1",
      PAPERCLIP_DEPLOY_RUNNER_HEALTH_SLEEP: "0",
    };

    // Connect-refused probe: nothing listens on 127.0.0.1:1 (a privileged
    // port), so curl fails to connect at all -- no HTTP response was ever
    // received.
    const refusedScript = `set -uo pipefail\nsource "${SCRIPT}"\nhealth_check "http://127.0.0.1:1/health"`;
    const refusedResult = run("bash", ["-c", refusedScript], { env: healthEnv });
    assert.equal(refusedResult.status, 1, "a connect failure must still count as an unhealthy probe");

    const refusedLines = readFileSync(log, "utf8").split("\n").filter(Boolean);
    const refusedLine = refusedLines.at(-1);
    assert.match(
      refusedLine,
      /health probe 1\/1 http:\/\/127\.0\.0\.1:1\/health -> connect failed\/timed out \(curl exit \d+\)/,
    );
    assert.doesNotMatch(refusedLine, /-> HTTP/, "a connect failure must never be logged as if an HTTP response came back");

    // HTTP-error probe: a real server that deliberately answers 500, so the
    // distinction being asserted is against an actual response, not just
    // another way to fail to connect.
    const server = http.createServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      const errorScript = `set -uo pipefail\nsource "${SCRIPT}"\nhealth_check "http://127.0.0.1:${port}/health"`;
      // Async spawn, not spawnSync -- the server above lives in this same
      // process, so a synchronous spawn would freeze the event loop it needs
      // to answer curl's request (see runAsync's comment).
      const errorResult = await runAsync("bash", ["-c", errorScript], { env: healthEnv });
      assert.equal(errorResult.status, 1, "a 500 response must not count as healthy");

      const errorLines = readFileSync(log, "utf8").split("\n").filter(Boolean);
      const errorLine = errorLines.at(-1);
      assert.match(errorLine, new RegExp(`health probe 1/1 http://127\\.0\\.0\\.1:${port}/health -> HTTP 500`));
      assert.doesNotMatch(errorLine, /connect failed/, "an actual HTTP error response must never be conflated with a connect failure");
      assert.match(errorLine, /\(load avg: [0-9.]+\)/, "each probe should carry the host load average when it's cheaply available");
    } finally {
      server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// DUR-163: before a rollback swaps out a failed container, its logs must be
// captured somewhere that survives the swap. capture_failure_logs() is the
// unit under test here in isolation; format_log_excerpt() is the piece that
// turns a (potentially large) capture into the bounded excerpt the failure
// comment actually carries.
test("capture_failure_logs writes the failing container's docker compose logs to a durable file, and format_log_excerpt returns a bounded tail", () => {
  const scenario = makeScenario();
  try {
    const targetDir = path.join(scenario.dir, "target-repo");
    mkdirSync(targetDir, { recursive: true });
    const lines = Array.from({ length: 250 }, (_, i) => `log line ${i + 1}`);
    writeFileSync(path.join(scenario.dir, "compose-logs-output.txt"), `${lines.join("\n")}\n`);

    const script = `set -uo pipefail\nsource "${SCRIPT}"\ncapture_failure_logs "${targetDir}" "compose_recreate" "" "" "" "aid-1"`;
    const result = run("bash", ["-c", script], {
      env: {
        ...process.env,
        PATH: `${scenario.binDir}:${process.env.PATH}`,
        SCENARIO_DIR: scenario.dir,
        PAPERCLIP_DEPLOY_RUNNER_LOG: scenario.log,
      },
    });
    assertSuccess(result, "capture_failure_logs");
    const capturePath = result.stdout.trim();
    assert.ok(capturePath, "capture_failure_logs must print the capture file path on success");
    assert.ok(existsSync(capturePath), `capture file ${capturePath} must exist on disk`);

    const captured = readFileSync(capturePath, "utf8");
    assert.match(captured, /^log line 1$/m, "the full capture must include the earliest lines");
    assert.match(captured, /^log line 250$/m, "the full capture must include the latest lines");

    const excerptScript = `set -uo pipefail\nsource "${SCRIPT}"\nformat_log_excerpt "${capturePath}"`;
    const excerptResult = run("bash", ["-c", excerptScript], { env: process.env });
    assertSuccess(excerptResult, "format_log_excerpt");
    assert.doesNotMatch(excerptResult.stdout, /^log line 50$/m, "the comment excerpt must be bounded to the last 200 lines, not the full capture");
    assert.match(excerptResult.stdout, /^log line 51$/m, "tail -200 of 250 lines should start at line 51");
    assert.match(excerptResult.stdout, /^log line 250$/m);
    assert.match(
      excerptResult.stdout,
      new RegExp(capturePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "the excerpt should point at the full capture file for anyone who needs more than the tail",
    );
  } finally {
    scenario.cleanup();
  }
});

test("capture_failure_logs captures nothing for a custom recipe kind, since there is no defined container identity to target", () => {
  const scenario = makeScenario();
  try {
    const script = `set -uo pipefail\nsource "${SCRIPT}"\ncapture_failure_logs "/tmp" "custom" "" "" "" "aid-1"`;
    const result = run("bash", ["-c", script], {
      env: {
        ...process.env,
        PATH: `${scenario.binDir}:${process.env.PATH}`,
        SCENARIO_DIR: scenario.dir,
        PAPERCLIP_DEPLOY_RUNNER_LOG: scenario.log,
      },
    });
    assert.equal(result.status, 1, "a custom recipe has no defined container identity, so nothing should be captured");
    assert.equal(result.stdout, "");
  } finally {
    scenario.cleanup();
  }
});

// DUR-163 end-to-end: a real compose_recreate recipe failure, through
// process_approval(), must capture the failing container's logs BEFORE
// maybe_rollback() resets the checkout and re-runs the recipe (which is
// exactly what destroys the evidence), and the resulting failure comment
// must carry a bounded excerpt of that capture rather than only a pointer
// to deploy-runner.log.
test("process_approval captures pre-rollback container logs before maybe_rollback runs, and includes a bounded excerpt in the failure comment", () => {
  const scenario = makeScenario();
  const dir = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-capture-integration-"));
  try {
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
    mkdirSync(targetDir, { recursive: true });
    g(targetDir, ["init", "--quiet", "-b", "custom"]);
    writeFileSync(path.join(targetDir, "f.txt"), "A");
    g(targetDir, ["add", "f.txt"]);
    g(targetDir, ["commit", "--quiet", "-m", "A"]);

    const lines = Array.from({ length: 250 }, (_, i) => `container log ${i + 1}`);
    writeFileSync(path.join(scenario.dir, "compose-logs-output.txt"), `${lines.join("\n")}\n`);
    // The recipe's `up -d --force-recreate` fails -- this is the "failed
    // deploy" whose evidence must not be destroyed by the rollback that follows.
    writeFileSync(path.join(scenario.dir, "compose-up-exit"), "1");

    const project = {
      id: "proj-1",
      deployPolicy: {
        enabled: true,
        workspaceId: "ws-1",
        deployKind: "compose_recreate",
        deployTargetPath: targetDir,
        healthCheckUrl: "http://example.invalid/health",
        rollback: "git_previous",
      },
      workspaces: [{ id: "ws-1", repoUrl: "https://example.invalid/repo.git", repoRef: "custom" }],
    };
    scenario.writeJson("project-proj-1.json", project);
    scenario.writeJson("approval-aid-1.json", {
      id: "aid-1",
      payload: { projectId: "proj-1", workspaceId: "ws-1", kind: "deploy" },
    });

    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { return 0; }
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

    // Not scenario.commentsFor() here: that helper splits the delivered
    // comment log on "\n" on the assumption a comment body is single-line,
    // which every OTHER test's body is -- this one's body deliberately isn't
    // (it embeds a multi-line log excerpt), so read the raw file instead.
    const commentPath = path.join(scenario.dir, "comment-aid-1.log");
    assert.ok(existsSync(commentPath), "expected a delivered comment for aid-1");
    const commentBody = readFileSync(commentPath, "utf8");
    assert.equal(commentBody.split("Deploy failed").length - 1, 1, "expected exactly one delivered comment for aid-1");
    assert.match(commentBody, /Rolled back to/);
    assert.match(commentBody, /Last 200 lines of container logs captured just before rollback/);
    assert.match(commentBody, /container log 250/);
    assert.doesNotMatch(commentBody, /container log 1\n/, "the comment must carry a bounded tail, not the entire capture");

    const runnerLog = scenario.readLog();
    const capturedAt = runnerLog.indexOf("captured pre-rollback container logs to");
    const rollingBackAt = runnerLog.indexOf("rolling back");
    assert.ok(capturedAt !== -1, "expected a log line recording the capture");
    assert.ok(rollingBackAt !== -1, "expected a log line recording the rollback");
    assert.ok(capturedAt < rollingBackAt, "the capture must happen BEFORE the rollback, or the evidence would already be destroyed by it");
  } finally {
    scenario.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
