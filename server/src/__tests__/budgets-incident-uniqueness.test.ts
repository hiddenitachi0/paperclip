import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
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
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { logger } from "../middleware/logger.js";
import { agentService } from "../services/agents.ts";
import { budgetService } from "../services/budgets.ts";
import { costService } from "../services/costs.ts";

/**
 * Budget incidents against a real database (16 Sep regression).
 *
 * PR #301 stopped reusing a resolved hard incident so a second budget stop in
 * the same month files a new card. Its tests used a DB stub, so they never
 * met the unique index on budget_incidents, which still counted resolved
 * incidents: the new incident was refused with a duplicate-key error (138
 * times in three hours, on the 80% warning as well as the hard stop), the
 * card inserted just before it was left behind, the agent was not paused, and
 * the error escaped into the heartbeat as "heartbeat execution failed".
 *
 * Everything here goes through the real schema and migrations, and spend is
 * recorded through costService.createEvent, the same call a heartbeat makes
 * after a run, so "createEvent resolves" is "the heartbeat is not failed".
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres budget incident tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const PAPERWORK_FAILURE_LINE = "Budget limit reached, but the budget record could not be saved";

describeEmbeddedPostgres("budget incidents and their cards on a real database", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let loggerError: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("budget-incident-uniqueness");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 60_000);

  beforeEach(() => {
    loggerError = vi.spyOn(logger, "error");
  });

  afterEach(async () => {
    loggerError.mockRestore();
    await db.execute(sql`DROP TRIGGER IF EXISTS test_fail_budget_incident_insert ON budget_incidents`);
    await db.delete(activityLog);
    await db.delete(budgetIncidents);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(costEvents);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Nordstrand",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agent = await agentService(db).create(companyId, {
      name: "Tech Boss",
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

  async function setPolicy(
    companyId: string,
    agentId: string,
    amount: number,
    options: { notifyEnabled?: boolean; actorUserId?: string | null } = {},
  ) {
    return budgetService(db).upsertPolicy(
      companyId,
      {
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: options.notifyEnabled ?? false,
        isActive: true,
      },
      options.actorUserId ?? null,
    );
  }

  /** Records spend exactly the way a heartbeat does after a run. */
  function spend(companyId: string, agentId: string, costCents: number) {
    return costService(db).createEvent(companyId, {
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      model: "claude-sonnet-5",
      inputTokens: 1,
      outputTokens: 1,
      costCents,
      occurredAt: new Date(),
    });
  }

  async function incidentsFor(companyId: string, thresholdType: "soft" | "hard") {
    return db
      .select()
      .from(budgetIncidents)
      .where(and(eq(budgetIncidents.companyId, companyId), eq(budgetIncidents.thresholdType, thresholdType)))
      .orderBy(budgetIncidents.createdAt);
  }

  async function cardsFor(companyId: string) {
    return db
      .select()
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), eq(approvals.type, "budget_override_required")))
      .orderBy(approvals.createdAt);
  }

  async function agentRow(agentId: string) {
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    return row!;
  }

  function paperworkFailureLogs() {
    return loggerError.mock.calls.filter((call) =>
      call.some((arg) => typeof arg === "string" && arg.includes(PAPERWORK_FAILURE_LINE)),
    );
  }

  async function installIncidentInsertFailure() {
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION test_fail_budget_incident_insert() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected failure writing budget incident';
      END
      $$ LANGUAGE plpgsql
    `);
    await db.execute(sql`
      CREATE TRIGGER test_fail_budget_incident_insert
      BEFORE INSERT ON budget_incidents
      FOR EACH ROW EXECUTE FUNCTION test_fail_budget_incident_insert()
    `);
  }

  it("(a) files a new incident and a new card when the raised limit is reached in the same month", async () => {
    const { companyId, agentId } = await seedAgent();
    await setPolicy(companyId, agentId, 1000);

    await spend(companyId, agentId, 1000);
    const [firstStop] = await incidentsFor(companyId, "hard");
    expect(firstStop?.status).toBe("open");
    expect((await agentRow(agentId)).status).toBe("paused");

    await budgetService(db).resolveIncident(
      companyId,
      firstStop!.id,
      { action: "raise_budget_and_resume", amount: 2000 },
      "board-user",
    );
    expect((await agentRow(agentId)).status).toBe("idle");

    await expect(spend(companyId, agentId, 1000)).resolves.toBeTruthy();

    const hard = await incidentsFor(companyId, "hard");
    expect(hard.map((row) => [row.status, row.amountLimit])).toEqual([
      ["resolved", 1000],
      ["open", 2000],
    ]);
    const cards = await cardsFor(companyId);
    expect(cards.map((card) => card.status)).toEqual(["approved", "pending"]);
    expect(hard[1]!.approvalId).toBe(cards[1]!.id);
    expect((await agentRow(agentId)).status).toBe("paused");
    expect(paperworkFailureLogs()).toHaveLength(0);
  });

  it("(b) files a new incident and card when the operator lowers the limit back below spend", async () => {
    const { companyId, agentId } = await seedAgent();
    await setPolicy(companyId, agentId, 1000);
    await spend(companyId, agentId, 1000);
    const [firstStop] = await incidentsFor(companyId, "hard");
    await budgetService(db).resolveIncident(
      companyId,
      firstStop!.id,
      { action: "raise_budget_and_resume", amount: 2000 },
      "board-user",
    );

    // Back to the limit the first stop was at, which spend already reaches.
    await expect(setPolicy(companyId, agentId, 1000, { actorUserId: "board-user" })).resolves.toBeTruthy();

    const hard = await incidentsFor(companyId, "hard");
    expect(hard.map((row) => [row.status, row.amountLimit])).toEqual([
      ["resolved", 1000],
      ["open", 1000],
    ]);
    const cards = await cardsFor(companyId);
    expect(cards.map((card) => card.status)).toEqual(["approved", "pending"]);
    expect(hard[1]!.approvalId).toBe(cards[1]!.id);
    expect((await agentRow(agentId)).status).toBe("paused");
    expect(paperworkFailureLogs()).toHaveLength(0);
  });

  it("(c) reuses a still-open incident, so one breach has one card", async () => {
    const { companyId, agentId } = await seedAgent();
    await setPolicy(companyId, agentId, 1000);

    await spend(companyId, agentId, 1000);
    await spend(companyId, agentId, 50);
    await spend(companyId, agentId, 50);

    const hard = await incidentsFor(companyId, "hard");
    expect(hard).toHaveLength(1);
    expect(hard[0]!.status).toBe("open");
    expect(await cardsFor(companyId)).toHaveLength(1);
  });

  async function recordCostRowAtLimit(companyId: string, agentId: string, costCents: number) {
    const [event] = await db
      .insert(costEvents)
      .values({
        companyId,
        agentId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "metered_api",
        model: "claude-sonnet-5",
        inputTokens: 1,
        outputTokens: 1,
        costCents,
        occurredAt: new Date(),
      })
      .returning();
    return event!;
  }

  it("(d) a cost event that loses the race to file the incident reuses the winner's, with one card", async () => {
    const { companyId, agentId } = await seedAgent();
    await setPolicy(companyId, agentId, 1000);
    const event = await recordCostRowAtLimit(companyId, agentId, 1000);
    const [policy] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, companyId));
    const windowStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const windowEnd = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1));

    // The winner: another cost event's transaction that has written its card
    // and its open incident but not committed yet, so the one under test
    // finds nothing to reuse and has to meet it at the unique index.
    let releaseWinner!: () => void;
    const winnerMayCommit = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    let winnerWrote!: () => void;
    const winnerHasWritten = new Promise<void>((resolve) => {
      winnerWrote = resolve;
    });
    let winnerIncidentId = "";
    const winner = db.transaction(async (tx) => {
      const [card] = await tx
        .insert(approvals)
        .values({ companyId, type: "budget_override_required", status: "pending", payload: {} })
        .returning();
      const [incident] = await tx
        .insert(budgetIncidents)
        .values({
          companyId,
          policyId: policy!.id,
          scopeType: "agent",
          scopeId: agentId,
          metric: "billed_cents",
          windowKind: "calendar_month_utc",
          windowStart,
          windowEnd,
          thresholdType: "hard",
          amountLimit: 1000,
          amountObserved: 1000,
          status: "open",
          approvalId: card!.id,
        })
        .returning();
      winnerIncidentId = incident!.id;
      winnerWrote();
      await winnerMayCommit;
    });
    await winnerHasWritten;

    const loser = budgetService(db).evaluateCostEvent(event);
    const loserOutcome = loser.then(
      () => "resolved",
      (err: unknown) => err,
    );

    // Wait until the loser is actually blocked on the winner's uncommitted
    // incident, so the race is certain rather than a matter of timing.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [row] = (await db.execute(sql`
        SELECT count(*)::int AS waiting
        FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE 'insert into "budget_incidents"%'
      `)) as unknown as { waiting: number }[];
      if ((row?.waiting ?? 0) > 0) break;
      if (Date.now() > deadline) throw new Error("the second cost event never reached the incident insert");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    releaseWinner();
    await winner;

    expect(await loserOutcome).toBe("resolved");
    const hard = await incidentsFor(companyId, "hard");
    expect(hard.map((row) => [row.id, row.status])).toEqual([[winnerIncidentId, "open"]]);
    const cards = await cardsFor(companyId);
    expect(cards).toHaveLength(1);
    expect(hard[0]!.approvalId).toBe(cards[0]!.id);
    expect((await agentRow(agentId)).status).toBe("paused");
    expect(paperworkFailureLogs()).toHaveLength(0);
  });

  it("(d) many cost events at the limit at once make exactly one open incident and one card", async () => {
    const { companyId, agentId } = await seedAgent();
    await setPolicy(companyId, agentId, 1000);
    const event = await recordCostRowAtLimit(companyId, agentId, 1000);
    // Open the pool's connections first, so the evaluations overlap instead
    // of queueing behind connection setup.
    await Promise.all(Array.from({ length: 8 }, () => db.execute(sql`SELECT pg_sleep(0.05)`)));

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => budgetService(db).evaluateCostEvent(event)),
    );

    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    const hard = await incidentsFor(companyId, "hard");
    expect(hard).toHaveLength(1);
    expect(hard[0]!.status).toBe("open");
    const cards = await cardsFor(companyId);
    expect(cards).toHaveLength(1);
    expect(hard[0]!.approvalId).toBe(cards[0]!.id);
    expect(paperworkFailureLogs()).toHaveLength(0);
  });

  it("(e) a failure writing the incident leaves no card behind", async () => {
    const { companyId, agentId } = await seedAgent();
    await setPolicy(companyId, agentId, 1000);
    await installIncidentInsertFailure();

    await spend(companyId, agentId, 1000).catch(() => undefined);

    expect(await incidentsFor(companyId, "hard")).toHaveLength(0);
    expect(await cardsFor(companyId)).toHaveLength(0);
  });

  it("(f) a failure writing the incident still pauses the agent, fails no heartbeat, and is logged once", async () => {
    const { companyId, agentId } = await seedAgent();
    await setPolicy(companyId, agentId, 1000);
    await installIncidentInsertFailure();

    await expect(spend(companyId, agentId, 1000)).resolves.toBeTruthy();
    const paused = await agentRow(agentId);
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason).toBe("budget");

    // Work that was already running finishes and reports its cost: still no
    // failed heartbeat, and the same failure is not logged again each time.
    await expect(spend(companyId, agentId, 10)).resolves.toBeTruthy();
    await expect(spend(companyId, agentId, 10)).resolves.toBeTruthy();
    expect(paperworkFailureLogs()).toHaveLength(1);

    const block = await budgetService(db).getInvocationBlock(companyId, agentId);
    expect(block?.scopeType).toBe("agent");
  });

  it("(g) does not raise the warning again after a hard stop resolved it at the same limit", async () => {
    const { companyId, agentId } = await seedAgent();
    await setPolicy(companyId, agentId, 1000, { notifyEnabled: true });

    await spend(companyId, agentId, 800);
    expect((await incidentsFor(companyId, "soft")).map((row) => row.status)).toEqual(["open"]);

    await spend(companyId, agentId, 200);
    await spend(companyId, agentId, 10);
    await spend(companyId, agentId, 10);

    expect((await incidentsFor(companyId, "soft")).map((row) => row.status)).toEqual(["resolved"]);
    expect((await incidentsFor(companyId, "hard")).map((row) => row.status)).toEqual(["open"]);
    expect(await cardsFor(companyId)).toHaveLength(1);
    expect(paperworkFailureLogs()).toHaveLength(0);
  });

  it("(h) a warning at one limit, a raise, then 80% of the new limit gives one new warning and no failed heartbeat", async () => {
    // Tech Boss, 16 Sep: warning created 14 Sep, limit raised afterwards,
    // then every cost event hit the duplicate key on the warning insert.
    const { companyId, agentId } = await seedAgent();
    await setPolicy(companyId, agentId, 1000, { notifyEnabled: true });

    await spend(companyId, agentId, 850);
    expect((await incidentsFor(companyId, "soft")).map((row) => [row.status, row.amountLimit])).toEqual([
      ["open", 1000],
    ]);

    await setPolicy(companyId, agentId, 2000, { notifyEnabled: true, actorUserId: "board-user" });

    await expect(spend(companyId, agentId, 800)).resolves.toBeTruthy();
    await expect(spend(companyId, agentId, 10)).resolves.toBeTruthy();

    expect((await incidentsFor(companyId, "soft")).map((row) => [row.status, row.amountLimit])).toEqual([
      ["resolved", 1000],
      ["open", 2000],
    ]);
    expect(await incidentsFor(companyId, "hard")).toHaveLength(0);
    expect((await agentRow(agentId)).status).not.toBe("paused");
    expect(paperworkFailureLogs()).toHaveLength(0);
  });

  it("allows only one open incident per policy, window and threshold, but any number of resolved ones", async () => {
    const { companyId, agentId } = await seedAgent();
    await setPolicy(companyId, agentId, 5000);
    const [policy] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, companyId));
    const windowStart = new Date(Date.UTC(2026, 8, 1));
    const row = (status: string) => ({
      companyId,
      policyId: policy!.id,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      windowStart,
      windowEnd: new Date(Date.UTC(2026, 9, 1)),
      thresholdType: "hard",
      amountLimit: 1000,
      amountObserved: 1000,
      status,
    });

    await db.insert(budgetIncidents).values([row("resolved"), row("resolved"), row("dismissed"), row("open")]);
    await expect(db.insert(budgetIncidents).values(row("open"))).rejects.toThrow();
  });
});
