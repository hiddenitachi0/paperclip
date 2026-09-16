import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SCHEDULER_TICK_CHAINS } from "../services/scheduler-tick-single-flight.js";

/**
 * DUR-385 / DUR-327 ("two lists that must agree, with nothing enforcing it, is
 * the recurring bug"): the single-flight guard only helps for chains that
 * actually go through it. The guarded set is enumerated in
 * services/scheduler-tick-single-flight.ts, but the chains themselves are
 * dispatched at fire-and-forget call sites in server/src/index.ts.
 *
 * This test reads the REAL call sites out of that source file, so a scheduler
 * chain added later fails here instead of silently going unguarded — which is
 * exactly the state DUR-385 exists to fix.
 */
const serverIndexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

/**
 * Fire-and-forget `void x(...)` calls in index.ts that are NOT guarded tick
 * chains. Each one needs a reason, and the list is checked in both directions
 * so it cannot rot.
 */
const UNGUARDED_VOID_CALLS: Record<string, string> = {
  // One-shot startup reconciliations, not timer ticks: they run once per
  // process start, so there is no next invocation to overlap with.
  reconcilePersistedRuntimeServicesOnStartup: "startup one-shot",
  reconcileCloudUpstreamRunsOnStartup: "startup one-shot",
  reconcileCodexLocalManagedHomesOnStartup: "startup one-shot",
  // Timer-driven, but it has carried its own single-flight guard since long
  // before DUR-385 (`databaseBackupInFlight`), which also serves the manual
  // trigger by raising a 409. Asserted below so it cannot quietly disappear.
  runServerDatabaseBackup: "self-guarded (databaseBackupInFlight)",
  // Not scheduler work at all.
  import: "dynamic import of the browser opener",
  shutdown: "signal handler",
  startServer: "process entrypoint",
};

function guardedChainsInServerIndex(): string[] {
  const matches = serverIndexSource.matchAll(/schedulerTickSingleFlight\.run\(SCHEDULER_TICK_CHAIN\.(\w+)/g);
  return [...matches].map((match) => match[1]!);
}

function schedulerRoutesInServerIndex(): string[] {
  const matches = serverIndexSource.matchAll(/route: "heartbeat-scheduler:([^"]+)"/g);
  return [...new Set([...matches].map((match) => match[1]!))];
}

function voidCallsInServerIndex(): string[] {
  const matches = serverIndexSource.matchAll(/\bvoid\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g);
  return [...new Set([...matches].map((match) => match[1]!))];
}

describe("DUR-385: every fire-and-forget scheduler tick chain is single-flight guarded", () => {
  it("finds the call sites it is supposed to be checking", () => {
    // Guards against the regexes silently matching nothing, which would make
    // every assertion below vacuously true.
    expect(guardedChainsInServerIndex().length).toBeGreaterThan(10);
    expect(schedulerRoutesInServerIndex().length).toBeGreaterThan(10);
  });

  it("guards exactly the chains enumerated in scheduler-tick-single-flight.ts", () => {
    // If this fails: a chain was added, renamed or removed in index.ts. Add it
    // to SCHEDULER_TICK_CHAINS (or take it out), don't loosen the test.
    expect([...guardedChainsInServerIndex()].sort()).toEqual([...SCHEDULER_TICK_CHAINS].sort());
  });

  it("guards each chain exactly once", () => {
    const guarded = guardedChainsInServerIndex();
    expect(guarded).toHaveLength(new Set(guarded).size);
  });

  it("leaves no bypass tick chain dispatched without the guard", () => {
    // The shape a new chain would be copy-pasted in as. The only bare
    // runInCompanyScopeBypass left is the awaited startup recovery, which
    // cannot overlap with itself.
    expect(serverIndexSource.match(/\bvoid\s+runInCompanyScopeBypass\(/g)).toBeNull();
    expect(serverIndexSource.match(/\bawait\s+runInCompanyScopeBypass\(/g)).toHaveLength(1);
  });

  it("accounts for every scheduler bypass route as either guarded or the startup one-shot", () => {
    // Ties the guarded set to the routes the call sites actually declare, so a
    // chain that declares a route but skips the guard is caught even if it is
    // dispatched in some other shape.
    const accountedFor = [...SCHEDULER_TICK_CHAINS, "startup-recovery"].sort();
    expect([...schedulerRoutesInServerIndex()].sort()).toEqual(accountedFor);
  });

  it("accounts for every other fire-and-forget call in index.ts", () => {
    const expected = ["schedulerTickSingleFlight.run", ...Object.keys(UNGUARDED_VOID_CALLS)].sort();
    // If this fails: something new is dispatched fire-and-forget in index.ts.
    // If it is a timer-driven chain, run it through schedulerTickSingleFlight;
    // if it genuinely cannot overlap, add it to UNGUARDED_VOID_CALLS with the
    // reason why.
    expect(voidCallsInServerIndex().sort()).toEqual(expected);
  });

  it("keeps the database backup's own single-flight guard", () => {
    // The one chain exempted above is exempt only because of this flag.
    expect(serverIndexSource).toContain("let databaseBackupInFlight = false;");
    expect(serverIndexSource).toContain("if (databaseBackupInFlight) {");
    expect(serverIndexSource).toContain(
      'logger.warn("Skipping scheduled database backup because a previous backup is still running")',
    );
  });
});
