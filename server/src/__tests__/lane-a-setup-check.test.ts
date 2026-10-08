import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  costEvents,
  createDb,
  laneAConversations,
  laneAMessages,
  localModelHealth,
  modelDirectoryEntries,
  secretAccessEvents,
} from "@paperclipai/db";
import type { LaneABackupModelConfig } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { secretService } from "../services/secrets.ts";

// "Check this setup": one tiny, real call through exactly the chat path for a
// quick agent's main model or one backup, reported in plain words. Every
// model call here is a stub: nothing leaves the test.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const LOCAL_URL = "http://office-pc.tailnet.example:11434/v1";

type Reply = { status?: number; body: unknown };

function json(reply: Reply): Response {
  return new Response(JSON.stringify(reply.body), {
    status: reply.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function toolCallReply(cost = 0.00002) {
  return {
    body: {
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "setup_check_ping", arguments: '{"word":"ready"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 10, cost },
    },
  };
}

function textReply(text: string, cost = 0.00001) {
  return {
    body: {
      choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 140, completion_tokens: 2, cost },
    },
  };
}

/** A provider stub: GET /models answers (reachability), each chat call takes the next scripted reply. */
function stubProvider(script: Array<Reply | Error>) {
  const chatBodies: Array<Record<string, unknown>> = [];
  const authHeaders: Array<string | undefined> = [];
  const urls: string[] = [];
  const providerFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/models")) {
      const next = script[0];
      if (next instanceof Error) throw next;
      return json({ body: { data: [] } });
    }
    const headers = (init?.headers as Record<string, string>) ?? {};
    authHeaders.push(headers.authorization ?? headers.Authorization);
    chatBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const next = script.shift();
    if (!next) throw new Error("unexpected extra model call");
    if (next instanceof Error) throw next;
    return json(next);
  }) as unknown as typeof fetch;
  return { providerFetch, chatBodies, authHeaders, urls };
}

describeEmbeddedPostgres("lane A: Check this setup", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-lane-a-setup-check-${randomUUID()}`);

  vi.setConfig({ testTimeout: 60_000 });

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("lane-a-setup-check");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    await import("../services/lane-a.ts");
  }, 90_000);

  afterEach(async () => {
    await db.delete(laneAMessages);
    await db.delete(laneAConversations);
    await db.delete(localModelHealth);
    await db.delete(modelDirectoryEntries);
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany(name = "Acme") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(
    companyId: string,
    fields: Partial<typeof agents.$inferInsert>,
    laneA?: Record<string, unknown>,
  ) {
    const created = await agentService(db).create(companyId, {
      name: "Front desk",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: laneA ? { laneA } : {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    await db.update(agents).set({ laneAEnabled: true, ...fields }).where(eq(agents.id, created.id));
    return created.id;
  }

  async function seedKey(companyId: string, value: string) {
    const secret = await secretService(db).create(companyId, { name: `key-${randomUUID()}`, provider: "local_encrypted", value });
    return { type: "secret_ref" as const, secretId: secret.id, version: "latest" as const };
  }

  async function service(providerFetch: typeof fetch) {
    const { laneAService } = await import("../services/lane-a.ts");
    return laneAService(db, { providerFetch });
  }

  it("a local model that answers and calls the test tool: everything works, health recorded, nothing stored as a chat", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, { laneAProvider: "local", laneAModel: "qwen3:8b", laneABaseUrl: LOCAL_URL, laneAThinking: "off", laneATemperature: 0.3 });
    const stub = stubProvider([toolCallReply(), textReply("OK")]);

    const result = await (await service(stub.providerFetch)).checkSetup({ companyId, agentId, target: "main" });

    expect(result.ok).toBe(true);
    expect(result.toolCalling).toBe("works");
    expect(result.thinkingAccepted).toBe(true);
    expect(result.summary).toMatch(/Everything works/);
    expect(result.steps.find((s) => s.id === "tools")).toMatchObject({ ok: true, text: "Tool calling works." });
    expect(result.steps.find((s) => s.id === "temperature")).toMatchObject({ ok: true });
    // The exact chat-path settings went on the wire.
    expect(stub.chatBodies).toHaveLength(2);
    expect(stub.chatBodies[0]).toMatchObject({ model: "qwen3:8b", temperature: 0.3, reasoning_effort: "none" });
    expect(JSON.stringify(stub.chatBodies[0]!.tools)).toContain("setup_check_ping");
    expect(stub.urls[0]).toBe(`${LOCAL_URL}/models`);
    // Health follows the check; no conversation is stored; the (zero) cost is recorded.
    const [health] = await db.select().from(localModelHealth).where(eq(localModelHealth.companyId, companyId));
    expect(health).toMatchObject({ status: "ready", model: "qwen3:8b" });
    expect(await db.select().from(laneAConversations)).toHaveLength(0);
    const costs = await db.select().from(costEvents).where(eq(costEvents.agentId, agentId));
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({ provider: "local", model: "qwen3:8b", inputTokens: 260, outputTokens: 12 });
  });

  it("an unreachable local model server: plain words, health set to unreachable, no cost", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, { laneAProvider: "local", laneAModel: "qwen3:8b", laneABaseUrl: LOCAL_URL });
    const stub = stubProvider([new TypeError("fetch failed: connect ECONNREFUSED")]);

    const result = await (await service(stub.providerFetch)).checkSetup({ companyId, agentId, target: "main" });

    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/Could not reach the model server at http:\/\/office-pc/);
    expect(result.steps.find((s) => s.id === "reachable")).toMatchObject({ ok: false });
    expect(result.costCents).toBe(0);
    const [health] = await db.select().from(localModelHealth).where(eq(localModelHealth.companyId, companyId));
    expect(health).toMatchObject({ status: "unreachable" });
    expect(await db.select().from(costEvents)).toHaveLength(0);
  });

  it("a key the provider refuses: the key step fails", async () => {
    const companyId = await seedCompany();
    const key = await seedKey(companyId, `sk-or-v1-${randomUUID()}`);
    const agentId = await seedAgent(companyId, { laneAProvider: "openrouter", laneAModel: "qwen/qwen3-14b" }, { apiKey: key });
    const stub = stubProvider([{ status: 401, body: { error: { message: "No auth credentials found" } } }]);

    const result = await (await service(stub.providerFetch)).checkSetup({ companyId, agentId, target: "main" });

    expect(result.ok).toBe(false);
    expect(result.summary).toBe("OpenRouter refused the key. Pick the right key, or replace it under Connections.");
    expect(result.steps.find((s) => s.id === "key")).toMatchObject({ ok: false });
    expect(stub.authHeaders[0]).toMatch(/^Bearer sk-or-v1-/);
  });

  it("no key at all: says so without calling anything", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, { laneAProvider: "openrouter", laneAModel: "qwen/qwen3-14b" });
    const stub = stubProvider([]);

    const result = await (await service(stub.providerFetch)).checkSetup({ companyId, agentId, target: "main" });

    expect(result.ok).toBe(false);
    expect(result.steps.find((s) => s.id === "key")).toMatchObject({ ok: false, text: expect.stringMatching(/no OpenRouter key/) });
    expect(stub.providerFetch).not.toHaveBeenCalled();
  });

  it("a model the local server does not have: model step fails, health says model_missing", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, { laneAProvider: "local", laneAModel: "llama9:70b", laneABaseUrl: LOCAL_URL });
    const stub = stubProvider([{ status: 404, body: { error: { message: 'model "llama9:70b" not found, try pulling it first' } } }]);

    const result = await (await service(stub.providerFetch)).checkSetup({ companyId, agentId, target: "main" });

    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/does not have "llama9:70b".*ollama pull llama9:70b/);
    expect(result.steps.find((s) => s.id === "model")).toMatchObject({ ok: false });
    const [health] = await db.select().from(localModelHealth).where(eq(localModelHealth.companyId, companyId));
    expect(health).toMatchObject({ status: "model_missing" });
  });

  it("a host that refuses tools: retried without tools, answers, but tool calling is reported as not working", async () => {
    const companyId = await seedCompany();
    const key = await seedKey(companyId, `sk-or-v1-${randomUUID()}`);
    const agentId = await seedAgent(companyId, { laneAProvider: "openrouter", laneAModel: "some/model" }, { apiKey: key });
    const stub = stubProvider([
      { status: 400, body: { error: { message: "This model does not support tool use" } } },
      textReply("OK", 0.000015),
    ]);

    const result = await (await service(stub.providerFetch)).checkSetup({ companyId, agentId, target: "main" });

    expect(result.ok).toBe(false);
    expect(result.toolCalling).toBe("not_supported");
    expect(result.summary).toBe("It answers, but tool calling does not work with it.");
    expect(stub.chatBodies[1]!.tools).toBeUndefined();
    expect(result.costMicroUsd).toBe(15);
    expect(result.steps.find((s) => s.id === "cost")!.text).toMatch(/Cost of this check/);
  });

  it("checks a backup with the agent's key for the backup's provider, not the main key", async () => {
    const companyId = await seedCompany();
    const orValue = `sk-or-v1-${randomUUID()}`;
    const orKey = await seedKey(companyId, orValue);
    const backup: LaneABackupModelConfig = { id: "bk_or", provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct" };
    const agentId = await seedAgent(
      companyId,
      { laneAProvider: "local", laneAModel: "qwen3:8b", laneABaseUrl: LOCAL_URL, laneABackupModels: [backup] },
      { apiKeyByProvider: { openrouter: orKey } },
    );
    const stub = stubProvider([toolCallReply(), textReply("OK")]);

    const result = await (await service(stub.providerFetch)).checkSetup({ companyId, agentId, target: { backupId: "bk_or" } });

    expect(result.ok).toBe(true);
    expect(result.provider).toBe("openrouter");
    expect(result.model).toBe("meta-llama/llama-3.3-70b-instruct");
    expect(stub.urls.every((u) => u.startsWith("https://openrouter.ai/"))).toBe(true);
    expect(stub.authHeaders[0]).toBe(`Bearer ${orValue}`);
    expect(result.costMicroUsd).toBe(30);
  });

  it("an unknown backup or another company's agent is not found", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany("Other");
    const agentId = await seedAgent(companyId, { laneAProvider: "local", laneAModel: "qwen3:8b", laneABaseUrl: LOCAL_URL });
    const stub = stubProvider([]);
    const svc = await service(stub.providerFetch);

    await expect(svc.checkSetup({ companyId, agentId, target: { backupId: "nope" } })).rejects.toMatchObject({ status: 404 });
    await expect(svc.checkSetup({ companyId: otherCompanyId, agentId, target: "main" })).rejects.toMatchObject({ status: 404 });
    expect(stub.providerFetch).not.toHaveBeenCalled();
  });

  it("Refresh status records Installed / Not installed / Offline for saved setups and agents at that address", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, { laneAProvider: "local", laneAModel: "qwen3:8b", laneABaseUrl: LOCAL_URL });
    await db.insert(modelDirectoryEntries).values({ companyId, name: "Llama", provider: "local", model: "llama3.2", baseUrl: LOCAL_URL });
    const { modelHealthService } = await import("../services/model-health.ts");
    const health = modelHealthService(db);

    expect(await health.recordLocalSync(companyId, "http://OFFICE-PC.tailnet.example:11434/", ["qwen3:8b", "mistral:latest"])).toEqual({ recorded: 2 });
    let rows = await db.select().from(localModelHealth).where(eq(localModelHealth.companyId, companyId));
    expect(Object.fromEntries(rows.map((r) => [r.model, r.status]))).toEqual({ "qwen3:8b": "ready", "llama3.2": "model_missing" });

    await health.recordLocalSync(companyId, LOCAL_URL, null);
    rows = await db.select().from(localModelHealth).where(eq(localModelHealth.companyId, companyId));
    expect(rows.every((r) => r.status === "unreachable")).toBe(true);
  });
});
