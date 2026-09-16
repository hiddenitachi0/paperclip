import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROUTINE_SCHEDULER_BYPASS_ROUTES, isRoutineSchedulerBypass } from "@paperclipai/db";

// DUR-386 / DUR-327 ("two lists that must agree, with nothing enforcing it,
// is the recurring bug"): the silenced set lives in
// packages/db/src/cross-company-audit.ts, but the consumers it silences are
// declared at runInCompanyScopeBypass call sites in server/src/index.ts.
// This test reads the REAL call sites out of that source file and forces the
// two to agree -- so a scheduler chain can never be added, renamed or removed
// without a deliberate decision about whether it writes an audit row.
const serverIndexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

/**
 * Scheduler bypass consumers that deliberately DO still write a
 * cross_company_access_log row. Keep this list tiny and justified.
 */
const DELIBERATELY_NOT_SILENCED = [
  // Runs once per process start, not per tick: a row here marks a restart,
  // which is a notable one-off rather than routine mechanics.
  "heartbeat-scheduler:startup-recovery",
] as const;

function schedulerRoutesDeclaredInServerIndex(): string[] {
  const matches = serverIndexSource.matchAll(/route: "(heartbeat-scheduler:[^"]+)"/g);
  return [...new Set([...matches].map((match) => match[1]!))].sort();
}

describe("DUR-386: the silenced scheduler set matches the real bypass call sites", () => {
  it("finds the scheduler bypass call sites it is supposed to be checking", () => {
    // Guards against the regex silently matching nothing (which would make
    // every assertion below vacuously true) if the call sites are reshaped.
    expect(schedulerRoutesDeclaredInServerIndex().length).toBeGreaterThan(10);
  });

  it("accounts for every scheduler bypass consumer exactly once", () => {
    const declared = schedulerRoutesDeclaredInServerIndex();
    const accountedFor = [...ROUTINE_SCHEDULER_BYPASS_ROUTES, ...DELIBERATELY_NOT_SILENCED].sort();

    // If this fails: a scheduler chain was added, renamed or removed in
    // server/src/index.ts. Decide explicitly -- add its route to
    // ROUTINE_SCHEDULER_BYPASS_ROUTES in packages/db/src/cross-company-audit.ts
    // if it is routine per-tick mechanics, or to DELIBERATELY_NOT_SILENCED
    // above if each occurrence is genuinely worth an audit row.
    expect(declared).toEqual(accountedFor);
  });

  it("silences every route on the list and nothing else", () => {
    for (const route of schedulerRoutesDeclaredInServerIndex()) {
      const silenced = isRoutineSchedulerBypass({ actorType: "scheduler", route });
      expect(
        silenced,
        `${route} should ${(ROUTINE_SCHEDULER_BYPASS_ROUTES as readonly string[]).includes(route) ? "" : "not "}be silenced`,
      ).toBe((ROUTINE_SCHEDULER_BYPASS_ROUTES as readonly string[]).includes(route));
    }
  });

  it("leaves every non-scheduler bypass consumer writing a row", () => {
    // Request-driven bypasses go through companyScopeBypassForRoute, whose
    // `route` is the HTTP path and whose actorType comes from the request
    // actor -- never the scheduler. Sample the real ones declared in the
    // routes layer plus the hand-written service call sites.
    const requestRoutes = [
      "/board-claim/abc",
      "/bootstrap/claim",
      "/cli-auth/challenges/1",
      "/board-api-keys",
      "/board-delegate-tokens",
      "/admin/users",
    ];
    for (const route of requestRoutes) {
      for (const actorType of ["user", "agent", "none", null]) {
        expect(isRoutineSchedulerBypass({ actorType, route })).toBe(false);
      }
    }
    // Service-level bypasses pass no route at all.
    expect(isRoutineSchedulerBypass({ actorType: "user", route: null })).toBe(false);
    expect(isRoutineSchedulerBypass({ reason: "first instance-admin bootstrap claim" } as never)).toBe(false);
  });

  it("every scheduler bypass call site in server/src/index.ts declares a route", () => {
    // The silencing decision keys on `route`; a call site that passes none
    // could never be silenced (safe), but it would also escape the
    // enumeration check above, so require them all to declare one.
    // `await`/`void` prefixed only, so the identifier appearing in prose
    // inside a comment is not counted as a call site.
    const callSites = serverIndexSource.match(/(?:await|void)\s+runInCompanyScopeBypass\(/g) ?? [];
    expect(callSites.length).toBe(schedulerRoutesDeclaredInServerIndex().length);
  });
});
