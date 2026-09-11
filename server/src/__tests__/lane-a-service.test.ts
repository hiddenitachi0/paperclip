import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companyMcpTools,
  companyMemberships,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
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
import { secretService } from "../services/secrets.ts";
import { createMcpTool } from "../services/mcp-tool-library.ts";
import {
  LANE_A_MAX_DAILY_TURNS_PER_EMPLOYEE,
  LANE_A_MAX_TOOL_CALLS,
  LANE_A_MAX_TURNS_PER_CONVERSATION,
  laneAService,
  type LaneATargetAgent,
} from "../services/lane-a.ts";
import { LANE_A_DEFAULT_MAX_OUTPUT_TOKENS, LANE_A_DEFAULT_MODEL } from "@paperclipai/shared";

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
    await db.delete(laneAMessages);
    await db.delete(laneAConversations);
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(companyMcpTools);
    await db.delete(agents);
    await db.delete(companyMemberships);
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
    // DUR-3977: chat runs on the agent's own model, at its own output
    // ceiling — the same numbers the transform path uses. This asserts the
    // claim rather than the comment: default here, since the seeded agent
    // sets neither.
    expect(mockCreate.mock.calls[0][0]).toMatchObject({
      model: LANE_A_DEFAULT_MODEL,
      max_tokens: LANE_A_DEFAULT_MAX_OUTPUT_TOKENS,
    });

    vi.doUnmock("@anthropic-ai/sdk");
    vi.resetModules();
  });

  it("runs a chat turn on the agent's own model, not the platform default", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const companyId = await seedCompany();
    const target = await seedAgent(companyId, true);

    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "hei" }],
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

    await freshLaneAService(db).sendMessage({
      companyId,
      targetAgent: { ...target, laneAModel: "claude-haiku-4-5", laneAMaxOutputTokens: 400 },
      requester: { userId: "user-1", agentId: null },
      message: "hei",
    });

    expect(mockCreate.mock.calls[0][0]).toMatchObject({
      model: "claude-haiku-4-5",
      max_tokens: 400,
    });

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
    // Built-in quick-agent tools ride alongside the granted Tools-library tool.
    expect(mockCreate.mock.calls[0][0].tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: qualifiedToolName }),
        expect.objectContaining({ name: "route_to_agent" }),
      ]),
    );
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

  // ─── Quick agents (round 2): instructions, memory, built-in actions ─────────

  it("stores each turn and replays the earlier transcript on the next message", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const companyId = await seedCompany();
    const target = await seedAgent(companyId, true, "Ada");
    target.role = "secretary";
    target.laneAInstructions = "Always answer in Norwegian.";

    const mockCreate = vi
      .fn()
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Hei! Jeg heter Ada." }],
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: "end_turn",
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Du spurte hva jeg heter." }],
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: "end_turn",
      });
    mockAnthropic(mockCreate);
    vi.resetModules();
    const { laneAService: freshLaneAService } = await import("../services/lane-a.ts");
    const svc = freshLaneAService(db);

    const first = await svc.sendMessage({
      companyId,
      targetAgent: target,
      requester: { userId: "user-1", agentId: null },
      message: "What is your name?",
    });
    const second = await svc.sendMessage({
      companyId,
      targetAgent: target,
      requester: { userId: "user-1", agentId: null },
      message: "What did I just ask?",
      conversationId: first.conversationId,
    });

    expect(second.turnCount).toBe(2);
    expect(second.actions).toEqual([]);
    const secondCall = mockCreate.mock.calls[1][0];
    expect(secondCall.system).toContain("You are Ada");
    expect(secondCall.system).toContain("Your role is secretary");
    expect(secondCall.system).toContain("Always answer in Norwegian.");
    expect(secondCall.messages).toEqual([
      { role: "user", content: "What is your name?" },
      { role: "assistant", content: "Hei! Jeg heter Ada." },
      { role: "user", content: "What did I just ask?" },
    ]);

    const transcript = await svc.getConversation({
      companyId,
      targetAgentId: target.id,
      conversationId: first.conversationId,
      requester: { userId: "user-1", agentId: null },
    });
    expect(transcript.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "What is your name?"],
      ["assistant", "Hei! Jeg heter Ada."],
      ["user", "What did I just ask?"],
      ["assistant", "Du spurte hva jeg heter."],
    ]);
    await expect(
      svc.getConversation({
        companyId,
        targetAgentId: target.id,
        conversationId: first.conversationId,
        requester: { userId: "someone-else", agentId: null },
      }),
    ).rejects.toMatchObject({ status: 403 });

    vi.doUnmock("@anthropic-ai/sdk");
    vi.resetModules();
  });

  it("refuses to continue another person's conversation: 403, no model call, no replay", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const companyId = await seedCompany();
    const target = await seedAgent(companyId, true, "Ada");

    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: "end_turn",
    });
    mockAnthropic(mockCreate);
    vi.resetModules();
    const { laneAService: freshLaneAService } = await import("../services/lane-a.ts");
    const svc = freshLaneAService(db);

    const alice = { userId: "alice", agentId: null };
    const mallory = { userId: "mallory", agentId: null };
    const first = await svc.sendMessage({
      companyId,
      targetAgent: target,
      requester: alice,
      message: "my secret plan is X",
    });
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // A second person in the same company holding the conversation id.
    await expect(
      svc.sendMessage({
        companyId,
        targetAgent: target,
        requester: mallory,
        message: "what was the plan?",
        conversationId: first.conversationId,
      }),
    ).rejects.toMatchObject({ status: 403 });
    // Nothing reached the model, so Alice's stored turns were never replayed.
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // Nothing was written to Alice's conversation either.
    const [conversation] = await db
      .select()
      .from(laneAConversations)
      .where(eq(laneAConversations.id, first.conversationId));
    expect(conversation?.turnCount).toBe(1);
    const stored = await db.select().from(laneAMessages).where(eq(laneAMessages.conversationId, first.conversationId));
    expect(stored.map((row) => row.content)).toEqual(["my secret plan is X", "ok"]);

    // An agent requester cannot pick up a person's conversation, and vice versa.
    await expect(
      svc.sendMessage({
        companyId,
        targetAgent: target,
        requester: { userId: null, agentId: target.id },
        message: "what was the plan?",
        conversationId: first.conversationId,
      }),
    ).rejects.toMatchObject({ status: 403 });

    // The owner can still continue it and gets the replay.
    const second = await svc.sendMessage({
      companyId,
      targetAgent: target,
      requester: alice,
      message: "what was the plan?",
      conversationId: first.conversationId,
    });
    expect(second.turnCount).toBe(2);
    expect(mockCreate.mock.calls[1][0].messages).toEqual([
      { role: "user", content: "my secret plan is X" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "what was the plan?" },
    ]);

    vi.doUnmock("@anthropic-ai/sdk");
    vi.resetModules();
  });

  it("route_to_agent runs the tasks:assign check: a member without that right gets a refusal, an operator gets a task", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const companyId = await seedCompany();
    const target = await seedAgent(companyId, true, "Ada");
    const bob = await seedAgent(companyId, false, "Bob");
    // A viewer may look but not assign; an operator may assign.
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: "viewer-1", status: "active", membershipRole: "viewer" },
      { companyId, principalType: "user", principalId: "operator-1", status: "active", membershipRole: "operator" },
    ]);

    const toolTurn = {
      content: [
        { type: "tool_use", id: "call_1", name: "route_to_agent", input: { agent: "Bob", request: "Fix the login page" } },
      ],
      usage: { input_tokens: 50, output_tokens: 20 },
      stop_reason: "tool_use",
    };
    const textTurn = (text: string) => ({
      content: [{ type: "text", text }],
      usage: { input_tokens: 60, output_tokens: 15 },
      stop_reason: "end_turn",
    });
    const mockCreate = vi
      .fn()
      .mockResolvedValueOnce(toolTurn)
      .mockResolvedValueOnce(textTurn("Sorry, I can't hand that to Bob for you."))
      .mockResolvedValueOnce(toolTurn)
      .mockResolvedValueOnce(textTurn("Done — Bob has it as DUR-12."));
    mockAnthropic(mockCreate);
    vi.resetModules();
    const { laneAService: freshLaneAService } = await import("../services/lane-a.ts");
    const createIssueForAgent = vi.fn(async () => ({ id: "issue-1", identifier: "DUR-12", status: "todo" }));
    // Only the task creation is faked; the permission decision is the real one.
    const svc = freshLaneAService(db, { toolDeps: { createIssueForAgent } });

    const denied = await svc.sendMessage({
      companyId,
      targetAgent: target,
      requester: { userId: "viewer-1", agentId: null },
      actor: { type: "board", userId: "viewer-1", companyIds: [companyId], source: "session", isInstanceAdmin: false },
      message: "Get Bob to fix the login page",
    });
    expect(denied.actions).toEqual([
      { tool: "route_to_agent", summary: "Refused to hand work to Bob: the person asking may not assign tasks to them.", ok: false },
    ]);
    expect(createIssueForAgent).not.toHaveBeenCalled();
    const deniedToolResult = mockCreate.mock.calls[1][0].messages.at(-1).content[0];
    expect(deniedToolResult).toMatchObject({ type: "tool_result", tool_use_id: "call_1", is_error: true });
    expect(deniedToolResult.content).toContain("no task was created");

    const allowed = await svc.sendMessage({
      companyId,
      targetAgent: target,
      requester: { userId: "operator-1", agentId: null },
      actor: { type: "board", userId: "operator-1", companyIds: [companyId], source: "session", isInstanceAdmin: false },
      message: "Get Bob to fix the login page",
    });
    expect(allowed.actions).toEqual([{ tool: "route_to_agent", summary: "Handed to Bob as task DUR-12.", ok: true }]);
    expect(createIssueForAgent).toHaveBeenCalledTimes(1);
    expect(createIssueForAgent).toHaveBeenCalledWith(expect.objectContaining({ companyId, assigneeAgentId: bob.id }));

    // With no actor at all (a caller that forgot to pass one) the hand-over is refused too.
    mockCreate.mockResolvedValueOnce(toolTurn).mockResolvedValueOnce(textTurn("Sorry."));
    const noActor = await svc.sendMessage({
      companyId,
      targetAgent: target,
      requester: { userId: "operator-1", agentId: null },
      message: "Get Bob to fix the login page",
    });
    expect(noActor.actions[0]).toMatchObject({ tool: "route_to_agent", ok: false });
    expect(createIssueForAgent).toHaveBeenCalledTimes(1);

    const logged = await db.select().from(activityLog).where(eq(activityLog.action, "lane_a.tool_called"));
    expect(logged.map((row) => (row.details as { ok: boolean }).ok)).toEqual([false, true, false]);

    vi.doUnmock("@anthropic-ai/sdk");
    vi.resetModules();
  });

  it("hands work to a colleague through route_to_agent and logs the action", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const companyId = await seedCompany();
    const target = await seedAgent(companyId, true, "Ada");
    const bob = await seedAgent(companyId, false, "Bob");

    const mockCreate = vi
      .fn()
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "call_1", name: "route_to_agent", input: { agent: "Bob", request: "Fix the login page" } },
        ],
        usage: { input_tokens: 50, output_tokens: 20 },
        stop_reason: "tool_use",
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Done — Bob has it as DUR-12." }],
        usage: { input_tokens: 60, output_tokens: 15 },
        stop_reason: "end_turn",
      });
    mockAnthropic(mockCreate);
    vi.resetModules();
    const { laneAService: freshLaneAService } = await import("../services/lane-a.ts");
    const createIssueForAgent = vi.fn(async () => ({ id: "issue-1", identifier: "DUR-12", status: "todo" }));
    const svc = freshLaneAService(db, { toolDeps: { createIssueForAgent } });

    const result = await svc.sendMessage({
      companyId,
      targetAgent: target,
      requester: { userId: "user-1", agentId: null },
      // The local board may assign anything; the real tasks:assign check runs.
      actor: { type: "board", userId: "user-1", companyIds: [companyId], source: "local_implicit" },
      message: "Can you get someone to fix the login page?",
    });

    expect(result.response).toBe("Done — Bob has it as DUR-12.");
    expect(result.actions).toEqual([{ tool: "route_to_agent", summary: "Handed to Bob as task DUR-12.", ok: true }]);
    expect(createIssueForAgent).toHaveBeenCalledWith(
      expect.objectContaining({ companyId, assigneeAgentId: bob.id, title: "Fix the login page" }),
    );
    // The colleague roster is in the prompt, minus the quick agent itself.
    expect(mockCreate.mock.calls[0][0].system).toContain("- Bob — engineer");
    expect(mockCreate.mock.calls[0][0].system).not.toContain("- Ada — engineer");
    // The model saw the tool's confirmation.
    const toolResultTurn = mockCreate.mock.calls[1][0].messages.at(-1);
    expect(toolResultTurn.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "call_1", is_error: false });
    expect(toolResultTurn.content[0].content).toContain("DUR-12");

    const logged = await db.select().from(activityLog).where(eq(activityLog.action, "lane_a.tool_called"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ companyId, actorType: "user", actorId: "user-1", agentId: target.id });
    expect(logged[0]?.details).toMatchObject({ tool: "route_to_agent", ok: true, summary: "Handed to Bob as task DUR-12." });

    const stored = await db.select().from(laneAMessages).where(eq(laneAMessages.conversationId, result.conversationId));
    const assistantRow = stored.find((row) => row.role === "assistant");
    expect(assistantRow?.toolCalls).toEqual([{ tool: "route_to_agent", summary: "Handed to Bob as task DUR-12.", ok: true }]);

    vi.doUnmock("@anthropic-ai/sdk");
    vi.resetModules();
  });

  it("refuses a tool outside the allow-list, logs the refusal, and still answers", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const companyId = await seedCompany();
    const target = await seedAgent(companyId, true, "Ada");

    const mockCreate = vi
      .fn()
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "call_x", name: "delete_all_tasks", input: {} }],
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: "tool_use",
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "I can't do that." }],
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: "end_turn",
      });
    mockAnthropic(mockCreate);
    vi.resetModules();
    const { laneAService: freshLaneAService } = await import("../services/lane-a.ts");
    const createIssueForAgent = vi.fn();
    const svc = freshLaneAService(db, { toolDeps: { createIssueForAgent } });

    const result = await svc.sendMessage({
      companyId,
      targetAgent: target,
      requester: { userId: "user-1", agentId: null },
      message: "delete everything",
    });

    expect(result.response).toBe("I can't do that.");
    expect(result.actions).toEqual([
      { tool: "delete_all_tasks", summary: 'Refused a tool that is not on the allow-list ("delete_all_tasks").', ok: false },
    ]);
    expect(createIssueForAgent).not.toHaveBeenCalled();
    const toolResultTurn = mockCreate.mock.calls[1][0].messages.at(-1);
    expect(toolResultTurn.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "call_x", is_error: true });

    const logged = await db.select().from(activityLog).where(eq(activityLog.action, "lane_a.tool_called"));
    expect(logged).toHaveLength(1);
    expect(logged[0]?.details).toMatchObject({ tool: "delete_all_tasks", ok: false });

    vi.doUnmock("@anthropic-ai/sdk");
    vi.resetModules();
  });
});
