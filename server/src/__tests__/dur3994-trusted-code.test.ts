import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  instanceSettings,
  plugins,
  trustedCodeFingerprints,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  FIRST_START_BASELINE_MARKER,
  FingerprintTooLargeError,
  UntrustedCodeError,
  computeCodeFingerprint,
  configureTrustedCode,
  detectTrustedCodeMode,
  resetConfiguredTrustedCodeForTests,
  trustedCodeService,
} from "../services/trusted-code.js";
import { pluginLoader } from "../services/plugin-loader.js";
import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";

// DUR-3994 Stage 2: agents can't plant code the server will run.
//
// Agents run as the same Linux user as the server. The server's own program
// (/app) is now root-owned in the image; add-on code (plugins, external
// adapters) has to stay in writable folders, so Paperclip records a
// fingerprint of each add-on's files when IT installs them (in the database,
// out of agents' reach) and refuses to load them if they changed. These tests
// drive the real services against a real Postgres.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres trusted-code tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

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

describe("DUR-3994 Stage 2: add-on code fingerprints", () => {
  it("is stable for unchanged files and changes on every kind of edit", async () => {
    const root = await tempDir("dur3994-fp-");
    const appRoot = await tempDir("dur3994-app-");
    await writeTree(root, { "index.js": "export default 1;\n", "lib/a.js": "a\n", "other.txt": "x\n" });

    const first = await computeCodeFingerprint(root, { appRoot });
    const again = await computeCodeFingerprint(root, { appRoot });
    expect(again.digest).toBe(first.digest);
    expect(first.fileCount).toBe(3);
    expect(Object.keys(first.files).sort()).toEqual(["index.js", "lib/a.js", "other.txt"].map((p) => p.split("/").join(path.sep)).sort());

    await appendFile(path.join(root, "lib/a.js"), "planted\n");
    const edited = await computeCodeFingerprint(root, { appRoot });
    expect(edited.digest).not.toBe(first.digest);

    await writeFile(path.join(root, "lib/a.js"), "a\n");
    expect((await computeCodeFingerprint(root, { appRoot })).digest).toBe(first.digest);

    await writeFile(path.join(root, "new.js"), "planted\n");
    const added = await computeCodeFingerprint(root, { appRoot });
    expect(added.digest).not.toBe(first.digest);
    await unlink(path.join(root, "new.js"));

    await unlink(path.join(root, "other.txt"));
    expect((await computeCodeFingerprint(root, { appRoot })).digest).not.toBe(first.digest);
  });

  it("follows symbolic links (and notices a re-pointed one), but not into the root-owned app folder", async () => {
    const root = await tempDir("dur3994-fp-link-");
    const outside = await tempDir("dur3994-fp-outside-");
    const appRoot = await tempDir("dur3994-fp-app-");
    await writeTree(outside, { "dep.js": "dep\n", "evil.js": "evil\n" });
    await writeTree(appRoot, { "server.js": "server\n" });
    await writeTree(root, { "index.js": "i\n" });
    await symlink(path.join(outside, "dep.js"), path.join(root, "dep.js"));
    await symlink(appRoot, path.join(root, "app-link"));

    const first = await computeCodeFingerprint(root, { appRoot });
    expect(first.files["dep.js"]).toBeDefined();
    // Nothing under the app folder is hashed: it is protected by ownership.
    expect(Object.keys(first.files).some((rel) => rel.startsWith("app-link"))).toBe(false);

    // Editing the file a link points at is a change.
    await appendFile(path.join(outside, "dep.js"), "planted\n");
    const targetEdited = await computeCodeFingerprint(root, { appRoot });
    expect(targetEdited.digest).not.toBe(first.digest);

    // Re-pointing the link is a change.
    await unlink(path.join(root, "dep.js"));
    await symlink(path.join(outside, "evil.js"), path.join(root, "dep.js"));
    expect((await computeCodeFingerprint(root, { appRoot })).digest).not.toBe(targetEdited.digest);
  });

  it("ignores node_modules/.cache (build-tool caches) and refuses folders that are too big to check", async () => {
    const root = await tempDir("dur3994-fp-cache-");
    const appRoot = await tempDir("dur3994-fp-app2-");
    await writeTree(root, { "index.js": "i\n", "node_modules/.cache/babel/x.json": "{}\n" });
    const first = await computeCodeFingerprint(root, { appRoot });
    await writeFile(path.join(root, "node_modules/.cache/babel/y.json"), "{}\n");
    expect((await computeCodeFingerprint(root, { appRoot })).digest).toBe(first.digest);

    await expect(computeCodeFingerprint(root, { appRoot, maxFiles: 0 })).rejects.toBeInstanceOf(FingerprintTooLargeError);
  });

  it("enforces only where this server cannot write its own program file", async () => {
    const dir = await tempDir("dur3994-mode-");
    const programFile = path.join(dir, "index.js");
    await writeFile(programFile, "server\n");
    expect(detectTrustedCodeMode(programFile)).toBe("off");
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root can write anything
    await chmod(programFile, 0o444);
    await chmod(dir, 0o555);
    try {
      expect(detectTrustedCodeMode(programFile)).toBe("enforce");
    } finally {
      await chmod(dir, 0o755);
    }
    // The real server module, in this checkout, is writable: off.
    expect(detectTrustedCodeMode()).toBe("off");
  });
});

describeEmbeddedPostgres("DUR-3994 Stage 2: the trusted-code check against a real database", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let appRoot!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dur3994-trusted-code-");
    db = createDb(tempDb.connectionString);
    appRoot = await tempDir("dur3994-approot-");
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(plugins);
    await db.delete(trustedCodeFingerprints);
    await db.delete(companies);
    await db.delete(instanceSettings);
    resetConfiguredTrustedCodeForTests();
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

  it("accepts recorded files, refuses edited ones in plain words, and tells every company once", async () => {
    const companyA = await seedCompany("Company A");
    const companyB = await seedCompany("Company B");
    const root = await tempDir("dur3994-addon-");
    await writeTree(root, { "index.js": "export default 1;\n" });
    const service = enforcing();
    const subject = { kind: "adapter" as const, codeRoot: root, label: "demo_adapter" };

    await service.record(subject, "install");
    await expect(service.assertTrusted(subject)).resolves.toBeUndefined();

    await appendFile(path.join(root, "index.js"), "globalThis.planted = true;\n");
    const refusal = await service.assertTrusted(subject).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(UntrustedCodeError);
    expect((refusal as UntrustedCodeError).reason).toBe("changed");
    expect((refusal as Error).message).toContain('did not start the adapter "demo_adapter"');
    expect((refusal as Error).message).toContain("changed after it was installed");
    expect((refusal as Error).message).toContain("installs it again");

    // A second refusal of the same thing does not repeat the alert.
    await expect(service.assertTrusted(subject)).rejects.toBeInstanceOf(UntrustedCodeError);
    const alerts = await db
      .select({ companyId: activityLog.companyId, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "instance.untrusted_code_refused"));
    expect(alerts.map((row) => row.companyId).sort()).toEqual([companyA, companyB].sort());
    expect(String((alerts[0]?.details as { message?: string })?.message)).toContain("changed after it was installed");

    // Installing again (recording again) is how an admin trusts the new files.
    await service.record(subject, "reinstall");
    await expect(service.assertTrusted(subject)).resolves.toBeUndefined();
  });

  it("refuses code nobody installed through Paperclip, and code it cannot read", async () => {
    const service = enforcing();
    const planted = await tempDir("dur3994-planted-");
    await writeTree(planted, { "index.js": "evil\n" });
    const check = await service.check({ kind: "adapter", codeRoot: planted, label: "planted" });
    expect(check.ok).toBe(false);
    expect(!check.ok && check.error.reason).toBe("unknown");
    expect(!check.ok && check.error.message).toContain("was not installed through Paperclip");

    const gone = await tempDir("dur3994-gone-");
    await writeTree(gone, { "index.js": "x\n" });
    await service.record({ kind: "plugin", codeRoot: gone, label: "gone" }, "install");
    await rm(gone, { recursive: true, force: true });
    const missing = await service.check({ kind: "plugin", codeRoot: gone, label: "gone" });
    expect(!missing.ok && missing.error.reason).toBe("unverifiable");
  });

  it("leaves code inside the root-owned program folder alone", async () => {
    const service = enforcing();
    const bundled = path.join(appRoot, "packages", "plugins", "bundled");
    await writeTree(bundled, { "index.js": "bundled\n" });
    await expect(service.check({ kind: "plugin", codeRoot: bundled, label: "bundled" })).resolves.toEqual({
      ok: true,
      exempt: true,
    });
    await service.record({ kind: "plugin", codeRoot: bundled, label: "bundled" }, "install");
    expect(await db.select().from(trustedCodeFingerprints)).toHaveLength(0);
  });

  it("does nothing at all when the check is off (a developer checkout)", async () => {
    const service = trustedCodeService(db, { mode: "off", appRoot });
    const root = await tempDir("dur3994-off-");
    await writeTree(root, { "index.js": "x\n" });
    await service.record({ kind: "plugin", codeRoot: root, label: "p" }, "install");
    expect(await db.select().from(trustedCodeFingerprints)).toHaveLength(0);
    await expect(service.assertTrusted({ kind: "plugin", codeRoot: root, label: "p" })).resolves.toBeUndefined();
    expect(await service.checkFile({ kind: "plugin", codeRoot: root, label: "p" }, path.join(root, "index.js"))).toBe(true);
  });

  it("trusts what is installed at the first start exactly once", async () => {
    const service = enforcing();
    const existing = await tempDir("dur3994-existing-");
    await writeTree(existing, { "index.js": "existing\n" });
    const first = await service.recordFirstStartBaseline([
      { kind: "plugin", codeRoot: existing, label: "existing" },
      { kind: "plugin", codeRoot: path.join(existing, "does-not-exist"), label: "missing" },
    ]);
    expect(first).toEqual({ alreadyTaken: false, recorded: 1, failed: 0 });
    expect((await service.check({ kind: "plugin", codeRoot: existing, label: "existing" })).ok).toBe(true);
    const marker = await db
      .select()
      .from(trustedCodeFingerprints)
      .where(eq(trustedCodeFingerprints.codeRoot, FIRST_START_BASELINE_MARKER));
    expect(marker).toHaveLength(1);

    // Something that appears later (an agent adding an adapter record, say)
    // is NOT swept in by a later start.
    const later = await tempDir("dur3994-later-");
    await writeTree(later, { "index.js": "later\n" });
    const second = await service.recordFirstStartBaseline([{ kind: "adapter", codeRoot: later, label: "later" }]);
    expect(second).toEqual({ alreadyTaken: true, recorded: 0, failed: 0 });
    const check = await service.check({ kind: "adapter", codeRoot: later, label: "later" });
    expect(!check.ok && check.error.reason).toBe("unknown");
  });

  it("checks single served files against what was installed", async () => {
    const service = enforcing();
    const root = await tempDir("dur3994-ui-");
    await writeTree(root, { "dist/ui/index.js": "ui\n", "dist/worker.js": "w\n" });
    const subject = { kind: "plugin" as const, codeRoot: root, label: "ui-plugin" };
    await service.record(subject, "install");
    const uiFile = path.join(root, "dist/ui/index.js");
    expect(await service.checkFile(subject, uiFile)).toBe(true);
    expect(service.checkFileSync(subject, uiFile)).toBe(true);

    await writeFile(uiFile, "document.cookie\n");
    expect(await service.checkFile(subject, uiFile)).toBe(false);
    expect(service.checkFileSync(subject, uiFile)).toBe(false);

    await writeFile(path.join(root, "dist/ui/new.js"), "planted\n");
    expect(await service.checkFile(subject, path.join(root, "dist/ui/new.js"))).toBe(false);
    expect(await service.checkFile(subject, path.join(os.tmpdir(), "elsewhere.js"))).toBe(false);
  });

  describe("plugins", () => {
    const pluginKey = "dur3994.demo-plugin";

    async function createPluginPackage(version = "0.1.0") {
      const packageRoot = await tempDir("dur3994-plugin-");
      await writePluginFiles(packageRoot, version);
      return packageRoot;
    }

    async function writePluginFiles(packageRoot: string, version: string) {
      await writeTree(packageRoot, {
        "package.json": JSON.stringify({
          name: "dur3994-demo-plugin",
          version,
          type: "module",
          paperclipPlugin: { manifest: "./manifest.js" },
        }),
        "manifest.js": `export default ${JSON.stringify({
          id: pluginKey,
          apiVersion: 1,
          version,
          displayName: "Demo",
          description: "Demo plugin",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["companies.read"],
          entrypoints: { worker: "./dist/worker.js" },
        })};\n`,
        "dist/worker.js": "export {};\n",
      });
    }

    function buildLoader(localPluginDir: string) {
      const workerManager = {
        startWorker: vi.fn().mockResolvedValue(undefined),
        stopAll: vi.fn().mockResolvedValue(undefined),
      };
      const lifecycleManager = { markError: vi.fn().mockResolvedValue(undefined) };
      const loader = pluginLoader(
        db,
        {
          localPluginDir,
          enableLocalFilesystem: false,
          enableNpmDiscovery: false,
          trustedCode: enforcing(),
        },
        {
          workerManager,
          eventBus: { forPlugin: vi.fn(() => ({})), subscriptionCount: vi.fn(() => 0) },
          jobScheduler: { registerPlugin: vi.fn().mockResolvedValue(undefined), stop: vi.fn() },
          jobStore: { syncJobDeclarations: vi.fn().mockResolvedValue(undefined) },
          toolDispatcher: { registerPluginTools: vi.fn() },
          lifecycleManager,
          buildHostHandlers: vi.fn(() => ({})),
          instanceInfo: {
            instanceId: "test-instance",
            hostVersion: "1.0.0",
            deploymentMode: "authenticated",
            deploymentExposure: "private",
          },
        } as never,
      );
      return { loader, workerManager, lifecycleManager };
    }

    async function markReady() {
      const [row] = await db
        .update(plugins)
        .set({ status: "ready" })
        .where(eq(plugins.pluginKey, pluginKey))
        .returning({ id: plugins.id });
      return row!.id;
    }

    it("loads an installed plugin, and refuses it (without running any of its code) once its manifest is edited", async () => {
      await seedCompany("Company A");
      const packageRoot = await createPluginPackage();
      const localPluginDir = await tempDir("dur3994-managed-");
      const { loader, workerManager, lifecycleManager } = buildLoader(localPluginDir);

      await loader.installPlugin({ localPath: packageRoot });
      const pluginId = await markReady();

      const ok = await loader.loadSingle(pluginId);
      expect(ok.success).toBe(true);
      expect(workerManager.startWorker).toHaveBeenCalledTimes(1);
      const workerOptions = workerManager.startWorker.mock.calls[0]![1] as { verifyBeforeSpawn?: () => Promise<void> };
      expect(typeof workerOptions.verifyBeforeSpawn).toBe("function");
      await expect(workerOptions.verifyBeforeSpawn!()).resolves.toBeUndefined();

      // What an agent could do: append code to the manifest (which the
      // server imports in-process) that leaves a marker if it ever runs.
      const marker = path.join(await tempDir("dur3994-marker-"), "ran");
      await appendFile(
        path.join(packageRoot, "manifest.js"),
        `\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`,
      );

      // The worker restart path is checked too.
      await expect(workerOptions.verifyBeforeSpawn!()).rejects.toBeInstanceOf(UntrustedCodeError);

      const refused = await loader.loadSingle(pluginId);
      expect(refused.success).toBe(false);
      expect(refused.error).toContain(`did not start the plugin "${pluginKey}"`);
      expect(refused.error).toContain("changed after it was installed");
      expect(workerManager.startWorker).toHaveBeenCalledTimes(1);
      expect(lifecycleManager.markError).toHaveBeenCalledWith(
        pluginId,
        expect.stringContaining("changed after it was installed"),
      );
      expect(existsSync(marker)).toBe(false);

      const alerts = await db.select().from(activityLog).where(eq(activityLog.action, "instance.untrusted_code_refused"));
      expect(alerts).toHaveLength(1);
    });

    it("an upgrade through Paperclip makes the new files the trusted ones", async () => {
      const packageRoot = await createPluginPackage("0.1.0");
      const localPluginDir = await tempDir("dur3994-managed-");
      const { loader, workerManager } = buildLoader(localPluginDir);
      await loader.installPlugin({ localPath: packageRoot });
      const pluginId = await markReady();

      await writePluginFiles(packageRoot, "0.2.0");
      expect((await loader.loadSingle(pluginId)).success).toBe(false);

      await loader.upgradePlugin(pluginId, { localPath: packageRoot });
      await markReady();
      const result = await loader.loadSingle(pluginId);
      expect(result.success).toBe(true);
      expect(workerManager.startWorker).toHaveBeenCalledTimes(1);
    });

    it("refuses a plugin row pointing at a folder Paperclip never installed", async () => {
      const packageRoot = await createPluginPackage();
      const localPluginDir = await tempDir("dur3994-managed-");
      const { loader, workerManager } = buildLoader(localPluginDir);
      await loader.installPlugin({ localPath: packageRoot });
      const pluginId = await markReady();

      const elsewhere = await createPluginPackage();
      await db.update(plugins).set({ packagePath: elsewhere }).where(eq(plugins.id, pluginId));
      const result = await loader.loadSingle(pluginId);
      expect(result.success).toBe(false);
      expect(result.error).toContain("was not installed through Paperclip");
      expect(workerManager.startWorker).not.toHaveBeenCalled();
    });
  });

  describe("external adapters", () => {
    const previousHome = process.env.PAPERCLIP_HOME;

    afterEach(() => {
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
    });

    async function createAdapterPackage(type: string) {
      const packageRoot = await tempDir("dur3994-adapter-");
      await writeTree(packageRoot, {
        "package.json": JSON.stringify({ name: `${type}-pkg`, version: "1.0.0", type: "module", main: "index.js" }),
        "index.js": `export function createServerAdapter() { return { type: ${JSON.stringify(type)}, execute: async () => ({}) }; }\n`,
      });
      return packageRoot;
    }

    it("loads an adapter installed through Paperclip and refuses it after its files change", async () => {
      await seedCompany("Company A");
      process.env.PAPERCLIP_HOME = await tempDir("dur3994-home-");
      const service = enforcing();
      configureTrustedCode(service);
      const { addAdapterPlugin } = await import("../services/adapter-plugin-store.js");
      const { buildExternalAdapters, recordExternalAdapterCode } = await import("../adapters/plugin-loader.js");

      const type = "dur3994_demo_adapter";
      const packageRoot = await createAdapterPackage(type);
      await recordExternalAdapterCode({ localPath: packageRoot, type }, "install");
      addAdapterPlugin({ packageName: `${type}-pkg`, localPath: packageRoot, type, installedAt: new Date().toISOString() });

      const loaded = await buildExternalAdapters();
      expect(loaded.map((adapter) => adapter.type)).toEqual([type]);

      await appendFile(path.join(packageRoot, "index.js"), "globalThis.dur3994Planted = true;\n");
      const afterEdit = await buildExternalAdapters();
      expect(afterEdit).toEqual([]);
      expect((globalThis as { dur3994Planted?: boolean }).dur3994Planted).toBeUndefined();
      const alerts = await db.select().from(activityLog).where(eq(activityLog.action, "instance.untrusted_code_refused"));
      expect(alerts).toHaveLength(1);
      expect(String((alerts[0]!.details as { message?: string }).message)).toContain(`the adapter "${type}"`);
    });

    it("refuses an adapter record written straight into adapter-plugins.json (the way an agent could)", async () => {
      const home = await tempDir("dur3994-home-");
      process.env.PAPERCLIP_HOME = home;
      configureTrustedCode(enforcing());
      const { buildExternalAdapters } = await import("../adapters/plugin-loader.js");
      const type = "dur3994_planted_adapter";
      const packageRoot = await createAdapterPackage(type);
      await writeFile(
        path.join(home, "adapter-plugins.json"),
        JSON.stringify([{ packageName: `${type}-pkg`, localPath: packageRoot, type, installedAt: new Date().toISOString() }]),
      );
      expect(await buildExternalAdapters()).toEqual([]);
    });
  });
});

describe("DUR-3994 Stage 2: plugin worker (re)starts are checked", () => {
  const workerEntrypoint = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "plugin-worker-delayed.cjs");
  const manifest = {
    id: "test.plugin",
    apiVersion: 1 as const,
    version: "1.0.0",
    displayName: "Test plugin",
    description: "Test plugin",
    author: "Paperclip",
    categories: ["automation" as const],
    capabilities: [],
    entrypoints: { worker: "dist/worker.js" },
  };

  it("does not start the worker process when the check refuses", async () => {
    let allow = true;
    const verifyBeforeSpawn = vi.fn(async () => {
      if (!allow) throw new Error("files changed");
    });
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: workerEntrypoint,
      manifest,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: {},
      verifyBeforeSpawn,
    });
    try {
      await handle.start();
      expect(handle.status).toBe("running");
      await handle.stop();

      allow = false;
      await expect(handle.start()).rejects.toThrow("files changed");
      expect(handle.status).toBe("crashed");
      expect(handle.diagnostics().pid).toBeNull();
      expect(verifyBeforeSpawn).toHaveBeenCalledTimes(2);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});
