import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, costEvents, createDb, laneAConversations } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import {
  LANE_A_MAX_DAILY_TURNS_PER_EMPLOYEE,
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
});
