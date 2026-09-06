import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
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
