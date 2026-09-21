/**
 * DUR-3994 Stage 1: the server keeps its keys in memory only.
 *
 * Covers: reading and closing the entrypoint's hand-over descriptor, never
 * writing a key into process.env, the single list of names, instance .env
 * files unable to plant a key, and (under a user namespace, where available)
 * the real entrypoint + dash here-document pipe end to end.
 *
 * Every value used here is a random decoy ("canary"); assertions compare
 * booleans / names so a failure never prints a value.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { stripServerSecrets } from "@paperclipai/adapter-utils/server-env-secrets";
import {
  adoptServerSecretsFromEnvFile,
  captureServerSecrets,
  parseServerSecretsHandoff,
  readServerSecret,
  resetServerSecretsForTests,
  serverSecretsHandoffUsed,
} from "../server-secrets.js";
import { buildServerSecretsHandoff, formatServerSecretsHandoff } from "../server-secrets-handoff.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const canary = () => `DUR3994CANARY${randomBytes(12).toString("hex")}`;
const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const TOUCHED = [
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_AGENT_JWT_SECRET",
  "PAPERCLIP_SECRETS_MASTER_KEY",
  "PAPERCLIP_SERVER_ANTHROPIC_API_KEY",
  "DATABASE_URL",
  "DATABASE_BYPASS_URL",
  "DATABASE_MIGRATION_URL",
  "PAPERCLIP_SECRETS_FD",
  "PAPERCLIP_CONFIG",
  "DUR3994_HARMLESS_SETTING",
];
const saved = new Map(TOUCHED.map((k) => [k, process.env[k]]));

beforeEach(() => {
  resetServerSecretsForTests();
});

afterEach(() => {
  resetServerSecretsForTests();
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("hand-over parsing", () => {
  it("accepts only server-key names and base64 values", () => {
    const auth = canary();
    const text = [
      `BETTER_AUTH_SECRET=${b64(auth)}`,
      `PATH=${b64("/evil")}`,
      "DATABASE_URL=%%%not-base64",
      "garbage-without-equals",
      "",
    ].join("\n");
    const { values, problems } = parseServerSecretsHandoff(text);
    expect([...values.keys()]).toEqual(["BETTER_AUTH_SECRET"]);
    expect(values.get("BETTER_AUTH_SECRET") === auth).toBe(true);
    expect(problems.join(" | ")).toContain("PATH");
    expect(problems.join(" | ")).toContain("DATABASE_URL");
    expect(problems.join(" | ").includes(auth)).toBe(false);
  });
});

describe("captureServerSecrets", () => {
  it("reads the descriptor, closes it at once, and never writes a value into the environment", () => {
    const auth = canary();
    const db = `postgres://paperclip:${canary()}@db:5432/paperclip`;
    const dir = tempDir("dur3994-fd-");
    const file = path.join(dir, "handoff");
    fs.writeFileSync(file, `BETTER_AUTH_SECRET=${b64(auth)}\nDATABASE_URL=${b64(db)}\n`);
    const fd = fs.openSync(file, "r");
    const env: NodeJS.ProcessEnv = { PAPERCLIP_SECRETS_FD: String(fd), HOME: "/paperclip" };

    const result = captureServerSecrets(env);

    expect(result.fromDescriptor.sort()).toEqual(["BETTER_AUTH_SECRET", "DATABASE_URL"]);
    expect(result.problems).toEqual([]);
    expect(() => fs.fstatSync(fd)).toThrow(); // closed: nothing can inherit it
    expect(env).toEqual({ HOME: "/paperclip" }); // the descriptor name is gone too
    expect(serverSecretsHandoffUsed()).toBe(true);
    expect(readServerSecret("BETTER_AUTH_SECRET") === auth).toBe(true);
    expect(readServerSecret("DATABASE_URL") === db).toBe(true);
    expect(JSON.stringify(process.env).includes(auth)).toBe(false);
    expect(JSON.stringify(process.env).includes(db)).toBe(false);
  });

  it("moves server keys still in process.env into memory and deletes them there", () => {
    const auth = canary();
    const jwt = canary();
    process.env.BETTER_AUTH_SECRET = auth;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = jwt;
    process.env.PAPERCLIP_SERVER_ANTHROPIC_API_KEY = canary();
    process.env.DUR3994_HARMLESS_SETTING = "kept";

    const result = captureServerSecrets();

    expect(result.fromEnvironment).toEqual(
      expect.arrayContaining(["BETTER_AUTH_SECRET", "PAPERCLIP_AGENT_JWT_SECRET", "PAPERCLIP_SERVER_ANTHROPIC_API_KEY"]),
    );
    expect(process.env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toBeUndefined();
    expect(process.env.PAPERCLIP_SERVER_ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.DUR3994_HARMLESS_SETTING).toBe("kept");
    expect(readServerSecret("BETTER_AUTH_SECRET") === auth).toBe(true);
    expect(readServerSecret("PAPERCLIP_AGENT_JWT_SECRET") === jwt).toBe(true);
  });

  it("a descriptor that cannot be read is reported by name only and does not throw", () => {
    const env: NodeJS.ProcessEnv = { PAPERCLIP_SECRETS_FD: "987" };
    const result = captureServerSecrets(env);
    expect(result.fromDescriptor).toEqual([]);
    expect(result.problems.length).toBe(1);
    expect(env.PAPERCLIP_SECRETS_FD).toBeUndefined();
  });

  it("after capture, the server's own database address is still stripped from agents (equality rule)", async () => {
    const db = `postgres://paperclip:${canary()}@db:5432/paperclip`;
    const dir = tempDir("dur3994-fd-");
    const file = path.join(dir, "handoff");
    fs.writeFileSync(file, `DATABASE_URL=${b64(db)}\n`);
    captureServerSecrets({ PAPERCLIP_SECRETS_FD: String(fs.openSync(file, "r")) });

    // An adapter that forwards the address under its own settings (the
    // hermes case) -- the server's value must still be removed...
    expect(stripServerSecrets({ DATABASE_URL: db }, {})).toEqual({});
    // ...while a different, deliberately configured one still gets through.
    const own = "postgres://scoped:agent@db:5432/paperclip";
    expect(stripServerSecrets({ DATABASE_URL: own }, {})).toEqual({ DATABASE_URL: own });

    const child = await runChildProcess(
      "dur3994-stage1-child",
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(process.env))"],
      { cwd: process.cwd(), env: { DATABASE_URL: db }, timeoutSec: 20, graceSec: 2, onLog: async () => {} },
    );
    expect(child.exitCode).toBe(0);
    expect(child.stdout.includes(db)).toBe(false);
  });
});

describe("instance .env files cannot plant or leak a key", () => {
  it("with the entrypoint hand-over, key names in the file are ignored", () => {
    const dir = tempDir("dur3994-fd-");
    const file = path.join(dir, "handoff");
    fs.writeFileSync(file, `BETTER_AUTH_SECRET=${b64(canary())}\n`);
    captureServerSecrets({ PAPERCLIP_SECRETS_FD: String(fs.openSync(file, "r")) });

    const planted = canary();
    const passThrough = adoptServerSecretsFromEnvFile(
      { PAPERCLIP_AGENT_JWT_SECRET: planted, DUR3994_HARMLESS_SETTING: "x" },
      "test file",
    );
    expect(passThrough).toEqual({ DUR3994_HARMLESS_SETTING: "x" });
    expect(readServerSecret("PAPERCLIP_AGENT_JWT_SECRET")).toBeUndefined();
  });

  it("without the hand-over (local installs), a file key is kept in memory, never in process.env", () => {
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    const fileKey = canary();
    const passThrough = adoptServerSecretsFromEnvFile({ PAPERCLIP_AGENT_JWT_SECRET: fileKey }, "test file");
    expect(passThrough).toEqual({});
    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toBeUndefined();
    expect(readServerSecret("PAPERCLIP_AGENT_JWT_SECRET") === fileKey).toBe(true);
  });

  it("config.ts applies this to the real instance .env file", async () => {
    const dir = tempDir("dur3994-instance-");
    const planted = canary();
    fs.writeFileSync(path.join(dir, "config.json"), "{}\n");
    fs.writeFileSync(
      path.join(dir, ".env"),
      `PAPERCLIP_AGENT_JWT_SECRET=${planted}\nDUR3994_HARMLESS_SETTING=from-file\n`,
    );
    process.env.PAPERCLIP_CONFIG = path.join(dir, "config.json");
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.DUR3994_HARMLESS_SETTING;

    // Fresh module graph: the hand-over was used (as in the Docker image).
    vi.resetModules();
    const secrets = await import("../server-secrets.js");
    const fdFile = path.join(dir, "handoff");
    fs.writeFileSync(fdFile, `BETTER_AUTH_SECRET=${b64(canary())}\n`);
    secrets.captureServerSecrets({ PAPERCLIP_SECRETS_FD: String(fs.openSync(fdFile, "r")) });
    await import("../config.js");

    expect(process.env.DUR3994_HARMLESS_SETTING).toBe("from-file");
    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toBeUndefined();
    expect(secrets.readServerSecret("PAPERCLIP_AGENT_JWT_SECRET")).toBeUndefined();
    vi.resetModules();
  });
});

describe("entrypoint helper", () => {
  it("prefers the secrets file, hands over only non-blank values, and unsets every key name", () => {
    const fromFile = canary();
    const fromEnv = canary();
    const handoff = buildServerSecretsHandoff({
      env: { BETTER_AUTH_SECRET: "", DATABASE_URL: fromEnv, DATABASE_MIGRATION_URL: "  ", HOME: "/paperclip" },
      fileText: `BETTER_AUTH_SECRET=${fromFile}\nNOT_A_KEY=x\n`,
    });
    expect(handoff.unsetNames).toEqual(["BETTER_AUTH_SECRET", "DATABASE_MIGRATION_URL", "DATABASE_URL"]);
    expect(handoff.values.get("BETTER_AUTH_SECRET") === fromFile).toBe(true);
    expect(handoff.values.get("DATABASE_URL") === fromEnv).toBe(true);
    expect(handoff.values.has("DATABASE_MIGRATION_URL")).toBe(false);
    expect(handoff.ignoredFileNames).toEqual(["NOT_A_KEY"]);

    const text = formatServerSecretsHandoff(handoff);
    expect(text.split("\n")[0]).toBe("UNSET BETTER_AUTH_SECRET DATABASE_MIGRATION_URL DATABASE_URL");
    expect(text.includes(fromFile) || text.includes(fromEnv)).toBe(false); // base64 only
    const parsed = parseServerSecretsHandoff(text.split("\n").slice(1).join("\n"));
    expect(parsed.values.get("BETTER_AUTH_SECRET") === fromFile).toBe(true);
  });

  it("prints nothing when there is nothing to hand over", () => {
    expect(formatServerSecretsHandoff(buildServerSecretsHandoff({ env: { HOME: "/x", BETTER_AUTH_SECRET: "" } }))).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The real entrypoint, run as "root" inside a user namespace, with stubs for
// the container-only tools (gosu, id) and the real dash here-document.
// ---------------------------------------------------------------------------
function canUseUserNamespace(): boolean {
  if (process.platform !== "linux") return false;
  const res = spawnSync("unshare", ["-r", "sh", "-c", "test \"$(id -u)\" = 0"], { stdio: "ignore" });
  return res.status === 0;
}

describe.skipIf(!canUseUserNamespace())("docker-entrypoint.sh hand-over (real dash pipe)", () => {
  function setup() {
    const dir = tempDir("dur3994-entrypoint-");
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const realNode = process.execPath;
    const loader = path.join(REPO_ROOT, "server/node_modules/tsx/dist/loader.mjs");
    const helper = path.join(REPO_ROOT, "server/src/server-secrets-handoff.ts");
    // node stub: the entrypoint calls the helper by its /app path; run the
    // repository's source instead (and the test's secrets file path).
    fs.writeFileSync(
      path.join(bin, "node"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--import" ] && [ "$3" = "/app/server/dist/server-secrets-handoff.js" ]; then',
        `  exec '${realNode}' --import '${loader}' '${helper}' "\${TEST_SECRETS_FILE:-$4}"`,
        "fi",
        `exec '${realNode}' "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(bin, "gosu"), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 });
    fs.writeFileSync(
      path.join(bin, "id"),
      '#!/bin/sh\ncase "$*" in "-u node"|"-g node") echo 1000 ;; "-u"|"-g") echo 0 ;; *) exec /usr/bin/id "$@" ;; esac\n',
      { mode: 0o755 },
    );
    // What the server would do at boot, reported as names / booleans only.
    const probe = path.join(dir, "probe.mjs");
    fs.writeFileSync(
      probe,
      `
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const canaries = process.env.TEST_CANARIES_FILE ? JSON.parse(fs.readFileSync(process.env.TEST_CANARIES_FILE, "utf8")) : [];
const environ = fs.readFileSync("/proc/self/environ", "latin1");
const secrets = await import(${JSON.stringify(path.join(REPO_ROOT, "server/src/server-secrets.ts"))});
const fdEnv = process.env.PAPERCLIP_SECRETS_FD ?? null;
const fdTarget = fdEnv ? fs.readlinkSync("/proc/self/fd/" + fdEnv) : null;
const result = secrets.captureServerSecrets();
let fdOpenAfter = true;
try { fs.fstatSync(Number(fdEnv ?? 3)); } catch { fdOpenAfter = false; }
// A child started now must not inherit the hand-over pipe.
const childFd3 = execFileSync("sh", ["-c", "readlink /proc/$$/fd/3 || true"], { encoding: "utf8" }).trim();
process.stdout.write(JSON.stringify({
  fdEnv,
  fdIsPipe: fdTarget ? fdTarget.startsWith("pipe:") : null,
  fdOpenAfter,
  childHasFd3: fdTarget !== null && childFd3 === fdTarget,
  fromDescriptor: result.fromDescriptor.sort(),
  environHasCanary: canaries.some((c) => environ.includes(c)),
  environHasKeyName: /(^|\\0)(BETTER_AUTH_SECRET|DATABASE_URL|PAPERCLIP_AGENT_JWT_SECRET)=/.test(environ),
  valuesMatch: canaries.length > 0 && canaries.every((c) =>
    ["BETTER_AUTH_SECRET", "DATABASE_URL", "PAPERCLIP_AGENT_JWT_SECRET"].some((n) => (secrets.readServerSecret(n) ?? "").includes(c))),
  harmless: process.env.DUR3994_HARMLESS_SETTING ?? null,
  bigLength: secrets.readServerSecret("PAPERCLIP_SERVER_DUR3994_BIG")?.length ?? null,
}));
`,
    );
    return { dir, bin, probe, realNode, loader };
  }

  function runEntrypoint(
    ctx: ReturnType<typeof setup>,
    env: Record<string, string>,
    command: "server" | "other" = "server",
  ) {
    const args =
      command === "server"
        ? [ctx.realNode, "--import", ctx.loader, ctx.probe, "server/dist/index.js"]
        : [ctx.realNode, "--import", ctx.loader, ctx.probe, "some-other-command"];
    if (env.TEST_CANARIES !== undefined) {
      // Handed to the probe through a file, never through the environment
      // under test.
      const canariesFile = path.join(ctx.dir, "canaries.json");
      fs.writeFileSync(canariesFile, env.TEST_CANARIES);
      env = { ...env, TEST_CANARIES_FILE: canariesFile };
      delete env.TEST_CANARIES;
    }
    const res = spawnSync("unshare", ["-r", "sh", path.join(REPO_ROOT, "scripts/docker-entrypoint.sh"), ...args], {
      encoding: "utf8",
      env: {
        PATH: `${ctx.bin}:/usr/bin:/bin`,
        USER_UID: "1000",
        USER_GID: "1000",
        DUR3994_HARMLESS_SETTING: "kept",
        ...env,
      },
      timeout: 60_000,
    });
    expect(res.status, res.stderr).toBe(0);
    return JSON.parse(res.stdout) as Record<string, unknown>;
  }

  it("env mode: keys arrive through a one-shot pipe and are absent from the server's start environment", () => {
    const ctx = setup();
    const auth = canary();
    const db = `postgres://paperclip:${canary()}@db:5432/paperclip`;
    const out = runEntrypoint(ctx, {
      BETTER_AUTH_SECRET: auth,
      DATABASE_URL: db,
      DATABASE_MIGRATION_URL: "",
      TEST_CANARIES: JSON.stringify([auth, db]),
    });
    expect(out).toEqual({
      fdEnv: "3",
      fdIsPipe: true,
      fdOpenAfter: false,
      childHasFd3: false,
      fromDescriptor: ["BETTER_AUTH_SECRET", "DATABASE_URL"],
      environHasCanary: false,
      environHasKeyName: false,
      valuesMatch: true,
      harmless: "kept",
      bigLength: null,
    });
  }, 60_000);

  it("a hand-over bigger than one pipe buffer still arrives whole", () => {
    const ctx = setup();
    const big = canary() + "x".repeat(20_000);
    const out = runEntrypoint(ctx, {
      BETTER_AUTH_SECRET: canary(),
      PAPERCLIP_SERVER_DUR3994_BIG: big,
      TEST_CANARIES: JSON.stringify([big.slice(0, 40)]),
    });
    expect(out.fdIsPipe).toBe(true);
    expect(out.bigLength).toBe(big.length);
    expect(out.environHasCanary).toBe(false);
    expect(out.fdOpenAfter).toBe(false);
  }, 60_000);

  it("file mode: values come from the root-only secrets file; blank environment entries are dropped", () => {
    const ctx = setup();
    const auth = canary();
    const jwt = canary();
    const secretsFile = path.join(ctx.dir, "server.env");
    fs.writeFileSync(secretsFile, `BETTER_AUTH_SECRET=${auth}\nPAPERCLIP_AGENT_JWT_SECRET=${jwt}\n`, { mode: 0o400 });
    const out = runEntrypoint(ctx, {
      BETTER_AUTH_SECRET: "",
      PAPERCLIP_AGENT_JWT_SECRET: "",
      TEST_SECRETS_FILE: secretsFile,
      TEST_CANARIES: JSON.stringify([auth, jwt]),
    });
    expect(out.fdIsPipe).toBe(true);
    expect(out.fromDescriptor).toEqual(["BETTER_AUTH_SECRET", "PAPERCLIP_AGENT_JWT_SECRET"]);
    expect(out.environHasCanary).toBe(false);
    expect(out.environHasKeyName).toBe(false);
    expect(out.valuesMatch).toBe(true);
    expect(out.childHasFd3).toBe(false);
  }, 60_000);

  it("nothing to hand over: the server starts exactly as before (no descriptor, environment untouched)", () => {
    const ctx = setup();
    const out = runEntrypoint(ctx, { BETTER_AUTH_SECRET: "" });
    expect(out.fdEnv).toBeNull();
    expect(out.fromDescriptor).toEqual([]);
    expect(out.harmless).toBe("kept");
  }, 60_000);

  it("a command other than the server keeps its environment", () => {
    const ctx = setup();
    const auth = canary();
    const out = runEntrypoint(ctx, { BETTER_AUTH_SECRET: auth, TEST_CANARIES: JSON.stringify([auth]) }, "other");
    expect(out.fdEnv).toBeNull();
    expect(out.environHasCanary).toBe(true);
  }, 60_000);
});
