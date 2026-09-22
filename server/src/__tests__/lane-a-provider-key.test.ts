import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
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
  secretAccessEvents,
} from "@paperclipai/db";
import { LANE_A_API_KEY_CONFIG_PATH } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { secretService } from "../services/secrets.ts";

// DUR-3997 (Connections, slice 2): a quick agent runs on the provider and the
// stored company key it was given. This file proves the resolution order
// lane-a.ts implements, against a real database:
//
//   1. a company secret bound at adapterConfig.laneA.apiKey is used, through
//      the binding gate, and the read is written to secret_access_events;
//      when such a binding exists the instance key is NOT read at all;
//   2. with no binding, a Claude quick agent still uses the instance key
//      (readAnthropicApiKey) — nothing changes for existing agents;
//   3. an OpenAI-compatible provider is called with the bound key as a bearer
//      token, and its cost row is stamped with that provider, never
//      "anthropic";
//   4. a quick agent on OpenAI with no key is refused in plain words, before
//      anything is called or billed;
//   5. the resolved key never lands in process.env, nor in the environment of
//      a child process started afterwards (DUR-3994).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Lane A provider-key tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type FreshLaneA = typeof import("../services/lane-a.ts");

function completionResponse(text: string, usage = { prompt_tokens: 2_000_000, completion_tokens: 500_000 }) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describeEmbeddedPostgres("lane A provider key resolution (DUR-3997)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousApiKey = process.env.ANTHROPIC_API_KEY;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-lane-a-provider-key-${randomUUID()}`);

  // Several tests below re-import lane-a.ts after vi.resetModules() so a mocked
  // SDK is picked up. The first transform of that module graph is slow on a
  // cold cache, and slower still while other embedded-Postgres suites load,
  // so it is warmed here once (the transform cache survives resetModules) and
  // the per-test budget is raised above vitest's 5s default.
  vi.setConfig({ testTimeout: 60_000 });

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("lane-a-provider-key");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    await import("../services/lane-a.ts");
  }, 90_000);

  afterEach(async () => {
    vi.doUnmock("@anthropic-ai/sdk");
    vi.doUnmock("../env-values.js");
    vi.resetModules();
    await db.delete(laneAMessages);
    await db.delete(laneAConversations);
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
    if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousApiKey;
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany(name = "Nordstrand") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedSecret(companyId: string, value: string) {
    return secretService(db).create(companyId, {
      name: `provider-key-${randomUUID()}`,
      provider: "local_encrypted",
      value,
    });
  }

  async function seedQuickAgent(
    companyId: string,
    input: {
      provider?: string | null;
      model?: string | null;
      baseUrl?: string | null;
      keySecretId?: string | null;
    } = {},
  ) {
    const created = await agentService(db).create(companyId, {
      name: "Front desk",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: input.keySecretId
        ? { laneA: { apiKey: { type: "secret_ref", secretId: input.keySecretId, version: "latest" } } }
        : {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    await db
      .update(agents)
      .set({
        laneAEnabled: true,
        laneAProvider: input.provider ?? null,
        laneAModel: input.model ?? null,
        laneABaseUrl: input.baseUrl ?? null,
      })
      .where(eq(agents.id, created.id));
    return {
      id: created.id,
      companyId,
      name: created.name,
      laneAEnabled: true,
      laneAProvider: input.provider ?? null,
      laneAModel: input.model ?? null,
      laneABaseUrl: input.baseUrl ?? null,
    };
  }

  /**
   * A fresh lane-a module with the Anthropic SDK replaced by a class that
   * records what it was constructed with, and the instance-key reader replaced
   * by a spy. Both mocks apply to the dynamic import that follows them.
   */
  async function loadLaneAWithFakes(input: { readInstanceKey: () => string | undefined }) {
    const constructed: Array<Record<string, unknown>> = [];
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "hello there" }],
      usage: { input_tokens: 100, output_tokens: 50 },
      stop_reason: "end_turn",
    });
    vi.doMock("@anthropic-ai/sdk", async () => {
      const actual = await vi.importActual<typeof import("@anthropic-ai/sdk")>("@anthropic-ai/sdk");
      const RealDefault = (actual as { default: typeof actual.default }).default;
      class FakeAnthropic {
        static AuthenticationError = RealDefault.AuthenticationError;
        static RateLimitError = RealDefault.RateLimitError;
        static APIError = RealDefault.APIError;
        messages = { create: mockCreate };
        constructor(opts: Record<string, unknown>) {
          constructed.push(opts);
        }
      }
      return { ...actual, default: FakeAnthropic };
    });
    const readAnthropicApiKey = vi.fn(input.readInstanceKey);
    vi.doMock("../env-values.js", async () => {
      const actual = await vi.importActual<typeof import("../env-values.js")>("../env-values.js");
      return { ...actual, readAnthropicApiKey };
    });
    vi.resetModules();
    const laneA: FreshLaneA = await import("../services/lane-a.ts");
    return { laneA, constructed, mockCreate, readAnthropicApiKey };
  }

  it("uses the bound company secret for Claude, audits the read, and never asks for the instance key", async () => {
    const companyId = await seedCompany();
    const boundValue = `sk-ant-company-${randomUUID()}`;
    const secret = await seedSecret(companyId, boundValue);
    const target = await seedQuickAgent(companyId, { keySecretId: secret.id });
    const instanceCanary = `sk-ant-instance-${randomUUID()}`;
    process.env.ANTHROPIC_API_KEY = instanceCanary;
    const { laneA, constructed, readAnthropicApiKey } = await loadLaneAWithFakes({
      readInstanceKey: () => instanceCanary,
    });

    const result = await laneA.laneAService(db).sendMessage({
      companyId,
      targetAgent: target,
      requester: { userId: "filip", agentId: null },
      actor: { type: "board", userId: "filip", companyIds: [companyId], source: "local_implicit" } as never,
      message: "hi",
    });

    expect(result.response).toBe("hello there");
    expect(constructed).toEqual([{ apiKey: boundValue }]);
    expect(readAnthropicApiKey).not.toHaveBeenCalled();

    // The read went through the binding gate and is on record, named by the
    // agent and the path it was bound at — the value itself is nowhere.
    const audit = await db
      .select()
      .from(secretAccessEvents)
      .where(and(eq(secretAccessEvents.companyId, companyId), eq(secretAccessEvents.secretId, secret.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      consumerType: "agent",
      consumerId: target.id,
      configPath: LANE_A_API_KEY_CONFIG_PATH,
      outcome: "success",
      actorType: "user",
      actorId: "filip",
    });

    const [cost] = await db.select().from(costEvents).where(eq(costEvents.companyId, companyId));
    expect(cost).toMatchObject({ provider: "anthropic", biller: "anthropic", model: "claude-sonnet-5" });
  });

  it("with no binding, a Claude quick agent still runs on the instance key exactly as before", async () => {
    const companyId = await seedCompany();
    const target = await seedQuickAgent(companyId);
    const instanceKey = `sk-ant-instance-${randomUUID()}`;
    const { laneA, constructed, readAnthropicApiKey } = await loadLaneAWithFakes({
      readInstanceKey: () => instanceKey,
    });

    const result = await laneA.laneAService(db).sendMessage({
      companyId,
      targetAgent: target,
      requester: { userId: "filip", agentId: null },
      message: "hi",
    });

    expect(result.response).toBe("hello there");
    expect(readAnthropicApiKey).toHaveBeenCalledTimes(1);
    expect(constructed).toEqual([{ apiKey: instanceKey }]);
    expect(await db.select().from(secretAccessEvents)).toHaveLength(0);
  });

  it("refuses a bound secret that is no longer usable, without falling back to the instance key", async () => {
    const companyId = await seedCompany();
    const secret = await seedSecret(companyId, `sk-ant-company-${randomUUID()}`);
    const target = await seedQuickAgent(companyId, { keySecretId: secret.id });
    // The binding row is what gates resolution; without it the secret may not be read.
    await db.delete(companySecretBindings).where(eq(companySecretBindings.secretId, secret.id));
    const { laneA, constructed, readAnthropicApiKey } = await loadLaneAWithFakes({
      readInstanceKey: () => "sk-ant-instance-should-not-be-used",
    });

    await expect(
      laneA.laneAService(db).sendMessage({
        companyId,
        targetAgent: target,
        requester: { userId: "filip", agentId: null },
        message: "hi",
      }),
    ).rejects.toMatchObject({ status: 503, details: { code: "LANE_A_KEY_UNRESOLVED" } });
    expect(constructed).toHaveLength(0);
    expect(readAnthropicApiKey).not.toHaveBeenCalled();
    expect(await db.select().from(costEvents)).toHaveLength(0);
  });

  it("calls OpenAI with the bound key as a bearer token and stamps the cost with the provider", async () => {
    const companyId = await seedCompany();
    const boundValue = `sk-proj-${randomUUID()}`;
    const secret = await seedSecret(companyId, boundValue);
    const target = await seedQuickAgent(companyId, {
      provider: "openai",
      model: "gpt-4.1-mini",
      keySecretId: secret.id,
    });
    process.env.ANTHROPIC_API_KEY = "sk-ant-instance-must-not-be-used";
    const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const providerFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: (init?.headers as Record<string, string>) ?? {},
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return completionResponse("Hei fra OpenAI");
    }) as unknown as typeof fetch;
    const { laneAService } = await import("../services/lane-a.ts");

    const result = await laneAService(db, { providerFetch }).sendMessage({
      companyId,
      targetAgent: target,
      requester: { userId: "filip", agentId: null },
      message: "hi",
    });

    expect(result.response).toBe("Hei fra OpenAI");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${boundValue}`);
    expect(calls[0]!.body.model).toBe("gpt-4.1-mini");
    expect(calls[0]!.body.max_completion_tokens).toBe(2048);

    // 2M input at $0.40/M + 0.5M output at $1.60/M = $1.60 = 160 cents, at
    // OpenAI's price — not Sonnet's, and stamped as OpenAI.
    const [cost] = await db.select().from(costEvents).where(eq(costEvents.companyId, companyId));
    expect(cost).toMatchObject({
      provider: "openai",
      biller: "openai",
      model: "gpt-4.1-mini",
      inputTokens: 2_000_000,
      outputTokens: 500_000,
      costCents: 160,
    });
    const audit = await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.secretId, secret.id));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ consumerId: target.id, configPath: LANE_A_API_KEY_CONFIG_PATH, outcome: "success" });

    // DUR-3994: the key was used for the call and nothing else. It is not in
    // this process's environment, and a child started now cannot see it.
    expect(Object.values(process.env)).not.toContain(boundValue);
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        "process.stdout.write(Object.values(process.env).some((v) => v === process.argv[1]) ? 'present' : 'absent')",
        boundValue,
      ],
      { env: process.env, encoding: "utf8" },
    );
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("absent");
  });

  it("runs a transform on OpenRouter with a free-form model, costed at 0 because no price is known", async () => {
    const companyId = await seedCompany();
    const boundValue = `sk-or-v1-${randomUUID()}`;
    const secret = await seedSecret(companyId, boundValue);
    const target = await seedQuickAgent(companyId, {
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b-instruct",
      keySecretId: secret.id,
    });
    const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const providerFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: (init?.headers as Record<string, string>) ?? {},
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return completionResponse("Ny tekst.", { prompt_tokens: 1000, completion_tokens: 200 });
    }) as unknown as typeof fetch;
    const { laneAService } = await import("../services/lane-a.ts");

    const result = await laneAService(db, { providerFetch }).transform({
      companyId,
      targetAgent: target,
      input: "Gammel tekst.",
    });

    expect(result).toMatchObject({
      text: "Ny tekst.",
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b-instruct",
      costCents: 0,
    });
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${boundValue}`);
    expect(calls[0]!.body.max_tokens).toBe(2048);
    expect(Object.hasOwn(calls[0]!.body, "tools")).toBe(false);
    const [cost] = await db.select().from(costEvents).where(eq(costEvents.companyId, companyId));
    expect(cost).toMatchObject({ provider: "openrouter", biller: "openrouter", costCents: 0, billingCode: "lane_a_transform" });
  });

  it("refuses a quick agent on OpenAI with no key, in plain words, before anything is called or billed", async () => {
    const companyId = await seedCompany();
    const target = await seedQuickAgent(companyId, { provider: "openai" });
    process.env.ANTHROPIC_API_KEY = "sk-ant-instance-must-not-be-used";
    const providerFetch = vi.fn() as unknown as typeof fetch;
    const { laneAService } = await import("../services/lane-a.ts");

    await expect(
      laneAService(db, { providerFetch }).sendMessage({
        companyId,
        targetAgent: target,
        requester: { userId: "filip", agentId: null },
        message: "hi",
      }),
    ).rejects.toMatchObject({
      status: 503,
      message: "This quick agent has no OpenAI key. Add one under Connections.",
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await db.select().from(costEvents)).toHaveLength(0);
  });

  it("refuses a local model with no address, and OpenRouter with no model picked", async () => {
    const companyId = await seedCompany();
    const { laneAService } = await import("../services/lane-a.ts");
    const noAddress = await seedQuickAgent(companyId, { provider: "local", model: "llama3.1" });
    await expect(
      laneAService(db).sendMessage({
        companyId,
        targetAgent: noAddress,
        requester: { userId: "filip", agentId: null },
        message: "hi",
      }),
    ).rejects.toMatchObject({ status: 503, details: { code: "LANE_A_BASE_URL_MISSING" } });

    const noModel = await seedQuickAgent(companyId, { provider: "openrouter" });
    await expect(
      laneAService(db).sendMessage({
        companyId,
        targetAgent: noModel,
        requester: { userId: "filip", agentId: null },
        message: "hi",
      }),
    ).rejects.toMatchObject({ status: 503, details: { code: "LANE_A_MODEL_MISSING" } });
  });

  it("reads the provider off the agent row when the caller did not pass it", async () => {
    const companyId = await seedCompany();
    const secret = await seedSecret(companyId, `sk-proj-${randomUUID()}`);
    const seeded = await seedQuickAgent(companyId, {
      provider: "openai",
      model: "gpt-4.1",
      keySecretId: secret.id,
    });
    const providerFetch = vi.fn(async () => completionResponse("ok")) as unknown as typeof fetch;
    const { laneAService } = await import("../services/lane-a.ts");

    // A caller that copied only the pre-DUR-3997 fields.
    const result = await laneAService(db, { providerFetch }).sendMessage({
      companyId,
      targetAgent: { id: seeded.id, companyId, name: seeded.name, laneAEnabled: true },
      requester: { userId: "filip", agentId: null },
      message: "hi",
    });
    expect(result.response).toBe("ok");
    expect(providerFetch).toHaveBeenCalledTimes(1);
    const [cost] = await db.select().from(costEvents).where(eq(costEvents.companyId, companyId));
    expect(cost).toMatchObject({ provider: "openai", model: "gpt-4.1" });
  });
});
