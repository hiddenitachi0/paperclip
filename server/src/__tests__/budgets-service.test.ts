import { beforeEach, describe, expect, it, vi } from "vitest";
import { budgetService } from "../services/budgets.ts";

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

type SelectResult = unknown[];

function createDbStub(selectResults: SelectResult[]) {
  const pendingSelects = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelects.shift() ?? []);
  const selectThen = vi.fn((resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve(pendingSelects.shift() ?? [])));
  const selectOrderBy = vi.fn(async () => pendingSelects.shift() ?? []);
  const selectFrom = vi.fn(() => ({
    where: selectWhere,
    then: selectThen,
    orderBy: selectOrderBy,
  }));
  const select = vi.fn(() => ({
    from: selectFrom,
  }));

  const insertValues = vi.fn();
  const insertReturning = vi.fn(async () => pendingInserts.shift() ?? []);
  const insert = vi.fn(() => ({
    values: insertValues.mockImplementation(() => ({
      returning: insertReturning,
      onConflictDoNothing: () => ({ returning: insertReturning }),
    })),
  }));

  const updateSet = vi.fn();
  const updateWhere = vi.fn(async () => pendingUpdates.shift() ?? []);
  const update = vi.fn(() => ({
    set: updateSet.mockImplementation(() => ({
      where: updateWhere,
    })),
  }));

  const pendingInserts: unknown[][] = [];
  const pendingUpdates: unknown[][] = [];

  // The card and its incident are written in one transaction (withCompanyScope
  // sets the company claim, then runs the callback). The stub runs the
  // callback on itself; real transaction behaviour is covered against a real
  // database in budgets-incident-uniqueness.test.ts.
  const db: Record<string, unknown> = {
    select,
    insert,
    update,
    execute: vi.fn(async () => []),
  };
  db.transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));

  return {
    db,
    queueInsert: (rows: unknown[]) => {
      pendingInserts.push(rows);
    },
    queueUpdate: (rows: unknown[] = []) => {
      pendingUpdates.push(rows);
    },
    selectWhere,
    insertValues,
    updateSet,
  };
}

describe("budgetService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a hard-stop incident and pauses an agent when spend exceeds a budget", async () => {
    const policy = {
      id: "policy-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      scopeType: "agent",
      scopeId: "agent-1",
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
    };

    const dbStub = createDbStub([
      [policy],
      [{ total: 150 }],
      [],
      [{
        companyId: "11111111-1111-4111-8111-111111111111",
        name: "Budget Agent",
        status: "running",
        pauseReason: null,
      }],
    ]);

    dbStub.queueInsert([{
      id: "approval-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      status: "pending",
    }]);
    dbStub.queueInsert([{
      id: "incident-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      policyId: "policy-1",
      approvalId: "approval-1",
    }]);
    dbStub.queueUpdate([]);
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);

    const service = budgetService(dbStub.db as any, { cancelWorkForScope });
    await service.evaluateCostEvent({
      companyId: "11111111-1111-4111-8111-111111111111",
      agentId: "agent-1",
      projectId: null,
    } as any);

    expect(dbStub.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "11111111-1111-4111-8111-111111111111",
        type: "budget_override_required",
        status: "pending",
      }),
    );
    expect(dbStub.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "11111111-1111-4111-8111-111111111111",
        policyId: "policy-1",
        thresholdType: "hard",
        amountLimit: 100,
        amountObserved: 150,
        approvalId: "approval-1",
      }),
    );
    expect(dbStub.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "paused",
        pauseReason: "budget",
        pausedAt: expect.any(Date),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "budget.hard_threshold_crossed",
        entityId: "incident-1",
      }),
    );
    expect(cancelWorkForScope).toHaveBeenCalledWith({
      companyId: "11111111-1111-4111-8111-111111111111",
      scopeType: "agent",
      scopeId: "agent-1",
    });
  });

  it("blocks new work when an agent hard-stop remains exceeded even if the agent is not paused yet", async () => {
    const agentPolicy = {
      id: "policy-agent-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      scopeType: "agent",
      scopeId: "agent-1",
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    };

    const dbStub = createDbStub([
      [{
        status: "running",
        pauseReason: null,
        companyId: "11111111-1111-4111-8111-111111111111",
        name: "Budget Agent",
      }],
      [{
        status: "active",
        name: "Paperclip",
      }],
      [],
      [agentPolicy],
      [{ total: 120 }],
    ]);

    const service = budgetService(dbStub.db as any);
    const block = await service.getInvocationBlock("11111111-1111-4111-8111-111111111111", "agent-1");

    expect(block).toEqual({
      scopeType: "agent",
      scopeId: "agent-1",
      scopeName: "Budget Agent",
      reason: "Agent cannot start because its budget hard-stop is still exceeded.",
    });
  });

  it("surfaces a budget-owned company pause distinctly from a manual pause", async () => {
    const dbStub = createDbStub([
      [{
        status: "idle",
        pauseReason: null,
        companyId: "11111111-1111-4111-8111-111111111111",
        name: "Budget Agent",
      }],
      [{
        status: "paused",
        pauseReason: "budget",
        name: "Paperclip",
      }],
    ]);

    const service = budgetService(dbStub.db as any);
    const block = await service.getInvocationBlock("11111111-1111-4111-8111-111111111111", "agent-1");

    expect(block).toEqual({
      scopeType: "company",
      scopeId: "11111111-1111-4111-8111-111111111111",
      scopeName: "Paperclip",
      reason: "Company is paused because its budget hard-stop was reached.",
    });
  });

  it("pauses an agent when a calendar-day token budget is exceeded, independent of billed_cents", async () => {
    const tokenPolicy = {
      id: "policy-tokens-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      scopeType: "agent",
      scopeId: "agent-1",
      metric: "total_tokens",
      windowKind: "calendar_day_utc",
      amount: 1_000_000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
    };

    const dbStub = createDbStub([
      [tokenPolicy],
      [{ total: 1_500_000 }],
      [],
      [{
        companyId: "11111111-1111-4111-8111-111111111111",
        name: "Budget Agent",
        status: "running",
        pauseReason: null,
      }],
    ]);

    dbStub.queueInsert([{
      id: "approval-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      status: "pending",
    }]);
    dbStub.queueInsert([{
      id: "incident-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      policyId: "policy-tokens-1",
      approvalId: "approval-1",
    }]);
    dbStub.queueUpdate([]);
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);

    const service = budgetService(dbStub.db as any, { cancelWorkForScope });
    await service.evaluateCostEvent({
      companyId: "11111111-1111-4111-8111-111111111111",
      agentId: "agent-1",
      projectId: null,
    } as any);

    expect(dbStub.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "11111111-1111-4111-8111-111111111111",
        policyId: "policy-tokens-1",
        metric: "total_tokens",
        windowKind: "calendar_day_utc",
        thresholdType: "hard",
        amountLimit: 1_000_000,
        amountObserved: 1_500_000,
      }),
    );
    expect(dbStub.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "paused",
        pauseReason: "budget",
      }),
    );
    expect(cancelWorkForScope).toHaveBeenCalledWith({
      companyId: "11111111-1111-4111-8111-111111111111",
      scopeType: "agent",
      scopeId: "agent-1",
    });
  });

  it("blocks new runs for an agent that already exceeded its daily token cap", async () => {
    const dbStub = createDbStub([
      [{
        status: "idle",
        pauseReason: null,
        companyId: "11111111-1111-4111-8111-111111111111",
        name: "Budget Agent",
      }],
      [{
        status: "active",
        name: "Paperclip",
      }],
      [],
      [{
        id: "policy-tokens-1",
        companyId: "11111111-1111-4111-8111-111111111111",
        scopeType: "agent",
        scopeId: "agent-1",
        metric: "total_tokens",
        windowKind: "calendar_day_utc",
        amount: 1_000_000,
        warnPercent: 80,
        hardStopEnabled: true,
        isActive: true,
      }],
      [{ total: 2_000_000 }],
    ]);

    const service = budgetService(dbStub.db as any);
    const block = await service.getInvocationBlock("11111111-1111-4111-8111-111111111111", "agent-1");

    expect(block).toEqual({
      scopeType: "agent",
      scopeId: "agent-1",
      scopeName: "Budget Agent",
      reason: "Agent cannot start because its budget hard-stop is still exceeded.",
    });
  });

  it("uses live observed spend when raising a budget incident", async () => {
    const dbStub = createDbStub([
      [{
        id: "incident-1",
        companyId: "11111111-1111-4111-8111-111111111111",
        policyId: "policy-1",
        amountObserved: 120,
        approvalId: "approval-1",
      }],
      [{
        id: "policy-1",
        companyId: "11111111-1111-4111-8111-111111111111",
        scopeType: "company",
        scopeId: "11111111-1111-4111-8111-111111111111",
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
      }],
      [{ total: 150 }],
    ]);

    const service = budgetService(dbStub.db as any);

    await expect(
      service.resolveIncident(
        "11111111-1111-4111-8111-111111111111",
        "incident-1",
        { action: "raise_budget_and_resume", amount: 140 },
        "board-user",
      ),
    ).rejects.toThrow("New budget must exceed current observed spend");
  });

  it("syncs company monthly budget when raising and resuming a company incident", async () => {
    const now = new Date();
    const dbStub = createDbStub([
      [{
        id: "incident-1",
        companyId: "11111111-1111-4111-8111-111111111111",
        policyId: "policy-1",
        scopeType: "company",
        scopeId: "11111111-1111-4111-8111-111111111111",
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        windowStart: now,
        windowEnd: now,
        thresholdType: "hard",
        amountLimit: 100,
        amountObserved: 120,
        status: "open",
        approvalId: "approval-1",
        resolvedAt: null,
        createdAt: now,
        updatedAt: now,
      }],
      [{
        id: "policy-1",
        companyId: "11111111-1111-4111-8111-111111111111",
        scopeType: "company",
        scopeId: "11111111-1111-4111-8111-111111111111",
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 100,
      }],
      [{ total: 120 }],
      [{ id: "approval-1", status: "approved" }],
      [{
        companyId: "11111111-1111-4111-8111-111111111111",
        name: "Paperclip",
        status: "paused",
        pauseReason: "budget",
        pausedAt: now,
      }],
    ]);

    const service = budgetService(dbStub.db as any);
    await service.resolveIncident(
      "11111111-1111-4111-8111-111111111111",
      "incident-1",
      { action: "raise_budget_and_resume", amount: 175 },
      "board-user",
    );

    expect(dbStub.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        budgetMonthlyCents: 175,
        updatedAt: expect.any(Date),
      }),
    );
  });
});

// Governance, 14 Sep: its $20 stop was approved and raised to $40 on 13 Sep.
// When it reached $40 the next day it was paused again, but the lookup found
// the resolved incident from the day before and returned it, so no new card
// was filed and nothing asked the operator anything.
describe("budgetService a second budget stop in the same month", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const agentPolicy = {
    id: "policy-1",
    companyId: "11111111-1111-4111-8111-111111111111",
    scopeType: "agent",
    scopeId: "agent-1",
    metric: "billed_cents",
    windowKind: "calendar_month_utc",
    amount: 4000,
    warnPercent: 80,
    hardStopEnabled: true,
    notifyEnabled: false,
    isActive: true,
  };
  const agentRow = { companyId: "11111111-1111-4111-8111-111111111111", name: "Governance", status: "running", pauseReason: null };

  function earlierIncident(overrides: Record<string, unknown>) {
    return {
      id: "incident-old",
      companyId: "11111111-1111-4111-8111-111111111111",
      policyId: "policy-1",
      thresholdType: "hard",
      amountLimit: 2000,
      amountObserved: 2010,
      status: "resolved",
      approvalId: "approval-old",
      ...overrides,
    };
  }

  async function reachLimit(existingIncidents: unknown[], policy: Record<string, unknown> = agentPolicy, observed = 4000) {
    const dbStub = createDbStub([[policy], [{ total: observed }], existingIncidents, [agentRow]]);
    dbStub.queueInsert([{ id: "approval-new", companyId: "11111111-1111-4111-8111-111111111111", status: "pending" }]);
    dbStub.queueInsert([{ id: "incident-new", companyId: "11111111-1111-4111-8111-111111111111", policyId: "policy-1", approvalId: "approval-new" }]);
    const service = budgetService(dbStub.db as any, { cancelWorkForScope: vi.fn().mockResolvedValue(undefined) });
    await service.evaluateCostEvent({ companyId: "11111111-1111-4111-8111-111111111111", agentId: "agent-1", projectId: null } as any);
    return dbStub;
  }

  function newCardFiled(dbStub: ReturnType<typeof createDbStub>) {
    return dbStub.insertValues.mock.calls.some(
      ([values]) => (values as { type?: string }).type === "budget_override_required",
    );
  }

  it("files a new card when the agent reaches its raised limit after the earlier stop was approved", async () => {
    const dbStub = await reachLimit([earlierIncident({})]);

    expect(newCardFiled(dbStub)).toBe(true);
    expect(dbStub.updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: "paused", pauseReason: "budget" }));
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "budget.hard_threshold_crossed",
        entityId: "incident-new",
        details: expect.objectContaining({ approvalId: "approval-new", amountLimit: 4000 }),
      }),
    );
  });

  it("files a new card even when the limit was later set back to the one the earlier stop was at", async () => {
    const dbStub = await reachLimit([earlierIncident({ amountLimit: 4000 })]);

    expect(newCardFiled(dbStub)).toBe(true);
  });

  it("still reuses an incident that is open, so one breach gets one card", async () => {
    const dbStub = await reachLimit([earlierIncident({ id: "incident-open", status: "open", amountLimit: 4000, approvalId: "approval-open" })]);

    expect(newCardFiled(dbStub)).toBe(false);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "budget.hard_threshold_crossed", entityId: "incident-open" }),
    );
  });

  it("does not raise the same warning again after a stop resolved it while the limit is unchanged", async () => {
    const dbStub = await reachLimit(
      [earlierIncident({ id: "soft-old", thresholdType: "soft", amountLimit: 4000, approvalId: null })],
      { ...agentPolicy, notifyEnabled: true },
      3500,
    );

    expect(dbStub.insertValues).not.toHaveBeenCalled();
  });
});
