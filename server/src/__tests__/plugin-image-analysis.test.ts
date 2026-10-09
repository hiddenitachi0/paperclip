import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  modelDirectoryEntries,
  modelDirectorySettings,
  pluginState,
  plugins,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { buildHostServices } from "../services/plugin-host-services.js";
import { PLUGIN_IMAGE_ANALYSIS_BILLING_CODE } from "../services/plugin-image-analysis.js";
import { findCompanyLocalAddress } from "../services/model-directory.js";
import { companyMediaStudioKeyRef, mediaStudioKeyRef } from "../services/media-studio-company-keys.js";
import { secretService } from "../services/secrets.js";
import type { StorageService } from "../storage/types.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * models.analyseImage: the host (not the plugin worker) sends a picture to
 * one of the company's saved models, so a company's own model server on its
 * own network can be used. Every model service is stubbed; nothing is called.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

const KEY = "paperclip.media-studio";

function eventBusStub() {
  return { forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() }) } as any;
}

/** Storage that keeps what was put, so the host can read the picture back. */
function memoryStorage(): StorageService {
  const objects = new Map<string, Buffer>();
  return {
    provider: "local_disk",
    putFile: vi.fn(async (input) => {
      const objectKey = `mem/${input.namespace}/${randomUUID()}`;
      objects.set(objectKey, Buffer.from(input.body));
      return { provider: "local_disk", objectKey, contentType: input.contentType, byteSize: input.body.length, sha256: "x", originalFilename: input.originalFilename };
    }),
    getObject: vi.fn(async (_companyId: string, objectKey: string) => {
      const body = objects.get(objectKey) ?? Buffer.alloc(0);
      return { stream: Readable.from([body]), contentType: "image/png", contentLength: body.length } as any;
    }),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  } as unknown as StorageService;
}

type Call = { url: string; headers: Record<string, string>; body: any; redirect: string | undefined };

d("host picture analysis for plugins (models.analyseImage)", () => {
  let db!: ReturnType<typeof createDb>;
  let stop: (() => Promise<void>) | null = null;
  let pluginId = "";
  const storage = memoryStorage();
  let PNG: Buffer;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("plugin-image-analysis");
    stop = started.cleanup;
    db = createDb(started.connectionString);
    const [row] = await db
      .insert(plugins)
      .values({
        pluginKey: KEY,
        packageName: "@paperclipai/plugin-media-studio",
        version: "1.0.0",
        manifestJson: { id: KEY, apiVersion: 1, version: "1.0.0", displayName: "MS", description: "x", author: "x", categories: ["automation"], capabilities: [], entrypoints: { worker: "w.js" } } as unknown as PaperclipPluginManifestV1,
        status: "ready",
      })
      .returning();
    pluginId = row!.id;
    PNG = await sharp({ create: { width: 64, height: 32, channels: 3, background: { r: 200, g: 10, b: 10 } } }).png().toBuffer();
  }, 90_000);
  afterAll(async () => {
    await stop?.();
  });

  function host(answer: (call: Call) => Response = () => okOpenAi("a description")) {
    const calls: Call[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init?.body ?? "null")), redirect: init?.redirect };
      calls.push(call);
      return answer(call);
    });
    const services = buildHostServices(db, pluginId, KEY, eventBusStub(), undefined, {
      storage,
      imageAnalysis: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        instanceAnthropicKey: () => "instance-claude-key",
        priceFetch: (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch,
      },
    });
    return { services, calls, fetchImpl };
  }

  function okOpenAi(text: string, usage: Record<string, unknown> = { prompt_tokens: 1000, completion_tokens: 200 }) {
    return new Response(JSON.stringify({ choices: [{ message: { content: text } }], usage }), { status: 200, headers: { "content-type": "application/json" } });
  }

  async function seed() {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Atelier", issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` },
      { id: otherCompanyId, name: "Other", issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` },
    ]);
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const runId = randomUUID();
    const otherRunId = randomUUID();
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Maja", role: "general" },
      { id: otherAgentId, companyId: otherCompanyId, name: "Ola", role: "general" },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: runId, companyId, agentId, status: "running" },
      { id: otherRunId, companyId: otherCompanyId, agentId: otherAgentId, status: "running" },
    ]);
    const { services } = host();
    const picture = await services.files.createCompanyFile({ companyId, contentBase64: PNG.toString("base64"), contentType: "image/png", filename: "maja.png", runId });
    const document = await services.files.createCompanyFile({ companyId, contentBase64: Buffer.from("hello").toString("base64"), contentType: "text/plain", filename: "notes.txt", runId });
    const foreignPicture = await services.files.createCompanyFile({ companyId: otherCompanyId, contentBase64: PNG.toString("base64"), contentType: "image/png", filename: "other.png", runId: otherRunId });
    const entry = async (company: string, values: Partial<typeof modelDirectoryEntries.$inferInsert>) => {
      const [row] = await db
        .insert(modelDirectoryEntries)
        .values({ companyId: company, name: `M ${randomUUID().slice(0, 6)}`, provider: "local", model: "llava:13b", ...values })
        .returning();
      return row!.id;
    };
    const local = await entry(companyId, { name: "Llava on the office PC", provider: "local", model: "llava:13b", baseUrl: "http://100.64.0.5:11434/v1" });
    const localNoAddress = await entry(companyId, { name: "Qwen VL", provider: "local", model: "qwen2.5vl:7b", baseUrl: null });
    const claude = await entry(companyId, { name: "Claude Sonnet", provider: "anthropic", model: "claude-sonnet-4-5" });
    const openrouter = await entry(companyId, { name: "Qwen on OpenRouter", provider: "openrouter", model: "qwen/qwen2.5-vl-72b-instruct" });
    const openrouterPrivate = await entry(companyId, { name: "Sneaky", provider: "openrouter", model: "x/y", baseUrl: "http://10.0.0.5:8080/v1" });
    const archived = await entry(companyId, { name: "Old", provider: "local", model: "llava", baseUrl: "http://100.64.0.5:11434/v1", archivedAt: new Date() });
    const foreignEntry = await entry(otherCompanyId, { name: "Their model", provider: "local", model: "llava", baseUrl: "http://100.64.0.99:11434/v1" });
    const scope = { invocationScope: { companyId, userId: "owner-1", canManageCompany: true } };
    return { companyId, otherCompanyId, picture: picture.id, document: document.id, foreignPicture: foreignPicture.id, local, localNoAddress, claude, openrouter, openrouterPrivate, archived, foreignEntry, scope };
  }

  const prompts = { systemPrompt: "Describe the person. JSON only.", userPrompt: "Describe this picture." };

  it("reaches the company's own local model server (a tailnet address) through the host, with the picture and no tools; records the cost and an activity entry", async () => {
    const s = await seed();
    const { services, calls } = host();
    const res = await services.models.analyseImage({ companyId: s.companyId, entryId: s.local, fileId: s.picture, ...prompts }, s.scope);
    expect(res).toMatchObject({ text: "a description", entryName: "Llava on the office PC", provider: "local", model: "llava:13b" });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("http://100.64.0.5:11434/v1/chat/completions");
    expect(call.redirect).toBe("error");
    expect(call.headers.authorization).toBeUndefined();
    expect(call.body.model).toBe("llava:13b");
    expect(call.body.messages[0]).toEqual({ role: "system", content: prompts.systemPrompt });
    expect(call.body.messages[1].content[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    for (const k of ["tools", "tool_choice", "functions", "function_call"]) expect(call.body).not.toHaveProperty(k);
    const costs = await db.select().from(costEvents).where(eq(costEvents.companyId, s.companyId));
    expect(costs).toEqual([expect.objectContaining({ billingCode: PLUGIN_IMAGE_ANALYSIS_BILLING_CODE, provider: "local", model: "llava:13b", inputTokens: 1000, outputTokens: 200, agentId: null, createdByUserId: "owner-1" })]);
    const log = await db.select().from(activityLog).where(and(eq(activityLog.companyId, s.companyId), eq(activityLog.action, "plugin.image_analysis.run")));
    expect(log).toHaveLength(1);
    expect(JSON.stringify(log[0]!.details)).not.toContain("base64");
  });

  it("a saved local model without its own address uses the company's model server address; without one it is refused before any call", async () => {
    const s = await seed();
    const { services, calls } = host();
    await expect(services.models.analyseImage({ companyId: s.companyId, entryId: s.localNoAddress, fileId: s.picture, ...prompts }, s.scope)).rejects.toThrow(/no address is set/);
    expect(calls).toHaveLength(0);
    await db.insert(modelDirectorySettings).values({ companyId: s.companyId, localBaseUrl: "http://100.64.0.7:11434/v1" });
    await services.models.analyseImage({ companyId: s.companyId, entryId: s.localNoAddress, fileId: s.picture, ...prompts }, s.scope);
    expect(calls[0]!.url).toBe("http://100.64.0.7:11434/v1/chat/completions");
  });

  it("a local address counts only when THIS company uses it", async () => {
    const s = await seed();
    expect(await findCompanyLocalAddress(db, s.companyId, "http://100.64.0.5:11434")).toBe("http://100.64.0.5:11434/v1");
    // The other company's model server is not one this company uses.
    expect(await findCompanyLocalAddress(db, s.companyId, "http://100.64.0.99:11434/v1")).toBeNull();
    expect(await findCompanyLocalAddress(db, s.otherCompanyId, "http://100.64.0.99:11434/v1")).toBe("http://100.64.0.99:11434/v1");
    expect(await findCompanyLocalAddress(db, s.companyId, "")).toBeNull();
  });

  it("the plugin cannot pick an address: extra fields are ignored and only the saved model's own address is called", async () => {
    const s = await seed();
    const { services, calls } = host();
    await services.models.analyseImage(
      { companyId: s.companyId, entryId: s.local, fileId: s.picture, ...prompts, baseUrl: "http://169.254.169.254/latest", url: "http://evil.example" } as never,
      s.scope,
    );
    expect(calls.map((c) => c.url)).toEqual(["http://100.64.0.5:11434/v1/chat/completions"]);
    await expect(services.models.analyseImage({ companyId: s.companyId, entryId: "http://evil.example/v1", fileId: s.picture, ...prompts }, s.scope)).rejects.toThrow(/not one of this company's models/);
  });

  it("refuses a hosted service whose saved address is private, before any call", async () => {
    const s = await seed();
    const { services, calls } = host();
    await expect(
      services.models.analyseImage({ companyId: s.companyId, entryId: s.openrouterPrivate, fileId: s.picture, keySecretId: null, ...prompts }, s.scope),
    ).rejects.toThrow(/not a public internet address/);
    expect(calls).toHaveLength(0);
  });

  it("only this company's saved models and pictures: another company's model or picture, an archived model, or a document is refused", async () => {
    const s = await seed();
    const { services, calls } = host();
    await expect(services.models.analyseImage({ companyId: s.companyId, entryId: s.foreignEntry, fileId: s.picture, ...prompts }, s.scope)).rejects.toThrow(/not one of this company's models/);
    await expect(services.models.analyseImage({ companyId: s.companyId, entryId: s.archived, fileId: s.picture, ...prompts }, s.scope)).rejects.toThrow(/archived/);
    await expect(services.models.analyseImage({ companyId: s.companyId, entryId: s.local, fileId: s.foreignPicture, ...prompts }, s.scope)).rejects.toThrow(/not in this company's Files/);
    await expect(services.models.analyseImage({ companyId: s.companyId, entryId: s.local, fileId: s.document, ...prompts }, s.scope)).rejects.toThrow(/not a picture/);
    expect(calls).toHaveLength(0);
  });

  it("only from a company manager's own UI action for the company it is scoped to", async () => {
    const s = await seed();
    const { services, calls } = host();
    const input = { companyId: s.companyId, entryId: s.local, fileId: s.picture, ...prompts };
    await expect(services.models.analyseImage(input)).rejects.toThrow(/only works from a person's action/);
    await expect(services.models.analyseImage(input, { invocationScope: { companyId: s.otherCompanyId, userId: "owner-1", canManageCompany: true } })).rejects.toThrow(/only works from a person's action/);
    // A tool call or job: a company scope but no person.
    await expect(services.models.analyseImage(input, { invocationScope: { companyId: s.companyId, runId: randomUUID() } })).rejects.toThrow(/only works from a person's action/);
    await expect(services.models.analyseImage(input, { invalidInvocationScope: true })).rejects.toThrow(/only works from a person's action/);
    await expect(services.models.analyseImage(input, { invocationScope: { companyId: s.companyId, userId: "member-1", canManageCompany: false } })).rejects.toThrow(/owner or an admin/);
    expect(calls).toHaveLength(0);
  });

  it("Claude: an image block, Paperclip's own Claude key when no company key is picked, never tools", async () => {
    const s = await seed();
    const { services, calls } = host(() => new Response(JSON.stringify({ content: [{ type: "text", text: "{\"refused\":true}" }], usage: { input_tokens: 500, output_tokens: 20 } }), { status: 200 }));
    const res = await services.models.analyseImage({ companyId: s.companyId, entryId: s.claude, fileId: s.picture, ...prompts }, s.scope);
    expect(res.text).toBe("{\"refused\":true}");
    const call = calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.headers["x-api-key"]).toBe("instance-claude-key");
    expect(call.body.system).toBe(prompts.systemPrompt);
    expect(call.body.messages[0].content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/jpeg" } });
    expect(call.body).not.toHaveProperty("tools");
    expect(call.body).not.toHaveProperty("tool_choice");
  });

  it("a hosted service uses the company's own secret, and a secret of another company is refused", async () => {
    const s = await seed();
    const secrets = secretService(db);
    const own = await secrets.create(s.companyId, { name: "OpenRouter key", provider: "local_encrypted", value: "or-test-value-123456" });
    const theirs = await secrets.create(s.otherCompanyId, { name: "Their key", provider: "local_encrypted", value: "their-value-123456" });
    const { services, calls } = host((c) => okOpenAi("ok", { prompt_tokens: 10, completion_tokens: 5, cost: 0.0042 }));
    await services.models.analyseImage({ companyId: s.companyId, entryId: s.openrouter, fileId: s.picture, keySecretId: own.id, ...prompts }, s.scope);
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0]!.headers.authorization).toBe("Bearer or-test-value-123456");
    // OpenRouter's own billed cost is what is recorded (rounded to cents).
    const [cost] = await db.select().from(costEvents).where(eq(costEvents.companyId, s.companyId));
    expect(cost).toMatchObject({ costMicroUsd: 4200, costSource: "provider" });
    await expect(
      services.models.analyseImage({ companyId: s.companyId, entryId: s.openrouter, fileId: s.picture, keySecretId: theirs.id, ...prompts }, s.scope),
    ).rejects.toThrow(/could not be read/);
    await expect(
      services.models.analyseImage({ companyId: s.companyId, entryId: s.openrouter, fileId: s.picture, keySecretId: null, ...prompts }, s.scope),
    ).rejects.toThrow(/Pick the OpenRouter key/);
    expect(calls).toHaveLength(1);
  });

  it("an unreachable model server is one plain sentence; an error answer never echoes the key", async () => {
    const s = await seed();
    const down = host(() => {
      throw new Error("connect ECONNREFUSED 100.64.0.5:11434");
    });
    await expect(down.services.models.analyseImage({ companyId: s.companyId, entryId: s.local, fileId: s.picture, ...prompts }, s.scope)).rejects.toThrow(
      /Check that the computer is on and the model server is running/,
    );
    const secrets = secretService(db);
    const own = await secrets.create(s.companyId, { name: "k", provider: "local_encrypted", value: "sk-or-v1-supersecretvalue" });
    const echo = host(() => new Response(JSON.stringify({ error: { message: "bad key sk-or-v1-supersecretvalue for model" } }), { status: 400 }));
    const err = await echo.services.models
      .analyseImage({ companyId: s.companyId, entryId: s.openrouter, fileId: s.picture, keySecretId: own.id, ...prompts }, s.scope)
      .catch((e: Error) => e);
    expect(String((err as Error).message)).toMatch(/could not look at the picture \(error 400\)/);
    expect(String((err as Error).message)).not.toContain("supersecretvalue");
  });

  it("the server reads each company's own Media Studio key first, else the instance's", async () => {
    const s = await seed();
    const instance = { falKeySecretRef: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sogniKeySecretRef: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    expect(await mediaStudioKeyRef(db, pluginId, s.companyId, "fal", instance)).toBe(instance.falKeySecretRef);
    await db.insert(pluginState).values({
      pluginId,
      scopeKind: "company",
      scopeId: s.companyId,
      namespace: "default",
      stateKey: "serviceKeys",
      valueJson: { fal: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", sogni: null, higgsfield: "not-an-id" },
    });
    expect(await mediaStudioKeyRef(db, pluginId, s.companyId, "fal", instance)).toBe("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    expect(await mediaStudioKeyRef(db, pluginId, s.companyId, "sogni", instance)).toBe(instance.sogniKeySecretRef);
    expect(await companyMediaStudioKeyRef(db, pluginId, s.companyId, "higgsfield")).toBeNull();
    // Another company is untouched.
    expect(await mediaStudioKeyRef(db, pluginId, s.otherCompanyId, "fal", instance)).toBe(instance.falKeySecretRef);
    expect(await mediaStudioKeyRef(db, pluginId, s.otherCompanyId, "fal", {})).toBe("");
  });
});
