// DUR-386 (from the DUR-382 security review of PR #210): which cross-company
// bypasses are worth a `cross_company_access_log` row, and which are routine
// scheduler mechanics that would drown the table.
//
// Background
// ----------
// Migration 0149 created `cross_company_access_log` to surface the RARE,
// genuine use of the cross-company escape hatch -- a board actor managing
// identity across every company, a bootstrap claim before any company
// exists, an admin fan-out. DUR-352 (DUR-277 Wave 6) then wrapped every
// independently-dispatched heartbeat scheduler tick chain in
// `runInCompanyScopeBypass`, so each chain also wrote one audit row per
// tick. Those chains are permanent, declared in source, and fire on a timer
// forever (`config.heartbeatSchedulerIntervalMs`, default 30s): they are by
// definition never a notable one-off, and at one row per chain per tick they
// bury the handful of rows the table exists for.
//
// What is silenced
// ----------------
// EXACTLY the enumerated, timer-driven scheduler chains below -- nothing
// else. The list is the single place the decision lives; it is enforced
// against the real call sites in server/src/index.ts by
// server/src/__tests__/cross-company-scheduler-bypass-silencing.test.ts,
// which fails if a scheduler chain is added without a deliberate choice
// either way (the DUR-327 "two lists that must agree" class of bug).
//
// Deliberately NOT silenced:
//   - "heartbeat-scheduler:startup-recovery". It runs once per process
//     start, not per tick, so it is a notable one-off: a row there marks a
//     restart, at a cost of one row per boot.
//   - Every request-driven bypass (board identity, API-key/delegate-token
//     management, instance-admin fan-out, CLI device auth, bootstrap
//     claims). Those carry `route` = the HTTP path and are exactly the rare
//     genuine use the table exists to surface.
//
// FAIL-OPEN, on purpose: anything this module is not sure about still gets
// an audit row. A bypass is silenced only when BOTH `actorType` is exactly
// "scheduler" AND `route` is an exact match in the list below. A new
// consumer, a renamed route, a typo, or a missing actorType all fall
// through to "write the row" -- the failure mode is a noisier table, never a
// genuine cross-company access that left no trace.
//
// The question "how often does the scheduler bypass company scoping?" stays
// answerable without the rows: every silenced bypass is counted in-process
// (see recordRoutineSchedulerBypass) and summarised to the log once an hour.

/** A silenced bypass must carry exactly this actorType as well as a listed route. */
export const ROUTINE_SCHEDULER_BYPASS_ACTOR_TYPE = "scheduler";

/**
 * The timer-driven heartbeat scheduler chains whose bypass is routine
 * mechanics, not an event. Each string is the `route` its
 * `runInCompanyScopeBypass` call site in server/src/index.ts passes.
 */
export const ROUTINE_SCHEDULER_BYPASS_ROUTES = [
  "heartbeat-scheduler:tickTimers",
  "heartbeat-scheduler:tickScheduledTriggers",
  "heartbeat-scheduler:mergeDeployVisibility",
  "heartbeat-scheduler:deployApprovalFeedback",
  "heartbeat-scheduler:deployCarriedIssues",
  "heartbeat-scheduler:mergePrAutomation",
  "heartbeat-scheduler:agentErrorAlerts",
  "heartbeat-scheduler:quietModeAlerts",
  "heartbeat-scheduler:untrackedWriteAlerts",
  "heartbeat-scheduler:personaPublisherSweep",
  "heartbeat-scheduler:issueThreadInteractionsAbandonment",
  "heartbeat-scheduler:modelBoostBossReviewTimeouts",
  "heartbeat-scheduler:environmentCustomImagesCleanup",
  "heartbeat-scheduler:periodicRecoveryPipeline",
  "heartbeat-scheduler:organizationCheckups",
  "heartbeat-scheduler:adminAuthCheck",
  "heartbeat-scheduler:claudeAuthCheck",
] as const;

export type RoutineSchedulerBypassRoute = (typeof ROUTINE_SCHEDULER_BYPASS_ROUTES)[number];

const ROUTINE_SCHEDULER_BYPASS_ROUTE_SET: ReadonlySet<string> = new Set(ROUTINE_SCHEDULER_BYPASS_ROUTES);

/** Just the fields the decision reads -- structurally satisfied by CompanyScopeBypassOptions. */
export interface RoutineSchedulerBypassSubject {
  readonly actorType?: string | null;
  readonly route?: string | null;
}

/**
 * True when this bypass is one of the enumerated timer-driven scheduler
 * chains above, i.e. routine mechanics that should not write an audit row.
 * Anything else -- including an unrecognised scheduler route -- is false.
 */
export function isRoutineSchedulerBypass(subject: RoutineSchedulerBypassSubject | null | undefined): boolean {
  if (!subject) return false;
  if (subject.actorType !== ROUTINE_SCHEDULER_BYPASS_ACTOR_TYPE) return false;
  const route = subject.route;
  return typeof route === "string" && ROUTINE_SCHEDULER_BYPASS_ROUTE_SET.has(route);
}

/** How often the in-process counter is summarised to the log. */
export const ROUTINE_SCHEDULER_BYPASS_SUMMARY_INTERVAL_MS = 60 * 60 * 1_000;

const totalsSinceBoot = new Map<string, number>();
const countsThisWindow = new Map<string, number>();
let windowStartedAt: number | null = null;

function formatCounts(counts: ReadonlyMap<string, number>): string {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([route, count]) => `${route.replace("heartbeat-scheduler:", "")}=${count}`)
    .join(", ");
}

/**
 * Count one silenced bypass, and once an hour log a single summary line so
 * "how often does the scheduler bypass company scoping?" is still
 * answerable from the logs alone. No timer of its own: the check rides on
 * the ticks themselves, which is why the first window is only closed by a
 * later tick (a process that stops ticking has nothing left to report).
 */
export function recordRoutineSchedulerBypass(
  route: string,
  now: number = Date.now(),
  log: (message: string) => void = console.info,
): void {
  totalsSinceBoot.set(route, (totalsSinceBoot.get(route) ?? 0) + 1);
  countsThisWindow.set(route, (countsThisWindow.get(route) ?? 0) + 1);

  if (windowStartedAt === null) {
    windowStartedAt = now;
    return;
  }
  const elapsedMs = now - windowStartedAt;
  if (elapsedMs < ROUTINE_SCHEDULER_BYPASS_SUMMARY_INTERVAL_MS) return;

  const windowTotal = [...countsThisWindow.values()].reduce((sum, count) => sum + count, 0);
  const grandTotal = [...totalsSinceBoot.values()].reduce((sum, count) => sum + count, 0);
  log(
    `company-scope: the scheduler bypassed company scoping ${windowTotal} time(s) in the last ` +
      `${Math.round(elapsedMs / 60_000)} min (${grandTotal} since start-up). Routine scheduler ticks are counted ` +
      "here instead of written to cross_company_access_log, which is reserved for rare genuine cross-company " +
      `access (DUR-386). Per chain: ${formatCounts(countsThisWindow)}`,
  );
  countsThisWindow.clear();
  windowStartedAt = now;
}

/** Cumulative silenced-bypass counts since this process started, per route. */
export function snapshotRoutineSchedulerBypassCounts(): Record<string, number> {
  return Object.fromEntries(totalsSinceBoot);
}

/** Test-only: clear the in-process counters and the summary window. */
export function resetRoutineSchedulerBypassCounts(): void {
  totalsSinceBoot.clear();
  countsThisWindow.clear();
  windowStartedAt = null;
}
