import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, plugins, trustedCodeFingerprints } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  configureTrustedCode,
  moduleGuardForWorker,
  resetConfiguredTrustedCodeForTests,
  trustedCodeService,
} from "../services/trusted-code.js";
import { pluginLoader } from "../services/plugin-loader.js";
import {
  DEFAULT_NPM_REGISTRY,
  buildIsolatedNpmInvocation,
  npmSafeEnv,
} from "../services/trusted-npm.js";

// DUR-3994 Stage 2, review fixes: the ways an agent could still get its code
// run by the server after the program folder became root-owned and add-ons
// were fingerprinted.

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const GUARD = path.join(REPO_ROOT, "scripts", "node-module-guard.cjs");
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
const MODULE_GUARD_KEY = Symbol.for("paperclip.moduleGuard");

const tempDirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), content, "utf8");
  }
}

function runNode(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  return spawnSync(process.execPath, args, { cwd: options.cwd, env: options.env, encoding: "utf8" });
}

describe("DUR-3994 Stage 2: the module guard (scripts/node-module-guard.cjs)", () => {
  it("stops require() from finding modules in HOME's global folders (a planted ~/.node_modules/bufferutil)", async () => {
    const home = await tempDir("dur3994-guard-home-");
    const cwd = await tempDir("dur3994-guard-cwd-");
    await writeTree(home, {
      ".node_modules/bufferutil/index.js": "console.log('PLANTED'); module.exports = {};\n",
      ".node_libraries/utf-8-validate.js": "console.log('PLANTED2'); module.exports = {};\n",
    });
    const script = [
      "for (const name of ['bufferutil', 'utf-8-validate']) {",
      "  try { require(name); console.log('LOADED ' + name); } catch (e) { console.log('MISSING ' + name); }",
      "}",
      "console.log('HOME=' + process.env.HOME);",
    ].join("\n");
    const env = { PATH: process.env.PATH ?? "", HOME: home };

    // Negative control: without the guard, Node does load the planted files.
    const unguarded = runNode(["-e", script], { cwd, env });
    expect(unguarded.stdout).toContain("PLANTED");
    expect(unguarded.stdout).toContain("LOADED bufferutil");

    const guarded = runNode(["--require", GUARD, "-e", script], { cwd, env });
    expect(guarded.status).toBe(0);
    expect(guarded.stdout).not.toContain("PLANTED");
    expect(guarded.stdout).toContain("MISSING bufferutil");
    expect(guarded.stdout).toContain("MISSING utf-8-validate");
    // HOME itself is unchanged for the server's children.
    expect(guarded.stdout).toContain(`HOME=${home}`);
  });

  it.skipIf(NODE_MAJOR < 24)(
    "refuses modules resolved into a folder agents can write, unless inside an allowed add-on folder",
    async () => {
      const dataHome = await tempDir("dur3994-guard-data-");
      const cwd = await tempDir("dur3994-guard-app-");
      await writeTree(dataHome, {
        "node_modules/evil/index.js": "console.log('EVIL RAN'); module.exports = {};\n",
        "addon/index.mjs": "import 'evil';\nconsole.log('addon loaded');\n",
      });
      const script =
        "import(process.argv[1]).then(() => console.log('OK'), (e) => console.log('REFUSED ' + e.code + ' ' + e.message))";
      const baseEnv = { PATH: process.env.PATH ?? "", HOME: dataHome, PAPERCLIP_HOME: dataHome };

      // The add-on folder alone is allowed: its missing dependency found one
      // folder up (outside it, where an agent could have put it) is refused.
      const addonOnly = runNode(["--require", GUARD, "-e", script, path.join(dataHome, "addon/index.mjs")], {
        cwd,
        env: { ...baseEnv, PAPERCLIP_MODULE_GUARD_ALLOW: path.join(dataHome, "addon") },
      });
      expect(addonOnly.stdout).not.toContain("EVIL RAN");
      expect(addonOnly.stdout).toContain("REFUSED ERR_MODULE_NOT_FOUND");
      expect(addonOnly.stdout).toContain("can be changed by agents");

      // Not allowed at all: the add-on itself is refused.
      const nothingAllowed = runNode(["--require", GUARD, "-e", script, path.join(dataHome, "addon/index.mjs")], {
        cwd,
        env: baseEnv,
      });
      expect(nothingAllowed.stdout).toContain("REFUSED ERR_MODULE_NOT_FOUND");
      expect(nothingAllowed.stdout).not.toContain("addon loaded");

      // Negative control: the whole folder allowed -> it loads.
      const allAllowed = runNode(["--require", GUARD, "-e", script, path.join(dataHome, "addon/index.mjs")], {
        cwd,
        env: { ...baseEnv, PAPERCLIP_MODULE_GUARD_ALLOW: dataHome },
      });
      expect(allAllowed.stdout).toContain("EVIL RAN");
      expect(allAllowed.stdout).toContain("OK");
    },
  );

  it("gives plugin workers the guard, allowed only for their own folder, when the server runs with it", () => {
    expect(moduleGuardForWorker("/somewhere")).toEqual({ execArgv: [], env: {} });
    const fake = {
      preloadPath: "/usr/local/lib/paperclip/node-module-guard.cjs",
      globalPathsCleared: true,
      hooksActive: true,
      denyRoots: ["/paperclip", "/tmp"],
      allowRoot: vi.fn(),
      disallowRoot: vi.fn(),
      allowedRoots: () => [],
    };
    (globalThis as Record<symbol, unknown>)[MODULE_GUARD_KEY] = fake;
    try {
      const worker = moduleGuardForWorker("/paperclip/.paperclip/plugins");
      expect(worker.execArgv).toEqual(["--require", fake.preloadPath]);
      expect(worker.env.PAPERCLIP_MODULE_GUARD_ALLOW).toBe("/paperclip/.paperclip/plugins");
      expect(worker.env.PAPERCLIP_MODULE_GUARD_DENY).toBe("/paperclip:/tmp");
    } finally {
      delete (globalThis as Record<symbol, unknown>)[MODULE_GUARD_KEY];
    }
  });

  it("is in the image: loaded first by the server, root-owned outside /app, and tsx's cache is off", () => {
    const dockerfile = readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8");
    expect(dockerfile).toContain(
      "COPY scripts/node-module-guard.cjs /usr/local/lib/paperclip/node-module-guard.cjs",
    );
    const cmd = dockerfile.split("\n").find((line) => line.startsWith("CMD "));
    expect(cmd).toBeDefined();
    const args = JSON.parse(cmd!.slice(4)) as string[];
    expect(args.indexOf("--require")).toBeGreaterThan(0);
    expect(args[args.indexOf("--require") + 1]).toBe("/usr/local/lib/paperclip/node-module-guard.cjs");
    expect(args.indexOf("--require")).toBeLessThan(args.indexOf("--import"));
    expect(dockerfile).toMatch(/^\s+TSX_DISABLE_CACHE=1$/m);
    const entrypoint = readFileSync(path.join(REPO_ROOT, "scripts", "docker-entrypoint.sh"), "utf8");
    expect(entrypoint).toContain("exec env TSX_DISABLE_CACHE=1 gosu node");
  });
});

describe("DUR-3994 Stage 2: npm for add-on installs ignores settings agents can write", () => {
  it("uses empty settings files, the public registry, a private cache and no npm_config_* variables", async () => {
    const invocation = await buildIsolatedNpmInvocation(["install", "x"], {
      env: {
        PATH: "/usr/bin",
        npm_config_registry: "http://127.0.0.1:9/",
        NPM_CONFIG_USERCONFIG: "/paperclip/.npmrc",
        NPM_TOKEN: "t",
      },
    });
    try {
      const flag = (name: string) => invocation.args[invocation.args.indexOf(name) + 1];
      expect(invocation.args.slice(0, 2)).toEqual(["install", "x"]);
      expect(flag("--registry")).toBe(DEFAULT_NPM_REGISTRY);
      expect(await readFile(flag("--userconfig")!, "utf8")).toBe("");
      expect(await readFile(flag("--globalconfig")!, "utf8")).toBe("");
      expect(await readdir(flag("--cache")!)).toEqual([]);
      expect(Object.keys(invocation.env)).toEqual(["PATH"]);
    } finally {
      await invocation.cleanup();
    }
    expect(npmSafeEnv({ PAPERCLIP_NPM_REGISTRY: "https://r.example/", A: "1" })).toEqual({
      PAPERCLIP_NPM_REGISTRY: "https://r.example/",
      A: "1",
    });
  });

  it("really makes npm ignore an agent-written ~/.npmrc registry", async () => {
    const home = await tempDir("dur3994-npm-home-");
    await writeFile(path.join(home, ".npmrc"), "registry=http://127.0.0.1:9/\n@evil:registry=http://127.0.0.1:9/\n");
    const env = { ...process.env, HOME: home, npm_config_registry: "http://127.0.0.1:9/" };
    let npmAvailable = true;
    const unguarded = await execFileAsync("npm", ["config", "get", "registry"], { env, cwd: home }).catch(() => {
      npmAvailable = false;
      return { stdout: "" };
    });
    if (!npmAvailable) return; // no npm on this machine
    // Negative control: plain npm takes the agent's registry.
    expect(unguarded.stdout.trim()).toBe("http://127.0.0.1:9/");

    // npm runs in the (checked) add-on folder, not in HOME.
    const installFolder = await tempDir("dur3994-npm-folder-");
    await writeFile(path.join(installFolder, "package.json"), "{}");
    const invocation = await buildIsolatedNpmInvocation(["config", "get", "registry"], { env });
    try {
      const { stdout } = await execFileAsync("npm", invocation.args, { env: invocation.env, cwd: installFolder });
      expect(stdout.trim()).toBe(DEFAULT_NPM_REGISTRY);
      const scoped = await execFileAsync("npm", ["config", "get", "@evil:registry", ...invocation.args.slice(3)], {
        env: invocation.env,
        cwd: installFolder,
      });
      expect(scoped.stdout.trim()).toBe("undefined");
    } finally {
      await invocation.cleanup();
    }
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("DUR-3994 Stage 2 review fixes against a real database", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let appRoot!: string;
  const previousHome = process.env.PAPERCLIP_HOME;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dur3994-hardening-");
    db = createDb(tempDb.connectionString);
    appRoot = await tempDir("dur3994-approot-");
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(plugins);
    await db.delete(trustedCodeFingerprints);
    await db.delete(companies);
    resetConfiguredTrustedCodeForTests();
    delete (globalThis as Record<symbol, unknown>)[MODULE_GUARD_KEY];
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name: string): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  function enforcing() {
    return trustedCodeService(db, { mode: "enforce", appRoot });
  }

  describe("npm-installed adapters: the package name comes from a file agents can write", () => {
    it("refuses a traversal or absolute packageName, and an entry point outside the checked folder", async () => {
      const home = await tempDir("dur3994-home-");
      process.env.PAPERCLIP_HOME = home;
      configureTrustedCode(enforcing());
      const { buildExternalAdapters, recordExternalAdapterCode, isSafeNpmPackageName } = await import(
        "../adapters/plugin-loader.js"
      );
      const { getAdapterPluginsDir } = await import("../services/adapter-plugin-store.js");
      const managed = getAdapterPluginsDir();

      // An agent's code, outside the managed folder.
      await writeTree(home, {
        "evil/package.json": JSON.stringify({ name: "evil", version: "1.0.0", type: "module", main: "index.js" }),
        "evil/index.js":
          "globalThis.dur3994EvilAdapterRan = true;\nexport function createServerAdapter() { return { type: 'evil', execute: async () => ({}) }; }\n",
      });
      // A package installed through Paperclip whose "main" points out of it.
      await writeTree(managed, {
        "node_modules/escaping-adapter/package.json": JSON.stringify({
          name: "escaping-adapter",
          version: "1.0.0",
          type: "module",
          main: "../../../evil/index.js",
        }),
        "node_modules/good-adapter/package.json": JSON.stringify({
          name: "good-adapter",
          version: "1.0.0",
          type: "module",
          main: "index.js",
        }),
        "node_modules/good-adapter/index.js":
          "export function createServerAdapter() { return { type: 'good_adapter', execute: async () => ({}) }; }\n",
      });
      // Paperclip recorded the managed folder (an npm adapter was installed).
      await recordExternalAdapterCode({ localPath: undefined, type: "good_adapter" }, "install");

      const now = new Date().toISOString();
      await writeFile(
        path.join(home, "adapter-plugins.json"),
        JSON.stringify([
          { type: "traversal", packageName: "../../evil", installedAt: now },
          { type: "absolute", packageName: path.join(home, "evil"), installedAt: now },
          { type: "escaping", packageName: "escaping-adapter", installedAt: now },
          { type: "good_adapter", packageName: "good-adapter", installedAt: now },
        ]),
      );

      const loaded = await buildExternalAdapters();
      expect(loaded.map((adapter) => adapter.type)).toEqual(["good_adapter"]);
      expect((globalThis as { dur3994EvilAdapterRan?: boolean }).dur3994EvilAdapterRan).toBeUndefined();

      expect(isSafeNpmPackageName("good-adapter")).toBe(true);
      expect(isSafeNpmPackageName("@scope/name.js")).toBe(true);
      for (const bad of ["../x", "/abs", "@scope/..", "a/b", "@scope/../../x", "..", ".", "", "a\\b"]) {
        expect(isSafeNpmPackageName(bad)).toBe(false);
      }
    });
  });

  describe("shared add-on folders are checked before Paperclip installs into them", () => {
    it("sets a changed folder aside (so nothing in it becomes trusted) and tells every company", async () => {
      const companyA = await seedCompany("Company A");
      const service = enforcing();
      const parent = await tempDir("dur3994-shared-");
      const shared = path.join(parent, "plugins");
      await writeTree(shared, {
        "package.json": "{}",
        "node_modules/a/index.js": "a\n",
        "node_modules/c-dep/index.js": "c\n",
      });
      const subject = { kind: "plugin" as const, codeRoot: shared, label: "managed plugin folder" };
      await service.record(subject, "install");

      // Untouched: left alone.
      expect(await service.prepareSharedFolder(subject)).toEqual({ movedAsideTo: null });
      expect(existsSync(shared)).toBe(true);

      // An agent edits another plugin's dependency, and points npm at itself.
      await appendFile(path.join(shared, "node_modules/c-dep/index.js"), "planted\n");
      await writeFile(path.join(shared, ".npmrc"), "registry=http://127.0.0.1:9/\n");
      const prepared = await service.prepareSharedFolder(subject);
      expect(prepared.movedAsideTo).toMatch(/plugins\.untrusted-/);
      expect(existsSync(shared)).toBe(false);
      expect(existsSync(path.join(prepared.movedAsideTo!, "node_modules/c-dep/index.js"))).toBe(true);
      const rows = await db
        .select()
        .from(trustedCodeFingerprints)
        .where(eq(trustedCodeFingerprints.codeRoot, path.resolve(shared)));
      expect(rows).toHaveLength(0);
      const alerts = await db.select().from(activityLog).where(eq(activityLog.action, "instance.untrusted_code_refused"));
      expect(alerts.map((row) => row.companyId)).toEqual([companyA]);
      const message = String((alerts[0]!.details as { message?: string }).message);
      expect(message).toContain("were changed after they were installed");
      expect(message).toContain("need to be installed again");

      // Whatever is installed next is recorded fresh.
      await writeTree(shared, { "package.json": "{}", "node_modules/b/index.js": "b\n" });
      await service.record(subject, "install");
      await expect(service.assertTrusted(subject)).resolves.toBeUndefined();
    });

    it("sets aside a folder that was never recorded without raising an alarm", async () => {
      await seedCompany("Company A");
      const service = enforcing();
      const parent = await tempDir("dur3994-shared-");
      const shared = path.join(parent, "adapter-plugins");
      await writeTree(shared, { "package.json": '{"dependencies":{"evil":"*"}}' });
      const prepared = await service.prepareSharedFolder({ kind: "adapter", codeRoot: shared, label: "managed" });
      expect(prepared.movedAsideTo).not.toBeNull();
      expect(existsSync(shared)).toBe(false);
      expect(await db.select().from(activityLog)).toHaveLength(0);
    });

    it("does nothing when the check is off (a developer checkout)", async () => {
      const service = trustedCodeService(db, { mode: "off", appRoot });
      const shared = await tempDir("dur3994-shared-off-");
      await writeTree(shared, { "x.js": "x\n" });
      expect(await service.prepareSharedFolder({ kind: "plugin", codeRoot: shared, label: "m" })).toEqual({
        movedAsideTo: null,
      });
      expect(existsSync(shared)).toBe(true);
    });

    it("a plugin uninstall does not re-trust a shared folder an agent changed", async () => {
      const service = enforcing();
      const parent = await tempDir("dur3994-uninstall-");
      const localPluginDir = path.join(parent, "plugins");
      await writeTree(localPluginDir, {
        "package.json": "{}",
        "node_modules/plugin-x/index.js": "x\n",
        "node_modules/plugin-y/index.js": "y\n",
      });
      await service.record({ kind: "plugin", codeRoot: localPluginDir, label: "managed plugin folder" }, "install");
      await appendFile(path.join(localPluginDir, "node_modules/plugin-y/index.js"), "planted\n");

      const loader = pluginLoader(
        db,
        { localPluginDir, enableLocalFilesystem: false, enableNpmDiscovery: false, trustedCode: service },
        { instanceInfo: { instanceId: "test", hostVersion: "1.0.0" } } as never,
      );
      await loader.cleanupInstallArtifacts({
        id: randomUUID(),
        pluginKey: "x.plugin",
        packageName: "plugin-x",
        packagePath: null,
      } as never);

      // The changed folder was set aside, not recorded again.
      expect(existsSync(localPluginDir)).toBe(false);
      const rows = await db
        .select()
        .from(trustedCodeFingerprints)
        .where(eq(trustedCodeFingerprints.codeRoot, path.resolve(localPluginDir)));
      expect(rows).toHaveLength(0);
    });
  });

  it("allows an add-on folder in the module guard only while its check passes", async () => {
    const fake = {
      preloadPath: "/guard.cjs",
      globalPathsCleared: true,
      hooksActive: true,
      denyRoots: [],
      allowRoot: vi.fn(),
      disallowRoot: vi.fn(),
      allowedRoots: () => [],
    };
    (globalThis as Record<symbol, unknown>)[MODULE_GUARD_KEY] = fake;
    const service = enforcing();
    const root = await tempDir("dur3994-guard-root-");
    await writeTree(root, { "index.js": "1\n" });
    const subject = { kind: "adapter" as const, codeRoot: root, label: "a" };
    await service.record(subject, "install");
    expect(fake.allowRoot).toHaveBeenCalledWith(path.resolve(root));

    fake.allowRoot.mockClear();
    await service.assertTrusted(subject);
    expect(fake.allowRoot).toHaveBeenCalledWith(path.resolve(root));

    await appendFile(path.join(root, "index.js"), "planted\n");
    await expect(service.assertTrusted(subject)).rejects.toThrow("changed after it was installed");
    expect(fake.disallowRoot).toHaveBeenCalledWith(path.resolve(root));
  });
});
