import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
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
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { laneAService, type LaneATargetAgent } from "../services/lane-a.ts";
import { eq } from "drizzle-orm";

/**
 * DUR-4347: the daily cap counts a turn once, however many fallback attempts
 * it took; and the morning report reaches the model only through
 * laneA.transform, so it inherits the chain with no code of its own.
 */
const modelStub = vi.hoisted(() => ({ create: vi.fn() }));

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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function ok(text: string) {
  return { content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: "end_turn" };
}
function overloaded() {
  return new Anthropic.APIError(503, { error: { message: "overloaded" } }, "overloaded", new Headers());
}

describeEmbeddedPostgres("lane A backup chain: budget (DUR-4347)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousApiKey = process.env.ANTHROPIC_API_KEY;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("lane-a-dur4347-budget");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 30_000);

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(async () => {
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

  async function seed(cap: number): Promise<{ companyId: string; target: LaneATargetAgent }> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Nordstrand",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
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
    await db
      .update(agents)
      .set({
        laneAEnabled: true,
        laneABackupModels: [
          { id: "b1", provider: "anthropic", model: "claude-haiku-4-5" },
          { id: "b2", provider: "anthropic", model: "claude-sonnet-5" },
        ],
        laneANoAnswerChainIds: ["b1", "b2"],
      })
      .where(eq(agents.id, created.id));
    return {
      companyId,
      target: {
        id: created.id,
        companyId,
        name: created.name,
        laneAEnabled: true,
        laneAInstructions: "Skriv om teksten.",
        laneATransformDailyCallCap: cap,
      },
    };
  }

  it("counts a turn once against the daily cap however many attempts it took, and meters every attempt that answered", async () => {
    const { companyId, target } = await seed(2);
    // main down, backup 1 down, backup 2 answers: three model calls, one turn.
    modelStub.create
      .mockRejectedValueOnce(overloaded())
      .mockRejectedValueOnce(overloaded())
      .mockResolvedValueOnce(ok("Ny tekst."));

    const first = await laneAService(db).transform({ companyId, targetAgent: target, input: "x" });
    expect(first.text).toBe("Ny tekst.");
    expect(modelStub.create).toHaveBeenCalledTimes(3);

    // One turn used: a second turn (cap 2) still passes, the third is refused.
    modelStub.create.mockResolvedValue(ok("Igjen."));
    await laneAService(db).transform({ companyId, targetAgent: target, input: "y" });
    await expect(
      laneAService(db).transform({ companyId, targetAgent: target, input: "z" }),
    ).rejects.toMatchObject({ status: 429, details: { reason: "daily_call_cap" } });
  });

  it("bills the rounds a chat turn spent before it failed, when every model then fails", async () => {
    const { companyId, target } = await seed(10);
    const createIssueForAgent = vi.fn(async () => ({ id: "issue-1", identifier: "DUR-12", status: "todo" }));
    modelStub.create
      // main: one tool round, then 503 on round 2
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "call_1", name: "route_to_agent", input: { agent: "Bob", request: "Fix it" } }],
        usage: { input_tokens: 100, output_tokens: 50 },
        stop_reason: "tool_use",
      })
      .mockRejectedValue(overloaded());

    await expect(
      laneAService(db, { toolDeps: { createIssueForAgent } }).sendMessage({
        companyId,
        targetAgent: target,
        requester: { userId: "user-1", agentId: null },
        actor: { type: "board", userId: "user-1", companyIds: [companyId], source: "local_implicit" },
        message: "Can you get someone to fix it?",
      }),
    ).rejects.toBeTruthy();

    const events = await db.select().from(costEvents);
    expect(events.reduce((n, e) => n + e.inputTokens, 0)).toBe(100);
    expect(events.reduce((n, e) => n + e.outputTokens, 0)).toBe(50);
  });

  it("bills every attempt of a transform that ends in an error (all replies were refusals)", async () => {
    const { companyId, target } = await seed(10);
    await db.update(agents).set({ laneARefusalChainIds: ["b1"] }).where(eq(agents.id, target.id));
    modelStub.create.mockResolvedValue(ok("I'm sorry, but I can't help with that request."));

    await expect(laneAService(db).transform({ companyId, targetAgent: target, input: "x" })).rejects.toBeTruthy();

    const events = await db.select().from(costEvents);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.reduce((n, e) => n + e.inputTokens, 0)).toBe(events.length * 100);
  });
});

describe("morning report inherits the fallback chain", () => {
  it("reaches the model only through laneA.transform, which wraps the fallback loop", async () => {
    const { readFileSync } = await import("node:fs");
    const report = readFileSync(new URL("../services/morning-report.ts", import.meta.url), "utf8");
    const lane = readFileSync(new URL("../services/lane-a.ts", import.meta.url), "utf8");
    expect(report).toMatch(/laneA\.transform\(/);
    expect(report).not.toMatch(/callTransformModel|buildProviderClient/);
    const transformBody = lane.slice(lane.indexOf("async function transform("));
    expect(transformBody).toMatch(/runLaneAFallbackLoop</);
  });
});
