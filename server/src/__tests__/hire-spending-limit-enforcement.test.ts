import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, approvals, budgetPolicies, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * DUR-3976: end-to-end proof that a newly hired agent's monthly spending limit
 * is ENFORCED, not just stored.
 *
 * What enforces a monthly limit on this instance is a budget policy
 * (budget_policies, scope "agent", window "calendar_month_utc", metric
 * "billed_cents", hard stop on). costService.createEvent records spend, then
 * budgetService.evaluateCostEvent compares it with active policies. At the
 * limit it pauses the agent (pause_reason "budget") and files a
 * budget_override_required card, and getInvocationBlock refuses new runs.
 * That is the mechanism that paused the $300 agent on 12 Sep 2026. The
 * agents.budget_monthly_cents column is only a copy of the policy's amount for
 * display, and enforces nothing on its own.
 *
 * So each test here goes through the real HTTP hire route, the real approval,
 * and the real cost pipeline on a real database. Nothing that decides
 * enforcement is mocked.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres hire spending-limit tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("a new hire's monthly spending limit is enforced (DUR-3976)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let agentRoutes!: typeof import("../routes/agents.js").agentRoutes;
  let errorHandler!: typeof import("../middleware/index.js").errorHandler;
  let costService!: typeof import("../services/costs.js").costService;
  let budgetService!: typeof import("../services/budgets.js").budgetService;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-hire-spending-limit-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(async () => {
    vi.resetModules();
    const [routes, middleware, costs, budgets] = await Promise.all([
      vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
      vi.importActual<typeof import("../services/costs.js")>("../services/costs.js"),
      vi.importActual<typeof import("../services/budgets.js")>("../services/budgets.js"),
    ]);
    agentRoutes = routes.agentRoutes;
    errorHandler = middleware.errorHandler;
    costService = costs.costService;
    budgetService = budgets.budgetService;
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "local_implicit",
        userId: "board-user",
        companyIds: [companyId],
      };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany(requireBoardApprovalForNewAgents: boolean) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents,
    });
    return companyId;
  }

  /** The body a CEO-proposed hire sends when it says nothing about a limit. */
  function hireBody(extra: Record<string, unknown> = {}) {
    return {
      name: `Analyst ${randomUUID().slice(0, 6)}`,
      role: "general",
      adapterType: "process",
      adapterConfig: { command: "echo" },
      ...extra,
    };
  }

  async function agentPolicies(agentId: string) {
    return db
      .select()
      .from(budgetPolicies)
      .where(and(eq(budgetPolicies.scopeType, "agent"), eq(budgetPolicies.scopeId, agentId)));
  }

  async function spend(companyId: string, agentId: string, costCents: number) {
    await costService(db).createEvent(companyId, {
      agentId,
      provider: "anthropic",
      model: "claude-sonnet",
      costCents,
      occurredAt: new Date(),
    });
  }

  async function agentRow(agentId: string) {
    return db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
  }

  async function budgetCardsFor(companyId: string, agentId: string) {
    const rows = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), eq(approvals.type, "budget_override_required")));
    return rows.filter((row) => (row.payload as Record<string, unknown>).scopeId === agentId);
  }

  /** Spends past the limit and asserts the same guard that paused the $300 agent fired. */
  async function expectSpendingIsStoppedAt(companyId: string, agentId: string, limitCents: number) {
    await spend(companyId, agentId, limitCents - 1);
    expect((await agentRow(agentId)).status).not.toBe("paused");
    expect(await budgetCardsFor(companyId, agentId)).toHaveLength(0);

    await spend(companyId, agentId, 1);
    const paused = await agentRow(agentId);
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason).toBe("budget");
    const cards = await budgetCardsFor(companyId, agentId);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.status).toBe("pending");
    const block = await budgetService(db).getInvocationBlock(companyId, agentId);
    expect(block?.scopeType).toBe("agent");
  }

  it("no-approval path: a hire that says nothing starts at $50 and is stopped there", async () => {
    const companyId = await seedCompany(false);

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/agent-hires`)
      .send(hireBody());

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.approval).toBeNull();
    const agentId = res.body.agent.id as string;
    expect(res.body.agent.budgetMonthlyCents).toBe(5000);

    const policies = await agentPolicies(agentId);
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({
      amount: 5000,
      isActive: true,
      hardStopEnabled: true,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
    });

    await expectSpendingIsStoppedAt(companyId, agentId, 5000);
  }, 60_000);

  it("no-approval path: the amount chosen on the form is the amount enforced", async () => {
    const companyId = await seedCompany(false);

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/agent-hires`)
      .send(hireBody({ budgetMonthlyCents: 12_000 }));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const agentId = res.body.agent.id as string;
    expect((await agentPolicies(agentId))[0]).toMatchObject({ amount: 12_000, isActive: true });
    await expectSpendingIsStoppedAt(companyId, agentId, 12_000);
  }, 60_000);

  it("approval path: the card carries $50, and approving it makes the limit enforced", async () => {
    const companyId = await seedCompany(true);
    const app = createApp(companyId);

    const res = await request(app).post(`/api/companies/${companyId}/agent-hires`).send(hireBody());

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const agentId = res.body.agent.id as string;
    expect(res.body.agent.status).toBe("pending_approval");
    expect(res.body.approval.payload.budgetMonthlyCents).toBe(5000);
    // Nothing enforced yet: the agent cannot run until the board approves.
    expect(await agentPolicies(agentId)).toHaveLength(0);

    const approve = await request(app).post(`/api/agents/${agentId}/approve`).send({});
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);

    const card = await db.select().from(approvals).where(eq(approvals.id, res.body.approval.id)).then((r) => r[0]!);
    expect(card.status).toBe("approved");
    expect((await agentPolicies(agentId))[0]).toMatchObject({ amount: 5000, isActive: true, hardStopEnabled: true });

    await expectSpendingIsStoppedAt(companyId, agentId, 5000);
  }, 60_000);

  it("approval path: an explicit 'no limit' shows 0 on the card and really has no limit", async () => {
    const companyId = await seedCompany(true);
    const app = createApp(companyId);

    const res = await request(app)
      .post(`/api/companies/${companyId}/agent-hires`)
      .send(hireBody({ budgetMonthlyCents: 0 }));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const agentId = res.body.agent.id as string;
    expect(res.body.approval.payload.budgetMonthlyCents).toBe(0);

    const approve = await request(app).post(`/api/agents/${agentId}/approve`).send({});
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);

    expect(await agentPolicies(agentId)).toHaveLength(0);
    expect((await agentRow(agentId)).budgetMonthlyCents).toBe(0);
    await spend(companyId, agentId, 100_000);
    expect((await agentRow(agentId)).status).not.toBe("paused");
  }, 60_000);

  it("approving a pending agent with no hire card still enforces the limit it carries", async () => {
    const companyId = await seedCompany(true);
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Pending without a card",
      role: "general",
      adapterType: "process",
      adapterConfig: {},
      status: "pending_approval",
      budgetMonthlyCents: 5000,
    });

    const approve = await request(createApp(companyId)).post(`/api/agents/${agentId}/approve`).send({});

    expect(approve.status, JSON.stringify(approve.body)).toBe(200);
    expect((await agentPolicies(agentId))[0]).toMatchObject({ amount: 5000, isActive: true });
    await expectSpendingIsStoppedAt(companyId, agentId, 5000);
  }, 60_000);

  it("leaves existing agents' limits exactly as the operator set them", async () => {
    const companyId = await seedCompany(false);
    const handSetId = randomUUID();
    const noLimitId = randomUUID();
    await db.insert(agents).values([
      {
        id: handSetId,
        companyId,
        name: "Hand-set limit",
        role: "general",
        adapterType: "process",
        adapterConfig: {},
        status: "idle",
        budgetMonthlyCents: 30_000,
      },
      {
        id: noLimitId,
        companyId,
        name: "Existing, no limit",
        role: "general",
        adapterType: "process",
        adapterConfig: {},
        status: "idle",
        budgetMonthlyCents: 0,
      },
    ]);
    const before = await db.select().from(agents).where(eq(agents.companyId, companyId));

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/agent-hires`)
      .send(hireBody());
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const after = await db.select().from(agents).where(eq(agents.companyId, companyId));
    for (const original of before) {
      const now = after.find((row) => row.id === original.id)!;
      expect(now.budgetMonthlyCents).toBe(original.budgetMonthlyCents);
      expect(now.updatedAt.getTime()).toBe(original.updatedAt.getTime());
    }
    expect(await agentPolicies(handSetId)).toHaveLength(0);
    expect(await agentPolicies(noLimitId)).toHaveLength(0);
  }, 60_000);
});
