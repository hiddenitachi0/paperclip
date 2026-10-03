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
  costEvents,
  createDb,
  laneAConversations,
  laneAMessages,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { laneAService, isLaneATemperatureUnsupportedError } from "../services/lane-a.ts";
import { LaneAProviderError, type LaneAModelClient } from "../services/lane-a-providers.ts";

// Quick-agent "creativity" (sampling temperature), against a real database:
//
//   1. the value saved on the agent round-trips through the agent service;
//   2. chat and transform send it (read off the agent row, not from the
//      caller) as `temperature` to an OpenAI-compatible host, and send no
//      `temperature` key at all when it is not set;
//   3. a Claude model that takes a temperature gets it clamped to 0-1, and
//      one that removed sampling parameters (Sonnet 5, Opus 5) gets none;
//   4. a host that refuses the parameter still answers: the call is repeated
//      once without it.

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping quick-agent creativity tests: ${support.reason ?? "unsupported environment"}`);
}

function completionResponse(text: string) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function recordingFetch(respond?: (body: Record<string, unknown>) => Response | null) {
  const bodies: Array<Record<string, unknown>> = [];
  const impl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "GET") return new Response("{}"); // local model reachability check (#536)
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    return respond?.(body) ?? completionResponse("Hei!");
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

function fakeClaude() {
  const create = vi.fn(async () => ({
    content: [{ type: "text", text: "Hei fra Claude" }],
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: "end_turn",
  }));
  return { client: { messages: { create } } as unknown as LaneAModelClient, create };
}

d("quick-agent creativity (sampling temperature)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const tmpDir = path.join(os.tmpdir(), `paperclip-lane-a-temperature-${randomUUID()}`);

  vi.setConfig({ testTimeout: 60_000 });

  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("lane-a-temperature");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);

  afterEach(async () => {
    await db.delete(laneAMessages);
    await db.delete(laneAConversations);
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Creativity",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  /**
   * A quick agent whose temperature lives only on its row. The returned
   * target deliberately leaves laneATemperature out, the way an older caller
   * would, so the tests prove the service reads it off the row.
   */
  async function seedQuickAgent(
    companyId: string,
    input: { provider?: string | null; model?: string | null; baseUrl?: string | null; temperature?: number | null },
  ) {
    const created = await agentService(db).create(companyId, {
      name: "Front desk",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
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
        laneATemperature: input.temperature ?? null,
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

  const localMistral = {
    provider: "local",
    model: "mistralai/mistral-small-3.2-24b-instruct",
    baseUrl: "http://localhost:11434/v1",
  };

  it("round-trips the saved value through the agent service, and clears back to null", async () => {
    const companyId = await seedCompany();
    const target = await seedQuickAgent(companyId, localMistral);

    await agentService(db).update(target.id, { laneATemperature: 0.9 });
    expect((await agentService(db).getById(target.id))?.laneATemperature).toBe(0.9);

    await agentService(db).update(target.id, { laneATemperature: null });
    expect((await agentService(db).getById(target.id))?.laneATemperature).toBeNull();
  });

  it("chat sends the agent's temperature, read off its row, to an OpenAI-compatible host", async () => {
    const companyId = await seedCompany();
    const target = await seedQuickAgent(companyId, { ...localMistral, temperature: 0.9 });
    const fetcher = recordingFetch();

    const result = await laneAService(db, { providerFetch: fetcher.impl }).sendMessage({
      companyId,
      targetAgent: target,
      requester: { userId: "filip", agentId: null },
      message: "hei",
    });

    expect(result.response).toBe("Hei!");
    expect(fetcher.bodies).toHaveLength(1);
    expect(fetcher.bodies[0]!.temperature).toBe(0.9);
  });

  it("chat sends no temperature key at all when none is set (the host's default, as before)", async () => {
    const companyId = await seedCompany();
    const target = await seedQuickAgent(companyId, localMistral);
    const fetcher = recordingFetch();

    await laneAService(db, { providerFetch: fetcher.impl }).sendMessage({
      companyId,
      targetAgent: target,
      requester: { userId: "filip", agentId: null },
      message: "hei",
    });

    expect(fetcher.bodies).toHaveLength(1);
    expect(Object.hasOwn(fetcher.bodies[0]!, "temperature")).toBe(false);
  });

  it("chat sends the temperature alongside the tools (only the retry drops it)", async () => {
    const companyId = await seedCompany();
    const target = await seedQuickAgent(companyId, {
      provider: "local",
      model: localMistral.model,
      baseUrl: localMistral.baseUrl,
      temperature: 0.9,
    });
    const fetcher = recordingFetch();
    await laneAService(db, { providerFetch: fetcher.impl }).sendMessage({
      companyId,
      targetAgent: target,
      requester: { userId: "filip", agentId: null },
      message: "hei",
    });
    expect(fetcher.bodies[0]!.temperature).toBe(0.9);
    expect(Array.isArray(fetcher.bodies[0]!.tools)).toBe(true);
  });

  it("transform sends it too", async () => {
    const companyId = await seedCompany();
    const target = await seedQuickAgent(companyId, { ...localMistral, temperature: 1.2 });
    const fetcher = recordingFetch();

    const result = await laneAService(db, { providerFetch: fetcher.impl }).transform({
      companyId,
      targetAgent: target,
      input: "Stol i eik.",
    });

    expect(result.text).toBe("Hei!");
    expect(fetcher.bodies).toHaveLength(1);
    expect(fetcher.bodies[0]!.temperature).toBe(1.2);
  });

  it("a host that refuses the temperature still answers: repeated once without it, in chat and transform", async () => {
    const companyId = await seedCompany();
    const target = await seedQuickAgent(companyId, { ...localMistral, temperature: 0.6 });
    const refuseTemperature = (body: Record<string, unknown>) =>
      Object.hasOwn(body, "temperature")
        ? new Response(
            JSON.stringify({ error: { message: "Unsupported value: 'temperature' does not support 0.6 with this model." } }),
            { status: 400, headers: { "content-type": "application/json" } },
          )
        : null;

    const chatFetch = recordingFetch(refuseTemperature);
    const chat = await laneAService(db, { providerFetch: chatFetch.impl }).sendMessage({
      companyId,
      targetAgent: target,
      requester: { userId: "filip", agentId: null },
      message: "hei",
    });
    expect(chat.response).toBe("Hei!");
    expect(chatFetch.bodies).toHaveLength(2);
    expect(chatFetch.bodies[0]!.temperature).toBe(0.6);
    expect(Object.hasOwn(chatFetch.bodies[1]!, "temperature")).toBe(false);
    // Tools were still offered on the retry: only the temperature was dropped.
    expect(Array.isArray(chatFetch.bodies[1]!.tools)).toBe(true);

    const transformFetch = recordingFetch(refuseTemperature);
    const transform = await laneAService(db, { providerFetch: transformFetch.impl }).transform({
      companyId,
      targetAgent: target,
      input: "Stol i eik.",
    });
    expect(transform.text).toBe("Hei!");
    expect(transformFetch.bodies).toHaveLength(2);
    expect(Object.hasOwn(transformFetch.bodies[1]!, "temperature")).toBe(false);
  });

  it("Claude Haiku gets the value clamped to Claude's 0-1 range", async () => {
    const companyId = await seedCompany();
    const target = await seedQuickAgent(companyId, { model: "claude-haiku-4-5", temperature: 1.2 });
    const claude = fakeClaude();

    const result = await laneAService(db, { createModelClient: () => claude.client }).sendMessage({
      companyId,
      targetAgent: target,
      requester: { userId: "filip", agentId: null },
      message: "hei",
    });

    expect(result.response).toBe("Hei fra Claude");
    expect(claude.create).toHaveBeenCalledTimes(1);
    expect((claude.create.mock.calls[0] as unknown[])[0]).toMatchObject({ model: "claude-haiku-4-5", temperature: 1 });
  });

  it("Claude Sonnet 5 (the default) gets no temperature: it removed sampling parameters and would refuse the call", async () => {
    const companyId = await seedCompany();
    const target = await seedQuickAgent(companyId, { temperature: 0.9 });
    const claude = fakeClaude();

    await laneAService(db, { createModelClient: () => claude.client }).sendMessage({
      companyId,
      targetAgent: target,
      requester: { userId: "filip", agentId: null },
      message: "hei",
    });

    const sent = (claude.create.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(sent.model).toBe("claude-sonnet-5");
    expect(Object.hasOwn(sent, "temperature")).toBe(false);
  });
});

describe("isLaneATemperatureUnsupportedError", () => {
  const refused = (message: string, status = 400) =>
    isLaneATemperatureUnsupportedError(new LaneAProviderError({ kind: "upstream", provider: "openai", status, message }));

  it("recognises a refusal that names the temperature, and nothing else", () => {
    expect(refused("OpenAI answered 400: Unsupported value: 'temperature' does not support 0.2 with this model.")).toBe(true);
    expect(refused("temperature: This model does not support sampling parameters.")).toBe(true);
    expect(
      refused("OpenRouter answered 404: No endpoints found that can handle the requested parameters.", 404),
    ).toBe(true);
    expect(refused("OpenAI answered 400: The requested model 'gpt-9' does not exist.")).toBe(false);
    expect(refused("OpenAI answered 503: overloaded (temperature of the GPUs too high)", 503)).toBe(false);
    expect(isLaneATemperatureUnsupportedError(new Error("temperature"))).toBe(false);
  });
});
