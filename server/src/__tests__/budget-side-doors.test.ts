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
import { LANE_A_TRANSFORM_BILLING_CODE } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * DUR-3989: ways spending used to get past the budget checks.
 *
 *   (1) quick chat (lane A sendMessage — also what the Telegram bridge calls
 *       through POST /chat/:agentId/messages) never checked whether the agent
 *       was paused or over its spending limit before calling the model;
 *   (2) the rewriting service (transform) stopped a paused agent but ignored
 *       an ordinary spending limit that was exceeded while the agent was not
 *       yet paused;
 *   (4) the check that stops an agent at its limit counted every budget,
 *       including a rewriting-only one, so an exhausted rewriting budget
 *       would have blocked all of that agent's normal work.
 *
 * (3), recovery runs started without their project, is covered in
 * heartbeat-process-recovery.test.ts next to the recovery fixtures.
 *
 * Everything here runs against a real embedded Postgres. The only things
 * replaced are the Anthropic transport (so no real model is called and we can
 * see whether it WOULD have been) and, for the fail-open tests only, a switch
 * that makes the budget check throw.
 */

const modelStub = vi.hoisted(() => ({
  create: vi.fn(),
}));

const budgetFault = vi.hoisted(() => ({ throwOnInvocationBlock: false }));

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  const Real = actual.default as unknown as new (...args: unknown[]) => Record<string, unknown>;
  class MockAnthropic extends Real {
    constructor(...args: unknown[]) {
      super(...args);
      (this as Record<string, unknown>).messages = { create: modelStub.create };
    }
  }
  return { ...actual, default: MockAnthropic };
});

// The real budget service against the real database. The single switch only
// exists to prove the quick-agent gate fails open when the check itself
// breaks; it is off for every other test.
vi.mock("../services/budgets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/budgets.js")>();
  return {
    ...actual,
    budgetService: (...args: Parameters<typeof actual.budgetService>) => {
      const real = actual.budgetService(...args);
      return {
        ...real,
        getInvocationBlock: async (...blockArgs: Parameters<typeof real.getInvocationBlock>) => {
          if (budgetFault.throwOnInvocationBlock) throw new Error("simulated budget-check failure");
          return real.getInvocationBlock(...blockArgs);
        },
      };
    },
  };
});

const { agentService } = await import("../services/agents.ts");
const { budgetService } = await import("../services/budgets.ts");
const { laneAService } = await import("../services/lane-a.ts");
type LaneATargetAgent = import("../services/lane-a.ts").LaneATargetAgent;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres budget side-door tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function modelResponse(text: string) {
  return {
    content: [{ type: "text", text }],
    usage: { input_tokens: 100, output_tokens: 50 },
    stop_reason: "end_turn",
  };
}

describeEmbeddedPostgres("budget side doors (DUR-3989)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousApiKey = process.env.ANTHROPIC_API_KEY;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("budget-side-doors");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 30_000);

  beforeEach(() => {
    vi.clearAllMocks();
    budgetFault.throwOnInvocationBlock = false;
    process.env.ANTHROPIC_API_KEY = "test-key";
    modelStub.create.mockResolvedValue(modelResponse("Svar."));
  });

  afterEach(async () => {
    budgetFault.throwOnInvocationBlock = false;
    await db.delete(laneAMessages);
    await db.delete(laneAConversations);
    await db.delete(activityLog);
    await db.delete(budgetIncidents);
    await db.delete(budgetPolicies);
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

  /**
   * A quick agent, returned the way the chat routes hand it to sendMessage:
   * WITHOUT its status. Neither /lane-a/:agentId/messages nor
   * /chat/:agentId/messages passes status, so the gate has to read it itself.
   */
  async function seedQuickAgent(companyId: string): Promise<LaneATargetAgent> {
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
    };
  }

  async function addHardStop(input: {
    companyId: string;
    scopeType: "agent" | "company";
    scopeId: string;
    metric: "billed_cents" | "lane_a_transform_cents";
    amount: number;
  }) {
    await db.insert(budgetPolicies).values({
      companyId: input.companyId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      metric: input.metric,
      windowKind: "calendar_month_utc",
      amount: input.amount,
      hardStopEnabled: true,
      isActive: true,
    });
  }

  /** Spend already on the books this month. Inserted directly, so nothing has paused anyone yet. */
  async function addSpend(companyId: string, agentId: string, costCents: number, billingCode: string | null = null) {
    await db.insert(costEvents).values({
      companyId,
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      billingCode,
      model: "claude-sonnet-5",
      inputTokens: 10,
      outputTokens: 10,
      costCents,
      occurredAt: new Date(),
    });
  }

  function chat(companyId: string, targetAgent: LaneATargetAgent) {
    return laneAService(db).sendMessage({
      companyId,
      targetAgent,
      requester: { userId: "user-1", agentId: null },
      message: "Hei, hva er status?",
    });
  }

  // ─── (4) a rewriting-only budget does not stop normal work ─────────────────

  describe("(4) the limit check that stops an agent's normal work", () => {
    it("does NOT stop an agent whose rewriting budget is used up", async () => {
      const companyId = await seedCompany();
      const agent = await seedQuickAgent(companyId);
      await addHardStop({ companyId, scopeType: "agent", scopeId: agent.id, metric: "lane_a_transform_cents", amount: 100 });
      await addSpend(companyId, agent.id, 500, LANE_A_TRANSFORM_BILLING_CODE);

      await expect(budgetService(db).getInvocationBlock(companyId, agent.id)).resolves.toBeNull();
    });

    it("does NOT stop the agent when a COMPANY-wide rewriting budget is used up", async () => {
      const companyId = await seedCompany();
      const agent = await seedQuickAgent(companyId);
      await addHardStop({ companyId, scopeType: "company", scopeId: companyId, metric: "lane_a_transform_cents", amount: 100 });
      await addSpend(companyId, agent.id, 500, LANE_A_TRANSFORM_BILLING_CODE);

      await expect(budgetService(db).getInvocationBlock(companyId, agent.id)).resolves.toBeNull();
    });

    it("still stops an agent whose ordinary spending limit is used up", async () => {
      const companyId = await seedCompany();
      const agent = await seedQuickAgent(companyId);
      await addHardStop({ companyId, scopeType: "agent", scopeId: agent.id, metric: "billed_cents", amount: 100 });
      await addSpend(companyId, agent.id, 500);

      await expect(budgetService(db).getInvocationBlock(companyId, agent.id)).resolves.toMatchObject({
        scopeType: "agent",
        scopeId: agent.id,
      });
    });

    it("still stops the agent on its ordinary limit when both budgets are used up", async () => {
      const companyId = await seedCompany();
      const agent = await seedQuickAgent(companyId);
      await addHardStop({ companyId, scopeType: "agent", scopeId: agent.id, metric: "lane_a_transform_cents", amount: 100 });
      await addHardStop({ companyId, scopeType: "agent", scopeId: agent.id, metric: "billed_cents", amount: 100 });
      await addSpend(companyId, agent.id, 500, LANE_A_TRANSFORM_BILLING_CODE);

      // The ordinary billed_cents metric counts ALL the agent's spend, so the
      // same 500 cents exceed both budgets; only the ordinary one may block.
      await expect(budgetService(db).getInvocationBlock(companyId, agent.id)).resolves.toMatchObject({
        scopeType: "agent",
      });
    });

    it("an exhausted rewriting budget leaves chat working while transform is refused", async () => {
      const companyId = await seedCompany();
      const agent = await seedQuickAgent(companyId);
      await addHardStop({ companyId, scopeType: "agent", scopeId: agent.id, metric: "lane_a_transform_cents", amount: 100 });
      await addSpend(companyId, agent.id, 500, LANE_A_TRANSFORM_BILLING_CODE);

      await expect(chat(companyId, agent)).resolves.toMatchObject({ response: "Svar." });
      await expect(
        laneAService(db).transform({ companyId, targetAgent: agent, input: "x" }),
      ).rejects.toMatchObject({ status: 429, details: { reason: "monthly_budget" } });
    });
  });

  // ─── (1) quick chat checks pause and spending limits ───────────────────────

  describe("(1) quick chat", () => {
    it("refuses a paused agent with a plain sentence, before any model call", async () => {
      const companyId = await seedCompany();
      const agent = await seedQuickAgent(companyId);
      await db.update(agents).set({ status: "paused", pauseReason: "manual", pausedAt: new Date() }).where(eq(agents.id, agent.id));

      const error = await chat(companyId, agent).catch((err) => err);
      expect(error).toMatchObject({ status: 403 });
      expect(error.message).toMatch(/^This quick agent is paused, so it cannot answer right now\./);
      expect(modelStub.create).not.toHaveBeenCalled();
      expect(await db.select().from(costEvents)).toHaveLength(0);
      expect(await db.select().from(laneAConversations)).toHaveLength(0);
    });

    it("refuses an agent paused by its budget", async () => {
      const companyId = await seedCompany();
      const agent = await seedQuickAgent(companyId);
      await db.update(agents).set({ status: "paused", pauseReason: "budget", pausedAt: new Date() }).where(eq(agents.id, agent.id));

      await expect(chat(companyId, agent)).rejects.toMatchObject({ status: 403 });
      expect(modelStub.create).not.toHaveBeenCalled();
    });

    it("refuses an agent over its ordinary spending limit even though nothing has paused it yet", async () => {
      const companyId = await seedCompany();
      const agent = await seedQuickAgent(companyId);
      await addHardStop({ companyId, scopeType: "agent", scopeId: agent.id, metric: "billed_cents", amount: 100 });
      await addSpend(companyId, agent.id, 500);

      const error = await chat(companyId, agent).catch((err) => err);
      expect(error).toMatchObject({ status: 403, details: { reason: "spending_limit", scopeType: "agent" } });
      expect(error.message).toBe(
        "This quick agent has reached its spending limit, so it is not answering messages right now. " +
          "Raise its budget in Paperclip (or answer the budget question about it) and try again.",
      );
      expect(modelStub.create).not.toHaveBeenCalled();
      // The spend already on the books is the only cost row: the refusal cost nothing.
      expect(await db.select().from(costEvents)).toHaveLength(1);
    });

    it("refuses when the company's ordinary spending limit is used up", async () => {
      const companyId = await seedCompany();
      const agent = await seedQuickAgent(companyId);
      await addHardStop({ companyId, scopeType: "company", scopeId: companyId, metric: "billed_cents", amount: 100 });
      await addSpend(companyId, agent.id, 500);

      const error = await chat(companyId, agent).catch((err) => err);
      expect(error).toMatchObject({ status: 403, details: { reason: "spending_limit", scopeType: "company" } });
      expect(error.message).toMatch(/^This company has reached its spending limit in Paperclip/);
      expect(modelStub.create).not.toHaveBeenCalled();
    });

    it("refuses when the company is paused", async () => {
      const companyId = await seedCompany();
      const agent = await seedQuickAgent(companyId);
      await db.update(companies).set({ status: "paused" }).where(eq(companies.id, companyId));

      await expect(chat(companyId, agent)).rejects.toMatchObject({ status: 403 });
      expect(modelStub.create).not.toHaveBeenCalled();
    });

    it("still answers while the ordinary limit has room", async () => {
      const companyId = await seedCompany();
      const agent = await seedQuickAgent(companyId);
      await addHardStop({ companyId, scopeType: "agent", scopeId: agent.id, metric: "billed_cents", amount: 1_000 });
      await addSpend(companyId, agent.id, 500);

      await expect(chat(companyId, agent)).resolves.toMatchObject({ response: "Svar." });
      expect(modelStub.create).toHaveBeenCalledTimes(1);
    });

    it("fails open: a broken budget check lets the message through instead of erroring", async () => {
      const companyId = await seedCompany();
      const agent = await seedQuickAgent(companyId);
      budgetFault.throwOnInvocationBlock = true;

      await expect(chat(companyId, agent)).resolves.toMatchObject({ response: "Svar." });
      expect(modelStub.create).toHaveBeenCalledTimes(1);
    });
  });

  // ─── (2) transform respects the ordinary spending limit ────────────────────

  describe("(2) the rewriting service", () => {
    it("refuses an agent over its ordinary spending limit with a plain sentence, before any model call", async () => {
      const companyId = await seedCompany();
      const agent = await seedQuickAgent(companyId);
      await addHardStop({ companyId, scopeType: "agent", scopeId: agent.id, metric: "billed_cents", amount: 100 });
      await addSpend(companyId, agent.id, 500);

      const error = await laneAService(db)
        .transform({ companyId, targetAgent: agent, input: "x" })
        .catch((err) => err);
      expect(error).toMatchObject({ status: 403, details: { reason: "spending_limit", scopeType: "agent" } });
      expect(error.message).toBe(
        "This quick agent has reached its spending limit, so it is not doing any work, including rewriting text, right now. " +
          "Raise its budget in Paperclip (or answer the budget question about it) and try again.",
      );
      expect(modelStub.create).not.toHaveBeenCalled();
      expect(await db.select().from(costEvents)).toHaveLength(1);
    });

    it("refuses when the company's ordinary spending limit is used up", async () => {
      const companyId = await seedCompany();
      const agent = await seedQuickAgent(companyId);
      await addHardStop({ companyId, scopeType: "company", scopeId: companyId, metric: "billed_cents", amount: 100 });
      await addSpend(companyId, agent.id, 500);

      await expect(
        laneAService(db).transform({ companyId, targetAgent: agent, input: "x" }),
      ).rejects.toMatchObject({ status: 403, details: { reason: "spending_limit", scopeType: "company" } });
      expect(modelStub.create).not.toHaveBeenCalled();
    });

    it("refuses an agent paused in the database even when the caller's copy says otherwise", async () => {
      const companyId = await seedCompany();
      const agent = await seedQuickAgent(companyId);
      await db.update(agents).set({ status: "paused", pauseReason: "manual", pausedAt: new Date() }).where(eq(agents.id, agent.id));

      await expect(
        laneAService(db).transform({ companyId, targetAgent: { ...agent, status: "active" }, input: "x" }),
      ).rejects.toMatchObject({ status: 403 });
      expect(modelStub.create).not.toHaveBeenCalled();
    });

    it("still rewrites while the ordinary limit has room", async () => {
      const companyId = await seedCompany();
      const agent = await seedQuickAgent(companyId);
      await addHardStop({ companyId, scopeType: "agent", scopeId: agent.id, metric: "billed_cents", amount: 1_000 });
      await addSpend(companyId, agent.id, 500);

      await expect(
        laneAService(db).transform({ companyId, targetAgent: agent, input: "x" }),
      ).resolves.toMatchObject({ text: "Svar." });
    });

    it("marks an agent over its ordinary limit unusable in the discovery list, agreeing with transform", async () => {
      const companyId = await seedCompany();
      const agent = await seedQuickAgent(companyId);
      await addHardStop({ companyId, scopeType: "agent", scopeId: agent.id, metric: "billed_cents", amount: 100 });
      await addSpend(companyId, agent.id, 500);

      const listed = await laneAService(db).listTransformAgents(companyId);
      expect(listed.agents).toEqual([
        expect.objectContaining({ id: agent.id, usable: false, unavailableReason: "spending_limit" }),
      ]);
    });

    it("fails open: a broken budget check lets the rewrite through instead of erroring", async () => {
      const companyId = await seedCompany();
      const agent = await seedQuickAgent(companyId);
      budgetFault.throwOnInvocationBlock = true;

      await expect(
        laneAService(db).transform({ companyId, targetAgent: agent, input: "x" }),
      ).resolves.toMatchObject({ text: "Svar." });
    });
  });
});
