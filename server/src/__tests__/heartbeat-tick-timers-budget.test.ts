import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
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
    `Skipping embedded Postgres tickTimers budget tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DUR-3991: on 2026-09-17 the tickTimers chain did not return. Every tick after
// it was skipped by the DUR-385 single-flight guard, the Now page said the
// scheduler had never completed a tick, and no agent was woken by anything
// until the server was restarted by hand.
//
// The guard's watchdog is the backstop. This is the part that makes the
// backstop rarely necessary: the chain gives itself a budget and each wake-up a
// deadline, so it always ends -- and it wakes the longest-waiting agents first,
// so ending early can never starve the same agents twice.
describeEmbeddedPostgres("heartbeat tickTimers always ends", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-tick-timers-budget-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** Three agents, all long overdue, each waiting a different length of time. */
  async function seedThreeOverdueAgents() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Budget Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const runtimeConfig = { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } };
    // Inserted newest-waiting first so a plain (no ORDER BY) scan returns them
    // in the opposite order to the one the tick should use.
    const seeded = [
      { id: randomUUID(), name: "Waited least", lastHeartbeatAt: new Date("2026-06-04T00:09:00Z") },
      { id: randomUUID(), name: "Waited middle", lastHeartbeatAt: new Date("2026-06-04T00:05:00Z") },
      { id: randomUUID(), name: "Waited longest", lastHeartbeatAt: new Date("2026-06-04T00:00:00Z") },
    ];
    for (const agent of seeded) {
      await db.insert(agents).values({
        id: agent.id,
        companyId,
        name: agent.name,
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig,
        permissions: {},
        lastHeartbeatAt: agent.lastHeartbeatAt,
      });
    }
    return { companyId, seeded };
  }

  const tickAt = new Date("2026-06-04T01:00:00Z");

  it("stops at its budget instead of running forever, and says how many it did not reach", async () => {
    await seedThreeOverdueAgents();

    // A budget of zero is the extreme of the same rule the real 2-minute one
    // applies: the tick ends, reports the shortfall, and leaves the rest.
    const heartbeat = heartbeatService(db, { timerTickBudgetMs: 0 });
    const result = await heartbeat.tickTimers(tickAt);

    expect(result.agentsDue).toBe(3);
    expect(result.agentsNotReached).toBe(3);
    expect(result.enqueued).toBe(0);
    // Nothing was attempted, and -- the point -- the call returned at all.
    expect(await db.select({ agentId: agentWakeupRequests.agentId }).from(agentWakeupRequests)).toEqual([]);
  });

  it("wakes the longest-waiting agents first, so a short tick can never starve the same ones", async () => {
    const { seeded } = await seedThreeOverdueAgents();

    // Enough budget for one agent's work, not three: the deadline is checked
    // between agents, so exactly one gets through before time is up.
    const heartbeat = heartbeatService(db, { timerTickBudgetMs: 1 });
    const result = await heartbeat.tickTimers(tickAt);

    expect(result.agentsDue).toBe(3);
    expect(result.agentsNotReached).toBe(2);

    const reached = await db.select({ agentId: agentWakeupRequests.agentId }).from(agentWakeupRequests);
    const reachedIds = new Set(reached.map((row) => row.agentId));
    // "Waited longest" is last in insertion order and first in wake order.
    expect(reachedIds.has(seeded[2]!.id)).toBe(true);
    expect(reachedIds.has(seeded[0]!.id)).toBe(false);
  });

  it("reaches every due agent when it has the time, and reports no shortfall", async () => {
    await seedThreeOverdueAgents();

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(tickAt);

    expect(result.agentsDue).toBe(3);
    expect(result.agentsNotReached).toBe(0);
    expect(result.agentsTimedOut).toBe(0);
    expect(result.phases.phases.find((phase) => phase.phase === "wakeAgent")?.count).toBe(3);
  });

  it("gives up on a wake-up that will not finish, and the tick still ends", async () => {
    await seedThreeOverdueAgents();

    // A one-millisecond deadline stands in for a wake-up that never settles:
    // no real wake-up can beat it. The tick ends -- which on 2026-09-17 is
    // precisely what did not happen.
    const heartbeat = heartbeatService(db, { timerWakeTimeoutMs: 1 });
    const result = await heartbeat.tickTimers(tickAt);

    expect(result.agentsDue).toBe(3);
    expect(result.agentsTimedOut).toBe(1);
    expect(result.enqueued).toBe(0);

    // It stops at the first one, on purpose. A deadline does not cancel the
    // work behind it: the abandoned wake-up still holds this chain's one
    // reserved connection and may still have a transaction open on it, so
    // nothing else may use that connection this tick. The two agents left go
    // first next tick, because the tick wakes the longest-waiting first.
    expect(result.agentsNotReached).toBe(2);
    expect(result.phases.phases.find((phase) => phase.phase === "wakeAgent")?.count).toBe(1);
    // The trailing sweeps are skipped for the same reason.
    expect(result.phases.phases.map((phase) => phase.phase)).not.toContain("customerInboxHandoff");
  });
});
