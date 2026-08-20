import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SCRIPT = path.join(import.meta.dirname, "deploy-runner.sh");

// Sources deploy-runner.sh (without running main, thanks to its BASH_SOURCE
// guard) and calls `process_one "$@"` with test doubles for the functions
// process_one delegates to (process_approval, already_processed,
// mark_processed) plus a real comment()/log() pointed at temp files, so we
// can observe exactly what gets marked processed and what gets commented.
function runProcessOne({ processApprovalBody, aid = "aid-1", companyId = "company-1" }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-test-"));
  const processed = path.join(dir, "processed");
  const log = path.join(dir, "runner.log");
  const commentsFile = path.join(dir, "comments.jsonl");
  const markerDir = path.join(dir, "markers");
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(processed, "");
  writeFileSync(log, "");
  writeFileSync(commentsFile, "");

  const script = `
    set -uo pipefail
    source "${SCRIPT}"

    # Test double: record every comment() call instead of shelling out to docker.
    comment() {
      : > "$COMMENT_MARKER_DIR/$1" 2>/dev/null || true
      printf '%s\\t%s\\n' "$1" "$2" >> "${commentsFile}"
    }

    process_approval() {
      ${processApprovalBody}
    }

    process_one "${aid}" "${companyId}"
  `;

  const result = spawnSync("bash", ["-c", script], {
    env: {
      ...process.env,
      PAPERCLIP_DEPLOY_RUNNER_PROCESSED: processed,
      PAPERCLIP_DEPLOY_RUNNER_LOG: log,
      PAPERCLIP_DEPLOY_RUNNER_COMMENT_MARKER_DIR: markerDir,
    },
    encoding: "utf8",
  });

  const comments = readFileSync(commentsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, ...rest] = line.split("\t");
      return { id, body: rest.join("\t") };
    });
  const processedIds = readFileSync(processed, "utf8").split("\n").filter(Boolean);

  rmSync(dir, { recursive: true, force: true });

  return { result, comments, processedIds };
}

test("process_one posts a fallback comment when process_approval crashes without commenting", () => {
  // Simulates the DUR-44 incident: process_approval hits an unexpected
  // internal error (here: an unbound variable under `set -u`, which kills
  // only the subshell process_one wraps it in) and returns without ever
  // calling comment().
  const { result, comments, processedIds } = runProcessOne({
    processApprovalBody: `
      local _oops
      set -u
      echo "$UNSET_VARIABLE_THAT_TRIGGERS_A_CRASH"
    `,
  });

  assert.equal(result.status, 0, `process_one itself must not crash the runner: ${result.stderr}`);
  assert.deepEqual(processedIds, ["aid-1"], "the approval must still be marked processed exactly once");
  assert.equal(comments.length, 1, "exactly one comment must have been posted");
  assert.equal(comments[0].id, "aid-1");
  assert.match(comments[0].body, /unexpected internal error/);
});

test("process_one does not double-comment when process_approval already reported a result", () => {
  const { comments, processedIds } = runProcessOne({
    processApprovalBody: `comment "aid-1" "Deployed OK"`,
  });

  assert.deepEqual(processedIds, ["aid-1"]);
  assert.equal(comments.length, 1, "the fallback must not fire when process_approval already commented");
  assert.equal(comments[0].body, "Deployed OK");
});

test("process_one skips an already-processed approval without re-commenting", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-test-"));
  const processed = path.join(dir, "processed");
  const log = path.join(dir, "runner.log");
  const commentsFile = path.join(dir, "comments.jsonl");
  const markerDir = path.join(dir, "markers");
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(processed, "aid-1\n");
  writeFileSync(log, "");
  writeFileSync(commentsFile, "");

  const script = `
    set -uo pipefail
    source "${SCRIPT}"
    comment() { printf '%s\\t%s\\n' "$1" "$2" >> "${commentsFile}"; }
    process_approval() { comment "$1" "should never run"; }
    process_one "aid-1" "company-1"
  `;

  spawnSync("bash", ["-c", script], {
    env: {
      ...process.env,
      PAPERCLIP_DEPLOY_RUNNER_PROCESSED: processed,
      PAPERCLIP_DEPLOY_RUNNER_LOG: log,
      PAPERCLIP_DEPLOY_RUNNER_COMMENT_MARKER_DIR: markerDir,
    },
    encoding: "utf8",
  });

  const comments = readFileSync(commentsFile, "utf8").split("\n").filter(Boolean);
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(comments, [], "an already-processed approval must not be touched again");
});

test("two approvals in the same poll cycle both end up with exactly one comment, even when the first silently crashes", () => {
  // This is the exact DUR-44 acceptance scenario: two approved deploy
  // approvals land in one poll cycle; one of them hits an unexpected
  // internal error partway through. Neither may end up with zero comments.
  const dir = mkdtempSync(path.join(os.tmpdir(), "deploy-runner-test-"));
  const processed = path.join(dir, "processed");
  const log = path.join(dir, "runner.log");
  const commentsFile = path.join(dir, "comments.jsonl");
  const markerDir = path.join(dir, "markers");
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(processed, "");
  writeFileSync(log, "");
  writeFileSync(commentsFile, "");

  const script = `
    set -uo pipefail
    source "${SCRIPT}"
    comment() {
      : > "$COMMENT_MARKER_DIR/$1" 2>/dev/null || true
      printf '%s\\t%s\\n' "$1" "$2" >> "${commentsFile}"
    }
    process_approval() {
      local aid="$1"
      if [ "$aid" = "approval-a" ]; then
        set -u
        echo "$UNSET_VARIABLE_THAT_TRIGGERS_A_CRASH"
      else
        comment "$aid" "Deployed OK"
      fi
    }
    for aid in approval-a approval-b; do
      process_one "$aid" "company-1"
    done
  `;

  const result = spawnSync("bash", ["-c", script], {
    env: {
      ...process.env,
      PAPERCLIP_DEPLOY_RUNNER_PROCESSED: processed,
      PAPERCLIP_DEPLOY_RUNNER_LOG: log,
      PAPERCLIP_DEPLOY_RUNNER_COMMENT_MARKER_DIR: markerDir,
    },
    encoding: "utf8",
  });

  const comments = readFileSync(commentsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, ...rest] = line.split("\t");
      return { id, body: rest.join("\t") };
    });
  const processedIds = readFileSync(processed, "utf8").split("\n").filter(Boolean);

  rmSync(dir, { recursive: true, force: true });

  assert.equal(result.status, 0);
  assert.deepEqual(processedIds.sort(), ["approval-a", "approval-b"]);
  assert.equal(comments.length, 2, "both approvals must end up with exactly one comment each");
  const byId = Object.fromEntries(comments.map((c) => [c.id, c.body]));
  assert.match(byId["approval-a"], /unexpected internal error/);
  assert.equal(byId["approval-b"], "Deployed OK");
});
