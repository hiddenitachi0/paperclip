import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, getAppPoolMax, runInCompanyScopeBypass } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { BEFORE_TICK_PHASE, timeTickPhase, withTickPhases } from "../services/scheduler-tick-phases.js";
import {
  createSchedulerTickSingleFlight,
  describeSchedulerRescues,
  SCHEDULER_TICK_CHAINS,
  TICK_PHASE_TIMED_CHAINS,
  WEDGED_AFTER_MS,
  type TickSingleFlightLogger,
} from "../services/scheduler-tick-single-flight.js";
import { buildSchedulerRescueNotice } from "../services/fleet-health.js";

// DUR-3991 review follow-up: tickTimers' phase recorder only opens INSIDE
// runInCompanyScopeBypass, after it has awaited a reserved connection (no
// timeout) and a role check. A hang there -- the likeliest shape of a hang
// right after a restart -- used to be reported as "its steps are not timed",
// which was false and pointed away from the connection wait.

interface CapturedLine {
  level: "info" | "warn" | "error";
  fields: Record<string, unknown>;
  msg: string;
}

function captureLog() {
  const lines: CapturedLine[] = [];
  const log: TickSingleFlightLogger = {
    info: (fields, msg) => lines.push({ level: "info", fields, msg }),
    warn: (fields, msg) => lines.push({ level: "warn", fields, msg }),
    error: (fields, msg) => lines.push({ level: "error", fields, msg }),
  };
  return { lines, log };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

describe("DUR-3991 which chains time their steps", () => {
  it("matches the real withTickPhases() call sites, so a timed chain is never called untimed", () => {
    const heartbeatSource = readFileSync(new URL("../services/heartbeat.ts", import.meta.url), "utf8");
    const timedInSource = SCHEDULER_TICK_CHAINS.filter((chain) =>
      new RegExp(`\\b${chain}: async[^\\n]*\\n\\s*withTickPhases\\(`).test(heartbeatSource),
    );
    expect(timedInSource).toEqual(["tickTimers"]);
    expect([...TICK_PHASE_TIMED_CHAINS].sort()).toEqual([...timedInSource].sort());
    // And nothing else in the services opens a recorder a chain would need listing for.
    const opened = heartbeatSource.match(/\bwithTickPhases\(/g) ?? [];
    expect(opened).toHaveLength(1);
  });

  it("still says a chain that times nothing is not timed", async () => {
    let clock = 0;
    const { lines, log } = captureLog();
    const guard = createSchedulerTickSingleFlight({ now: () => clock, log, bypassPoolMax: 10 });
    const never = new Promise<void>(() => {});
    void guard.run("mergePrAutomation", () => never);
    await flush();
    clock = WEDGED_AFTER_MS;
    void guard.run("mergePrAutomation", () => never);
    await flush();
    const error = lines.find((l) => l.level === "error")!;
    expect(error.msg).toContain("(its steps are not timed)");
    const rescues = describeSchedulerRescues(guard.snapshot(), guard.diagnostics());
    expect(rescues.last).toMatchObject({ phasesMeasured: false, stuckPhase: null });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("DUR-3991 a tick stuck waiting for its database connection", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-scheduler-before-tick-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("names the connection wait when reserve() hangs on an exhausted pool", async () => {
    // Take every connection in the pool, so the tick's reserve() waits forever.
    const held = await Promise.all(Array.from({ length: getAppPoolMax() }, () => db.$client.reserve()));

    let clock = 0;
    const { lines, log } = captureLog();
    const guard = createSchedulerTickSingleFlight({ now: () => clock, log, bypassPoolMax: getAppPoolMax() });
    let tickOpened = false;
    const tick = () =>
      runInCompanyScopeBypass(
        db,
        { reason: "test", actorType: "scheduler", route: "heartbeat-scheduler:tickTimers" },
        () =>
          withTickPhases(async () => {
            tickOpened = true;
            await timeTickPhase("loadAgents", async () => undefined);
          }),
      );
    const firstRun = guard.run("tickTimers", tick);
    await flush();
    expect(tickOpened).toBe(false);

    clock = WEDGED_AFTER_MS;
    // The replacement would hang on reserve() too; the rescue is what we check.
    const replacement = guard.run("tickTimers", tick);
    await flush();

    const error = lines.find((l) => l.level === "error")!;
    expect(error.msg).toContain(`stuck in phase "${BEFORE_TICK_PHASE}" for ${WEDGED_AFTER_MS}ms`);
    expect(error.msg).not.toContain("not timed");
    expect(error.fields).toMatchObject({ stuckPhase: BEFORE_TICK_PHASE, stuckPhaseMs: WEDGED_AFTER_MS });

    const rescues = describeSchedulerRescues(guard.snapshot(), guard.diagnostics());
    expect(rescues.last).toMatchObject({
      phasesMeasured: true,
      stuckPhase: BEFORE_TICK_PHASE,
      stuckPhaseLabel: "waiting for a database connection before starting its work",
    });
    const notice = buildSchedulerRescueNotice(rescues.last!, new Date(rescues.last!.at));
    expect(notice).toContain(
      "The scheduler got stuck while waiting for a database connection before starting its work " +
        "(part of waking agents on their timers)",
    );
    expect(notice).not.toContain("beforeTick");

    // Free the pool; both runs settle (the role check may reject -- the guard absorbs it).
    for (const connection of held) connection.release();
    await Promise.all([firstRun, replacement]);
  }, 30_000);
});
