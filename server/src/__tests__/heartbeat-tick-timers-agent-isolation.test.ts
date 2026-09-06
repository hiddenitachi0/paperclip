import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres tickTimers agent-isolation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DUR-3932: tickTimers iterates every heartbeat-eligible agent and calls
// enqueueWakeup for each one that's due. enqueueWakeup can throw a `conflict`
// error for reasons that have nothing to do with whether the *rest* of the
// fleet should still get ticked -- most notably a budget hard-stop that's
// exceeded on paper (via a fresh cost-event sum) before the pause side effect
// has caught up to the agent's `status` column, e.g. right after an operator
// lowers a budget policy's amount below already-accumulated spend. Before the
// fix, one such agent aborted the whole `for` loop and every agent queried
// after it that tick silently never got a wakeup attempt at all.
describeEmbeddedPostgres("heartbeat tickTimers per-agent isolation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-tick-timers-agent-isolation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(costEvents);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("still ticks agents queried after one whose enqueueWakeup throws", async () => {
    const companyId = randomUUID();
    const overBudgetAgentId = randomUUID();
    const healthyAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Isolation Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const heartbeatPolicy = {
      heartbeat: {
        enabled: true,
        intervalSec: 60,
        wakeOnDemand: true,
      },
    };

    // Inserted first so a plain (no ORDER BY) scan returns it before the
    // healthy agent below -- reproducing the "poison pill early in the
    // iteration order" shape of the production incident.
    await db.insert(agents).values({
      id: overBudgetAgentId,
      companyId,
      name: "Over Budget Agent",
      role: "engineer",
      // Left "idle" (not "paused") on purpose: this is exactly the gap --
      // the agent is over its hard-stop by a fresh sum of cost_events, but
      // nothing has run the pause side effect yet, so status-based
      // invokability checks still say it's invokable.
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: heartbeatPolicy,
      permissions: {},
      lastHeartbeatAt: new Date("2026-06-04T00:00:00Z"),
    });

    await db.insert(agents).values({
      id: healthyAgentId,
      companyId,
      name: "Healthy Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: heartbeatPolicy,
      permissions: {},
      lastHeartbeatAt: new Date("2026-06-04T00:00:00Z"),
    });

    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: overBudgetAgentId,
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 10,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
    });

    await db.insert(costEvents).values({
      companyId,
      agentId: overBudgetAgentId,
      provider: "test",
      biller: "test",
      billingType: "test",
      model: "test-model",
      costCents: 1000,
      occurredAt: new Date("2026-06-03T00:00:00Z"),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(new Date("2026-06-04T00:10:00Z"));

    // Both agents were checked; neither produced a run (the over-budget one
    // is blocked, the healthy one has no assigned work to act on), but both
    // were *reached* -- that's the point being tested.
    expect(result).toMatchObject({ checked: 2, enqueued: 0, skipped: 2 });

    // Before the fix, the over-budget agent's thrown conflict aborted the
    // whole `for` loop and the healthy agent -- queried right after it, with
    // no ORDER BY to save it -- would never get an agentWakeupRequests row at
    // all. Seeing a row for *both* agents proves the loop didn't die partway
    // through.
    const wakeups = await db
      .select({ agentId: agentWakeupRequests.agentId, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests);
    expect(wakeups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: overBudgetAgentId, reason: "budget.blocked" }),
        expect.objectContaining({ agentId: healthyAgentId, reason: "heartbeat.timer.no_actionable_work" }),
      ]),
    );

    const runs = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns);
    expect(runs.some((row) => row.agentId === overBudgetAgentId)).toBe(false);
  });
});
