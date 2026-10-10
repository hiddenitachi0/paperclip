import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// One-click host actions: scripts/operator-action-runner.py is the security
// boundary. The server's approval is necessary but never sufficient -- these
// tests drive the real script end to end with only the I/O edges faked:
// `docker` (the CLI calls into the server container, the catalogue publish,
// and the compose/restart commands) and `systemctl`, both on PATH, both
// logging exactly the argv they were given.
//
// Run: node --test scripts/operator-action-runner.test.mjs

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SCRIPT = path.join(repoRoot, "scripts", "operator-action-runner.py");

const COMPANY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const SECRET_ID = "22222222-2222-4222-8222-222222222222";

const FAKE_DOCKER = `#!/usr/bin/env python3
import json, os, sys
scenario = os.environ["SCENARIO_DIR"]
argv = sys.argv[1:]
def log(entry):
    with open(os.path.join(scenario, "calls.jsonl"), "a") as fh:
        fh.write(json.dumps(entry) + "\\n")
def fixture(name, default):
    p = os.path.join(scenario, name)
    if os.path.exists(p):
        with open(p) as fh:
            return fh.read()
    return default
if argv and argv[0] == "exec":
    if "cli/src/index.ts" in argv:
        i = argv.index("cli/src/index.ts") + 1
        j = argv.index("--api-base")
        cli = argv[i:j]
        log({"tool": "cli", "args": cli})
        if cli[:2] == ["company", "list"]:
            print(fixture("companies.json", "[]")); sys.exit(0)
        if cli[:2] == ["approval", "list"]:
            print(fixture("approvals-" + cli[3] + ".json", "[]")); sys.exit(0)
        if cli[:2] == ["approval", "comment"]:
            fail = os.path.join(scenario, "comment-fail")
            if os.path.exists(fail):
                sys.exit(1)
            with open(os.path.join(scenario, "comments.jsonl"), "a") as fh:
                fh.write(json.dumps({"approvalId": cli[2], "body": cli[4]}) + "\\n")
            print("{}"); sys.exit(0)
        if cli[:2] == ["approval", "issues"]:
            print(fixture("issues-" + cli[2] + ".json", "[]")); sys.exit(0)
        if cli[:2] == ["issue", "comment"]:
            with open(os.path.join(scenario, "issue-comments.jsonl"), "a") as fh:
                fh.write(json.dumps({"issueId": cli[2], "body": cli[4]}) + "\\n")
            print("{}"); sys.exit(0)
        if cli[:2] == ["approval", "operator-action-secret"]:
            out = fixture("secret-" + cli[2] + ".json", None)
            if out is None:
                sys.exit(1)
            print(out); sys.exit(0)
        sys.exit(2)
    if "sh" in argv and "-i" in argv:
        data = sys.stdin.read()
        with open(os.path.join(scenario, "published-catalog.json"), "w") as fh:
            fh.write(data)
        log({"tool": "publish"})
        sys.exit(0)
    sys.exit(3)
log({"tool": "docker", "argv": argv, "cwd": os.getcwd()})
print("fake docker output line")
sys.exit(int(fixture("docker-exit", "0")))
`;

const FAKE_SYSTEMCTL = `#!/usr/bin/env python3
import json, os, sys
scenario = os.environ["SCENARIO_DIR"]
with open(os.path.join(scenario, "calls.jsonl"), "a") as fh:
    fh.write(json.dumps({"tool": "systemctl", "argv": sys.argv[1:]}) + "\\n")
print("fake systemctl ok")
code_file = os.path.join(scenario, "systemctl-exit")
sys.exit(int(open(code_file).read()) if os.path.exists(code_file) else 0)
`;

let dir;
let scenario;
let composeDir;
let envPath;

function writeJson(name, value) {
  writeFileSync(path.join(scenario, name), JSON.stringify(value));
}

function baseConfig() {
  return {
    version: 1,
    companies: {
      [COMPANY_A]: {
        services: {
          "telegram-bridge": {
            label: "the Telegram bridge",
            systemdUnit: "paperclip-telegram-bridge.service",
            actions: ["restart_service"],
          },
          "dashboard-web": {
            label: "the dashboard website",
            compose: { directory: composeDir, files: ["docker-compose.yml"], envFile: ".env", service: "web" },
            actions: ["restart_service", "recreate_container"],
          },
        },
        envFiles: {
          dashboard: { label: "the dashboard settings file", path: envPath, keys: ["FEATURE_FLAG", "SHOP_MODE"] },
        },
      },
      [COMPANY_B]: { services: {}, envFiles: {} },
    },
  };
}

function writeConfig(config = baseConfig()) {
  writeFileSync(path.join(dir, "operator-actions.json"), JSON.stringify(config));
}

// The plain-language wording the server stamps (server/src/services/operator-actions.ts),
// with the project prefix normalizeRequestBoardApprovalPayload adds.
const LABELS = {
  "telegram-bridge": "the Telegram bridge",
  "dashboard-web": "the dashboard website",
  dashboard: "the dashboard settings file",
};
function wording(payload) {
  const label = LABELS[payload.target] ?? "something";
  const title =
    payload.action === "set_env_var"
      ? `Change the setting ${payload.envKey} in ${label}`
      : `${payload.action === "recreate_container" ? "Recreate" : "Restart"} ${label}`;
  return {
    title: `Paperclip — ${title}`,
    targetLabel: label,
    nextActionOnApproval: `When you approve, the server acts on ${label}.`,
    ...(payload.action === "set_env_var" ? { secretName: "checkout-flag" } : {}),
  };
}

let cardCounter = 0;
function card(payload, overrides = {}) {
  cardCounter += 1;
  return {
    id: `cccccccc-cccc-4ccc-8ccc-${String(cardCounter).padStart(12, "0")}`,
    companyId: COMPANY_A,
    type: "request_board_approval",
    status: "approved",
    decidedByUserId: "user-filip",
    decidedAt: new Date().toISOString(),
    requestedByAgentId: "agent-1",
    payload: { kind: "operator_action", reason: "new code needs a restart", ...wording(payload), ...payload },
    ...overrides,
  };
}

function setCards(companyId, cards) {
  writeJson(`approvals-${companyId}.json`, cards);
}

function runRunner(extraEnv = {}) {
  const result = spawnSync("python3", ["-I", SCRIPT], {
    encoding: "utf8",
    env: {
      PATH: `${path.join(dir, "bin")}:${process.env.PATH}`,
      SCENARIO_DIR: scenario,
      PAPERCLIP_OPERATOR_ACTIONS_CONFIG: path.join(dir, "operator-actions.json"),
      PAPERCLIP_OPERATOR_ACTION_RUNNER_SKIP_OWNER_CHECK: "1",
      PAPERCLIP_OPERATOR_ACTION_RUNNER_PROCESSED: path.join(dir, "processed"),
      PAPERCLIP_OPERATOR_ACTION_RUNNER_UNSENT: path.join(dir, "unsent.jsonl"),
      PAPERCLIP_OPERATOR_ACTION_RUNNER_PUBLISHED: path.join(dir, "published"),
      PAPERCLIP_OPERATOR_ACTION_RUNNER_LOG: path.join(dir, "runner.log"),
      PAPERCLIP_OPERATOR_ACTION_RUNNER_AUDIT_LOG: path.join(dir, "audit.log"),
      PAPERCLIP_OPERATOR_ACTION_RUNNER_LOCK: path.join(dir, "lock"),
      PAPERCLIP_OPERATOR_ACTION_RUNNER_COMMENT_RETRIES: "1",
      PAPERCLIP_OPERATOR_ACTION_RUNNER_COMMENT_RETRY_SLEEP: "0",
      ...extraEnv,
    },
  });
  assert.equal(result.status, 0, `runner failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

function readLines(name) {
  const p = path.join(dir === scenario ? dir : scenario, name);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function hostCalls() {
  return readLines("calls.jsonl").filter((c) => c.tool === "docker" || c.tool === "systemctl");
}

function comments() {
  return readLines("comments.jsonl");
}

function auditLines() {
  const p = path.join(dir, "audit.log");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const BRIDGE_RESTART = "systemctl restart paperclip-telegram-bridge.service";

describe("operator-action-runner.py", () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "op-runner-"));
    scenario = path.join(dir, "scenario");
    composeDir = path.join(dir, "dashboard");
    envPath = path.join(composeDir, ".env");
    mkdirSync(scenario);
    mkdirSync(composeDir);
    mkdirSync(path.join(dir, "bin"));
    writeFileSync(path.join(dir, "bin", "docker"), FAKE_DOCKER);
    writeFileSync(path.join(dir, "bin", "systemctl"), FAKE_SYSTEMCTL);
    chmodSync(path.join(dir, "bin", "docker"), 0o755);
    chmodSync(path.join(dir, "bin", "systemctl"), 0o755);
    writeFileSync(envPath, "# dashboard\nSHOP_MODE=live\nFEATURE_FLAG=old\nOTHER=keep\nFEATURE_FLAG=dupe\n");
    writeJson("companies.json", [{ id: COMPANY_A }, { id: COMPANY_B }]);
    writeConfig();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs an allow-listed restart with the fixed argv, comments, mirrors to the task and audits", () => {
    const c = card({ action: "restart_service", target: "telegram-bridge", willRun: BRIDGE_RESTART });
    setCards(COMPANY_A, [c]);
    writeJson(`issues-${c.id}.json`, [{ id: ISSUE_ID }]);
    runRunner();

    assert.deepEqual(hostCalls(), [{ tool: "systemctl", argv: ["restart", "paperclip-telegram-bridge.service"] }]);
    const [comment] = comments();
    assert.equal(comment.approvalId, c.id);
    assert.match(comment.body, /^Done: restarted the Telegram bridge\./);
    assert.match(comment.body, /fake systemctl ok/);
    assert.equal(readLines("issue-comments.jsonl")[0].issueId, ISSUE_ID);
    const [entry] = auditLines();
    assert.equal(entry.outcome, "succeeded");
    assert.equal(entry.approvalId, c.id);
    assert.equal(entry.decidedByUserId, "user-filip");
  });

  it("never runs the same card twice (processed marker)", () => {
    const c = card({ action: "restart_service", target: "telegram-bridge", willRun: BRIDGE_RESTART });
    setCards(COMPANY_A, [c]);
    runRunner();
    runRunner();
    assert.equal(hostCalls().length, 1);
    assert.equal(comments().length, 1);
    assert.equal(readFileSync(path.join(dir, "processed"), "utf8").trim(), c.id);
  });

  it("marks the card processed before running, so a failed comment never re-runs the action", () => {
    const c = card({ action: "restart_service", target: "telegram-bridge", willRun: BRIDGE_RESTART });
    setCards(COMPANY_A, [c]);
    writeFileSync(path.join(scenario, "comment-fail"), "");
    runRunner();
    assert.equal(hostCalls().length, 1);
    assert.equal(comments().length, 0);
    assert.equal(readLines("../unsent.jsonl").length, 1);

    rmSync(path.join(scenario, "comment-fail"));
    runRunner();
    assert.equal(hostCalls().length, 1, "the action itself is not retried");
    assert.equal(comments().length, 1, "the queued result comment is delivered on the next tick");
    assert.match(comments()[0].body, /^Done: restarted/);
  });

  it("refuses a server-approved card whose target is not on the LOCAL allow-list", () => {
    const c = card({ action: "restart_service", target: "sshd", willRun: "systemctl restart sshd.service" });
    setCards(COMPANY_A, [c]);
    runRunner();
    assert.deepEqual(hostCalls(), []);
    assert.match(comments()[0].body, /^Not run: "sshd" is not a service on this company's host actions list/);
    assert.equal(auditLines()[0].outcome, "refused");
  });

  it("refuses an action the target is not allowed to take", () => {
    const c = card({ action: "recreate_container", target: "telegram-bridge", willRun: BRIDGE_RESTART });
    setCards(COMPANY_A, [c]);
    runRunner();
    assert.deepEqual(hostCalls(), []);
    assert.match(comments()[0].body, /^Not run: the Telegram bridge is not allowed to recreate container/);
  });

  it("is company-scoped: another company cannot reach company A's services", () => {
    const c = card(
      { action: "restart_service", target: "telegram-bridge", willRun: BRIDGE_RESTART },
      { companyId: COMPANY_B },
    );
    setCards(COMPANY_B, [c]);
    runRunner();
    assert.deepEqual(hostCalls(), []);
    assert.match(comments()[0].body, /^Not run: "telegram-bridge" is not a service on this company's host actions list/);
  });

  it("refuses a card listed under one company that claims to belong to another", () => {
    const c = card({ action: "restart_service", target: "telegram-bridge", willRun: BRIDGE_RESTART });
    setCards(COMPANY_B, [c]);
    runRunner();
    assert.deepEqual(hostCalls(), []);
    assert.match(comments()[0].body, /different company/);
  });

  it("refuses a card whose shown command differs from what would really run", () => {
    const c = card({ action: "restart_service", target: "telegram-bridge", willRun: "systemctl restart something-harmless.service" });
    setCards(COMPANY_A, [c]);
    runRunner();
    assert.deepEqual(hostCalls(), []);
    assert.match(comments()[0].body, /command shown on the card is not what this server would run/);
  });

  it("never interpolates card text: shell-looking targets and extra fields are refused or ignored", () => {
    const evil = card({ action: "restart_service", target: "telegram-bridge; rm -rf /", willRun: "x" });
    const extra = card({
      action: "restart_service",
      target: "telegram-bridge",
      willRun: BRIDGE_RESTART,
      command: "rm -rf /",
      unit: "sshd.service",
      reason: "$(touch /tmp/pwned) `id`",
    });
    setCards(COMPANY_A, [evil, extra]);
    runRunner();
    assert.deepEqual(hostCalls(), [{ tool: "systemctl", argv: ["restart", "paperclip-telegram-bridge.service"] }]);
    const bodies = comments().map((x) => x.body);
    assert.match(bodies[0], /^Not run: the card does not name a valid target/);
    assert.match(bodies[1], /^Done:/);
  });

  it("recreates a compose service with the fixed template, in the configured folder", () => {
    const willRun = `cd ${composeDir} && docker compose --env-file .env -f docker-compose.yml up -d --no-deps --no-build --force-recreate web`;
    const c = card({ action: "recreate_container", target: "dashboard-web", willRun });
    setCards(COMPANY_A, [c]);
    runRunner();
    assert.deepEqual(hostCalls(), [
      {
        tool: "docker",
        argv: ["compose", "--env-file", ".env", "-f", "docker-compose.yml", "up", "-d", "--no-deps", "--no-build", "--force-recreate", "web"],
        cwd: composeDir,
      },
    ]);
    assert.match(comments()[0].body, /^Done: recreated the dashboard website\./);
  });

  it("reports a failing command with its exit code and output tail", () => {
    writeFileSync(path.join(scenario, "systemctl-exit"), "3");
    const c = card({ action: "restart_service", target: "telegram-bridge", willRun: BRIDGE_RESTART });
    setCards(COMPANY_A, [c]);
    runRunner();
    assert.match(comments()[0].body, /^Failed: could not restart the Telegram bridge\./);
    assert.match(comments()[0].body, /exit code 3/);
    assert.match(comments()[0].body, /fake systemctl ok/);
    assert.equal(auditLines()[0].outcome, "failed");
  });

  it("sets an allow-listed env key from the secret, never showing the value", () => {
    const willRun = `write FEATURE_FLAG=<secret value> into ${envPath}`;
    const c = card({ action: "set_env_var", target: "dashboard", envKey: "FEATURE_FLAG", secretId: SECRET_ID, willRun });
    setCards(COMPANY_A, [c]);
    writeJson(`secret-${c.id}.json`, { value: "s3cr3t value $HOME", name: "checkout-flag" });
    runRunner();
    assert.equal(
      readFileSync(envPath, "utf8"),
      "# dashboard\nSHOP_MODE=live\nFEATURE_FLAG='s3cr3t value $HOME'\nOTHER=keep\n",
    );
    assert.deepEqual(hostCalls(), []);
    const body = comments()[0].body;
    assert.match(body, /^Done: FEATURE_FLAG in the dashboard settings file now has the value from the secret/);
    assert.doesNotMatch(body, /s3cr3t/);
    assert.doesNotMatch(readFileSync(path.join(dir, "audit.log"), "utf8"), /s3cr3t/);
  });

  it("refuses an env key that is not allow-listed, and secret values with line breaks", () => {
    const notAllowed = card({
      action: "set_env_var",
      target: "dashboard",
      envKey: "DATABASE_URL",
      secretId: SECRET_ID,
      willRun: `write DATABASE_URL=<secret value> into ${envPath}`,
    });
    const multiline = card({
      action: "set_env_var",
      target: "dashboard",
      envKey: "SHOP_MODE",
      secretId: SECRET_ID,
      willRun: `write SHOP_MODE=<secret value> into ${envPath}`,
    });
    setCards(COMPANY_A, [notAllowed, multiline]);
    writeJson(`secret-${multiline.id}.json`, { value: "live\nDATABASE_URL=evil", name: "checkout-flag" });
    const before = readFileSync(envPath, "utf8");
    runRunner();
    assert.equal(readFileSync(envPath, "utf8"), before);
    const bodies = comments().map((x) => x.body);
    assert.match(bodies[0], /^Not run: that setting may not be changed/);
    assert.match(bodies[1], /^Not run: the secret's value has a line break/);
  });

  it("does not act on a card approved too long ago", () => {
    const c = card(
      { action: "restart_service", target: "telegram-bridge", willRun: BRIDGE_RESTART },
      { decidedAt: new Date(Date.now() - 2 * 86400 * 1000).toISOString() },
    );
    setCards(COMPANY_A, [c]);
    runRunner();
    assert.deepEqual(hostCalls(), []);
    assert.match(comments()[0].body, /approved more than 24 hours ago/);
  });

  it("does nothing but say so when the allow-list is missing or invalid", () => {
    const bad = baseConfig();
    bad.companies[COMPANY_A].services["telegram-bridge"].systemdUnit = "x.service; reboot";
    writeConfig(bad);
    const c = card({ action: "restart_service", target: "telegram-bridge", willRun: BRIDGE_RESTART });
    setCards(COMPANY_A, [c]);
    runRunner();
    assert.deepEqual(hostCalls(), []);
    assert.match(comments()[0].body, /^Not run: host actions are not set up on this server/);
    assert.equal(existsSync(path.join(scenario, "published-catalog.json")), false);
    assert.match(readFileSync(path.join(dir, "runner.log"), "utf8"), /systemdUnit must be a unit name/);
  });

  it("rejects a recreate allowance on a non-compose service at config load", () => {
    const bad = baseConfig();
    bad.companies[COMPANY_A].services["telegram-bridge"].actions = ["restart_service", "recreate_container"];
    writeConfig(bad);
    runRunner();
    assert.match(readFileSync(path.join(dir, "runner.log"), "utf8"), /recreate_container is only possible for a compose service/);
  });

  it("publishes the catalogue the server reads: commands and keys, never secrets", () => {
    runRunner();
    const catalog = JSON.parse(readFileSync(path.join(scenario, "published-catalog.json"), "utf8"));
    assert.equal(catalog.version, 1);
    assert.equal(
      catalog.companies[COMPANY_A].services["telegram-bridge"].actions.restart_service,
      BRIDGE_RESTART,
    );
    assert.deepEqual(catalog.companies[COMPANY_A].envFiles.dashboard.keys, ["FEATURE_FLAG", "SHOP_MODE"]);
    assert.deepEqual(catalog.companies[COMPANY_B], { services: {}, envFiles: {} });
  });

  it("refuses a card whose label was changed (edited catalogue) even though the command matches", () => {
    const c = card({
      action: "restart_service",
      target: "telegram-bridge",
      willRun: BRIDGE_RESTART,
      title: "Paperclip — Restart the harmless test service",
      targetLabel: "the harmless test service",
      nextActionOnApproval: "When you approve, the server restarts the harmless test service.",
    });
    setCards(COMPANY_A, [c]);
    runRunner();
    assert.deepEqual(hostCalls(), []);
    assert.match(comments()[0].body, /wording on the card does not match/);
  });

  it("only writes secrets allow-listed for that key when the env file has a secrets list", () => {
    const config = baseConfig();
    config.companies[COMPANY_A].envFiles.dashboard.secrets = { FEATURE_FLAG: ["checkout-flag"] };
    writeConfig(config);
    const willRunFlag = `write FEATURE_FLAG=<secret value> into ${envPath}`;
    const willRunMode = `write SHOP_MODE=<secret value> into ${envPath}`;
    const wrongSecret = card({ action: "set_env_var", target: "dashboard", envKey: "FEATURE_FLAG", secretId: SECRET_ID, willRun: willRunFlag, secretName: "db-password" });
    const unlistedKey = card({ action: "set_env_var", target: "dashboard", envKey: "SHOP_MODE", secretId: SECRET_ID, willRun: willRunMode });
    const ok = card({ action: "set_env_var", target: "dashboard", envKey: "FEATURE_FLAG", secretId: SECRET_ID, willRun: willRunFlag });
    setCards(COMPANY_A, [wrongSecret, unlistedKey, ok]);
    writeJson(`secret-${wrongSecret.id}.json`, { value: "hunter2", name: "db-password" });
    writeJson(`secret-${unlistedKey.id}.json`, { value: "test", name: "checkout-flag" });
    writeJson(`secret-${ok.id}.json`, { value: "on", name: "checkout-flag" });
    runRunner();
    const bodies = comments().map((x) => x.body);
    assert.match(bodies[0], /^Not run: the secret "db-password" may not be written into FEATURE_FLAG/);
    assert.match(bodies[1], /^Not run: no secret may be written into SHOP_MODE/);
    assert.match(bodies[2], /^Done:/);
    assert.match(readFileSync(envPath, "utf8"), /^FEATURE_FLAG=on$/m);
    assert.doesNotMatch(readFileSync(envPath, "utf8"), /hunter2/);
  });

  it("refuses when the server hands over a different secret than the card names", () => {
    const c = card({ action: "set_env_var", target: "dashboard", envKey: "FEATURE_FLAG", secretId: SECRET_ID, willRun: `write FEATURE_FLAG=<secret value> into ${envPath}` });
    setCards(COMPANY_A, [c]);
    writeJson(`secret-${c.id}.json`, { value: "x", name: "something-else" });
    const before = readFileSync(envPath, "utf8");
    runRunner();
    assert.equal(readFileSync(envPath, "utf8"), before);
    assert.match(comments()[0].body, /not the secret the server would hand over/);
  });

  it("never touches lines inside a multi-line quoted value", () => {
    writeFileSync(
      envPath,
      'A=1\nPRIVATE_KEY="-----BEGIN KEY-----\nFEATURE_FLAG=inside-the-key\n-----END KEY-----"\nFEATURE_FLAG=old\nB=\'x\'\n',
    );
    const c = card({ action: "set_env_var", target: "dashboard", envKey: "FEATURE_FLAG", secretId: SECRET_ID, willRun: `write FEATURE_FLAG=<secret value> into ${envPath}` });
    setCards(COMPANY_A, [c]);
    writeJson(`secret-${c.id}.json`, { value: "new", name: "checkout-flag" });
    runRunner();
    assert.equal(
      readFileSync(envPath, "utf8"),
      'A=1\nPRIVATE_KEY="-----BEGIN KEY-----\nFEATURE_FLAG=inside-the-key\n-----END KEY-----"\nFEATURE_FLAG=new\nB=\'x\'\n',
    );
  });

  it("refuses to edit a settings file with a quoted value that never closes", () => {
    writeFileSync(envPath, 'A="never closed\nFEATURE_FLAG=old\n');
    const c = card({ action: "set_env_var", target: "dashboard", envKey: "FEATURE_FLAG", secretId: SECRET_ID, willRun: `write FEATURE_FLAG=<secret value> into ${envPath}` });
    setCards(COMPANY_A, [c]);
    writeJson(`secret-${c.id}.json`, { value: "new", name: "checkout-flag" });
    runRunner();
    assert.equal(readFileSync(envPath, "utf8"), 'A="never closed\nFEATURE_FLAG=old\n');
    assert.match(comments()[0].body, /quoted value that is never closed/);
  });

  it("can publish the catalogue to a host folder (mounted read-only into the container)", () => {
    const hostDir = path.join(dir, "published-ro");
    runRunner({ PAPERCLIP_OPERATOR_ACTION_RUNNER_PUBLISH_HOST_DIR: hostDir });
    const catalog = JSON.parse(readFileSync(path.join(hostDir, "catalog.json"), "utf8"));
    assert.equal(catalog.companies[COMPANY_A].services["telegram-bridge"].label, "the Telegram bridge");
    assert.equal(existsSync(path.join(scenario, "published-catalog.json")), false, "no docker exec publish");
  });

  it("ignores cards that are not operator actions", () => {
    setCards(COMPANY_A, [{ ...card({}), payload: { kind: "deploy" } }]);
    runRunner();
    assert.deepEqual(hostCalls(), []);
    assert.deepEqual(comments(), []);
  });
});
