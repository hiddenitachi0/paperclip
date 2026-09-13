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
  // DUR-3974: `docker compose ...` — the pre-swap stop, the restart-after-a-
  // failed-swap, and (via capture_failure_diagnostics) the log capture. Every
  // invocation is appended to one ordered file so a test can assert not just
  // THAT the services were stopped but that it happened before the checkout
  // was swapped.
  'if [ "${1:-}" = "compose" ]; then',
  '  printf "%s\\n" "$*" >> "$SCENARIO_DIR/docker-compose-calls.log"',
  '  if [ -f "$SCENARIO_DIR/compose-fail-$2" ]; then echo "fake: docker compose $2 failed" >&2; exit 1; fi',
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
  // DUR-259: fake responses for the quiet-mode CLI wrapper deploy-runner.sh
  // polls before/after a compose_recreate|compose_build_swap recipe.
  // activate/deactivate calls are appended to a log file so tests can assert
  // ownership behavior (whether the runner activated it vs. found it already
  // active) without needing a real timing-based simulation.
  '  *"instance quiet-mode:status"*)',
  '    fixture="$SCENARIO_DIR/quiet-mode-status.json"',
  '    if [ -f "$fixture" ]; then cat "$fixture"; else printf \'{"active":false,"activeRunCount":0}\'; fi',
  '    ;;',
  // DUR-3965: the full command line is recorded too, so a test can assert
  // the runner names ITSELF as the reason ("--reason deploy") instead of
  // leaving readers to guess from the actor -- it signs in as an instance
  // admin, so by actor alone it looks exactly like a person.
  '  *"instance quiet-mode:activate"*)',
  '    echo activate >> "$SCENARIO_DIR/quiet-mode-calls.log"',
  '    printf \'%s\\n\' "$cmd" >> "$SCENARIO_DIR/quiet-mode-activate-cmd.log"',
  '    printf \'{"active":true}\'',
  '    ;;',
  // DUR-3965: a deactivate can fail because Paperclip's own API is down --
  // which is exactly the case when the deploy being rolled back IS Paperclip.
  // $SCENARIO_DIR/deactivate-fail-count says how many of the next deactivate
  // calls must fail; each failed attempt is logged as "deactivate-failed" so
  // the retry sequence itself is assertable.
  '  *"instance quiet-mode:deactivate"*)',
  '    fail_count_file="$SCENARIO_DIR/deactivate-fail-count"',
  '    if [ -f "$fail_count_file" ]; then',
  '      remaining="$(cat "$fail_count_file")"',
  '      if [ "$remaining" -gt 0 ]; then',
  '        echo $((remaining - 1)) > "$fail_count_file"',
  '        echo deactivate-failed >> "$SCENARIO_DIR/quiet-mode-calls.log"',
  '        echo "fake: quiet-mode:deactivate failed (server down)" >&2',
  '        exit 1',
  '      fi',
  '    fi',
  '    echo deactivate >> "$SCENARIO_DIR/quiet-mode-calls.log"',
  '    printf \'{"active":false}\'',
  '    ;;',
  // DUR-257: the pause-for-restart call the runner makes once the drain
  // times out. Logged into the same calls file so ordering can be asserted;
  // a `pause-for-restart-fail` marker file in the scenario makes it fail.
  '  *"instance heartbeat-runs:pause-for-restart"*)',
  '    echo pause-for-restart >> "$SCENARIO_DIR/quiet-mode-calls.log"',
  '    if [ -f "$SCENARIO_DIR/pause-for-restart-fail" ]; then echo "fake: pause-for-restart failed" >&2; exit 1; fi',
  '    printf \'{"paused":3,"runIds":["r1","r2","r3"]}\'',
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

// `overrides` is extra bash injected between `source deploy-runner.sh` and
// `main` — the same stubbing trick the single-function tests below use, but
// for a whole poll cycle, so a test can drive main() end to end without
// reaching the real GitHub API, git, docker compose or health-check URL.
function runMain(scenario, extraEnv = {}, overrides = "") {
  return run("bash", ["-c", `set -uo pipefail\nsource "${SCRIPT}"\n${overrides}\nmain`], {
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

// DUR-3923: unsupported-kind cards are only answered when decided within the last 24h
// (UNSUPPORTED_KIND_MAX_AGE_SECONDS), so their decidedAt must be relative to "now" --
// a hard-coded date silently goes stale the day after it is written.
function isoAgo(ms) {
  return new Date(Date.now() - ms).toISOString();
}
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

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
    // DUR-3952 follow-up: the refusal talks to the operator, not to whoever
    // knows the payload format -- it points at the rollback button instead of
    // naming a payload field or a ticket number.
    assert.match(comments[0], /Roll back to previous version/, "the refusal must tell the operator which button to use for a real rollback");
    assert.doesNotMatch(comments[0], /allowBackwardDeploy|payload\.|DUR-\d+/, "the refusal must not name payload fields or ticket ids");
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
    // DUR-3923: the "started" line precedes the outcome line; the outcome is what matters here.
    const entry = statusLines.filter((e) => e.approvalId === "aid-1" && e.outcome !== "started").pop();
    assert.ok(entry, "expected a status-log outcome entry for aid-1");
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
    // DUR-420: deploy-runner.sh logs `--short=12`, not git's 7-char default -- match it here so
    // this asserts against what the script actually produces (see commitsMatch()'s matching
    // 12-char minimum in deploy-completion-gate.ts for the full threat model this closes).
    const expectedCommit = g(["rev-parse", "--short=12", "HEAD"]);

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
    const entries = statusLines.filter((e) => e.approvalId === "aid-1");
    // DUR-3923: a "started" line lands first, then the terminal outcome.
    assert.equal(entries.length, 2, `expected a started line followed by the outcome line, got: ${JSON.stringify(entries)}`);
    assert.equal(entries[0].outcome, "started");
    assert.equal(entries[0].commentDelivered, false, "the started line is not a comment");
    const entry = entries[1];
    assert.notEqual(entry.outcome, "started");
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

// DUR-3923: the server's deploy-approval-feedback tick decides "the runner never picked this
// card up" purely from the status log. Every other line is written at the END of a deploy, and a
// deploy can legitimately take longer than the tick's patience (drain + build + health budget,
// doubled on rollback), so the runner must say "started" BEFORE the slow part -- and must do so
// on the failure path too, where the deploy takes longest.
test("DUR-3923: a 'started' status line is recorded before the build, even when the deploy then fails and rolls back", () => {
  const scenario = makeScenario();
  const dir = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-started-test-"));
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

    scenario.writeJson("project-proj-1.json", {
      id: "proj-1",
      deployPolicy: {
        enabled: true,
        workspaceId: "ws-1",
        deployKind: "custom",
        deployTargetPath: targetPath,
        healthCheckUrl: "http://example.invalid/health",
        rollback: "git_previous",
      },
      workspaces: [{ id: "ws-1", repoUrl: "https://example.invalid/repo.git", repoRef: "custom" }],
    });
    scenario.writeJson("approval-aid-1.json", {
      id: "aid-1",
      payload: { projectId: "proj-1", workspaceId: "ws-1", commit: "irrelevant", kind: "deploy" },
    });

    const statusPath = path.join(scenario.dir, "status.jsonl");
    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { return 0; }
      # The recipe fails the first time (the deploy) and succeeds the second (the rollback);
      # every status line written before the first recipe run is what this test is about.
      RECIPE_RUNS=0
      run_recipe() {
        RECIPE_RUNS=$((RECIPE_RUNS + 1))
        echo "recipe run $RECIPE_RUNS lines_before=$(grep -c . "${statusPath}" 2>/dev/null || echo 0)" >> "${scenario.dir}/recipe.log"
        [ "$RECIPE_RUNS" -eq 1 ] && return 1
        return 0
      }
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
    assert.equal(comments.length, 1, "exactly one outcome comment is posted; the started line is not a comment");
    assert.match(comments[0], /Deploy failed/);
    assert.match(comments[0], /Rolled back/);

    const statusLines = readFileSync(statusPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const entries = statusLines.filter((e) => e.approvalId === "aid-1");
    assert.equal(entries.length, 2, `expected exactly a started line and a failed line, got: ${JSON.stringify(entries)}`);
    assert.equal(entries[0].outcome, "started");
    assert.equal(entries[0].companyId, "co-1");
    assert.equal(entries[0].commentDelivered, false);
    assert.match(entries[0].body, /Deploy started/);
    assert.doesNotMatch(entries[0].body, /is live and healthy/, "a started line must never read like a success");
    assert.match(entries[1].body, /Deploy failed/);
    assert.notEqual(entries[1].outcome, "started");

    // The started line was on disk before the recipe (build) ever ran.
    const recipeLog = readFileSync(path.join(scenario.dir, "recipe.log"), "utf8").trim().split("\n");
    assert.equal(recipeLog.length, 2, "deploy recipe + rollback recipe");
    assert.match(recipeLog[0], /lines_before=1$/, "the started line must be written before the first recipe run");
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

// DUR-3905: deploy-runner must hold/skip a deploy whose GitHub CI is red or
// still running, instead of shipping it and relying on health-check +
// rollback to catch it afterward.

function makeCiScenarioProject(scenario, targetPath) {
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
    workspaces: [{ id: "ws-1", repoUrl: "https://github.com/acme/widgets.git", repoRef: "custom" }],
  };
  scenario.writeJson("project-proj-1.json", project);
  scenario.writeJson("approval-aid-1.json", {
    id: "aid-1",
    payload: { projectId: "proj-1", workspaceId: "ws-1", commit: "deadbeef", kind: "deploy" },
  });
}

test("process_approval stops the deploy for good, and never touches the checkout, when GitHub CI is red", () => {
  const scenario = makeScenario();
  try {
    const targetPath = path.join(scenario.dir, "target-repo");
    makeCiScenarioProject(scenario, targetPath);

    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      check_ci_status() { echo failure; }
      git_fetch_reset() { echo "git_fetch_reset must not run when CI is red" >&2; exit 9; }
      run_recipe() { echo "run_recipe must not run when CI is red" >&2; exit 9; }
      process_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], {
      env: {
        ...process.env,
        PATH: `${scenario.binDir}:${process.env.PATH}`,
        SCENARIO_DIR: scenario.dir,
        PAPERCLIP_DEPLOY_RUNNER_LOG: scenario.log,
        PAPERCLIP_DEPLOY_RUNNER_CI_WAIT_STATE: path.join(scenario.dir, "ci-waiting"),
      },
    });
    // DUR-3967: red is terminal — process_approval must return comment()'s
    // own delivery status (0 here), NOT the "held, re-check me" status that
    // a still-running build now returns.
    assertSuccess(result, "process_approval");

    const comments = scenario.commentsFor("aid-1");
    assert.equal(comments.length, 1);
    assert.match(comments[0], /did not pass/);
    assert.doesNotMatch(comments[0], /\bCI\b/, "operator-facing wording must say 'the automated checks', never 'CI'");
    assert.match(scenario.readLog(), /holding — GitHub CI for deadbeef is failure/);
  } finally {
    scenario.cleanup();
  }
});

// DUR-3967: the bug this whole block exists for. On 2026-09-10 card ca143f73
// (commit 3a372317) was approved seconds after its merge, so GitHub CI on the
// merge commit was still running when the runner first looked. "pending" was
// terminal: the card was commented, marked processed and never looked at
// again. CI went green two minutes later and nothing happened — the card read
// "approved" forever and had to be recovered by hand-editing the box's
// processed-set file. This is the ordinary case, not an edge case.

function makeCiPollScenario(scenario, { decidedAt } = {}) {
  const targetPath = path.join(scenario.dir, "target-repo");
  makeCiScenarioProject(scenario, targetPath);
  scenario.writeJson("company_list.json", [{ id: "co-1" }]);
  scenario.writeJson("approval_list.json", [
    {
      id: "aid-1",
      type: "request_board_approval",
      status: "approved",
      decidedAt: decidedAt ?? isoAgo(60 * 1000),
      payload: { kind: "deploy", projectId: "proj-1", workspaceId: "ws-1", commit: "deadbeef" },
    },
  ]);
  scenario.writeJson("approval-aid-1.json", {
    id: "aid-1",
    status: "approved",
    decidedAt: decidedAt ?? isoAgo(60 * 1000),
    payload: { kind: "deploy", projectId: "proj-1", workspaceId: "ws-1", commit: "deadbeef" },
  });
  return targetPath;
}

// check_ci_status is read from a scenario file so a test can change the
// answer BETWEEN poll cycles, which is the whole point: tick 1 sees a build
// that is still running, tick 2 sees the same build green.
const CI_STATUS_OVERRIDES = [
  'check_ci_status() { cat "$SCENARIO_DIR/ci-status"; }',
  // DUR-3974: process_approval calls git_fetch_reset twice — once as a dry run
  // (6th argument set) that only runs the refusal guards, and once for real. Only
  // the real one is a deploy, so only that one is counted here.
  'git_fetch_reset() { [ -n "${6:-}" ] || echo "$(date -u +%s) fetch" >> "$SCENARIO_DIR/deploys.log"; return 0; }',
  'run_recipe() { return 0; }',
  'health_check() { return 0; }',
].join("\n");

const NO_DEPLOY_OVERRIDES = [
  'check_ci_status() { cat "$SCENARIO_DIR/ci-status"; }',
  'git_fetch_reset() { [ -n "${6:-}" ] || echo fetch >> "$SCENARIO_DIR/deploys.log"; return 0; }',
  'run_recipe() { echo recipe >> "$SCENARIO_DIR/deploys.log"; return 0; }',
  'health_check() { return 0; }',
].join("\n");

function ciPollEnv(scenario, extra = {}) {
  return {
    PAPERCLIP_DEPLOY_RUNNER_CI_WAIT_STATE: path.join(scenario.dir, "ci-waiting"),
    ...extra,
  };
}

function setCiStatus(scenario, value) {
  writeFileSync(path.join(scenario.dir, "ci-status"), `${value}\n`);
}

// Same stubs as NO_DEPLOY_OVERRIDES, but WITHOUT stubbing check_ci_status —
// so the real function runs against a real (fake) GitHub over HTTP. Needed for
// any test about what happens when the API answer itself changes shape, which
// a stub returning canned words can't reach.
const REAL_CI_OVERRIDES = [
  'git_fetch_reset() { [ -n "${6:-}" ] || echo fetch >> "$SCENARIO_DIR/deploys.log"; return 0; }',
  'run_recipe() { echo recipe >> "$SCENARIO_DIR/deploys.log"; return 0; }',
  'health_check() { return 0; }',
].join("\n");

function deployAttempts(scenario) {
  const file = path.join(scenario.dir, "deploys.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean);
}

// The waiting-for-checks state file (one TAB-separated row per held card).
function ciWaitStatePath(scenario) {
  return path.join(scenario.dir, "ci-waiting");
}

function ciWaitRows(scenario) {
  const file = ciWaitStatePath(scenario);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean);
}

test("a deploy whose checks are still running on the first tick ships by itself on a later tick once they pass", () => {
  const scenario = makeScenario();
  try {
    makeCiPollScenario(scenario);

    // Tick 1: the automated checks are still running.
    setCiStatus(scenario, "pending");
    assertSuccess(runMain(scenario, ciPollEnv(scenario), CI_STATUS_OVERRIDES), "main() tick 1");

    assert.deepEqual(deployAttempts(scenario), [], "nothing may be deployed while the checks are still running");
    assert.deepEqual(
      scenario.processedIds(),
      [],
      "a still-running build must NOT be terminal — the card has to stay unprocessed so the next tick re-checks it",
    );
    const afterFirstTick = scenario.commentsFor("aid-1");
    assert.equal(afterFirstTick.length, 1, `expected exactly one waiting note, got: ${JSON.stringify(afterFirstTick)}`);
    assert.match(afterFirstTick[0], /Waiting for the automated checks/);
    assert.match(afterFirstTick[0], /will start on its own/, "the operator must be told the deploy resumes by itself");
    assert.doesNotMatch(
      afterFirstTick[0],
      /Re-approve|re-file/i,
      "the old wording taught the operator to approve the same commit twice for no safety reason",
    );

    // Tick 2: the same build has gone green. Nobody re-approved anything.
    setCiStatus(scenario, "success");
    assertSuccess(runMain(scenario, ciPollEnv(scenario), CI_STATUS_OVERRIDES), "main() tick 2");

    assert.equal(deployAttempts(scenario).length, 1, "the deploy must happen on its own once the checks pass");
    const comments = scenario.commentsFor("aid-1");
    assert.equal(comments.length, 2, `expected the waiting note plus one outcome, got: ${JSON.stringify(comments)}`);
    assert.match(comments[1], /is live and healthy/);
    assert.deepEqual(scenario.processedIds(), ["aid-1"], "once it has actually deployed the card is finished with");
    assert.equal(
      existsSync(path.join(scenario.dir, "ci-waiting")) &&
        readFileSync(path.join(scenario.dir, "ci-waiting"), "utf8").includes("aid-1"),
      false,
      "the wait state must be cleared once the card stops waiting",
    );
  } finally {
    scenario.cleanup();
  }
});

test("a deploy whose checks never finish gives up at the deadline with exactly one note, and deploys nothing", () => {
  const scenario = makeScenario();
  try {
    makeCiPollScenario(scenario, { decidedAt: isoAgo(10 * 60 * 1000) });
    setCiStatus(scenario, "pending");

    // Tick 1, well inside the deadline: one waiting note, still unprocessed.
    assertSuccess(
      runMain(scenario, ciPollEnv(scenario, { PAPERCLIP_DEPLOY_RUNNER_CI_WAIT_SECONDS: "3600" }), NO_DEPLOY_OVERRIDES),
      "main() tick 1",
    );
    assert.equal(scenario.commentsFor("aid-1").length, 1);
    assert.deepEqual(scenario.processedIds(), []);

    // Ticks 2 and 3 with the deadline already behind us (the card was decided
    // 10 minutes ago; a 0-second budget puts it past the deadline). The card
    // must give up ONCE — the second of these two ticks must find it already
    // processed and say nothing at all.
    for (const label of ["tick 2", "tick 3"]) {
      assertSuccess(
        runMain(scenario, ciPollEnv(scenario, { PAPERCLIP_DEPLOY_RUNNER_CI_WAIT_SECONDS: "0" }), NO_DEPLOY_OVERRIDES),
        `main() ${label}`,
      );
    }

    const comments = scenario.commentsFor("aid-1");
    assert.equal(comments.length, 2, `expected the waiting note plus exactly one deadline note, got: ${JSON.stringify(comments)}`);
    assert.match(comments[1], /Deploy not started/);
    assert.match(comments[1], /stopped waiting/);
    assert.doesNotMatch(comments[1], /\bCI\b/, "operator-facing wording must say 'the automated checks', never 'CI'");
    assert.deepEqual(scenario.processedIds(), ["aid-1"], "at the deadline the card becomes terminal");
    assert.deepEqual(deployAttempts(scenario), [], "an unproven build must never be deployed, deadline or not");
  } finally {
    scenario.cleanup();
  }
});

test("a card waiting on its checks does not post a comment on every tick, but stays visible in the log", () => {
  const scenario = makeScenario();
  try {
    makeCiPollScenario(scenario);
    setCiStatus(scenario, "pending");

    // The runner ticks every 60s. Three ticks, one waiting note.
    for (const label of ["tick 1", "tick 2", "tick 3"]) {
      assertSuccess(
        runMain(
          scenario,
          ciPollEnv(scenario, {
            PAPERCLIP_DEPLOY_RUNNER_CI_WAIT_SECONDS: "3600",
            // Nothing may be re-announced within the throttle window.
            PAPERCLIP_DEPLOY_RUNNER_CI_WAIT_LOG_INTERVAL_SECONDS: "3600",
          }),
          NO_DEPLOY_OVERRIDES,
        ),
        `main() ${label}`,
      );
    }

    assert.equal(
      scenario.commentsFor("aid-1").length,
      1,
      `a held card must be commented on once, not once per tick, got: ${JSON.stringify(scenario.commentsFor("aid-1"))}`,
    );
    assert.deepEqual(scenario.processedIds(), []);
    const throttledLog = scenario.readLog();
    assert.equal(
      (throttledLog.match(/still waiting — the automated checks/g) || []).length,
      0,
      "inside the throttle window the log must not repeat itself either",
    );
    assert.equal(
      (throttledLog.match(/waiting — the automated checks/g) || []).length,
      1,
      "…but the card entering the waiting state must be logged once",
    );

    // With the throttle window elapsed the wait stays visible: one more tick
    // logs it again (and mirrors a machine-readable line into the status feed
    // that the API already exposes), without adding another comment.
    assertSuccess(
      runMain(
        scenario,
        ciPollEnv(scenario, {
          PAPERCLIP_DEPLOY_RUNNER_CI_WAIT_SECONDS: "3600",
          PAPERCLIP_DEPLOY_RUNNER_CI_WAIT_LOG_INTERVAL_SECONDS: "0",
        }),
        NO_DEPLOY_OVERRIDES,
      ),
      "main() tick 4",
    );
    assert.match(scenario.readLog(), /still waiting — the automated checks/, "a long wait must not go dark in the log");
    assert.equal(scenario.commentsFor("aid-1").length, 1, "logging again must not mean commenting again");
  } finally {
    scenario.cleanup();
  }
});

test("a red build is terminal on the very first tick — commented once, marked processed, never retried", () => {
  const scenario = makeScenario();
  try {
    makeCiPollScenario(scenario);
    setCiStatus(scenario, "failure");

    assertSuccess(runMain(scenario, ciPollEnv(scenario), NO_DEPLOY_OVERRIDES), "main() tick 1");
    assert.deepEqual(scenario.processedIds(), ["aid-1"], "a build that actually failed needs a person, not a retry");
    assert.equal(scenario.commentsFor("aid-1").length, 1);
    assert.match(scenario.commentsFor("aid-1")[0], /did not pass/);
    assert.deepEqual(deployAttempts(scenario), []);

    assertSuccess(runMain(scenario, ciPollEnv(scenario), NO_DEPLOY_OVERRIDES), "main() tick 2");
    assert.equal(scenario.commentsFor("aid-1").length, 1, "a terminal card must not be re-commented on the next tick");
    assert.deepEqual(deployAttempts(scenario), []);
  } finally {
    scenario.cleanup();
  }
});

test("process_approval still deploys when GitHub CI is unknown (no checks configured) — fail open, not fail closed", () => {
  const scenario = makeScenario();
  try {
    const targetPath = path.join(scenario.dir, "target-repo");
    makeCiScenarioProject(scenario, targetPath);

    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      check_ci_status() { echo unknown; }
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
        PAPERCLIP_DEPLOY_RUNNER_CI_WAIT_STATE: path.join(scenario.dir, "ci-waiting"),
      },
    });
    assertSuccess(result, "process_approval");

    const comments = scenario.commentsFor("aid-1");
    assert.equal(comments.length, 1);
    assert.match(comments[0], /is live and healthy/, "no CI configured must not itself block a deploy that would otherwise have gone through");
  } finally {
    scenario.cleanup();
  }
});

// DUR-3967 safety: the retry loop multiplied the fail-open sample.
//
// Before this ticket a card was looked at ONCE, so exactly one GitHub API
// sample decided it and "unknown" was one coin toss. A held card now
// re-samples every 60s for up to 45 minutes, and check_ci_status collapses an
// unreachable API, a 403 rate-limit body, a timeout and unparseable JSON all
// into the same "unknown" — so without this guard, ~45 chances existed for a
// build we had positive evidence was still being checked to ship anyway. The
// api.github.com connect timeout is 5s from a box that runs at load 13+
// during a deploy; this is not exotic.
//
// This test deliberately does NOT stub check_ci_status: the pending -> unknown
// transition only exists in the real function, so a stub returning canned
// words would prove nothing about it.
test("a card already waiting on its checks does not fail open into a deploy when GitHub stops answering", async () => {
  const webRoot = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-ci-outage-root-"));
  writeGitHubFixture(webRoot, "deadbeef", {
    status: { total_count: 0, state: "pending" },
    checkRuns: { check_runs: [{ status: "in_progress", conclusion: null }] },
  });
  const { child, port } = await startPythonHttpServer(webRoot);
  const scenario = makeScenario();
  let stopped = false;
  const stopGitHub = async () => {
    if (stopped) return;
    stopped = true;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  };
  try {
    makeCiPollScenario(scenario);
    const env = (extra = {}) =>
      ciPollEnv(scenario, {
        PAPERCLIP_DEPLOY_RUNNER_GITHUB_API_BASE: `http://127.0.0.1:${port}`,
        PAPERCLIP_DEPLOY_RUNNER_CI_WAIT_SECONDS: "3600",
        ...extra,
      });

    // Tick 1: a real fixture, checks genuinely still running. The card is held
    // and the operator is told so — positive evidence that checks exist here.
    assertSuccess(runMain(scenario, env(), REAL_CI_OVERRIDES), "main() tick 1");
    assert.deepEqual(deployAttempts(scenario), []);
    assert.deepEqual(scenario.processedIds(), []);
    assert.equal(scenario.commentsFor("aid-1").length, 1);
    assert.match(scenario.commentsFor("aid-1")[0], /Waiting for the automated checks/);

    // Tick 2: GitHub is simply gone. check_ci_status can only say "unknown",
    // and "unknown" must NOT be read as "there was nothing to wait for".
    await stopGitHub();
    assertSuccess(runMain(scenario, env(), REAL_CI_OVERRIDES), "main() tick 2");
    assert.deepEqual(
      deployAttempts(scenario),
      [],
      "a build we already know was mid-check must not ship just because GitHub went unreachable",
    );
    assert.deepEqual(scenario.processedIds(), [], "it is still waiting, not finished with");
    assert.equal(scenario.commentsFor("aid-1").length, 1, "and the wait is not re-announced on every tick");

    // Tick 3: the hold is bounded by the SAME deadline, so a genuine GitHub
    // outage ends in the terminal note rather than holding the card forever.
    assertSuccess(
      runMain(scenario, env({ PAPERCLIP_DEPLOY_RUNNER_CI_WAIT_SECONDS: "0" }), REAL_CI_OVERRIDES),
      "main() tick 3",
    );
    assert.deepEqual(deployAttempts(scenario), []);
    assert.deepEqual(scenario.processedIds(), ["aid-1"]);
    const comments = scenario.commentsFor("aid-1");
    assert.equal(comments.length, 2, `expected the waiting note plus one deadline note, got: ${JSON.stringify(comments)}`);
    assert.match(comments[1], /Deploy not started/);
    assert.deepEqual(ciWaitRows(scenario), [], "and the wait state does not outlive the card");
  } finally {
    await stopGitHub();
    scenario.cleanup();
    rmSync(webRoot, { recursive: true, force: true });
  }
});

// DUR-3967 safety: the wait-state row must outlive an undeliverable terminal
// comment. The deadline branch used to clear the row BEFORE posting its note.
// If that note could not be delivered (the server container is mid-recreate,
// which is exactly when a deploy is in flight), run_one_approval leaves the
// card UNPROCESSED — but its wait row is already gone. A card with no wait row
// is precisely what tells the next tick that an "unknown" verdict means "this
// repo has no checks" rather than "we have already seen this one mid-check",
// so the guard above silently disarms itself and an unproven build ships.
//
// The rule this encodes: never drop state that a later decision depends on
// until something durable has actually happened. mark_processed() clears the
// row on every path that really did end the card.
test("a deadline note that cannot be delivered still leaves the card protected against a later unknown", async () => {
  const webRoot = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-ci-deadline-undeliverable-"));
  writeGitHubFixture(webRoot, "deadbeef", {
    status: { total_count: 0, state: "pending" },
    checkRuns: { check_runs: [{ status: "in_progress", conclusion: null }] },
  });
  const { child, port } = await startPythonHttpServer(webRoot);
  const scenario = makeScenario();
  let stopped = false;
  const stopGitHub = async () => {
    if (stopped) return;
    stopped = true;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  };
  try {
    makeCiPollScenario(scenario);
    const env = (extra = {}) =>
      ciPollEnv(scenario, {
        PAPERCLIP_DEPLOY_RUNNER_GITHUB_API_BASE: `http://127.0.0.1:${port}`,
        PAPERCLIP_DEPLOY_RUNNER_CI_WAIT_SECONDS: "3600",
        ...extra,
      });

    // Tick 1: checks genuinely still running, card held and announced.
    assertSuccess(runMain(scenario, env(), REAL_CI_OVERRIDES), "main() tick 1");
    assert.deepEqual(scenario.processedIds(), []);
    assert.equal(ciWaitRows(scenario).length, 1, "the card is on record as waiting");

    // Tick 2: past the deadline, but every comment delivery fails.
    scenario.setFailCount("aid-1", 50);
    assertSuccess(
      runMain(scenario, env({ PAPERCLIP_DEPLOY_RUNNER_CI_WAIT_SECONDS: "0" }), REAL_CI_OVERRIDES),
      "main() tick 2",
    );
    assert.deepEqual(
      scenario.processedIds(),
      [],
      "an undelivered terminal comment must leave the card unprocessed, so it is retried",
    );

    // Tick 3: comments work again, but GitHub is now unreachable -> "unknown".
    // The card is still one we have seen mid-check, so it must not deploy.
    scenario.setFailCount("aid-1", 0);
    await stopGitHub();
    assertSuccess(
      runMain(scenario, env({ PAPERCLIP_DEPLOY_RUNNER_CI_WAIT_SECONDS: "0" }), REAL_CI_OVERRIDES),
      "main() tick 3",
    );
    assert.deepEqual(
      deployAttempts(scenario),
      [],
      "a build whose checks never passed must not ship just because its deadline note failed to send",
    );
  } finally {
    await stopGitHub();
    scenario.cleanup();
    rmSync(webRoot, { recursive: true, force: true });
  }
});

// DUR-3967 safety: fail-open must still survive where it is justified. A repo
// that never had checks gets an "unknown" on its FIRST look, with no wait
// state behind it — no positive evidence that anything is being checked — and
// must deploy exactly as it always has.
test("a first look that finds no checks at all still fails open and deploys, even over the real GitHub call", async () => {
  const webRoot = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-ci-nochecks-root-"));
  writeGitHubFixture(webRoot, "deadbeef", {
    status: { total_count: 0, state: "pending" },
    checkRuns: { check_runs: [] },
  });
  const { child, port } = await startPythonHttpServer(webRoot);
  const scenario = makeScenario();
  try {
    makeCiPollScenario(scenario);
    assertSuccess(
      runMain(
        scenario,
        ciPollEnv(scenario, { PAPERCLIP_DEPLOY_RUNNER_GITHUB_API_BASE: `http://127.0.0.1:${port}` }),
        REAL_CI_OVERRIDES,
      ),
      "main()",
    );
    assert.equal(deployAttempts(scenario).length, 2, "absence of checks must not block a deploy that would otherwise go through");
    assert.deepEqual(scenario.processedIds(), ["aid-1"]);
    assert.match(scenario.commentsFor("aid-1")[0], /is live and healthy/);
  } finally {
    child.kill();
    scenario.cleanup();
    rmSync(webRoot, { recursive: true, force: true });
  }
});

// DUR-3967: a decidedAt AHEAD of this host's clock used to disable the
// deadline outright. `waited = now - decidedAt` went negative, the clamp
// pinned it at 0, and the card was announced once and then held forever:
// re-hitting GitHub every 60s, never reaching the deadline, never telling the
// operator anything again.
test("an approval timestamped in the future still gets a bounded wait, not a card held forever", () => {
  const scenario = makeScenario();
  try {
    makeCiPollScenario(scenario, { decidedAt: new Date(Date.now() + 2 * ONE_HOUR_MS).toISOString() });
    setCiStatus(scenario, "pending");
    // 30 minutes of budget — deliberately different from the hour this card
    // ends up actually waiting, so the deadline note can't fake the number.
    const env = ciPollEnv(scenario, { PAPERCLIP_DEPLOY_RUNNER_CI_WAIT_SECONDS: "1800" });

    // A timestamp from the future must not make the card give up instantly
    // either: it is announced and held like any other.
    assertSuccess(runMain(scenario, env, NO_DEPLOY_OVERRIDES), "main() tick 1");
    assert.equal(scenario.commentsFor("aid-1").length, 1);
    assert.match(scenario.commentsFor("aid-1")[0], /Waiting for the automated checks/);
    assert.deepEqual(scenario.processedIds(), []);
    assert.equal(ciWaitRows(scenario).length, 1);

    // Age the wait state by an hour — what an hour of 60s ticks does to it.
    const anHourAgo = Math.floor(Date.now() / 1000) - 3600;
    writeFileSync(ciWaitStatePath(scenario), `aid-1\t${anHourAgo}\t${anHourAgo}\n`);

    assertSuccess(runMain(scenario, env, NO_DEPLOY_OVERRIDES), "main() tick 2");
    const comments = scenario.commentsFor("aid-1");
    assert.equal(
      comments.length,
      2,
      `the wait must end at the deadline whatever the approval's timestamp says, got: ${JSON.stringify(comments)}`,
    );
    assert.match(comments[1], /Deploy not started/);
    assert.deepEqual(scenario.processedIds(), ["aid-1"]);
    assert.deepEqual(deployAttempts(scenario), []);
    assert.deepEqual(ciWaitRows(scenario), []);

    // …and the note quotes how long it ACTUALLY waited (an hour), not the
    // configured budget (30 minutes). A card the runner only got back to after
    // 90 minutes must not claim it gave up after 45.
    assert.match(comments[1], /about 60 minutes/);
    assert.doesNotMatch(comments[1], /about 30 minutes/);
  } finally {
    scenario.cleanup();
  }
});

// DUR-3967 operator wording: this is the one message that has to tell a
// non-technical operator what to do next, and every claim in it has to be
// true. See handle_ci_pending.
test("the two waiting-for-checks notes say something a non-technical operator can act on, and nothing untrue", () => {
  const scenario = makeScenario();
  try {
    makeCiPollScenario(scenario, { decidedAt: isoAgo(10 * 60 * 1000) });
    setCiStatus(scenario, "pending");

    assertSuccess(
      runMain(scenario, ciPollEnv(scenario, { PAPERCLIP_DEPLOY_RUNNER_CI_WAIT_SECONDS: "3600" }), NO_DEPLOY_OVERRIDES),
      "main() tick 1",
    );
    const waiting = scenario.commentsFor("aid-1")[0];
    // The single-flight lock means no tick happens AT ALL while another deploy
    // is running (~26 minutes has really happened), so "within a minute or two"
    // on its own is a promise this runner cannot keep.
    assert.match(waiting, /usually within a minute or two of the checks passing, longer if another deploy is already running/);

    assertSuccess(
      runMain(scenario, ciPollEnv(scenario, { PAPERCLIP_DEPLOY_RUNNER_CI_WAIT_SECONDS: "0" }), NO_DEPLOY_OVERRIDES),
      "main() tick 2",
    );
    const deadline = scenario.commentsFor("aid-1")[1];
    assert.match(deadline, /Once the checks have passed/, "'finished' includes finished red — which is not a green light");
    assert.match(
      deadline,
      /ask the agent that filed this deploy to file a new deploy approval/,
      "the operator must be told who to ask, the way the sibling messages in this file name a button or an agent",
    );
    assert.match(
      deadline,
      /If the checks keep hanging or finish red/,
      "asking again hits the same wall unless someone fixes what is failing — say so",
    );
    assert.doesNotMatch(deadline, /deploy runner/, "the other two messages manage without naming the machinery");
    assert.doesNotMatch(deadline, /\bCI\b/);
  } finally {
    scenario.cleanup();
  }
});

// DUR-3967: nothing may leave a row behind in the waiting-for-checks file. A
// stale row is not inert — the "unknown means keep waiting" guard in
// process_approval keys off exactly this file.
test("a waiting card leaves no row behind when it is superseded, and stale rows for finished cards are pruned", () => {
  const scenario = makeScenario();
  try {
    makeCiPollScenario(scenario);
    // aid-2: same project/workspace, decided later — so aid-1 is superseded.
    const aid2 = {
      id: "aid-2",
      type: "request_board_approval",
      status: "approved",
      decidedAt: isoAgo(0),
      payload: { kind: "deploy", projectId: "proj-1", workspaceId: "ws-1", commit: "deadbeef" },
    };
    scenario.writeJson("approval-aid-2.json", aid2);
    scenario.writeJson("approval_list.json", [
      {
        id: "aid-1",
        type: "request_board_approval",
        status: "approved",
        decidedAt: isoAgo(60 * 1000),
        payload: { kind: "deploy", projectId: "proj-1", workspaceId: "ws-1", commit: "deadbeef" },
      },
      aid2,
    ]);
    setCiStatus(scenario, "success");

    // aid-1 was left waiting by an earlier cycle; aid-old is a row from a card
    // that is already finished with (a crash, a kill -9, or a version of this
    // script that never cleared rows at all).
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(ciWaitStatePath(scenario), `aid-1\t${now}\t${now}\naid-old\t${now}\t${now}\n`);
    writeFileSync(scenario.processed, "aid-old\n");

    assertSuccess(runMain(scenario, ciPollEnv(scenario), NO_DEPLOY_OVERRIDES), "main()");

    assert.ok(scenario.processedIds().includes("aid-2"), "the newest approval for the group runs");
    assert.ok(scenario.processedIds().includes("aid-1"), "the superseded one is answered and finished with");
    assert.deepEqual(
      ciWaitRows(scenario),
      [],
      "neither the superseded card nor the already-processed one may keep a waiting-for-checks row",
    );
  } finally {
    scenario.cleanup();
  }
});

// check_ci_status() itself, against a real local HTTP server serving canned
// GitHub API responses as static files (same reasoning as health_check's own
// tests above for why this needs a real separate server process, not an
// in-process Node listener: curl blocks this process's event loop).
function writeGitHubFixture(webRoot, sha, { status, checkRuns }) {
  const commitDir = path.join(webRoot, "repos", "acme", "widgets", "commits", sha);
  mkdirSync(commitDir, { recursive: true });
  writeFileSync(path.join(commitDir, "status"), JSON.stringify(status));
  writeFileSync(path.join(commitDir, "check-runs"), JSON.stringify(checkRuns));
}

test("check_ci_status classifies GitHub's combined status + check-runs responses correctly", async () => {
  const webRoot = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-ci-status-root-"));
  writeGitHubFixture(webRoot, "success-sha", {
    status: { total_count: 1, state: "success" },
    checkRuns: { check_runs: [{ status: "completed", conclusion: "success" }] },
  });
  writeGitHubFixture(webRoot, "failure-sha", {
    status: { total_count: 1, state: "failure" },
    checkRuns: { check_runs: [] },
  });
  writeGitHubFixture(webRoot, "bad-check-run-sha", {
    status: { total_count: 0, state: "pending" },
    checkRuns: { check_runs: [{ status: "completed", conclusion: "failure" }] },
  });
  writeGitHubFixture(webRoot, "pending-sha", {
    status: { total_count: 0, state: "pending" },
    checkRuns: { check_runs: [{ status: "in_progress", conclusion: null }] },
  });
  writeGitHubFixture(webRoot, "unknown-sha", {
    status: { total_count: 0, state: "pending" },
    checkRuns: { check_runs: [] },
  });
  // DUR-3967: one check has already finished RED while another is still
  // running. "Still running" now means "hold this card and re-check it every
  // 60s", so calling this pending would leave a build with a known-failed
  // check sitting in the wait loop — and if somebody re-ran just the failed
  // job and it went green inside the window, it would ship on the operator's
  // original approval. Red beats still-running.
  writeGitHubFixture(webRoot, "red-plus-running-sha", {
    status: { total_count: 0, state: "pending" },
    checkRuns: {
      check_runs: [
        { status: "completed", conclusion: "failure" },
        { status: "in_progress", conclusion: null },
      ],
    },
  });
  // Same finding, reached the other way: the combined commit status is still
  // pending, but a check-run under it has already concluded red.
  writeGitHubFixture(webRoot, "combined-pending-red-run-sha", {
    status: { total_count: 1, state: "pending" },
    checkRuns: { check_runs: [{ status: "completed", conclusion: "failure" }] },
  });
  // …and the mirror image: nothing red, one job still going. Still pending.
  writeGitHubFixture(webRoot, "green-plus-running-sha", {
    status: { total_count: 0, state: "pending" },
    checkRuns: {
      check_runs: [
        { status: "completed", conclusion: "success" },
        { status: "in_progress", conclusion: null },
      ],
    },
  });

  const { child, port } = await startPythonHttpServer(webRoot);
  const scenario = makeScenario();
  try {
    const check = (sha) => {
      const result = run("bash", ["-c", `set -uo pipefail\nsource "${SCRIPT}"\ncheck_ci_status "https://github.com/acme/widgets.git" "$1" ""`, "_", sha], {
        env: {
          ...process.env,
          PAPERCLIP_DEPLOY_RUNNER_LOG: scenario.log,
          PAPERCLIP_DEPLOY_RUNNER_GITHUB_API_BASE: `http://127.0.0.1:${port}`,
        },
      });
      assertSuccess(result, `check_ci_status ${sha}`);
      return result.stdout.trim();
    };

    assert.equal(check("success-sha"), "success");
    assert.equal(check("failure-sha"), "failure");
    assert.equal(check("bad-check-run-sha"), "failure");
    assert.equal(check("pending-sha"), "pending");
    assert.equal(check("unknown-sha"), "unknown");
    assert.equal(check("red-plus-running-sha"), "failure", "a check that already finished red is terminal even while others run");
    assert.equal(check("combined-pending-red-run-sha"), "failure");
    assert.equal(check("green-plus-running-sha"), "pending", "…but nothing red and something still running is still just a wait");
  } finally {
    child.kill();
    scenario.cleanup();
    rmSync(webRoot, { recursive: true, force: true });
  }
});

test("github_owner_repo extracts owner/repo from both https and ssh GitHub remote URLs, and refuses non-GitHub hosts", () => {
  const scenario = makeScenario();
  const check = (url) => {
    const result = run("bash", ["-c", `set -uo pipefail\nsource "${SCRIPT}"\ngithub_owner_repo "$1"`, "_", url]);
    assertSuccess(result, `github_owner_repo ${url}`);
    return result.stdout.trim();
  };
  try {
    assert.equal(check("https://github.com/acme/widgets.git"), "acme/widgets");
    assert.equal(check("https://github.com/acme/widgets"), "acme/widgets");
    assert.equal(check("git@github.com:acme/widgets.git"), "acme/widgets");
    assert.equal(check("https://gitlab.example.com/acme/widgets.git"), "", "must never guess a token audience for a non-github.com host");
  } finally {
    scenario.cleanup();
  }
});

// DUR-259: deploy-runner.sh must proactively drain in-flight heartbeat runs
// (via the DUR-224 Quiet Mode mechanism) before a compose_recreate/
// compose_build_swap recipe recreates the shared docker-server-1 container —
// not just rely on shutdown()'s own in-process drain (DUR-257) once the
// recreate has already started. These tests exercise process_approval()
// directly (git_fetch_reset/run_recipe/health_check stubbed, same pattern as
// the DUR-237 test above) against the fake docker's quiet-mode:* handlers.
function setUpComposeRecreateScenario(scenario, { deployKind = "compose_recreate" } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-quiet-mode-test-"));
  const targetPath = path.join(dir, "target");
  mkdirSync(targetPath, { recursive: true });
  spawnSync("git", ["init", "--quiet", "-b", "custom"], { cwd: targetPath });

  const project = {
    id: "proj-1",
    deployPolicy: {
      enabled: true,
      workspaceId: "ws-1",
      deployKind,
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
  return { dir, targetPath };
}

function quietModeCallsLog(scenario) {
  const file = path.join(scenario.dir, "quiet-mode-calls.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean);
}

/** DUR-3965: the full `quiet-mode:activate` command lines, so --reason is assertable. */
function quietModeActivateCommands(scenario) {
  const file = path.join(scenario.dir, "quiet-mode-activate-cmd.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean);
}

test("DUR-259: a compose_recreate deploy activates quiet mode, drains immediately when nothing's in flight, then deactivates", () => {
  const scenario = makeScenario();
  let dir;
  try {
    ({ dir } = setUpComposeRecreateScenario(scenario));
    scenario.writeJson("quiet-mode-status.json", { active: false, activeRunCount: 0 });

    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { return 0; }
      run_recipe() { return 0; }
      health_check() { return 0; }
      process_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], { env: quietModeEnv(scenario) });
    assertSuccess(result, "process_approval");

    assert.equal(scenario.commentsFor("aid-1").length, 1);
    assert.match(scenario.commentsFor("aid-1")[0], /is live and healthy/);
    assert.deepEqual(quietModeCallsLog(scenario), ["activate", "deactivate"], "the runner activated quiet mode itself, so it must also be the one to deactivate it again");
    assert.match(scenario.readLog(), /activated quiet mode instance-wide before recreating/);
    assert.match(scenario.readLog(), /drain complete after 0s/);
    // DUR-3965 must-fix 3: the activation says WHY. Without it the server
    // cannot tell this apart from the operator switching quiet mode on for
    // the night — the runner authenticates as an instance admin.
    assert.match(
      quietModeActivateCommands(scenario).join("\n"),
      /instance quiet-mode:activate --reason deploy/,
      "the runner must name itself as the reason instead of leaving the server to guess from the actor",
    );
  } finally {
    scenario.cleanup();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("DUR-259: quiet mode already active (external maintenance window) is left active — the runner never activates or deactivates it", () => {
  const scenario = makeScenario();
  let dir;
  try {
    ({ dir } = setUpComposeRecreateScenario(scenario));
    scenario.writeJson("quiet-mode-status.json", { active: true, activeRunCount: 0 });

    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { return 0; }
      run_recipe() { return 0; }
      health_check() { return 0; }
      process_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], { env: quietModeEnv(scenario) });
    assertSuccess(result, "process_approval");

    assert.equal(scenario.commentsFor("aid-1").length, 1);
    assert.deepEqual(quietModeCallsLog(scenario), [], "quiet mode was already active — the runner must not call activate or deactivate itself");
    assert.match(scenario.readLog(), /quiet mode was already active \(external maintenance window\)/);
    assert.equal(
      existsSync(path.join(scenario.dir, "quiet-mode-pending")),
      false,
      "the runner never activated it, so it owns nothing to retry and must leave no marker behind",
    );
  } finally {
    scenario.cleanup();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("DUR-259: a drain that never reaches zero times out and still proceeds with the recreate, restoring quiet mode after", () => {
  const scenario = makeScenario();
  let dir;
  try {
    ({ dir } = setUpComposeRecreateScenario(scenario));
    // Always reports 3 runs still in flight — the drain can never complete.
    scenario.writeJson("quiet-mode-status.json", { active: false, activeRunCount: 3 });

    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { return 0; }
      run_recipe() { return 0; }
      health_check() { return 0; }
      process_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], {
      env: quietModeEnv(scenario, {
        PAPERCLIP_DEPLOY_RUNNER_DRAIN_TIMEOUT_SECONDS: "1",
        PAPERCLIP_DEPLOY_RUNNER_DRAIN_POLL_SECONDS: "1",
      }),
    });
    assertSuccess(result, "process_approval");

    assert.equal(scenario.commentsFor("aid-1").length, 1, "a drain timeout must not block the deploy from resolving to a definite outcome");
    assert.deepEqual(
      quietModeCallsLog(scenario),
      ["activate", "pause-for-restart", "deactivate"],
      "on a timeout the runner pauses the in-flight runs (DUR-257) before the recreate, and still restores quiet mode afterward",
    );
    assert.match(scenario.readLog(), /drain timed out after 1s with 3 heartbeat run\(s\) still in flight — marking them paused_for_restart before the recreate/);
    assert.match(scenario.readLog(), /paused in-flight heartbeat runs for the restart: .*"paused":3/);
  } finally {
    scenario.cleanup();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("DUR-257: when pause-for-restart itself fails, the runner logs it and still proceeds with the recreate", () => {
  const scenario = makeScenario();
  let dir;
  try {
    ({ dir } = setUpComposeRecreateScenario(scenario));
    scenario.writeJson("quiet-mode-status.json", { active: false, activeRunCount: 3 });
    writeFileSync(path.join(scenario.dir, "pause-for-restart-fail"), "");

    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { return 0; }
      run_recipe() { return 0; }
      health_check() { return 0; }
      process_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], {
      env: quietModeEnv(scenario, {
        PAPERCLIP_DEPLOY_RUNNER_DRAIN_TIMEOUT_SECONDS: "1",
        PAPERCLIP_DEPLOY_RUNNER_DRAIN_POLL_SECONDS: "1",
      }),
    });
    assertSuccess(result, "process_approval");

    assert.equal(scenario.commentsFor("aid-1").length, 1, "a failed pause call must not block the deploy from resolving");
    assert.deepEqual(quietModeCallsLog(scenario), ["activate", "pause-for-restart", "deactivate"]);
    assert.match(scenario.readLog(), /could not mark in-flight runs paused_for_restart — proceeding anyway/);
    assert.match(scenario.readLog(), /deployed OK/);
  } finally {
    scenario.cleanup();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("DUR-259: a custom deployKind never touches the quiet-mode drain at all", () => {
  const scenario = makeScenario();
  let dir;
  try {
    ({ dir } = setUpComposeRecreateScenario(scenario, { deployKind: "custom" }));
    scenario.writeJson("quiet-mode-status.json", { active: false, activeRunCount: 3 });

    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { return 0; }
      run_recipe() { return 0; }
      health_check() { return 0; }
      process_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], { env: quietModeEnv(scenario) });
    assertSuccess(result, "process_approval");

    assert.equal(scenario.commentsFor("aid-1").length, 1);
    assert.deepEqual(quietModeCallsLog(scenario), [], "an operator-authored custom command isn't known to touch the shared container, so it must not pay for a drain wait");
    assert.doesNotMatch(scenario.readLog(), /quiet mode/, "no quiet-mode drain logging at all for a custom deployKind");
    assert.equal(existsSync(path.join(scenario.dir, "quiet-mode-pending")), false, "nothing was drained, so there is nothing to retry later");
  } finally {
    scenario.cleanup();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// DUR-3965: on 2026-09-10 a failed deploy left the whole instance in quiet
// mode for 27 minutes -- both companies idle, 17 agents asleep, nothing in the
// UI saying why. Quiet mode lives in Paperclip's own database and is only
// reachable through Paperclip's own API, so when the deploy being rolled back
// IS Paperclip, the undo call lands while that API is down. These tests lock
// in the two halves of the fix: the undo happens on the FAILING paths too, and
// it survives a server that is not answering yet.
function quietModeEnv(scenario, extra = {}) {
  return {
    ...process.env,
    PATH: `${scenario.binDir}:${process.env.PATH}`,
    SCENARIO_DIR: scenario.dir,
    PAPERCLIP_DEPLOY_RUNNER_LOG: scenario.log,
    PAPERCLIP_DEPLOY_RUNNER_QUIET_MODE_MARKER: path.join(scenario.dir, "quiet-mode-pending"),
    // Keep the retry loop instant: no backoff sleeps, and a zero-second
    // budget for the "has the server come back?" wait (the fake health URL
    // never answers, which is precisely the case being simulated).
    PAPERCLIP_DEPLOY_RUNNER_QUIET_MODE_DEACTIVATE_BACKOFF_SECONDS: "0",
    PAPERCLIP_DEPLOY_RUNNER_QUIET_MODE_RECOVERY_HEALTH_SECONDS: "0",
    ...extra,
  };
}

test("DUR-3965: a deploy whose health check fails still ends quiet mode — the call log's last entry is deactivate", () => {
  const scenario = makeScenario();
  let dir;
  try {
    ({ dir } = setUpComposeRecreateScenario(scenario));
    scenario.writeJson("quiet-mode-status.json", { active: false, activeRunCount: 0 });

    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { return 0; }
      run_recipe() { return 0; }
      health_check() { return 1; }
      process_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], { env: quietModeEnv(scenario) });
    assertSuccess(result, "process_approval");

    assert.equal(scenario.commentsFor("aid-1").length, 1);
    assert.match(scenario.commentsFor("aid-1")[0], /health check against .* never returned 200/);
    const calls = quietModeCallsLog(scenario);
    assert.deepEqual(calls, ["activate", "deactivate"]);
    assert.equal(
      calls.at(-1),
      "deactivate",
      "a failed deploy must never be the reason the whole instance stays muted — the last quiet-mode call has to be the undo",
    );
    assert.equal(existsSync(path.join(scenario.dir, "quiet-mode-pending")), false, "the undo succeeded, so no retry marker is left behind");
  } finally {
    scenario.cleanup();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("DUR-3965: a deploy whose recipe fails still ends quiet mode", () => {
  const scenario = makeScenario();
  let dir;
  try {
    ({ dir } = setUpComposeRecreateScenario(scenario));
    scenario.writeJson("quiet-mode-status.json", { active: false, activeRunCount: 0 });

    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { return 0; }
      run_recipe() { return 1; }
      health_check() { return 0; }
      process_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], { env: quietModeEnv(scenario) });
    assertSuccess(result, "process_approval");

    assert.equal(scenario.commentsFor("aid-1").length, 1);
    assert.match(scenario.commentsFor("aid-1")[0], /recipe failed at commit/);
    assert.equal(quietModeCallsLog(scenario).at(-1), "deactivate");
  } finally {
    scenario.cleanup();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("DUR-3965: when the first deactivate calls fail (Paperclip's own API is down), a later retry succeeds and quiet mode is lifted", () => {
  const scenario = makeScenario();
  let dir;
  try {
    ({ dir } = setUpComposeRecreateScenario(scenario));
    scenario.writeJson("quiet-mode-status.json", { active: false, activeRunCount: 0 });
    // The first two attempts hit a server that is still coming back up.
    writeFileSync(path.join(scenario.dir, "deactivate-fail-count"), "2");

    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { return 0; }
      run_recipe() { return 0; }
      health_check() { return 1; }
      process_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], { env: quietModeEnv(scenario) });
    assertSuccess(result, "process_approval");

    assert.deepEqual(
      quietModeCallsLog(scenario),
      ["activate", "deactivate-failed", "deactivate-failed", "deactivate"],
      "the runner must keep trying to undo its own drain instead of giving up after one failed call",
    );
    assert.match(scenario.readLog(), /could not deactivate quiet mode \(attempt 1 of 5\)/);
    assert.match(scenario.readLog(), /deactivated quiet mode on attempt 3 of 5 — agents can take work again/);
    assert.equal(existsSync(path.join(scenario.dir, "quiet-mode-pending")), false, "the undo eventually succeeded, so nothing is left for the next cycle");
  } finally {
    scenario.cleanup();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("DUR-3965: when every deactivate attempt fails, the runner logs it loudly, leaves a marker, and the next poll cycle clears quiet mode", () => {
  const scenario = makeScenario();
  let dir;
  const marker = path.join(scenario.dir, "quiet-mode-pending");
  try {
    ({ dir } = setUpComposeRecreateScenario(scenario));
    scenario.writeJson("quiet-mode-status.json", { active: false, activeRunCount: 0 });
    // More failures than there are attempts: this deploy can never undo it.
    writeFileSync(path.join(scenario.dir, "deactivate-fail-count"), "99");

    const deployScript = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { return 0; }
      run_recipe() { return 0; }
      health_check() { return 1; }
      process_approval "aid-1" "co-1"
    `;
    const deployResult = run("bash", ["-c", deployScript], { env: quietModeEnv(scenario) });
    assertSuccess(deployResult, "process_approval");

    assert.deepEqual(quietModeCallsLog(scenario), ["activate", ...Array(5).fill("deactivate-failed")]);
    assert.match(scenario.readLog(), /QUIET MODE IS STILL ON and could not be turned off after 5 attempts/);
    assert.match(scenario.readLog(), /no agent in ANY company will start work until it is cleared/);
    assert.equal(existsSync(marker), true, "the failure has to survive this process so the next tick can retry it");
    assert.match(readFileSync(marker, "utf8"), /\taid-1\n$/, "the marker records which approval left quiet mode on");

    // Next poll cycle: quiet mode still reads as active — and says it was
    // this runner's deploy that switched it on, so it is safe to lift — and
    // the server is answering again, so the retry lifts it and clears the
    // marker.
    scenario.writeJson("quiet-mode-status.json", { active: true, activatedReason: "deploy", activeRunCount: 0 });
    writeFileSync(path.join(scenario.dir, "deactivate-fail-count"), "0");
    const retryResult = run("bash", ["-c", `set -uo pipefail\nsource "${SCRIPT}"\nretry_pending_quiet_mode_deactivate`], {
      env: quietModeEnv(scenario),
    });
    assertSuccess(retryResult, "retry_pending_quiet_mode_deactivate");

    assert.equal(quietModeCallsLog(scenario).at(-1), "deactivate");
    assert.match(scenario.readLog(), /turned it off now; every agent can take work again/);
    assert.equal(existsSync(marker), false, "a successful retry clears the marker so it is not retried forever");
  } finally {
    scenario.cleanup();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("DUR-3965: a deploy that dies mid-flight still has quiet mode undone by the exit trap", () => {
  const scenario = makeScenario();
  let dir;
  try {
    ({ dir } = setUpComposeRecreateScenario(scenario));
    scenario.writeJson("quiet-mode-status.json", { active: false, activeRunCount: 0 });

    // `exit 1` inside the recipe stands in for every way a deploy can die
    // after the drain is active and before any outcome path is reached: an
    // unbound-variable bug, the unit being stopped, the box rebooting. None
    // of them may leave the instance muted.
    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { return 0; }
      run_recipe() { exit 1; }
      health_check() { return 0; }
      run_one_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], { env: quietModeEnv(scenario) });
    assertSuccess(result, "run_one_approval");

    assert.deepEqual(quietModeCallsLog(scenario), ["activate", "deactivate"]);
    assert.equal(scenario.commentsFor("aid-1").length, 1, "the crash fallback comment still tells the operator the deploy died");
    assert.match(scenario.commentsFor("aid-1")[0], /exited unexpectedly/);
  } finally {
    scenario.cleanup();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("DUR-3965: a leftover marker whose quiet mode is already off is just cleared, with no deactivate call", () => {
  const scenario = makeScenario();
  const marker = path.join(scenario.dir, "quiet-mode-pending");
  try {
    writeFileSync(marker, "2026-09-10T13:20:00Z\taid-1\n");
    scenario.writeJson("quiet-mode-status.json", { active: false, activeRunCount: 0 });

    const result = run("bash", ["-c", `set -uo pipefail\nsource "${SCRIPT}"\nretry_pending_quiet_mode_deactivate`], {
      env: quietModeEnv(scenario),
    });
    assertSuccess(result, "retry_pending_quiet_mode_deactivate");

    assert.deepEqual(quietModeCallsLog(scenario), [], "someone already cleared it — do not touch an instance-wide switch that is already in the right place");
    assert.match(scenario.readLog(), /quiet mode is off again/);
    assert.equal(existsSync(marker), false);
  } finally {
    scenario.cleanup();
  }
});

// DUR-3965 recommendation A: the EXIT trap that undoes the drain does not run
// on SIGTERM or SIGKILL. `systemctl stop` overrunning its timeout, or the box
// rebooting mid-deploy, kills the runner outright — quiet mode stays on and
// nothing in this process ever gets to turn it off. That is only recoverable
// if the marker was written when the drain STARTED.
test("DUR-3965: a reboot mid-deploy leaves quiet mode on with a marker, and the next runner start lifts it", () => {
  const scenario = makeScenario();
  const marker = path.join(scenario.dir, "quiet-mode-pending");
  try {
    scenario.writeJson("quiet-mode-status.json", { active: false, activeRunCount: 0 });
    // SIGKILL to this shell: no EXIT trap, no undo, exactly like the box
    // going down between the drain and the recreate.
    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      maybe_begin_quiet_mode_drain "aid-1" "compose_recreate"
      kill -9 $$
    `;
    run("bash", ["-c", script], { env: quietModeEnv(scenario) });

    assert.deepEqual(quietModeCallsLog(scenario), ["activate"], "the runner was killed before it could undo its own drain");
    assert.equal(
      existsSync(marker),
      true,
      "with no EXIT trap and no marker there would be nothing at all left saying the fleet is muted — the marker must be written at drain start, not when the retries give up",
    );
    assert.match(readFileSync(marker, "utf8"), /\taid-1\n$/);

    // Next runner start: quiet mode is still on and still says a deploy did
    // it, so the retry lifts it about a minute later instead of leaving the
    // instance silent until a person notices.
    scenario.writeJson("quiet-mode-status.json", { active: true, activatedReason: "deploy", activeRunCount: 0 });
    const retry = run("bash", ["-c", `set -uo pipefail\nsource "${SCRIPT}"\nretry_pending_quiet_mode_deactivate`], {
      env: quietModeEnv(scenario),
    });
    assertSuccess(retry, "retry_pending_quiet_mode_deactivate");

    assert.equal(quietModeCallsLog(scenario).at(-1), "deactivate");
    assert.match(scenario.readLog(), /turned it off now; every agent can take work again/);
    assert.equal(existsSync(marker), false);
  } finally {
    scenario.cleanup();
  }
});

// DUR-3965 recommendation B: the marker means "a deploy left quiet mode on",
// not "quiet mode is on". If the operator switched it on themselves after the
// failed deploy — the overnight Claude-quota window is exactly that, most
// nights — un-muting the fleet from under them is the same mistake the server
// refuses to make.
test("DUR-3965: a quiet mode the operator switched on deliberately is never lifted by the marker retry", () => {
  const scenario = makeScenario();
  const marker = path.join(scenario.dir, "quiet-mode-pending");
  try {
    writeFileSync(marker, "2026-09-10T13:20:00Z\taid-1\n");
    scenario.writeJson("quiet-mode-status.json", { active: true, activatedReason: "manual", activeRunCount: 0 });

    const result = run("bash", ["-c", `set -uo pipefail\nsource "${SCRIPT}"\nretry_pending_quiet_mode_deactivate`], {
      env: quietModeEnv(scenario),
    });
    assertSuccess(result, "retry_pending_quiet_mode_deactivate");

    assert.deepEqual(quietModeCallsLog(scenario), [], "somebody chose this silence — the runner must not undo an operator's own switch");
    assert.match(scenario.readLog(), /switched on deliberately \(reason: manual\)/);
    assert.equal(existsSync(marker), false, "the marker is stale either way and must not keep re-firing every poll cycle");
  } finally {
    scenario.cleanup();
  }
});

// DUR-259 follow-up (see GH Actions run 33967261346's dead-silent
// deploy-runner.log): before this fix, `cli_json approval list ... ||
// continue` and the JSON-parse failure branch inside its python selector
// were both completely silent -- a main() poll cycle that hit either one
// would look, from deploy-runner.log, IDENTICAL to "nothing to do this
// cycle", even though process_approval (and everything downstream of it,
// including the whole DUR-259 drain) was never even reached. That blind
// spot is what made the recreate-acceptance CI failure impossible to
// diagnose from its own log dump. These two tests lock in that a JSON
// parse failure at either site is now loud, not silent.
test("main() logs a diagnostic (not silence) when the approval list for a company fails to parse as JSON", () => {
  const scenario = makeScenario();
  try {
    scenario.writeJson("company_list.json", [{ id: "co-1" }]);
    // Not valid JSON -- simulates stray stdout noise ahead of (or instead
    // of) the CLI's --json payload, e.g. a tool warning on stdout.
    writeFileSync(path.join(scenario.dir, "approval_list.json"), "not json at all");

    const result = runMain(scenario);
    assertSuccess(result, "main");
    assert.match(
      scenario.readLog(),
      /approval list for company co-1 did not parse as JSON -- skipping this company this poll cycle/,
      "a parse failure must be logged, not silently treated as an empty/no-op approval list",
    );
  } finally {
    scenario.cleanup();
  }
});

test("main() logs a diagnostic (not silence) when the company list itself fails to parse as JSON", () => {
  const scenario = makeScenario();
  try {
    writeFileSync(path.join(scenario.dir, "company_list.json"), "not json at all");

    const result = runMain(scenario);
    assertSuccess(result, "main");
    assert.match(
      scenario.readLog(),
      /company list did not parse as JSON -- aborting this poll cycle/,
      "a parse failure must be logged, not silently treated as zero companies",
    );
  } finally {
    scenario.cleanup();
  }
});

// DUR-3923 (NOR-1242): an approved card whose kind only looks like a deploy used to be
// invisible to main() -- filtered out by the `kind == "deploy"` candidate check, never
// commented on, never marked processed -- so the operator approved it and nothing at all
// happened. It must now get exactly one plain-language comment, a structured status-log
// entry, and be marked processed; and it must never reach process_approval (no deploy).
test("DUR-3923: an approved deploy_pr card gets a 'nothing acts on this' comment, never a deploy", () => {
  const scenario = makeScenario();
  try {
    scenario.writeJson("company_list.json", [{ id: "co-1" }]);
    scenario.writeJson("approval_list.json", [
      {
        id: "aid-deploy-pr",
        type: "request_board_approval",
        status: "approved",
        decidedAt: isoAgo(ONE_HOUR_MS),
        payload: { kind: "deploy_pr", prNumber: 42, repo: "acme/paperclip" },
      },
      {
        id: "aid-real",
        type: "request_board_approval",
        status: "approved",
        decidedAt: isoAgo(ONE_HOUR_MS - 5_000),
        payload: { kind: "deploy", projectId: "proj-1", workspaceId: "ws-1" },
      },
      {
        // Not deploy-like at all -- must be left alone entirely.
        id: "aid-merge",
        type: "request_board_approval",
        status: "approved",
        decidedAt: isoAgo(ONE_HOUR_MS - 10_000),
        payload: { kind: "merge_pr", prNumber: 43, repo: "acme/paperclip" },
      },
    ]);
    scenario.writeJson("approval-issues-aid-deploy-pr.json", [{ id: "issue-77" }]);
    scenario.writeJson("approval-aid-real.json", {
      id: "aid-real",
      payload: { kind: "deploy", projectId: "proj-1", workspaceId: "ws-1" },
    });
    scenario.writeJson("project-proj-1.json", DISABLED_POLICY_PROJECT);
    const statusPath = path.join(scenario.dir, "status.jsonl");

    const result = runMain(scenario, { PAPERCLIP_DEPLOY_RUNNER_STATUS_PATH: statusPath });
    assertSuccess(result, "main()");

    const comments = scenario.commentsFor("aid-deploy-pr");
    assert.equal(comments.length, 1, `expected exactly one comment for the deploy_pr card, got: ${JSON.stringify(comments)}`);
    assert.match(comments[0], /Nothing happened/);
    assert.match(comments[0], /kind "deploy_pr"/, "the comment must name the kind that was filed");
    assert.match(comments[0], /kind "deploy"/, "the comment must say what kind would actually work");
    assert.doesNotMatch(comments[0], /is live and healthy/, "an unsupported card must never read like a successful deploy");
    assert.deepEqual(scenario.issueCommentsFor("issue-77"), comments, "the note is mirrored onto the linked issue too");

    const statusLines = readFileSync(statusPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const entry = statusLines.find((e) => e.approvalId === "aid-deploy-pr");
    assert.ok(entry, "expected a status-log entry for the deploy_pr card");
    assert.equal(entry.outcome, "unsupported_kind");

    // The real deploy card is still handled exactly as before, and the merge_pr card untouched.
    assert.equal(scenario.commentsFor("aid-real").length, 1);
    assert.match(scenario.commentsFor("aid-real")[0], /Deploy failed/);
    assert.deepEqual(scenario.commentsFor("aid-merge"), []);
    assert.deepEqual(scenario.processedIds().sort(), ["aid-deploy-pr", "aid-real"]);

    // Idempotent: a second poll cycle says nothing more about it.
    const second = runMain(scenario, { PAPERCLIP_DEPLOY_RUNNER_STATUS_PATH: statusPath });
    assertSuccess(second, "main() second cycle");
    assert.equal(scenario.commentsFor("aid-deploy-pr").length, 1, "already processed -- must not comment again");
  } finally {
    scenario.cleanup();
  }
});

test("DUR-3923: an unsupported-kind card whose comment cannot be delivered is left unprocessed for the next cycle", () => {
  const scenario = makeScenario();
  try {
    scenario.writeJson("company_list.json", [{ id: "co-1" }]);
    scenario.writeJson("approval_list.json", [
      {
        id: "aid-rollout",
        type: "request_board_approval",
        status: "approved",
        decidedAt: isoAgo(ONE_HOUR_MS),
        payload: { kind: "rollout" },
      },
    ]);
    scenario.setFailCount("aid-rollout", 99);

    const result = runMain(scenario);
    assertSuccess(result, "main()");

    assert.deepEqual(scenario.commentsFor("aid-rollout"), []);
    assert.deepEqual(scenario.processedIds(), [], "no delivered comment means not processed (DUR-44 contract)");
    assert.match(scenario.readLog(), /aid-rollout \(unsupported kind "rollout"\) — no comment could be delivered/);
  } finally {
    scenario.cleanup();
  }
});

// DUR-3923 follow-up: the processed-set lives on the host and starts empty on a fresh
// box (or after a wipe), so without a decidedAt bound the first poll cycle after this
// runner ships would comment on every deploy_pr/rollout card ever approved across every
// company -- and mirror each onto its linked issues. Cards decided more than 24h ago
// (matching DEPLOY_APPROVAL_FEEDBACK_MAX_AGE_MS) must be left completely alone: no
// comment, no issue mirror, no status-log entry, no processed entry. A real
// kind:"deploy" card of the same age is NOT bounded -- an approved deploy still happens.
test("DUR-3923: an old approved deploy_pr card (decided >24h ago) is left alone -- no comment, not processed", () => {
  const scenario = makeScenario();
  try {
    scenario.writeJson("company_list.json", [{ id: "co-1" }]);
    scenario.writeJson("approval_list.json", [
      {
        id: "aid-old-deploy-pr",
        type: "request_board_approval",
        status: "approved",
        decidedAt: isoAgo(3 * ONE_DAY_MS),
        payload: { kind: "deploy_pr", prNumber: 12, repo: "acme/paperclip" },
      },
      {
        // Missing decidedAt entirely (and no updatedAt/createdAt): treated as old -- stay quiet.
        id: "aid-undated-rollout",
        type: "request_board_approval",
        status: "approved",
        payload: { kind: "rollout" },
      },
      {
        // Recent one in the same list still gets its comment, proving the bound is per card.
        id: "aid-recent-deploy-pr",
        type: "request_board_approval",
        status: "approved",
        decidedAt: isoAgo(ONE_HOUR_MS),
        payload: { kind: "deploy_pr", prNumber: 13, repo: "acme/paperclip" },
      },
      {
        // A real deploy card of the same old age is NOT bounded by this window.
        id: "aid-old-real",
        type: "request_board_approval",
        status: "approved",
        decidedAt: isoAgo(3 * ONE_DAY_MS),
        payload: { kind: "deploy", projectId: "proj-1", workspaceId: "ws-1" },
      },
    ]);
    scenario.writeJson("approval-issues-aid-old-deploy-pr.json", [{ id: "issue-old" }]);
    scenario.writeJson("approval-aid-old-real.json", {
      id: "aid-old-real",
      payload: { kind: "deploy", projectId: "proj-1", workspaceId: "ws-1" },
    });
    scenario.writeJson("project-proj-1.json", DISABLED_POLICY_PROJECT);
    const statusPath = path.join(scenario.dir, "status.jsonl");

    const result = runMain(scenario, { PAPERCLIP_DEPLOY_RUNNER_STATUS_PATH: statusPath });
    assertSuccess(result, "main()");

    assert.deepEqual(scenario.commentsFor("aid-old-deploy-pr"), [], "an old deploy_pr card must not be commented on");
    assert.deepEqual(scenario.issueCommentsFor("issue-old"), [], "nor mirrored onto its linked issue");
    assert.deepEqual(scenario.commentsFor("aid-undated-rollout"), [], "a card with no decision time is treated as old");
    const statusLines = existsSync(statusPath)
      ? readFileSync(statusPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    assert.equal(statusLines.find((e) => e.approvalId === "aid-old-deploy-pr"), undefined, "no status-log entry for the old card");
    assert.equal(statusLines.find((e) => e.approvalId === "aid-undated-rollout"), undefined);

    assert.equal(scenario.commentsFor("aid-recent-deploy-pr").length, 1, "the recent deploy_pr card in the same list is still answered");
    assert.match(scenario.commentsFor("aid-recent-deploy-pr")[0], /Nothing happened/);
    assert.equal(scenario.commentsFor("aid-old-real").length, 1, "a real deploy card is not age-bounded");
    assert.match(scenario.commentsFor("aid-old-real")[0], /Deploy failed/);

    assert.deepEqual(
      scenario.processedIds().sort(),
      ["aid-old-real", "aid-recent-deploy-pr"],
      "old/undated unsupported cards get no processed entry -- they were never acted on",
    );
  } finally {
    scenario.cleanup();
  }
});

test("DUR-3923: the unsupported-kind window is configurable via PAPERCLIP_DEPLOY_RUNNER_UNSUPPORTED_MAX_AGE_SECONDS", () => {
  const scenario = makeScenario();
  try {
    scenario.writeJson("company_list.json", [{ id: "co-1" }]);
    scenario.writeJson("approval_list.json", [
      {
        id: "aid-3d-deploy-pr",
        type: "request_board_approval",
        status: "approved",
        decidedAt: isoAgo(3 * ONE_DAY_MS),
        payload: { kind: "deploy_pr", prNumber: 14, repo: "acme/paperclip" },
      },
    ]);

    // 7-day window: the 3-day-old card is inside it and gets answered.
    const result = runMain(scenario, { PAPERCLIP_DEPLOY_RUNNER_UNSUPPORTED_MAX_AGE_SECONDS: String(7 * 24 * 60 * 60) });
    assertSuccess(result, "main()");
    assert.equal(scenario.commentsFor("aid-3d-deploy-pr").length, 1);
    assert.deepEqual(scenario.processedIds(), ["aid-3d-deploy-pr"]);
  } finally {
    scenario.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DUR-3974: the health check could not see a broken app, and new code could be
// serving before its own migrations had run.
//
// 2026-09-10, approval bbbc40cb (commit 06c32de): the checkout was reset at
// 22:25:16 and the three migrations that commit carried were not applied until
// 22:30:55. That repository's code is bind-mounted, so for five and a half
// minutes production ran new code against the old schema and answered 500 on
// every page that loads companies — while the deploy's health check, pointed
// at a login page that renders without touching the database, kept answering
// 200. The deploy was reported clean.
//
// These tests lock in both halves: a health check that opens the app's real
// pages and compares them against how they answered BEFORE the deploy, and an
// ordering that does not leave new code serving ahead of its migrations.
// ---------------------------------------------------------------------------

// A tiny HTTP server whose answer for each path is read from a file on every
// request, so a test can change what the app "does" mid-deploy (which is
// exactly what deploying broken code looks like from outside). Same
// separate-process reasoning as startPythonHttpServer above: curl blocks this
// process's event loop, so an in-process listener could never answer.
function startStatusHttpServer(dir) {
  return new Promise((resolve, reject) => {
    const script = [
      "import http.server, os, socketserver, sys",
      "root = sys.argv[1]",
      "class H(http.server.BaseHTTPRequestHandler):",
      "    def do_GET(self):",
      "        path = self.path.split('?')[0]",
      "        name = os.path.join(root, 'status' + path.replace('/', '_'))",
      "        try:",
      "            code = int(open(name).read().strip())",
      "        except Exception:",
      "            code = 404",
      "        self.send_response(code)",
      "        self.send_header('Content-Length', '2')",
      "        self.end_headers()",
      "        self.wfile.write(b'ok')",
      "    def log_message(self, *a): pass",
      "socketserver.TCPServer.allow_reuse_address = True",
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
      if (!settled) { settled = true; reject(new Error(`python3 status server exited early (code ${code})`)); }
    });
  });
}

/**
 * A project whose checkout is a real git repo with one commit (so the
 * backward-deploy guard and `maybe_rollback` both have a real commit to work
 * with), pointed at a live status server.
 */
function setUpPageCheckScenario(scenario, { port, appHealthCheckPaths, deployServices } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-page-check-"));
  const targetPath = path.join(dir, "target");
  mkdirSync(targetPath, { recursive: true });
  const git = (...args) => spawnSync("git", args, { cwd: targetPath });
  git("init", "--quiet", "-b", "custom");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  writeFileSync(path.join(targetPath, "README"), "live\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "live");

  scenario.writeJson("project-proj-1.json", {
    id: "proj-1",
    deployPolicy: {
      enabled: true,
      workspaceId: "ws-1",
      deployKind: "compose_recreate",
      deployTargetPath: targetPath,
      healthCheckUrl: `http://127.0.0.1:${port}/health`,
      rollback: "git_previous",
      ...(appHealthCheckPaths ? { appHealthCheckPaths } : {}),
      ...(deployServices ? { deployServices } : {}),
    },
    workspaces: [{ id: "ws-1", repoUrl: "https://example.invalid/repo.git", repoRef: "custom" }],
  });
  scenario.writeJson("approval-aid-1.json", {
    id: "aid-1",
    payload: { projectId: "proj-1", workspaceId: "ws-1", commit: "irrelevant", kind: "deploy" },
  });
  scenario.writeJson("quiet-mode-status.json", { active: false, activeRunCount: 0 });
  return { dir, targetPath };
}

function pageCheckEnv(scenario, webRoot, extra = {}) {
  return {
    ...process.env,
    PATH: `${scenario.binDir}:${process.env.PATH}`,
    SCENARIO_DIR: scenario.dir,
    WEB_ROOT: webRoot,
    PAPERCLIP_DEPLOY_RUNNER_LOG: scenario.log,
    PAPERCLIP_DEPLOY_RUNNER_PROCESSED: scenario.processed,
    PAPERCLIP_DEPLOY_RUNNER_QUIET_MODE_MARKER: path.join(scenario.dir, "quiet-mode-pending"),
    PAPERCLIP_DEPLOY_RUNNER_FAILURE_LOG_DIR: path.join(scenario.dir, "failure-logs"),
    PAPERCLIP_DEPLOY_RUNNER_HEALTH_RETRIES: "3",
    PAPERCLIP_DEPLOY_RUNNER_HEALTH_SLEEP: "0",
    PAPERCLIP_DEPLOY_RUNNER_PORT_WAIT_SECONDS: "5",
    PAPERCLIP_DEPLOY_RUNNER_PAGE_CHECK_RETRIES: "2",
    PAPERCLIP_DEPLOY_RUNNER_PAGE_CHECK_SLEEP: "0",
    PAPERCLIP_DEPLOY_RUNNER_QUIET_MODE_DEACTIVATE_BACKOFF_SECONDS: "0",
    PAPERCLIP_DEPLOY_RUNNER_QUIET_MODE_RECOVERY_HEALTH_SECONDS: "0",
    ...extra,
  };
}

function composeCalls(scenario) {
  const file = path.join(scenario.dir, "docker-compose-calls.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean);
}

// The recipe stub stands in for "the new code goes live". On the first call
// (the deploy) it applies whatever $WEB_ROOT/after_<page> says the new version
// does to each page; on the second call (the rollback re-running the same
// recipe) it puts the pre-deploy answers back, exactly as restoring the old
// code would.
const RECIPE_SWAPS_THE_APP = [
  'run_recipe() {',
  '  echo recipe >> "$SCENARIO_DIR/recipe.log"',
  '  local n; n="$(wc -l < "$SCENARIO_DIR/recipe.log")"',
  '  local f base',
  '  for f in "$WEB_ROOT"/after_*; do',
  '    [ -e "$f" ] || continue',
  '    base="$(basename "$f")"; base="${base#after_}"',
  '    if [ "$n" -eq 1 ]; then cp "$f" "$WEB_ROOT/status_$base"; else cp "$WEB_ROOT/before_$base" "$WEB_ROOT/status_$base"; fi',
  '  done',
  '  return 0',
  '}',
].join("\n");

function writePage(webRoot, page, { before, after }) {
  writeFileSync(path.join(webRoot, `status_${page}`), String(before));
  writeFileSync(path.join(webRoot, `before_${page}`), String(before));
  if (after !== undefined) writeFileSync(path.join(webRoot, `after_${page}`), String(after));
}

test("DUR-3974: a deploy that leaves a working page returning 500 is rolled back, even though the health check address still answers 200", async () => {
  const webRoot = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-web-"));
  // The 2026-09-10 shape exactly: the configured health check is a page that
  // renders without touching the database and keeps answering 200 throughout.
  writePage(webRoot, "health", { before: 200, after: 200 });
  writePage(webRoot, "dashboard_now", { before: 200, after: 500 });
  const { child, port } = await startStatusHttpServer(webRoot);
  const scenario = makeScenario();
  let dir;
  try {
    ({ dir } = setUpPageCheckScenario(scenario, { port, appHealthCheckPaths: ["/dashboard/now"] }));
    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { return 0; }
      ${RECIPE_SWAPS_THE_APP}
      process_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], { env: pageCheckEnv(scenario, webRoot) });
    assertSuccess(result, "process_approval");

    const comments = scenario.commentsFor("aid-1");
    assert.equal(comments.length, 1, `expected one outcome comment, got: ${JSON.stringify(comments)}`);
    assert.match(comments[0], /Deploy failed/, "a deploy that broke a working page is a failed deploy, not a healthy one");
    assert.doesNotMatch(comments[0], /is live and healthy/);
    assert.match(comments[0], /dashboard\/now/, "the comment must name the page that broke");
    assert.match(comments[0], /answered 200 before, 500 now/, "and say what changed, in codes an operator can hand to someone");
    assert.match(comments[0], /put back to the version that was live before/, "and say what was done about it");
    assert.match(
      comments[0],
      /checked again and are working/,
      "the card must not merely hope the rollback worked — the pages are opened again before it says so",
    );

    const recipeRuns = readFileSync(path.join(scenario.dir, "recipe.log"), "utf8").split("\n").filter(Boolean);
    assert.equal(recipeRuns.length, 2, "the rollback must actually re-run the recipe, not just report a rollback");
    assert.equal(readFileSync(path.join(webRoot, "status_dashboard_now"), "utf8").trim(), "200", "the page must be working again afterwards");
  } finally {
    child.kill();
    scenario.cleanup();
    rmSync(webRoot, { recursive: true, force: true });
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("DUR-3974: when the rollback does not fix the broken page either, the card says so instead of claiming the site is back", async () => {
  const webRoot = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-web-"));
  writePage(webRoot, "health", { before: 200, after: 200 });
  writePage(webRoot, "dashboard_now", { before: 200, after: 500 });
  const { child, port } = await startStatusHttpServer(webRoot);
  const scenario = makeScenario();
  let dir;
  try {
    ({ dir } = setUpPageCheckScenario(scenario, { port, appHealthCheckPaths: ["/dashboard/now"] }));
    // A recipe whose rollback run does NOT put the page back — e.g. the
    // migration the bad version applied is still applied.
    const stubbornlyBroken = [
      'run_recipe() {',
      '  echo recipe >> "$SCENARIO_DIR/recipe.log"',
      '  echo 500 > "$WEB_ROOT/status_dashboard_now"',
      '  return 0',
      '}',
    ].join("\n");
    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { return 0; }
      ${stubbornlyBroken}
      process_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], { env: pageCheckEnv(scenario, webRoot) });
    assertSuccess(result, "process_approval");

    const body = scenario.commentsFor("aid-1")[0];
    assert.match(body, /STILL not working/, "a rollback that did not help must not be reported as if it had");
    assert.match(body, /needs a person/);
    assert.doesNotMatch(body, /checked again and are working/);
  } finally {
    child.kill();
    scenario.cleanup();
    rmSync(webRoot, { recursive: true, force: true });
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("DUR-3974: a page that was ALREADY broken before the deploy cannot fail that deploy — the check is a comparison, not a verdict on health", async () => {
  const webRoot = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-web-"));
  writePage(webRoot, "health", { before: 200, after: 200 });
  // Broken before, broken after: this deploy neither caused nor fixed it.
  writePage(webRoot, "dashboard_now", { before: 500, after: 500 });
  const { child, port } = await startStatusHttpServer(webRoot);
  const scenario = makeScenario();
  let dir;
  try {
    ({ dir } = setUpPageCheckScenario(scenario, { port, appHealthCheckPaths: ["/dashboard/now"] }));
    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { return 0; }
      ${RECIPE_SWAPS_THE_APP}
      process_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], { env: pageCheckEnv(scenario, webRoot) });
    assertSuccess(result, "process_approval");

    const comments = scenario.commentsFor("aid-1");
    assert.equal(comments.length, 1);
    assert.match(comments[0], /is live and healthy/, "an already-broken page must never roll back a good deploy");
    const recipeRuns = readFileSync(path.join(scenario.dir, "recipe.log"), "utf8").split("\n").filter(Boolean);
    assert.equal(recipeRuns.length, 1, "no rollback may have run");
    assert.match(scenario.readLog(), /it was already answering 500 before the deploy/);
  } finally {
    child.kill();
    scenario.cleanup();
    rmSync(webRoot, { recursive: true, force: true });
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("DUR-3974: only a server error fails a deploy — a page that starts redirecting, asking for a login or 404ing does not", async () => {
  const webRoot = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-web-"));
  writePage(webRoot, "health", { before: 200, after: 200 });
  writePage(webRoot, "moved", { before: 200, after: 302 });
  writePage(webRoot, "private", { before: 200, after: 401 });
  writePage(webRoot, "gone", { before: 200, after: 404 });
  const { child, port } = await startStatusHttpServer(webRoot);
  const scenario = makeScenario();
  let dir;
  try {
    ({ dir } = setUpPageCheckScenario(scenario, { port, appHealthCheckPaths: ["/moved", "/private", "/gone"] }));
    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { return 0; }
      ${RECIPE_SWAPS_THE_APP}
      process_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], { env: pageCheckEnv(scenario, webRoot) });
    assertSuccess(result, "process_approval");

    assert.match(scenario.commentsFor("aid-1")[0], /is live and healthy/, "a redirect, a login wall and a missing page are not outages");
    const recipeRuns = readFileSync(path.join(scenario.dir, "recipe.log"), "utf8").split("\n").filter(Boolean);
    assert.equal(recipeRuns.length, 1, "no rollback may have run");
  } finally {
    child.kill();
    scenario.cleanup();
    rmSync(webRoot, { recursive: true, force: true });
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("DUR-3974: with no pages listed, the successful deploy comment says so instead of implying the app was checked", async () => {
  const webRoot = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-web-"));
  writePage(webRoot, "health", { before: 200, after: 200 });
  writePage(webRoot, "", { before: 200, after: 200 }); // the front page, "/"
  const { child, port } = await startStatusHttpServer(webRoot);
  const scenario = makeScenario();
  let dir;
  try {
    ({ dir } = setUpPageCheckScenario(scenario, { port }));
    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { return 0; }
      ${RECIPE_SWAPS_THE_APP}
      process_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], { env: pageCheckEnv(scenario, webRoot) });
    assertSuccess(result, "process_approval");

    const body = scenario.commentsFor("aid-1")[0];
    assert.match(body, /is live and healthy/);
    assert.match(body, /Only the health check address and the front page were opened/, "the operator must not be told more was checked than was");
    assert.match(body, /Pages that must still work/, "and must be told where to change that");
    // Everything the note points at has to exist for the operator to use.
    const ui = readFileSync(path.join(repoRoot, "ui", "src", "components", "ProjectProperties.tsx"), "utf8");
    assert.match(ui, /Pages that must still work/, "the deploy settings must actually offer the field the comment names");
  } finally {
    child.kill();
    scenario.cleanup();
    rmSync(webRoot, { recursive: true, force: true });
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("DUR-3974: the front page is checked even when the project lists no pages, so a deploy that 500s everything is still caught", async () => {
  const webRoot = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-web-"));
  writePage(webRoot, "health", { before: 200, after: 200 });
  writePage(webRoot, "", { before: 200, after: 500 });
  const { child, port } = await startStatusHttpServer(webRoot);
  const scenario = makeScenario();
  let dir;
  try {
    ({ dir } = setUpPageCheckScenario(scenario, { port }));
    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { return 0; }
      ${RECIPE_SWAPS_THE_APP}
      process_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], { env: pageCheckEnv(scenario, webRoot) });
    assertSuccess(result, "process_approval");
    assert.match(scenario.commentsFor("aid-1")[0], /Deploy failed/);
    assert.match(scenario.commentsFor("aid-1")[0], /answered 200 before, 500 now/);
  } finally {
    child.kill();
    scenario.cleanup();
    rmSync(webRoot, { recursive: true, force: true });
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("DUR-3974: a page nothing could reach before the deploy is skipped, not treated as a regression", async () => {
  const webRoot = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-web-"));
  writePage(webRoot, "health", { before: 200, after: 200 });
  const { child, port } = await startStatusHttpServer(webRoot);
  const scenario = makeScenario();
  let dir;
  try {
    // A page on a host that does not exist: nothing answers, before or after.
    ({ dir } = setUpPageCheckScenario(scenario, { port, appHealthCheckPaths: ["http://127.0.0.1:1/never"] }));
    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { return 0; }
      ${RECIPE_SWAPS_THE_APP}
      process_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], { env: pageCheckEnv(scenario, webRoot) });
    assertSuccess(result, "process_approval");
    assert.match(scenario.commentsFor("aid-1")[0], /is live and healthy/);
    assert.match(scenario.readLog(), /nothing answered there before the deploy either/);
  } finally {
    child.kill();
    scenario.cleanup();
    rmSync(webRoot, { recursive: true, force: true });
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// --- "nothing answered at all" is the loudest failure there is, not a pass ---

test("DUR-3974: a page that worked before the deploy and answers NOTHING after it is a failure, not a pass", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-down-"));
  try {
    // verify_pages_after_deploy probed directly, the way a reviewer would:
    // one page, a real pre-deploy answer, and nothing listening afterwards.
    // This used to log "still works after the deploy (was 200, now 000)" and
    // return 0, so a deploy that took the whole application down PASSED the
    // check that exists to catch precisely that.
    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      PAGE_CHECK_RETRIES=2
      PAGE_CHECK_SLEEP_SECONDS=0
      echo "--worked-before--"
      if broken="$(verify_pages_after_deploy aid-x "$(printf 'http://127.0.0.1:1/gone\\t200')")"; then
        echo "verdict=pass"
      else
        echo "verdict=fail broken=\${broken}"
      fi
      echo "--never-worked--"
      if verify_pages_after_deploy aid-x "$(printf 'http://127.0.0.1:1/gone\\t000')" >/dev/null; then
        echo "verdict=pass"
      else
        echo "verdict=fail"
      fi
      echo "--already-500--"
      if verify_pages_after_deploy aid-x "$(printf 'http://127.0.0.1:1/gone\\t503')" >/dev/null; then
        echo "verdict=pass"
      else
        echo "verdict=fail"
      fi
    `;
    const result = run("bash", ["-c", script], {
      env: { ...process.env, PAPERCLIP_DEPLOY_RUNNER_LOG: path.join(dir, "runner.log") },
    });
    assertSuccess(result, "verify_pages_after_deploy");
    const [, workedBefore, neverWorked, already500] = result.stdout.split(/--(?:worked-before|never-worked|already-500)--\n/);

    assert.match(
      workedBefore,
      /verdict=fail/,
      "a page that answered 200 before the deploy and answers nothing after it must fail the deploy",
    );
    assert.match(workedBefore, /answered 200 before, nothing at all now/, "and say so in words, not as the code 000");
    // The genuine cases this must NOT start failing — the whole point of the
    // check being a comparison rather than a verdict on health.
    assert.match(neverWorked, /verdict=pass/, "a page nothing could reach before the deploy is not a regression this deploy caused");
    assert.match(already500, /verdict=pass/, "a page that was already server-erroring before the deploy is not a regression either");

    const log = readFileSync(path.join(dir, "runner.log"), "utf8");
    assert.doesNotMatch(log, /still works after the deploy \(was 200, now 000\)/, "and it must never be logged as working");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DUR-3974: a deploy that takes the app off the air entirely is rolled back, and the card says the rollback did not bring it back", async () => {
  // Two servers, because this is the case a single-address health check is
  // blind to: the configured health address keeps answering (a status page,
  // another container, nginx) while the application itself is simply gone.
  const healthRoot = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-web-"));
  const appRoot = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-app-"));
  writeFileSync(path.join(healthRoot, "status_health"), "200");
  writeFileSync(path.join(appRoot, "status_dashboard_now"), "200");
  const health = await startStatusHttpServer(healthRoot);
  const app = await startStatusHttpServer(appRoot);
  const scenario = makeScenario();
  let dir;
  try {
    ({ dir } = setUpPageCheckScenario(scenario, {
      port: health.port,
      appHealthCheckPaths: [`http://127.0.0.1:${app.port}/dashboard/now`],
    }));
    writeFileSync(path.join(scenario.dir, "app.pid"), String(app.child.pid));
    // The deploy kills the application outright; the rollback cannot revive it
    // (a rolled-back checkout does not undo, say, a half-applied migration
    // that stops the server booting at all).
    const recipeKillsTheApp = [
      'run_recipe() {',
      '  echo recipe >> "$SCENARIO_DIR/recipe.log"',
      '  local n; n="$(wc -l < "$SCENARIO_DIR/recipe.log")"',
      '  if [ "$n" -eq 1 ]; then kill "$(cat "$SCENARIO_DIR/app.pid")" 2>/dev/null; sleep 1; fi',
      '  return 0',
      '}',
    ].join("\n");
    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { return 0; }
      ${recipeKillsTheApp}
      process_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], {
      env: pageCheckEnv(scenario, healthRoot, { PAPERCLIP_DEPLOY_RUNNER_ROLLBACK_HEALTH_WAIT_SECONDS: "2" }),
    });
    assertSuccess(result, "process_approval");

    const body = scenario.commentsFor("aid-1")[0];
    assert.match(body, /Deploy failed/, "a deploy that took the app down is the clearest possible failed deploy");
    assert.doesNotMatch(body, /is live and healthy/);
    assert.match(body, /dashboard\/now/, "the card must name the page that stopped answering");
    assert.match(body, /answered 200 before, nothing at all now/);
    assert.match(body, /STILL not working/, "the rollback did not bring it back and the card must not pretend otherwise");
    assert.match(body, /needs a person/);
    assert.doesNotMatch(body, /checked again and are working/);
    assert.match(
      scenario.readLog(),
      /ROLLBACK DID NOT RESTORE THE APP/,
      "the worst case has to be loud in the log too, not just on the card",
    );
  } finally {
    health.child.kill();
    app.child.kill();
    scenario.cleanup();
    rmSync(healthRoot, { recursive: true, force: true });
    rmSync(appRoot, { recursive: true, force: true });
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("DUR-3974: the re-check after a rollback waits for the old version to come back before judging it", async () => {
  const webRoot = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-web-"));
  writePage(webRoot, "health", { before: 200, after: 200 });
  writePage(webRoot, "dashboard_now", { before: 200, after: 500 });
  const { child, port } = await startStatusHttpServer(webRoot);
  const scenario = makeScenario();
  let dir;
  try {
    ({ dir } = setUpPageCheckScenario(scenario, { port, appHealthCheckPaths: ["/dashboard/now"] }));
    // `docker compose up -d --force-recreate` returns when the container has
    // STARTED. This recipe models that honestly: the rollback run returns
    // immediately with the app not yet listening (503), and the old version
    // only finishes booting a couple of seconds later. Judging the rollback at
    // the instant the recipe returns reads a booting app as "the rollback did
    // not help" — the single most alarming thing the runner can say, and here
    // it would be false.
    const rollbackComesBackSlowly = [
      'run_recipe() {',
      '  echo recipe >> "$SCENARIO_DIR/recipe.log"',
      '  local n; n="$(wc -l < "$SCENARIO_DIR/recipe.log")"',
      '  if [ "$n" -eq 1 ]; then',
      '    echo 500 > "$WEB_ROOT/status_dashboard_now"',
      '  else',
      '    echo 503 > "$WEB_ROOT/status_health"',
      '    echo 503 > "$WEB_ROOT/status_dashboard_now"',
      '    ( sleep 3; echo 200 > "$WEB_ROOT/status_health"; echo 200 > "$WEB_ROOT/status_dashboard_now" ) >/dev/null 2>&1 &',
      '  fi',
      '  return 0',
      '}',
    ].join("\n");
    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { return 0; }
      ${rollbackComesBackSlowly}
      process_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], {
      env: pageCheckEnv(scenario, webRoot, {
        // One page attempt, no page-level sleep: the ONLY thing that can give
        // the rolled-back app time here is the health wait under test.
        PAPERCLIP_DEPLOY_RUNNER_PAGE_CHECK_RETRIES: "1",
        PAPERCLIP_DEPLOY_RUNNER_PAGE_CHECK_SLEEP: "0",
        PAPERCLIP_DEPLOY_RUNNER_HEALTH_SLEEP: "1",
        PAPERCLIP_DEPLOY_RUNNER_ROLLBACK_HEALTH_WAIT_SECONDS: "30",
      }),
    });
    assertSuccess(result, "process_approval");

    const body = scenario.commentsFor("aid-1")[0];
    assert.match(body, /Deploy failed/);
    assert.match(
      body,
      /checked again and are working/,
      "the rollback did work — it was just still booting when the recipe returned",
    );
    assert.doesNotMatch(body, /STILL not working/, "a still-booting app must not be reported as a rollback that failed");
    assert.match(
      scenario.readLog(),
      /the rolled-back version is answering at .* re-checking the pages/,
      "the wait has to be visible in the log, so a slow recovery is explainable afterwards",
    );
  } finally {
    child.kill();
    scenario.cleanup();
    rmSync(webRoot, { recursive: true, force: true });
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("DUR-3974: the wait for a rolled-back app to come back is bounded, and ends even when the sleep between probes is zero", () => {
  // wait_for_health spends its budget in HEALTH_SLEEP_SECONDS steps, and that
  // is tunable to 0 — which would advance the clock by nothing and spin here
  // forever on a server that never comes back, hanging the deploy runner on a
  // failure path. Nothing may take longer than the budget it was given.
  const started = Date.now();
  const script = `
    set -uo pipefail
    source "${SCRIPT}"
    HEALTH_SLEEP_SECONDS=0
    HEALTH_CONNECT_TIMEOUT_SECONDS=1
    HEALTH_MAX_TIME_SECONDS=1
    if wait_for_health "http://127.0.0.1:1/health" 3; then echo "verdict=came-back"; else echo "verdict=gave-up"; fi
  `;
  const result = run("bash", ["-c", script], { timeout: 30_000 });
  assertSuccess(result, "wait_for_health");
  assert.match(result.stdout, /verdict=gave-up/);
  assert.ok(Date.now() - started < 30_000, "wait_for_health must return, not spin");
});

test("app_health_check_urls resolves paths against the health check address, keeps full addresses, de-duplicates, and falls back to the front page", () => {
  const script = `
    set -uo pipefail
    source "${SCRIPT}"
    echo "--none--"
    app_health_check_urls "https://app.example.com/accounts/login/" ""
    echo "--some--"
    app_health_check_urls "https://app.example.com/accounts/login/" "/DUR/dashboard/now
reports
https://other.example.com/status
/DUR/dashboard/now"
  `;
  const result = run("bash", ["-c", script]);
  assertSuccess(result, "app_health_check_urls");
  const [, none, some] = result.stdout.split(/--(?:none|some)--\n/);
  assert.deepEqual(none.split("\n").filter(Boolean), ["https://app.example.com/"]);
  assert.deepEqual(some.split("\n").filter(Boolean), [
    "https://app.example.com/DUR/dashboard/now",
    "https://app.example.com/reports",
    "https://other.example.com/status",
  ]);
});

// --- ordering: new code must not be serving while its migrations are unapplied ---

test("DUR-3974: the quiet-mode drain and every refusal guard happen BEFORE the checkout is swapped, not between the swap and the recreate", () => {
  const scenario = makeScenario();
  let dir;
  try {
    ({ dir } = setUpComposeRecreateScenario(scenario));
    scenario.writeJson("quiet-mode-status.json", { active: false, activeRunCount: 0 });

    // One ordered log for both the quiet-mode calls (written by the fake
    // docker) and the moment the checkout is actually reset.
    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() {
        if [ -n "\${6:-}" ]; then echo dry-run-guards >> "$SCENARIO_DIR/quiet-mode-calls.log"; else echo reset-checkout >> "$SCENARIO_DIR/quiet-mode-calls.log"; fi
        return 0
      }
      run_recipe() { echo run-recipe >> "$SCENARIO_DIR/quiet-mode-calls.log"; return 0; }
      health_check() { return 0; }
      verify_pages_after_deploy() { return 0; }
      process_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], { env: quietModeEnv(scenario) });
    assertSuccess(result, "process_approval");

    const calls = quietModeCallsLog(scenario);
    assert.deepEqual(
      calls,
      ["dry-run-guards", "activate", "reset-checkout", "run-recipe", "deactivate"],
      "on 2026-09-10 the drain sat between the reset and the recreate, so the new code served against the old schema for the whole drain — the reset must come after it",
    );
  } finally {
    scenario.cleanup();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("DUR-3974: a compose_recreate project that names its services has them stopped before the files are swapped, and started again by the recipe", () => {
  const scenario = makeScenario();
  let dir;
  try {
    ({ dir } = setUpComposeRecreateScenario(scenario));
    const project = JSON.parse(readFileSync(path.join(scenario.dir, "project-proj-1.json"), "utf8"));
    project.deployPolicy.deployServices = ["web", "worker"];
    scenario.writeJson("project-proj-1.json", project);
    scenario.writeJson("quiet-mode-status.json", { active: false, activeRunCount: 0 });

    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() {
        [ -n "\${6:-}" ] || printf '%s\\n' "reset-checkout" >> "$SCENARIO_DIR/docker-compose-calls.log"
        return 0
      }
      health_check() { return 0; }
      verify_pages_after_deploy() { return 0; }
      process_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], { env: quietModeEnv(scenario) });
    assertSuccess(result, "process_approval");

    const calls = composeCalls(scenario);
    assert.deepEqual(
      calls,
      ["compose stop web worker", "reset-checkout", "compose up -d --force-recreate web worker"],
      "the services that serve the code must be stopped before the files change under them, and the recipe is what starts them again",
    );
    assert.match(scenario.commentsFor("aid-1")[0], /is live and healthy/);
    assert.match(scenario.readLog(), /stopped web worker before swapping the files/);
  } finally {
    scenario.cleanup();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("DUR-3974: a project that names no services is not stopped at all (that would take the database down too) and the log says why", () => {
  const scenario = makeScenario();
  let dir;
  try {
    ({ dir } = setUpComposeRecreateScenario(scenario));
    scenario.writeJson("quiet-mode-status.json", { active: false, activeRunCount: 0 });

    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { return 0; }
      health_check() { return 0; }
      verify_pages_after_deploy() { return 0; }
      process_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], { env: quietModeEnv(scenario) });
    assertSuccess(result, "process_approval");

    assert.deepEqual(
      composeCalls(scenario).filter((line) => line.startsWith("compose stop")),
      [],
      "with no services named, `docker compose stop` would stop everything in the file, database included",
    );
    assert.match(scenario.readLog(), /names no services, so the runner will not stop anything before swapping the files/);
  } finally {
    scenario.cleanup();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("DUR-3974: a git fetch that fails after the services were stopped starts them again — a failed deploy never leaves production stopped", () => {
  const scenario = makeScenario();
  let dir;
  try {
    ({ dir } = setUpComposeRecreateScenario(scenario));
    const project = JSON.parse(readFileSync(path.join(scenario.dir, "project-proj-1.json"), "utf8"));
    project.deployPolicy.deployServices = ["web"];
    scenario.writeJson("project-proj-1.json", project);
    scenario.writeJson("quiet-mode-status.json", { active: false, activeRunCount: 0 });

    // The guards pass on the dry run; the real reset then fails.
    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      git_fetch_reset() { [ -n "\${6:-}" ] && return 0; return 1; }
      run_recipe() { echo run-recipe >> "$SCENARIO_DIR/docker-compose-calls.log"; return 0; }
      health_check() { return 0; }
      process_approval "aid-1" "co-1"
    `;
    const result = run("bash", ["-c", script], { env: quietModeEnv(scenario) });
    assertSuccess(result, "process_approval");

    const calls = composeCalls(scenario);
    assert.equal(calls[0], "compose stop web");
    assert.ok(
      calls.some((line) => line === "compose start web" || line === "compose up -d web"),
      `the stopped service must be started again, got: ${JSON.stringify(calls)}`,
    );
    assert.ok(!calls.includes("run-recipe"), "the recipe never ran, so nothing else would have started it");
    assert.match(scenario.commentsFor("aid-1")[0], /Deploy failed/);
  } finally {
    scenario.cleanup();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("DUR-3974: a deploy that dies between the stop and the recipe still has its services started again by the exit trap", () => {
  const scenario = makeScenario();
  let dir;
  try {
    ({ dir } = setUpComposeRecreateScenario(scenario));
    const project = JSON.parse(readFileSync(path.join(scenario.dir, "project-proj-1.json"), "utf8"));
    project.deployPolicy.deployServices = ["web"];
    scenario.writeJson("project-proj-1.json", project);
    scenario.writeJson("quiet-mode-status.json", { active: false, activeRunCount: 0 });

    const script = `
      set -uo pipefail
      source "${SCRIPT}"
      # An unbound variable under \`set -u\` — i.e. the shape of any future
      # typo in this script — kills the deploy subshell outright, without
      # reaching any of the explicit failure paths.
      git_fetch_reset() { [ -n "\${6:-}" ] && return 0; echo "$A_VARIABLE_NOBODY_SET"; }
      run_recipe() { return 0; }
      health_check() { return 0; }
      run_one_approval "aid-1" "co-1"
    `;
    run("bash", ["-c", script], { env: quietModeEnv(scenario) });

    const calls = composeCalls(scenario);
    assert.ok(
      calls.some((line) => line === "compose start web" || line === "compose up -d web"),
      `a killed deploy must not leave the service stopped, got: ${JSON.stringify(calls)}`,
    );
  } finally {
    scenario.cleanup();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});
