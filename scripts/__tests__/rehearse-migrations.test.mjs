import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// scripts/rehearse-migrations.sh is the step that should have caught the
// migration that crash-looped production on 2026-09-09: it restores a dump of
// a real database into a scratch database and runs the pending migrations
// there first.
//
// These tests never touch a real Postgres. The script is sourceable (guarded
// by a BASH_SOURCE check at the bottom) so its real functions run here, and
// `psql`, `pg_restore` and `pnpm` are faked on PATH -- the true I/O boundary --
// so the failure path can be driven deliberately and the operator-facing
// report asserted verbatim.

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const SCRIPT = path.join(repoRoot, "scripts", "rehearse-migrations.sh");

function makeBin(dir, name, body) {
  const file = path.join(dir, name);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

/** A scenario directory with fake psql/pg_restore/pnpm on PATH. */
function scenario({ migrateExitCode = 0, migrateOutput = "", appliedHashes = "" } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rehearse-migrations-test-"));

  makeBin(
    dir,
    "psql",
    [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "psql $*" >> "$SCENARIO_DIR/psql.log"',
      // The hash query is the only psql call whose output the script reads.
      'for arg in "$@"; do',
      '  case "$arg" in',
      '    *__drizzle_migrations*) cat "$SCENARIO_DIR/applied-hashes.txt"; exit 0 ;;',
      "  esac",
      "done",
      "exit 0",
    ].join("\n"),
  );

  makeBin(
    dir,
    "pg_restore",
    ["#!/usr/bin/env bash", 'printf "%s\\n" "pg_restore $*" >> "$SCENARIO_DIR/pg_restore.log"', "exit 0"].join("\n"),
  );

  makeBin(
    dir,
    "pnpm",
    [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "pnpm $* DATABASE_URL=${DATABASE_URL:-}" >> "$SCENARIO_DIR/pnpm.log"',
      `cat <<'MIGRATE_OUTPUT'`,
      migrateOutput,
      "MIGRATE_OUTPUT",
      `exit ${migrateExitCode}`,
    ].join("\n"),
  );

  writeFileSync(path.join(dir, "applied-hashes.txt"), appliedHashes);
  writeFileSync(path.join(dir, "backup.dump"), "not a real dump");

  return dir;
}

function runScript(dir, args, extraEnv = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      SCENARIO_DIR: dir,
      TMPDIR: dir,
      DATABASE_URL: "",
      ...extraEnv,
    },
  });
}

/** Calls one function of the script directly, after sourcing it. */
function callFunction(dir, snippet, extraEnv = {}) {
  return spawnSync("bash", ["-c", `source "${SCRIPT}"\n${snippet}`], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      SCENARIO_DIR: dir,
      TMPDIR: dir,
      DATABASE_URL: "",
      ...extraEnv,
    },
  });
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test("sourcing the script runs nothing", () => {
  const dir = scenario();
  try {
    const result = callFunction(dir, 'echo "sourced ok"');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /sourced ok/);
    assert.equal(existsSync(path.join(dir, "psql.log")), false);
  } finally {
    cleanup(dir);
  }
});

test("refuses a scratch database name that is not obviously a scratch one", () => {
  const dir = scenario();
  try {
    const result = callFunction(dir, 'assert_safe_target "postgres://127.0.0.1:5432/postgres" "paperclip"');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must start with "rehearsal_"/);
  } finally {
    cleanup(dir);
  }
});

test("refuses when the scratch database is the live DATABASE_URL", () => {
  const dir = scenario();
  try {
    const result = callFunction(
      dir,
      'assert_safe_target "postgres://user@db.internal:5432/postgres" "rehearsal_x"',
      {
        DATABASE_URL: "postgres://user@db.internal:5432/rehearsal_x",
        PAPERCLIP_REHEARSAL_ALLOW_REMOTE: "1",
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /same as DATABASE_URL/);
  } finally {
    cleanup(dir);
  }
});

test("refuses a remote host unless the operator opts in", () => {
  const dir = scenario();
  try {
    const blocked = callFunction(dir, 'assert_safe_target "postgres://user@db.internal:5432/postgres" "rehearsal_x"');
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /db\.internal/);

    const allowed = callFunction(dir, 'assert_safe_target "postgres://user@db.internal:5432/postgres" "rehearsal_x"', {
      PAPERCLIP_REHEARSAL_ALLOW_REMOTE: "1",
    });
    assert.equal(allowed.status, 0, allowed.stderr);
  } finally {
    cleanup(dir);
  }
});

test("keeps query parameters when it swaps the database name", () => {
  const dir = scenario();
  try {
    const result = callFunction(
      dir,
      'url_with_database "postgres://u:p@127.0.0.1:5432/paperclip?sslmode=require" "rehearsal_1"',
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "postgres://u:p@127.0.0.1:5432/rehearsal_1?sslmode=require");
  } finally {
    cleanup(dir);
  }
});

test("treats every migration whose hash is not recorded as pending, in journal order", () => {
  const dir = scenario();
  try {
    const result = callFunction(dir, 'pending_migrations "postgres://127.0.0.1:5432/rehearsal_x"');
    assert.equal(result.status, 0, result.stderr);
    const pending = result.stdout.trim().split("\n").filter(Boolean);
    // No hashes recorded, so every migration in the journal is pending and the
    // list is ordered the way the journal applies them.
    assert.ok(pending.length > 100, `expected the whole journal, got ${pending.length}`);
    assert.match(pending[0], /^0000_/);
    assert.deepEqual([...pending].sort(), pending, "pending migrations are not in file order");
    assert.ok(pending.includes("0164_rls_login_roles.sql"));
  } finally {
    cleanup(dir);
  }
});

test("reports a clean rehearsal in plain language", () => {
  const dir = scenario({ migrateExitCode: 0, migrateOutput: "Migrations complete" });
  try {
    const result = runScript(dir, ["--dump", path.join(dir, "backup.dump"), "--scratch-db", "rehearsal_ok"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /PASSED\./);
    assert.match(result.stdout, /safe to deploy/);

    // It created and dropped a database named rehearsal_ok, restored the dump,
    // and ran the migration command against the scratch URL -- never the live one.
    const psqlLog = readFileSync(path.join(dir, "psql.log"), "utf8");
    assert.match(psqlLog, /CREATE DATABASE "rehearsal_ok"/);
    assert.match(psqlLog, /DROP DATABASE IF EXISTS "rehearsal_ok"/);
    const pnpmLog = readFileSync(path.join(dir, "pnpm.log"), "utf8");
    assert.match(pnpmLog, /--filter @paperclipai\/db migrate/);
    assert.match(pnpmLog, /DATABASE_URL=postgres:\/\/postgres@127\.0\.0\.1:5432\/rehearsal_ok/);
  } finally {
    cleanup(dir);
  }
});

test("names the failing migration and quotes the Postgres error", () => {
  // Exactly the shape of the 2026-09-09 outage: the migration blows up on a
  // table this repo does not define.
  const dir = scenario({
    migrateExitCode: 1,
    migrateOutput: [
      "Applying 1 pending migration(s)...",
      "PostgresError: operator does not exist: bigint = uuid",
    ].join("\n"),
  });
  try {
    const result = runScript(dir, ["--dump", path.join(dir, "backup.dump"), "--scratch-db", "rehearsal_bad"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAILED\. Do not deploy this\./);
    assert.match(result.stdout, /The migration that failed: 0/);
    assert.match(result.stdout, /operator does not exist: bigint = uuid/);
    assert.match(result.stdout, /Full log:/);
  } finally {
    cleanup(dir);
  }
});

test("keeps the scratch database when asked", () => {
  const dir = scenario({ migrateExitCode: 1, migrateOutput: "PostgresError: boom" });
  try {
    const result = runScript(dir, [
      "--dump",
      path.join(dir, "backup.dump"),
      "--scratch-db",
      "rehearsal_keep",
      "--keep",
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /left in place/);
    const psqlLog = readFileSync(path.join(dir, "psql.log"), "utf8");
    // One DROP only: the pre-create cleanup. No teardown drop.
    const drops = psqlLog.split("\n").filter((line) => line.includes("DROP DATABASE"));
    assert.equal(drops.length, 1, psqlLog);
  } finally {
    cleanup(dir);
  }
});

test("requires a dump", () => {
  const dir = scenario();
  try {
    const result = runScript(dir, []);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing --dump/);
  } finally {
    cleanup(dir);
  }
});
