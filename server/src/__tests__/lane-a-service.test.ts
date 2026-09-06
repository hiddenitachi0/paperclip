import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  companyMcpTools,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  costEvents,
  createDb,
  laneAConversations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { secretService } from "../services/secrets.ts";
import { createMcpTool } from "../services/mcp-tool-library.ts";
import {
  LANE_A_MAX_DAILY_TURNS_PER_EMPLOYEE,
  LANE_A_MAX_TOOL_CALLS,
  LANE_A_MAX_TURNS_PER_CONVERSATION,
  laneAService,
  type LaneATargetAgent,
} from "../services/lane-a.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Lane A service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("lane A service", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousApiKey = process.env.ANTHROPIC_API_KEY;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("lane-a-service");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(laneAConversations);
    await db.delete(costEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(companyMcpTools);
    await db.delete(agents);
    await db.delete(companies);
    if (previousApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previousApiKey;
    }
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany(name = "Paperclip") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, laneAEnabled: boolean, name = "Agent") {
    const created = await agentService(db).create(companyId, {
      name,
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    if (laneAEnabled) {
      await db.update(agents).set({ laneAEnabled: true }).where(eq(agents.id, created.id));
    }
    const target: LaneATargetAgent = {
      id: created.id,
      companyId,
      name: created.name,
      laneAEnabled,
    };
    return target;
  }

  it("rejects a message when the target agent has Lane A disabled", async () => {
    const companyId = await seedCompany();
    const target = await seedAgent(companyId, false);

    await expect(
      laneAService(db).sendMessage({
        companyId,
        targetAgent: target,
        requester: { userId: "user-1", agentId: null },
        message: "hi",
      }),
    ).rejects.toMatchObject({ status: 403 });

    const rows = await db.select().from(laneAConversations);
    expect(rows).toHaveLength(0);
  });

  it("returns 503 without creating a cost event or advancing turnCount when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const companyId = await seedCompany();
    const target = await seedAgent(companyId, true);

    await expect(
      laneAService(db).sendMessage({
        companyId,
        targetAgent: target,
        requester: { userId: "user-1", agentId: null },
        message: "hi",
      }),
    ).rejects.toMatchObject({ status: 503 });

    const rows = await db.select().from(laneAConversations);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.turnCount).toBe(0);
  });

  it("forces company_id from the parent agent via the DB trigger regardless of caller input", async () => {
    const companyA = await seedCompany("Company A");
    const companyB = await seedCompany("Company B");
    const target = await seedAgent(companyA, true);

    const [inserted] = await db
      .insert(laneAConversations)
      .values({
        // Caller-supplied companyId deliberately mismatches the agent's real company.
        companyId: companyB,
        agentId: target.id,
        requestedByUserId: "user-1",
      })
      .returning();

    expect(inserted?.companyId).toBe(companyA);
  });

  it("rejects a conversationId belonging to a different agent", async () => {
    const companyId = await seedCompany();
    const targetA = await seedAgent(companyId, true, "Agent A");
    const targetB = await seedAgent(companyId, true, "Agent B");

    const [conversation] = await db
      .insert(laneAConversations)
      .values({ companyId, agentId: targetA.id, requestedByUserId: "user-1" })
      .returning();

    await expect(
      laneAService(db).sendMessage({
        companyId,
        targetAgent: targetB,
        requester: { userId: "user-1", agentId: null },
        message: "hi",
        conversationId: conversation!.id,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects a conversationId that has gone idle", async () => {
    const companyId = await seedCompany();
    const target = await seedAgent(companyId, true);

    const [conversation] = await db
      .insert(laneAConversations)
      .values({
        companyId,
        agentId: target.id,
        requestedByUserId: "user-1",
        lastMessageAt: new Date(Date.now() - 60 * 60 * 1000),
      })
      .returning();

    await expect(
      laneAService(db).sendMessage({
        companyId,
        targetAgent: target,
        requester: { userId: "user-1", agentId: null },
        message: "hi",
        conversationId: conversation!.id,
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "LANE_A_CONVERSATION_EXPIRED" } });
  });

  it("rejects a conversationId that has reached the per-conversation turn cap", async () => {
    const companyId = await seedCompany();
    const target = await seedAgent(companyId, true);

    const [conversation] = await db
      .insert(laneAConversations)
      .values({
        companyId,
        agentId: target.id,
        requestedByUserId: "user-1",
        turnCount: LANE_A_MAX_TURNS_PER_CONVERSATION,
      })
      .returning();

    await expect(
      laneAService(db).sendMessage({
        companyId,
        targetAgent: target,
        requester: { userId: "user-1", agentId: null },
        message: "hi",
        conversationId: conversation!.id,
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "LANE_A_TURN_CAP_REACHED" } });
  });

  it("rejects a new message once the requester's persisted daily turn total is at the cap", async () => {
    const companyId = await seedCompany();
    const target = await seedAgent(companyId, true);

    await db.insert(laneAConversations).values({
      companyId,
      agentId: target.id,
      requestedByUserId: "user-1",
      turnCount: LANE_A_MAX_DAILY_TURNS_PER_EMPLOYEE,
    });

    await expect(
      laneAService(db).sendMessage({
        companyId,
        targetAgent: target,
        requester: { userId: "user-1", agentId: null },
        message: "hi",
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "LANE_A_DAILY_CAP_REACHED" } });

    // A different requester against the same agent is unaffected.
    delete process.env.ANTHROPIC_API_KEY;
    await expect(
      laneAService(db).sendMessage({
        companyId,
        targetAgent: target,
        requester: { userId: "user-2", agentId: null },
        message: "hi",
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("completes a turn end-to-end: writes a cost event and advances turnCount", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const companyId = await seedCompany();
    const target = await seedAgent(companyId, true);

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
        constructor(_opts: unknown) {}
      }
      return { ...actual, default: FakeAnthropic };
    });
    vi.resetModules();
    const { laneAService: freshLaneAService } = await import("../services/lane-a.ts");

    const result = await freshLaneAService(db).sendMessage({
      companyId,
      targetAgent: target,
      requester: { userId: "user-1", agentId: null },
      message: "hi",
    });

    expect(result.response).toBe("hello there");
    expect(result.turnCount).toBe(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);

    const [conversation] = await db
      .select()
      .from(laneAConversations)
      .where(eq(laneAConversations.id, result.conversationId));
    expect(conversation?.turnCount).toBe(1);

    vi.doUnmock("@anthropic-ai/sdk");
    vi.resetModules();
  });

  function mockMcpSdk(mcp: { connect: ReturnType<typeof vi.fn>; listTools: ReturnType<typeof vi.fn>; callTool: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }) {
    vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
      Client: class {
        connect = mcp.connect;
        listTools = mcp.listTools;
        callTool = mcp.callTool;
        close = mcp.close;
      },
    }));
    vi.doMock("@modelcontextprotocol/sdk/client/stdio.js", () => ({ StdioClientTransport: class {} }));
    vi.doMock("@modelcontextprotocol/sdk/client/sse.js", () => ({ SSEClientTransport: class {} }));
    vi.doMock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({ StreamableHTTPClientTransport: class {} }));
  }

  function unmockMcpSdk() {
    vi.doUnmock("@modelcontextprotocol/sdk/client/index.js");
    vi.doUnmock("@modelcontextprotocol/sdk/client/stdio.js");
    vi.doUnmock("@modelcontextprotocol/sdk/client/sse.js");
    vi.doUnmock("@modelcontextprotocol/sdk/client/streamableHttp.js");
  }

  function mockAnthropic(mockCreate: ReturnType<typeof vi.fn>) {
    vi.doMock("@anthropic-ai/sdk", async () => {
      const actual = await vi.importActual<typeof import("@anthropic-ai/sdk")>("@anthropic-ai/sdk");
      const RealDefault = (actual as { default: typeof actual.default }).default;
      class FakeAnthropic {
        static AuthenticationError = RealDefault.AuthenticationError;
        static RateLimitError = RealDefault.RateLimitError;
        static APIError = RealDefault.APIError;
        messages = { create: mockCreate };
        constructor(_opts: unknown) {}
      }
      return { ...actual, default: FakeAnthropic };
    });
  }

  async function seedFalTool(companyId: string) {
    const secret = await secretService(db).create(companyId, {
      name: "Fal.ai API key",
      provider: "local_encrypted",
      value: `fal-key-${randomUUID()}`,
    });
    return createMcpTool(db, companyId, {
      name: "Fal.ai",
      description: "Generates images",
      connection: {
        url: "https://fal.run/mcp",
        headers: { Authorization: { type: "secret_ref", secretId: secret.id, version: "latest" } },
      },
    });
  }

  it("calls a granted Tools-library MCP tool through a capped tool-use loop", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const companyId = await seedCompany();
    const tool = await seedFalTool(companyId);
    const created = await agentService(db).create(companyId, {
      name: "Artist",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    await db.update(agents).set({ laneAEnabled: true }).where(eq(agents.id, created.id));
    await agentService(db).syncMcpToolSelection(created.id, [tool.id]);
    const target: LaneATargetAgent = {
      id: created.id,
      companyId,
      name: created.name,
      laneAEnabled: true,
      mcpToolIds: [tool.id],
    };

    const mockConnect = vi.fn().mockResolvedValue(undefined);
    const mockListTools = vi.fn().mockResolvedValue({
      tools: [{ name: "generate_image", description: "Generate an image", inputSchema: { type: "object", properties: {} } }],
    });
    const mockCallTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "https://cdn.fal/image.png" }] });
    const mockClose = vi.fn().mockResolvedValue(undefined);
    mockMcpSdk({ connect: mockConnect, listTools: mockListTools, callTool: mockCallTool, close: mockClose });

    const qualifiedToolName = `${tool.key}__generate_image`;
    const mockCreate = vi
      .fn()
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "call_1", name: qualifiedToolName, input: { prompt: "a cat" } }],
        usage: { input_tokens: 50, output_tokens: 20 },
        stop_reason: "tool_use",
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Here you go: https://cdn.fal/image.png" }],
        usage: { input_tokens: 60, output_tokens: 15 },
        stop_reason: "end_turn",
      });
    mockAnthropic(mockCreate);
    vi.resetModules();
    const { laneAService: freshLaneAService } = await import("../services/lane-a.ts");

    const result = await freshLaneAService(db).sendMessage({
      companyId,
      targetAgent: target,
      requester: { userId: "user-1", agentId: null },
      message: "generate an image of a cat",
    });

    expect(result.response).toBe("Here you go: https://cdn.fal/image.png");
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[0][0].tools).toEqual([
      expect.objectContaining({ name: qualifiedToolName }),
    ]);
    expect(mockCallTool).toHaveBeenCalledTimes(1);
    expect(mockCallTool).toHaveBeenCalledWith({ name: "generate_image", arguments: { prompt: "a cat" } });
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockClose).toHaveBeenCalledTimes(1);

    unmockMcpSdk();
    vi.doUnmock("@anthropic-ai/sdk");
    vi.resetModules();
  });

  it("caps tool executions at LANE_A_MAX_TOOL_CALLS even if the model keeps requesting more", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const companyId = await seedCompany();
    const tool = await seedFalTool(companyId);
    const created = await agentService(db).create(companyId, {
      name: "Artist",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    await db.update(agents).set({ laneAEnabled: true }).where(eq(agents.id, created.id));
    await agentService(db).syncMcpToolSelection(created.id, [tool.id]);
    const target: LaneATargetAgent = {
      id: created.id,
      companyId,
      name: created.name,
      laneAEnabled: true,
      mcpToolIds: [tool.id],
    };

    const mockCallTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    mockMcpSdk({
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [{ name: "generate_image", description: "Generate an image", inputSchema: { type: "object", properties: {} } }],
      }),
      callTool: mockCallTool,
      close: vi.fn().mockResolvedValue(undefined),
    });

    const qualifiedToolName = `${tool.key}__generate_image`;
    // The model always asks for another tool call, never stopping on its own —
    // the loop must still terminate after LANE_A_MAX_TOOL_CALLS executions.
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "tool_use", id: `call_${randomUUID()}`, name: qualifiedToolName, input: {} }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: "tool_use",
    });
    mockAnthropic(mockCreate);
    vi.resetModules();
    const { laneAService: freshLaneAService } = await import("../services/lane-a.ts");

    await freshLaneAService(db).sendMessage({
      companyId,
      targetAgent: target,
      requester: { userId: "user-1", agentId: null },
      message: "keep generating images forever",
    });

    expect(mockCallTool).toHaveBeenCalledTimes(LANE_A_MAX_TOOL_CALLS);
    expect(mockCreate).toHaveBeenCalledTimes(LANE_A_MAX_TOOL_CALLS + 1);

    unmockMcpSdk();
    vi.doUnmock("@anthropic-ai/sdk");
    vi.resetModules();
  });
});
