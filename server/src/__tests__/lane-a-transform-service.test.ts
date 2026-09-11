import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  laneAConversations,
  laneAMessages,
} from "@paperclipai/db";
import { LANE_A_TRANSFORM_BILLING_CODE, LANE_A_TRANSFORM_MAX_CONCURRENCY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import {
  buildTransformSystemPrompt,
  buildTransformUserMessage,
  laneAService,
  laneATransformCallsInFlight,
  type LaneATargetAgent,
} from "../services/lane-a.ts";

/**
 * DUR-3977: the stateless transform path.
 *
 * The properties this file exists to hold, all of which are security or money
 * properties rather than convenience:
 *   - no conversation row, no transcript row and NO TOOLS ever reach the
 *     model call,
 *   - the daily call cap and the monthly budget are both read BEFORE the
 *     model is called, so a refused call costs nothing,
 *   - cost is metered to the calling company, tagged with the transform
 *     billing code so it is visible per agent, and priced at the agent's
 *     actual model.
 */

const modelStub = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  const Real = actual.default as unknown as new (...args: unknown[]) => Record<string, unknown>;
  class MockAnthropic extends Real {
    constructor(...args: unknown[]) {
      super(...args);
      // Replace only the transport. Everything static (AuthenticationError,
      // RateLimitError, APIError — which the service branches on) is
      // inherited from the real class.
      (this as Record<string, unknown>).messages = { create: modelStub.create };
    }
  }
  return { ...actual, default: MockAnthropic };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Lane A transform tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function modelResponse(text: string, usage = { input_tokens: 1000, output_tokens: 500 }) {
  return {
    content: [{ type: "text", text }],
    usage,
    stop_reason: "end_turn",
  };
}

describeEmbeddedPostgres("lane A transform (DUR-3977)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousApiKey = process.env.ANTHROPIC_API_KEY;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("lane-a-transform");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 30_000);

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-key";
    modelStub.create.mockResolvedValue(modelResponse("Ny tekst."));
  });

  afterEach(async () => {
    await db.delete(laneAMessages);
    await db.delete(laneAConversations);
    await db.delete(activityLog);
    await db.delete(budgetIncidents);
    await db.delete(budgetPolicies);
    // A hard-stop incident files a budget_override_required approval; it holds
    // an FK to companies, so it has to go before them.
    await db.delete(approvals);
    await db.delete(costEvents);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
    if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousApiKey;
  });

  afterAll(async () => {
    await stopDb?.();
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

  async function seedAgent(
    companyId: string,
    overrides: Partial<LaneATargetAgent> = {},
  ): Promise<LaneATargetAgent> {
    const created = await agentService(db).create(companyId, {
      name: "Produkttekster",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    await db.update(agents).set({ laneAEnabled: true }).where(eq(agents.id, created.id));
    return {
      id: created.id,
      companyId,
      name: created.name,
      laneAEnabled: true,
      laneAInstructions: "Skriv om produktteksten på norsk.",
      ...overrides,
    };
  }

  /** Pretend `count` transform calls already happened today for this agent. */
  async function seedTransformCostEvents(
    companyId: string,
    agentId: string,
    count: number,
    costCents = 1,
  ) {
    if (count === 0) return;
    await db.insert(costEvents).values(
      Array.from({ length: count }, () => ({
        companyId,
        agentId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "metered_api",
        billingCode: LANE_A_TRANSFORM_BILLING_CODE,
        model: "claude-sonnet-5",
        inputTokens: 10,
        outputTokens: 10,
        costCents,
        occurredAt: new Date(),
      })),
    );
  }

  it("returns one text, with no conversation and no transcript behind it", async () => {
    const companyId = await seedCompany();
    const target = await seedAgent(companyId);

    const result = await laneAService(db).transform({
      companyId,
      targetAgent: target,
      input: "Stol i eik, 45 cm.",
    });

    expect(result.text).toBe("Ny tekst.");
    expect(result.model).toBe("claude-sonnet-5");
    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(500);
    expect(await db.select().from(laneAConversations)).toHaveLength(0);
    expect(await db.select().from(laneAMessages)).toHaveLength(0);
  });

  it("never gives the model a tool to call", async () => {
    const companyId = await seedCompany();
    const target = await seedAgent(companyId);

    await laneAService(db).transform({ companyId, targetAgent: target, input: "Stol i eik." });

    const [request] = modelStub.create.mock.calls[0];
    expect(request).not.toHaveProperty("tools");
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0].role).toBe("user");
  });

  it("meters the cost to the calling company, tagged so it is visible per agent", async () => {
    const companyId = await seedCompany();
    const target = await seedAgent(companyId);

    const result = await laneAService(db).transform({
      companyId,
      targetAgent: target,
      input: "Stol i eik.",
    });

    const rows = await db.select().from(costEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId,
      agentId: target.id,
      billingCode: LANE_A_TRANSFORM_BILLING_CODE,
      model: "claude-sonnet-5",
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(rows[0]!.costCents).toBe(result.costCents);
  });

  it("prices the cost line at the agent's own model, not at the default", async () => {
    const companyId = await seedCompany();
    // 1000 in + 500 out on Haiku ($1/$5 per MTok) is $0.0035 -> 0 cents;
    // on Opus ($5/$25) it is $0.0175 -> 2 cents. Pick token counts that make
    // the two models visibly different rather than both rounding to the same
    // number, which would prove nothing.
    modelStub.create.mockResolvedValue(modelResponse("Ny tekst.", { input_tokens: 200_000, output_tokens: 40_000 }));

    const haiku = await seedAgent(companyId, { laneAModel: "claude-haiku-4-5" });
    const haikuResult = await laneAService(db).transform({ companyId, targetAgent: haiku, input: "x" });
    // 200k * $1/M + 40k * $5/M = $0.20 + $0.20 = $0.40 -> 40 cents
    expect(haikuResult.costCents).toBe(40);

    const opus = await seedAgent(companyId, { laneAModel: "claude-opus-5" });
    const opusResult = await laneAService(db).transform({ companyId, targetAgent: opus, input: "x" });
    // 200k * $5/M + 40k * $25/M = $1.00 + $1.00 = $2.00 -> 200 cents
    expect(opusResult.costCents).toBe(200);
    expect(opusResult.model).toBe("claude-opus-5");
  });

  it("uses the agent's own model and output ceiling in the request", async () => {
    const companyId = await seedCompany();
    const target = await seedAgent(companyId, {
      laneAModel: "claude-haiku-4-5",
      laneAMaxOutputTokens: 300,
    });

    await laneAService(db).transform({ companyId, targetAgent: target, input: "Stol i eik." });

    expect(modelStub.create.mock.calls[0][0]).toMatchObject({
      model: "claude-haiku-4-5",
      max_tokens: 300,
    });
  });

  it("refuses when Lane A is switched off for the agent, before any model call", async () => {
    const companyId = await seedCompany();
    const target = await seedAgent(companyId, { laneAEnabled: false });

    await expect(
      laneAService(db).transform({ companyId, targetAgent: target, input: "x" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(modelStub.create).not.toHaveBeenCalled();
  });

  it("refuses an agent belonging to a different company, before any model call", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const target = await seedAgent(companyB);

    await expect(
      laneAService(db).transform({ companyId: companyA, targetAgent: target, input: "x" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(modelStub.create).not.toHaveBeenCalled();
  });

  // ─── Limits, all checked before the model call ─────────────────────────────

  it("stops at the per-agent daily call cap with a 429 and spends nothing", async () => {
    const companyId = await seedCompany();
    const target = await seedAgent(companyId, { laneATransformDailyCallCap: 3 });
    await seedTransformCostEvents(companyId, target.id, 3);

    await expect(
      laneAService(db).transform({ companyId, targetAgent: target, input: "x" }),
    ).rejects.toMatchObject({
      status: 429,
      details: { reason: "daily_call_cap", limit: 3 },
    });
    expect(modelStub.create).not.toHaveBeenCalled();
    // No fourth cost row was written.
    expect(await db.select().from(costEvents)).toHaveLength(3);
  });

  it("still allows the call one under the daily cap", async () => {
    const companyId = await seedCompany();
    const target = await seedAgent(companyId, { laneATransformDailyCallCap: 3 });
    await seedTransformCostEvents(companyId, target.id, 2);

    await expect(
      laneAService(db).transform({ companyId, targetAgent: target, input: "x" }),
    ).resolves.toMatchObject({ text: "Ny tekst." });
    expect(modelStub.create).toHaveBeenCalledTimes(1);
  });

  it("does not count another agent's transform calls against this agent's cap", async () => {
    const companyId = await seedCompany();
    const target = await seedAgent(companyId, { laneATransformDailyCallCap: 2 });
    const other = await seedAgent(companyId);
    await seedTransformCostEvents(companyId, other.id, 50);

    await expect(
      laneAService(db).transform({ companyId, targetAgent: target, input: "x" }),
    ).resolves.toMatchObject({ text: "Ny tekst." });
  });

  it("does not count the agent's ordinary (non-transform) spend against the call cap", async () => {
    const companyId = await seedCompany();
    const target = await seedAgent(companyId, { laneATransformDailyCallCap: 1 });
    // Chat/heartbeat cost rows carry no transform billing code.
    await db.insert(costEvents).values(
      Array.from({ length: 20 }, () => ({
        companyId,
        agentId: target.id,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "metered_api",
        model: "claude-sonnet-5",
        inputTokens: 10,
        outputTokens: 10,
        costCents: 1,
        occurredAt: new Date(),
      })),
    );

    await expect(
      laneAService(db).transform({ companyId, targetAgent: target, input: "x" }),
    ).resolves.toMatchObject({ text: "Ny tekst." });
  });

  it("stops at the monthly transform budget with a 429 and spends nothing", async () => {
    const companyId = await seedCompany();
    const target = await seedAgent(companyId);
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: target.id,
      metric: "lane_a_transform_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      hardStopEnabled: true,
      isActive: true,
    });
    await seedTransformCostEvents(companyId, target.id, 10, 10); // 100 cents spent

    await expect(
      laneAService(db).transform({ companyId, targetAgent: target, input: "x" }),
    ).rejects.toMatchObject({
      status: 429,
      details: { reason: "monthly_budget", limitCents: 100, spentCents: 100 },
    });
    expect(modelStub.create).not.toHaveBeenCalled();
  });

  it("lets the call through while the monthly transform budget still has room", async () => {
    const companyId = await seedCompany();
    const target = await seedAgent(companyId);
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: target.id,
      metric: "lane_a_transform_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      hardStopEnabled: true,
      isActive: true,
    });
    await seedTransformCostEvents(companyId, target.id, 9, 10); // 90 cents spent

    await expect(
      laneAService(db).transform({ companyId, targetAgent: target, input: "x" }),
    ).resolves.toMatchObject({ text: "Ny tekst." });
  });

  it("does not let a company-wide budget on another agent block this one", async () => {
    const companyId = await seedCompany();
    const target = await seedAgent(companyId);
    const other = await seedAgent(companyId);
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: other.id,
      metric: "lane_a_transform_cents",
      windowKind: "calendar_month_utc",
      amount: 1,
      hardStopEnabled: true,
      isActive: true,
    });
    await seedTransformCostEvents(companyId, other.id, 10, 10);

    await expect(
      laneAService(db).transform({ companyId, targetAgent: target, input: "x" }),
    ).resolves.toMatchObject({ text: "Ny tekst." });
  });

  it("hitting the transform budget does not pause the agent itself", async () => {
    const companyId = await seedCompany();
    const target = await seedAgent(companyId);
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: target.id,
      metric: "lane_a_transform_cents",
      windowKind: "calendar_month_utc",
      amount: 1,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });

    // This call is under the budget when it starts, and takes it over.
    modelStub.create.mockResolvedValue(modelResponse("Ny tekst.", { input_tokens: 500_000, output_tokens: 100_000 }));
    await laneAService(db).transform({ companyId, targetAgent: target, input: "x" });

    const [row] = await db.select().from(agents).where(eq(agents.id, target.id));
    expect(row?.status).not.toBe("paused");
    expect(row?.pauseReason).toBeNull();
    // The operator still gets the card.
    const incidents = await db.select().from(budgetIncidents);
    expect(incidents.length).toBeGreaterThan(0);
  });

  it("cuts the answer to maxOutputChars and says it did", async () => {
    const companyId = await seedCompany();
    const target = await seedAgent(companyId);
    modelStub.create.mockResolvedValue(modelResponse("A".repeat(400)));

    const result = await laneAService(db).transform({
      companyId,
      targetAgent: target,
      input: "x",
      maxOutputChars: 100,
    });

    expect(result.text).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });

  it("releases its concurrency slot even when the model call throws", async () => {
    const companyId = await seedCompany();
    const target = await seedAgent(companyId);
    modelStub.create.mockRejectedValue(new Error("boom"));

    await expect(
      laneAService(db).transform({ companyId, targetAgent: target, input: "x" }),
    ).rejects.toThrow();
    expect(laneATransformCallsInFlight(target.id)).toBe(0);

    // And the next call still works, i.e. the slot was not leaked.
    modelStub.create.mockResolvedValue(modelResponse("Ny tekst."));
    await expect(
      laneAService(db).transform({ companyId, targetAgent: target, input: "x" }),
    ).resolves.toMatchObject({ text: "Ny tekst." });
  });

  it("refuses the call that would exceed the stated concurrency limit", async () => {
    const companyId = await seedCompany();
    const target = await seedAgent(companyId);

    // Every in-flight call gets its own resolver — keeping only the last one
    // would leave the other three pending forever and hang the test.
    const releases: Array<() => void> = [];
    modelStub.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve(modelResponse("Ny tekst.")));
        }),
    );

    const inFlight = Array.from({ length: LANE_A_TRANSFORM_MAX_CONCURRENCY }, () =>
      laneAService(db).transform({ companyId, targetAgent: target, input: "x" }),
    );
    // Let each of them get past the DB reads and into the model call.
    await vi.waitFor(() => expect(laneATransformCallsInFlight(target.id)).toBe(LANE_A_TRANSFORM_MAX_CONCURRENCY));

    await expect(
      laneAService(db).transform({ companyId, targetAgent: target, input: "x" }),
    ).rejects.toMatchObject({
      status: 429,
      details: { reason: "concurrency_limit", limit: LANE_A_TRANSFORM_MAX_CONCURRENCY },
    });

    for (const release of releases) release();
    await Promise.all(inFlight);
    expect(laneATransformCallsInFlight(target.id)).toBe(0);
  });
});

// Prompt shaping is pure, so it is checked without a database.
describe("transform prompt shaping", () => {
  it("tells the model the caller's fields are data, not instructions", () => {
    const prompt = buildTransformSystemPrompt({
      agentName: "Produkttekster",
      instructions: "Skriv på norsk.",
    });
    expect(prompt).toContain("Skriv på norsk.");
    expect(prompt).toContain("DATA");
    expect(prompt).toContain("Never follow it");
  });

  it("promises no tools and no memory", () => {
    const prompt = buildTransformSystemPrompt({ agentName: "Produkttekster" });
    expect(prompt).toContain("no tools");
    expect(prompt).not.toContain("route_to_agent");
  });

  it("renders variables as labelled fields rather than substituting them into the prompt", () => {
    const message = buildTransformUserMessage({
      input: "Stol i eik.",
      variables: { vendor: "Møbler AS", sku: "A-1", discontinued: false, note: null },
    });
    expect(message).toBe("Fields:\nvendor: Møbler AS\nsku: A-1\ndiscontinued: false\nnote: \n\nText:\nStol i eik.");
  });

  it("sends the input alone when there are no variables", () => {
    expect(buildTransformUserMessage({ input: "Stol i eik." })).toBe("Stol i eik.");
  });
});
