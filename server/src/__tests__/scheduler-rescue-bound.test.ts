import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createDb,
  createRequestScopedDb,
  getAppPoolMax,
  runInCompanyScopeBypass,
  withCompanyScope,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  createSchedulerTickSingleFlight,
  describeSchedulerRescues,
  describeStuckSchedulerChain,
  maxAbandonedInFlightFor,
  WEDGED_AFTER_MS,
  type TickSingleFlightLogger,
} from "../services/scheduler-tick-single-flight.js";
import { timeTickPhase, withTickPhases } from "../services/scheduler-tick-phases.js";
import { summarizeFleetHealth, computeFleetSlotUsage } from "../services/fleet-health.js";

// DUR-3991 follow-up, against a real database and through the real entry
// point the scheduler uses (runInCompanyScopeBypass on its own pool).
//
// What an abandoned scheduler tick can still be holding is the whole reason
// the watchdog's rescues are bounded: a tick that never settles never reaches
// the `finally` that releases its reserved connection, and if it hung inside a
// transaction that transaction stays open too. These tests make real ticks
// hang exactly like that and check three things:
//   1. the rescue names the phase the tick was stuck in, read from inside it;
//   2. the rescue bound holds: never more abandoned ticks than it allows, so
//      real connections are left over and another chain still completes;
//   3. the operator is told plainly, once the bound is hit, that a restart is
//      needed.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres scheduler rescue tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function captureLog() {
  const lines: Array<{ level: string; fields: Record<string, unknown>; msg: string }> = [];
  const log: TickSingleFlightLogger = {
    info: (fields, msg) => lines.push({ level: "info", fields, msg }),
    warn: (fields, msg) => lines.push({ level: "warn", fields, msg }),
    error: (fields, msg) => lines.push({ level: "error", fields, msg }),
  };
  return { lines, log };
}

/** Rejects rather than hanging, so a wedge fails the test instead of timing the suite out. */
async function within<T>(label: string, ms: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describeEmbeddedPostgres("DUR-3991: bounded scheduler rescues against a real database", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let bypassDb!: ReturnType<typeof createDb>;
  // A separate pool for looking at the database from outside, so the
  // observation never competes with the pool under test.
  let observer!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-scheduler-rescue-");
    observer = createDb(tempDb.connectionString);
    await observer.execute(sql`GRANT paperclip_app_bypass TO CURRENT_USER`);
    // The same construction index.ts uses for the scheduler's bypass pool.
    bypassDb = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** Connections sitting inside a transaction nobody is finishing. */
  async function idleInTransaction(): Promise<number> {
    const rows = (await observer.execute(sql`
      select count(*)::int as n from pg_stat_activity
      where datname = current_database() and state = 'idle in transaction' and pid <> pg_backend_pid()
    `)) as unknown as Array<{ n: number }>;
    return Number(rows[0]!.n);
  }

  it("names the stuck phase, holds the bound, and leaves the pool usable for every other chain", async () => {
    const scopedDb = createRequestScopedDb(bypassDb);
    const poolMax = getAppPoolMax();
    const bound = maxAbandonedInFlightFor(poolMax);
    expect(bound).toBe(3);

    let clock = Date.parse("2026-09-18T03:00:00.000Z");
    const { lines, log } = captureLog();
    const guard = createSchedulerTickSingleFlight({ now: () => clock, log, bypassPoolMax: poolMax });

    // A tick shaped like tickTimers: load the agents, then wake them one by
    // one -- and hang while waking one, INSIDE a transaction on the tick's
    // reserved connection. Each copy has its own hang so the test can let it
    // go at the end.
    const hangs: Array<() => void> = [];
    let starts = 0;
    const wedgingTick = () => {
      starts += 1;
      let release!: () => void;
      const hung = new Promise<void>((resolve) => {
        release = resolve;
      });
      hangs.push(release);
      let reached!: () => void;
      const reachedHang = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const chain = runInCompanyScopeBypass(
        bypassDb,
        { reason: "rescue test tick", actorType: "scheduler", route: "heartbeat-scheduler:tickTimers" },
        () =>
          withTickPhases(async () => {
            await timeTickPhase("loadAgents", async () => {
              await scopedDb.execute(sql`select 1`);
            });
            await timeTickPhase("wakeAgents", () =>
              timeTickPhase("wakeAgent", () =>
                withCompanyScope(scopedDb, randomUUID(), async (tx) => {
                  await tx.execute(sql`select 2`);
                  reached();
                  await hung;
                }),
              ),
            );
          }),
      );
      return { chain, reachedHang };
    };
    let lastReached: Promise<void> = Promise.resolve();
    const run = () =>
      guard.run("tickTimers", () => {
        const { chain, reachedHang } = wedgingTick();
        lastReached = reachedHang;
        return chain;
      });

    void run();
    await within("first tick reaching its hang", 10_000, lastReached);
    expect(await idleInTransaction()).toBe(1);

    // Rescue up to the bound. Each rescue reads where the abandoned tick was.
    for (let rescue = 1; rescue <= bound; rescue += 1) {
      clock += WEDGED_AFTER_MS;
      void run();
      await within(`replacement ${rescue} reaching its hang`, 10_000, lastReached);
      const last = guard.diagnostics().lastRescue!;
      expect(last).toMatchObject({
        chain: "tickTimers",
        stuckPhase: "wakeAgent",
        phasesMeasured: true,
        runningMs: WEDGED_AFTER_MS,
      });
      expect(last.openPhases.map((p) => p.phase)).toEqual(["wakeAgents", "wakeAgent"]);
      expect(last.completedPhases.map((p) => p.phase)).toEqual(["loadAgents"]);
    }
    expect(starts).toBe(bound + 1);
    // Every abandoned tick really is still holding its connection and its
    // open transaction -- the resource the bound exists to protect.
    expect(await idleInTransaction()).toBe(bound + 1);

    // One clear log line per rescue, naming the stuck phase.
    const rescueLines = lines.filter((l) => l.level === "error" && l.msg.includes("abandoning it"));
    expect(rescueLines).toHaveLength(bound);
    expect(rescueLines[0]!.msg).toContain('stuck in phase "wakeAgent"');
    expect(rescueLines[0]!.msg).toContain("finished: loadAgents");
    expect(rescueLines[0]!.fields).toMatchObject({ stuckPhase: "wakeAgent" });

    // The bound holds: the next wedge is NOT rescued, however long it lasts.
    for (let tick = 0; tick < 20; tick += 1) {
      clock += WEDGED_AFTER_MS;
      await run();
    }
    expect(starts).toBe(bound + 1);
    expect(guard.diagnostics().abandonedInFlightTotal).toBe(bound);
    expect(await idleInTransaction()).toBe(bound + 1);

    // ...so the pool still has connections for every other chain.
    let otherChainRan = false;
    await within(
      "another scheduler chain on the same pool",
      10_000,
      guard.run("agentErrorAlerts", () =>
        runInCompanyScopeBypass(
          bypassDb,
          { reason: "rescue test other chain", actorType: "scheduler", route: "heartbeat-scheduler:agentErrorAlerts" },
          async () => {
            await scopedDb.execute(sql`select 3`);
            otherChainRan = true;
          },
        ),
      ),
    );
    expect(otherChainRan).toBe(true);

    // And the operator is told, in plain words, that only a restart is left.
    const stuck = describeStuckSchedulerChain(guard.snapshot());
    expect(stuck).toMatchObject({ label: "waking agents on their timers", restartNeeded: true });
    const rescues = describeSchedulerRescues(guard.snapshot(), guard.diagnostics());
    expect(rescues).toMatchObject({
      total: bound,
      abandonedStillRunning: bound,
      maxAbandonedStillRunning: bound,
      restartNeededFor: ["waking agents on their timers"],
    });
    expect(rescues.last).toMatchObject({
      stuckPhase: "wakeAgent",
      stuckPhaseLabel: "waking one of the agents that was due",
    });
    const summary = summarizeFleetHealth({
      runs: {
        windowMinutes: 15,
        startedInWindow: 0,
        succeededInWindow: 0,
        failedInWindow: 0,
        cancelledInWindow: 0,
        running: 0,
        queued: 0,
        queuedWithNoRunningAgent: 0,
        oldestQueuedWaitMs: null,
        zombieCandidates: 0,
        zombieSilenceMinutes: 30,
      },
      slots: computeFleetSlotUsage(4, 0),
      agents: { inError: 0, inErrorSample: [] },
      scheduler: {
        enabled: true,
        intervalMs: 30_000,
        lastTickStartedAt: null,
        lastTickFinishedAt: null,
        lastTickResult: null,
        lastTickError: null,
        sinceLastTickMs: null,
        stale: true,
        stuckChain: stuck,
        rescues,
      },
      requests: {
        inFlight: 0,
        streaming: 0,
        peakInFlight: 0,
        peakInFlightAt: null,
        longestInFlightMs: 0,
        slowInFlight: 0,
        slowThresholdMs: 10_000,
        overloadThreshold: 50,
        overloaded: false,
        totalStarted: 0,
        totalFinished: 0,
      },
      database: { available: false, poolMax: null, connections: null, active: null, idleInTransaction: null, waitingOnLocks: null },
      quietMode: {
        active: false,
        activatedAt: null,
        activeForMs: null,
        activatedReason: null,
        stuckAfterMinutes: 30,
        stuck: false,
        activatedForDeploy: false,
      },
      now: new Date(clock),
    });
    expect(summary.level).toBe("critical");
    expect(summary.headline).toContain("restarting the server is the only thing left");
    expect(summary.notes.join("\n")).toContain(
      "The scheduler got stuck while waking one of the agents that was due (part of waking agents on their timers) " +
        "and was restarted automatically at",
    );

    // Let every hung tick go: each settles, releases its connection, and hands
    // its share of the bound back.
    for (const release of hangs) release();
    await within(
      "abandoned ticks settling",
      15_000,
      (async () => {
        while (guard.diagnostics().abandonedInFlightTotal > 0 || guard.snapshot()[0]!.inFlight) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      })(),
    );
    expect(await idleInTransaction()).toBe(0);
  }, 60_000);
});
