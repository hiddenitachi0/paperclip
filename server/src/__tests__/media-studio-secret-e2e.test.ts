import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHostClientHandlers } from "@paperclipai/plugin-sdk";
import { agents, companies, createDb, pluginConfig, plugins } from "@paperclipai/db";
import mediaStudioManifest, { TOOL_GENERATE } from "../../../packages/plugins/media-studio/src/manifest.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { createPluginWorkerManager, type PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import { pluginToolExecutionService } from "../services/plugin-tool-execution.js";
import { openLaneAPluginRun } from "../services/lane-a-plugin-runs.js";
import { SECRET_REF_ENABLED_PLUGIN_KEYS } from "../services/plugin-secrets-handler.js";
import { secretService } from "../services/secrets.js";
import type { StorageService } from "../storage/types.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * Media Studio's Fal key, end to end, the way production runs it: the BUILT
 * add-on (packages/plugins/media-studio/dist/worker.js) in a real worker child
 * process, the real worker manager, the real host services and secrets
 * handler, a real company secret in a real database, and the quick agent's
 * (Lane A) tool path — openLaneAPluginRun + pluginToolExecutionService, as
 * services/lane-a.ts calls it. Only Fal's HTTP is faked (host http.fetch), so
 * no network call is made.
 *
 * The worker's `ctx.secrets.resolve` is a worker→host call nested inside the
 * host's `executeTool` / `performAction` call; the host must hand the
 * invocation scope it verified for that call on to the secrets handler, or
 * the handler (correctly) fails closed with "Plugin secret references are
 * disabled ...".
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Media Studio secret end-to-end tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MEDIA_STUDIO_DIR = path.join(REPO_ROOT, "packages/plugins/media-studio");
const MEDIA_STUDIO_WORKER = path.join(MEDIA_STUDIO_DIR, "dist/worker.js");
const TSC = path.join(REPO_ROOT, "node_modules/typescript/bin/tsc");
// plugin-loader.ts runs a repo-local add-on install (a bundled add-on has a
// packagePath) through this loader so workspace packages resolve from source.
const DEV_TSX_LOADER_PATH = path.join(REPO_ROOT, "cli/node_modules/tsx/dist/loader.mjs");
const FAL_KEY = `fal-test-key-${randomUUID()}`;
const FAL_IMAGE_URL = "https://v3.fal.media/files/test/picture.jpg";
const GENERATE_TOOL = `${mediaStudioManifest.id}:${TOOL_GENERATE}`;

/** Build the add-on the way the Dockerfile does (SDK dist first, then the plugin's own `tsc`). */
function buildMediaStudio() {
  execFileSync(process.execPath, [path.join(REPO_ROOT, "scripts/ensure-plugin-build-deps.mjs")], {
    cwd: REPO_ROOT,
    stdio: "pipe",
  });
  execFileSync(process.execPath, [TSC, "-p", MEDIA_STUDIO_DIR], { cwd: MEDIA_STUDIO_DIR, stdio: "pipe" });
  if (!existsSync(MEDIA_STUDIO_WORKER)) throw new Error(`Media Studio build did not produce ${MEDIA_STUDIO_WORKER}`);
}

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() };
    },
  } as any;
}

function createStorageServiceStub(): StorageService {
  return {
    provider: "local_disk",
    putFile: vi.fn(async (input) => ({
      provider: "local_disk",
      objectKey: `stub/${input.namespace}/${randomUUID()}`,
      contentType: input.contentType,
      byteSize: input.body.length,
      sha256: "stub-sha256",
      originalFilename: input.originalFilename,
    })),
    getObject: vi.fn(),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  } as unknown as StorageService;
}

describeEmbeddedPostgres("Media Studio Fal key resolution (real worker, real host services, real secret)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let workerManager: PluginWorkerManager | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-media-studio-secret-e2e-${randomUUID()}`);

  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const agentId = randomUUID();
  const pluginDbId = randomUUID();
  /** Every Fal request the worker made through the host, as the host saw it. */
  const falRequests: Array<{ url: string; authorization: string | null }> = [];

  beforeAll(async () => {
    buildMediaStudio();

    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-media-studio-secret-e2e-");
    db = createDb(tempDb.connectionString);

    await db.insert(companies).values([
      { id: companyId, name: "Nordco", issuePrefix: `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` },
      { id: otherCompanyId, name: "OtherCo", issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Maja",
      role: "general",
      laneAEnabled: true,
      pluginToolGrants: [GENERATE_TOOL],
    });
    const secret = await secretService(db).create(companyId, {
      name: `fal-key-${randomUUID()}`,
      provider: "local_encrypted",
      value: FAL_KEY,
    });
    await db.insert(plugins).values({
      id: pluginDbId,
      pluginKey: mediaStudioManifest.id,
      packageName: "@paperclipai/plugin-media-studio",
      version: mediaStudioManifest.version,
      apiVersion: mediaStudioManifest.apiVersion,
      manifestJson: mediaStudioManifest,
      status: "ready",
    });
    const config = { provider: "fal", falKeySecretRef: secret.id };
    await db.insert(pluginConfig).values({ pluginId: pluginDbId, configJson: config });

    // Host side, exactly as app.ts buildHostHandlers wires it — except Fal's
    // HTTP, which is answered here so nothing leaves the machine.
    workerManager = createPluginWorkerManager();
    const services = buildHostServices(db, pluginDbId, mediaStudioManifest.id, createEventBusStub(), undefined, {
      pluginWorkerManager: workerManager,
      manifest: mediaStudioManifest,
      storage: createStorageServiceStub(),
    });
    services.http.fetch = async (params) => {
      const headers = (params.init?.headers ?? {}) as Record<string, string>;
      falRequests.push({ url: params.url, authorization: headers.Authorization ?? headers.authorization ?? null });
      if (params.url.startsWith("https://fal.run/")) {
        return {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ images: [{ url: FAL_IMAGE_URL, content_type: "image/jpeg" }], seed: 42 }),
        };
      }
      if (params.url === FAL_IMAGE_URL) {
        return { status: 200, statusText: "OK", headers: { "content-type": "image/jpeg" }, body: "fake-jpeg-bytes" };
      }
      return { status: 404, statusText: "Not Found", headers: {}, body: "" };
    };
    const hostHandlers = createHostClientHandlers({
      pluginId: pluginDbId,
      capabilities: mediaStudioManifest.capabilities,
      services,
    });

    await workerManager.startWorker(pluginDbId, {
      entrypointPath: MEDIA_STUDIO_WORKER,
      manifest: mediaStudioManifest,
      config,
      instanceInfo: { instanceId: "test", hostVersion: "0.0.0" },
      apiVersion: mediaStudioManifest.apiVersion,
      hostHandlers,
      autoRestart: false,
      execArgv: ["--import", DEV_TSX_LOADER_PATH],
      // As plugin-loader.ts starts it (DUR-193 serialization stays on).
      serializeInvocationScope: SECRET_REF_ENABLED_PLUGIN_KEYS.has(mediaStudioManifest.id),
    });
  }, 180_000);

  afterAll(async () => {
    await workerManager?.stopAll().catch(() => undefined);
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  it("a quick agent's generate-image call resolves the company's Fal key and makes the picture", async () => {
    const dispatcher = createPluginToolDispatcher({ workerManager: workerManager!, db });
    dispatcher.registerPluginTools(mediaStudioManifest.id, mediaStudioManifest, pluginDbId);
    const execution = pluginToolExecutionService(db, dispatcher);
    falRequests.length = 0;

    // services/lane-a.ts, add-on tool branch.
    const pluginRun = openLaneAPluginRun({
      agentId,
      companyId,
      conversationId: randomUUID(),
      requestedByUserId: "user-1",
      requestedByAgentId: null,
      requesterMessage: "make a picture of a sofa",
    });
    let outcome;
    try {
      outcome = await execution.execute({
        tool: GENERATE_TOOL,
        parameters: { prompt: "a green sofa" },
        runContext: { agentId, runId: pluginRun.run.runId, companyId, projectId: "" },
        agent: { laneAEnabled: true, pluginToolGrants: [GENERATE_TOOL] },
      });
    } finally {
      pluginRun.close();
    }

    expect(outcome.ok).toBe(true);
    const result = outcome.ok ? outcome.result.result : null;
    expect(result?.error).toBeUndefined();
    expect(result?.content).toMatch(/saved it to the company's Files/);
    const falCall = falRequests.find((request) => request.url.startsWith("https://fal.run/"));
    expect(falCall).toBeDefined();
    // Compared, never printed: the key the worker sent Fal is the company secret's value.
    expect(falCall?.authorization === `Key ${FAL_KEY}`).toBe(true);
  }, 60_000);

  it("the Media Studio page's generate action resolves the key for a board user in the key's company", async () => {
    falRequests.length = 0;
    // What routes/plugins.ts POST /plugins/:pluginId/bridge/action sends.
    const result = (await workerManager!.call(pluginDbId, "performAction", {
      key: "generate",
      params: { prompt: "a green sofa", companyId },
      actorContext: {
        type: "user",
        userId: "user-1",
        agentId: null,
        runId: null,
        companyId,
        canManageCompany: true,
      },
      renderEnvironment: null,
    })) as { provider?: string; imageUrl?: string };

    expect(result).toMatchObject({ provider: "fal", imageUrl: FAL_IMAGE_URL });
    const falCall = falRequests.find((request) => request.url.startsWith("https://fal.run/"));
    expect(falCall?.authorization === `Key ${FAL_KEY}`).toBe(true);
  }, 60_000);

  it("still refuses the key to a call scoped to another company (never another company's secret)", async () => {
    falRequests.length = 0;
    await expect(
      workerManager!.call(pluginDbId, "performAction", {
        key: "generate",
        params: { prompt: "a green sofa", companyId: otherCompanyId },
        actorContext: {
          type: "user",
          userId: "user-2",
          agentId: null,
          runId: null,
          companyId: otherCompanyId,
          canManageCompany: true,
        },
        renderEnvironment: null,
      }),
    ).rejects.toThrow(/Invalid secret reference/);
    expect(falRequests).toHaveLength(0);
  }, 60_000);
});
