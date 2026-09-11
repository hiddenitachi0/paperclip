import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
} from "@paperclipai/db";
import {
  BUDGET_METRICS,
  BUDGET_METRICS_WITHOUT_SCOPE_PAUSE,
  LANE_A_TRANSFORM_BILLING_CODE,
  budgetMetricPausesScope,
  type BudgetMetric,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { budgetService } from "../services/budgets.ts";

/**
 * Anti-drift for the budget metrics (DUR-3977).
 *
 * BUDGET_METRICS in @paperclipai/shared and the `if (policy.metric !== ...)`
 * guard in computeObservedAmount (server/src/services/budgets.ts) are two
 * lists that have to agree, with nothing in the type system tying them
 * together: a metric added to the array but not to the guard silently
 * observes 0, which means a budget that never triggers — a limit that reads
 * as "set" in the UI and does nothing at all. That is the bug class this file
 * exists to catch, so it reads the array rather than naming metrics by hand.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres budget metric tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * For each metric: a cost row that metric must observe, and the amount the
 * policy should then report. Typed as a total map over BudgetMetric, so a new
 * metric with no sample here fails typecheck before it can fail at runtime.
 */
const SPEND_SAMPLES: Record<
  BudgetMetric,
  { costCents: number; inputTokens: number; outputTokens: number; billingCode?: string; expectObserved: number }
> = {
  billed_cents: { costCents: 250, inputTokens: 10, outputTokens: 5, expectObserved: 250 },
  total_tokens: { costCents: 250, inputTokens: 10, outputTokens: 5, expectObserved: 15 },
  lane_a_transform_cents: {
    costCents: 250,
    inputTokens: 10,
    outputTokens: 5,
    billingCode: LANE_A_TRANSFORM_BILLING_CODE,
    expectObserved: 250,
  },
};

describe("budget metric list", () => {
  it("has a spend sample for every metric", () => {
    expect(Object.keys(SPEND_SAMPLES).sort()).toEqual([...BUDGET_METRICS].sort());
  });

  it("only exempts metrics that are actually metrics", () => {
    for (const metric of BUDGET_METRICS_WITHOUT_SCOPE_PAUSE) {
      expect(BUDGET_METRICS).toContain(metric);
      expect(budgetMetricPausesScope(metric)).toBe(false);
    }
  });

  it("still pauses the scope for every metric that is not exempt", () => {
    for (const metric of BUDGET_METRICS) {
      if ((BUDGET_METRICS_WITHOUT_SCOPE_PAUSE as readonly string[]).includes(metric)) continue;
      expect(budgetMetricPausesScope(metric)).toBe(true);
    }
  });
});

describeEmbeddedPostgres("every budget metric is actually observed", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("budget-metrics");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(budgetIncidents);
    await db.delete(budgetPolicies);
    await db.delete(approvals);
    await db.delete(costEvents);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Nordstrand",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agent = await agentService(db).create(companyId, {
      name: "Produkttekster",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    return { companyId, agentId: agent.id };
  }

  for (const metric of BUDGET_METRICS) {
    it(`observes real spend for "${metric}" instead of silently reporting zero`, async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const sample = SPEND_SAMPLES[metric];
      await db.insert(costEvents).values({
        companyId,
        agentId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "metered_api",
        billingCode: sample.billingCode ?? null,
        model: "claude-sonnet-5",
        inputTokens: sample.inputTokens,
        outputTokens: sample.outputTokens,
        costCents: sample.costCents,
        occurredAt: new Date(),
      });

      const summary = await budgetService(db).upsertPolicy(
        companyId,
        {
          scopeType: "agent",
          scopeId: agentId,
          metric,
          windowKind: "calendar_month_utc",
          amount: 10_000,
          warnPercent: 80,
          hardStopEnabled: true,
          notifyEnabled: true,
          isActive: true,
        },
        null,
      );

      expect(summary.observedAmount).toBe(sample.expectObserved);
    });
  }

  it("keeps the transform metric narrowed to transform spend only", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    // Ordinary agent spend, no transform billing code.
    await db.insert(costEvents).values({
      companyId,
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      model: "claude-sonnet-5",
      inputTokens: 10,
      outputTokens: 5,
      costCents: 9_999,
      occurredAt: new Date(),
    });

    const summary = await budgetService(db).upsertPolicy(
      companyId,
      {
        scopeType: "agent",
        scopeId: agentId,
        metric: "lane_a_transform_cents",
        windowKind: "calendar_month_utc",
        amount: 100,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      },
      null,
    );

    expect(summary.observedAmount).toBe(0);
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agentRow?.status).not.toBe("paused");
  });

  it("does not resume an agent paused by its ordinary budget when the transform budget is raised", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    // The agent is paused because its ordinary billed_cents hard stop fired.
    await db
      .update(agents)
      .set({ status: "paused", pauseReason: "budget", pausedAt: new Date() })
      .where(eq(agents.id, agentId));

    await budgetService(db).upsertPolicy(
      companyId,
      {
        scopeType: "agent",
        scopeId: agentId,
        metric: "lane_a_transform_cents",
        windowKind: "calendar_month_utc",
        amount: 50_000,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      },
      null,
    );

    const [agentRow] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agentRow?.status).toBe("paused");
    expect(agentRow?.pauseReason).toBe("budget");
  });
});
