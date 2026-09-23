import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { agents, companies, getAppPoolMax, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import {
  ASSIGNEE_PICKUP_WAITING_ISSUE_STATUSES,
  type AssigneeUnavailableReason,
  type FleetWaitingOnUnavailableAgents,
  normalizeAgentUrlKey,
  QUIET_MODE_REASON_DEPLOY,
  QUIET_MODE_STALE_AFTER_MS,
  QUIET_MODE_STUCK_AFTER_MS,
  type FleetAgentCounts,
  type FleetDatabaseLoad,
  type FleetHealthLevel,
  type FleetHealthSnapshot,
  type FleetHealthSummary,
  type FleetQuietMode,
  type FleetRequestLoad,
  type FleetRunCounts,
  type FleetSchedulerRescue,
  type FleetSchedulerStatus,
  type FleetSchedulerStuckChain,
  type FleetSlotUsage,
  type QuietModeState,
} from "@paperclipai/shared";
import { instanceSettingsService } from "./instance-settings.js";
import {
  buildAgentInErrorReasonText,
  buildFleetWaitingOnUnavailableAgentsNote,
  buildQuietModeNotice,
  buildUnavailableAgentReasonText,
  formatOperatorDuration,
} from "./operator-notices.js";
import { classifyAssigneePickup } from "./assignee-pickup.js";
import { evaluateAgentInvokability, type AgentOrgRow } from "./agent-invokability.js";
import { logger } from "../middleware/logger.js";

// DUR-3939/DUR-3940 (with DUR-272 and DUR-98): one computed, on-demand
// health signal for the whole fleet. On 2026-09-06 the fleet sat starved for
// 20+ minutes with every global run slot held and 15 runs queued; the
// scheduler was ticking fine, but the only visible symptom was a bare
// "Queued 9" count, and the night before the whole fleet went dormant for
// ~5h with nothing on screen saying so. Everything here is a cheap indexed
// query or an in-process counter -- no model calls, no cached "last known
// good" -- so what the operator sees is what is true right now.

export const FLEET_HEALTH_WINDOW_MS = 15 * 60 * 1000;
export const FLEET_ZOMBIE_SILENCE_MS = 30 * 60 * 1000;
/**
 * DUR-3965: how long a DEPLOY-activated quiet mode may stay on before the
 * fleet signal calls it out as critical. Override per instance with
 * PAPERCLIP_QUIET_MODE_STUCK_MINUTES.
 *
 * This window applies ONLY to a quiet mode a deploy switched on -- nobody
 * chose that silence, so half an hour of it is an incident. A quiet mode a
 * person switched on is a deliberate decision (Filip's overnight
 * Claude-quota window is ~22 hours of exactly that) and is held to
 * QUIET_MODE_STALE_AFTER_MS instead; see quietModeThresholdMs.
 */
export function resolveQuietModeStuckMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PAPERCLIP_QUIET_MODE_STUCK_MINUTES;
  if (raw === undefined || raw === null || String(raw).trim() === "") return QUIET_MODE_STUCK_AFTER_MS;
  const parsed = Number(String(raw).trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return QUIET_MODE_STUCK_AFTER_MS;
  return Math.floor(parsed) * 60_000;
}
/** Queued runs waiting longer than this behind a full cap are called out more loudly. */
export const FLEET_QUEUE_WAIT_WARN_MS = 15 * 60 * 1000;
/** DUR-4001: the Now page lists every sampled agent by name, so the bound is what fits on a phone screen. */
export const FLEET_AGENTS_IN_ERROR_SAMPLE_LIMIT = 10;

/**
 * DUR-4001: the same route key the agents list and org chart link with
 * (services/agents.ts withUrlKey), so a link built from the fleet signal lands
 * on the same page as one built from the agents list. A terminated agent
 * gets its id instead: the agent route resolves short names through
 * resolveByReference, which skips terminated agents, so its name would land
 * on "Agent not found".
 */
function fleetAgentUrlKey(row: { id: string; name: string; status?: string | null }): string {
  if (row.status === "terminated") return row.id;
  return normalizeAgentUrlKey(row.name) ?? row.id;
}
/** How far back the window query looks so long runs that finish inside the window are still counted. */
const FLEET_WINDOW_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;

export interface ComputeFleetHealthOptions {
  now?: Date;
  windowMs?: number;
  zombieSilenceMs?: number;
  /** Override for tests; otherwise read from instance settings. */
  globalMaxConcurrentRuns?: number;
  scheduler: FleetSchedulerStatus;
  requests: FleetRequestLoad;
  /** Skip the pg_stat_activity probe (tests on a mocked db). */
  includeDatabaseLoad?: boolean;
  /** Override for tests; otherwise read from instance settings. */
  quietMode?: QuietModeState;
  /**
   * How long a DEPLOY-activated quiet mode may stay on before it is critical.
   * Override for tests; otherwise PAPERCLIP_QUIET_MODE_STUCK_MINUTES / 30 min.
   */
  quietModeStuckMs?: number;
  /**
   * How long a HUMAN-activated quiet mode may stay on before it is even
   * mentioned as a warning. Override for tests; otherwise the 24h
   * QUIET_MODE_STALE_AFTER_MS convention, which is sized above the ~22h
   * overnight quota window on purpose.
   */
  quietModeManualStuckMs?: number;
}

function asCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" && value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export async function loadFleetRunCounts(
  db: Db,
  input: { now: Date; windowMs: number; zombieSilenceMs: number },
): Promise<FleetRunCounts> {
  const cutoffDate = new Date(input.now.getTime() - input.windowMs);
  const lookback = new Date(cutoffDate.getTime() - FLEET_WINDOW_LOOKBACK_MS);
  // Raw sql`` params go to postgres.js as-is, which does not serialize Date --
  // pass ISO strings and cast (same convention as issues.ts/pipelines.ts).
  const cutoff = cutoffDate.toISOString();
  const zombieCutoff = new Date(input.now.getTime() - input.zombieSilenceMs).toISOString();

  // Bounded by the created_at index; a run older than a day that finishes
  // inside the window is the one case this undercounts, and that is rare
  // enough not to be worth an unindexed finished_at scan on every poll.
  const [windowRow] = await db
    .select({
      started: sql<number>`count(*) filter (where ${heartbeatRuns.startedAt} >= ${cutoff}::timestamptz)`.mapWith(Number),
      succeeded: sql<number>`count(*) filter (where ${heartbeatRuns.finishedAt} >= ${cutoff}::timestamptz and ${heartbeatRuns.status} = 'succeeded')`.mapWith(Number),
      failed: sql<number>`count(*) filter (where ${heartbeatRuns.finishedAt} >= ${cutoff}::timestamptz and ${heartbeatRuns.status} in ('failed', 'timed_out'))`.mapWith(Number),
      cancelled: sql<number>`count(*) filter (where ${heartbeatRuns.finishedAt} >= ${cutoff}::timestamptz and ${heartbeatRuns.status} = 'cancelled')`.mapWith(Number),
    })
    .from(heartbeatRuns)
    .where(gte(heartbeatRuns.createdAt, lookback));

  // Staleness keys on evidence of progress (output, process start, run
  // start), never updatedAt -- the watchdog bumps updatedAt on every pass,
  // which is exactly how dead runs read as "fresh" for an hour on 2026-09-06
  // (DUR-257). Same rule as reapOrphanedRuns.
  const [activeRow] = await db
    .select({
      running: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'running')`.mapWith(Number),
      queued: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'queued')`.mapWith(Number),
      // Agents run one at a time, so a run queued behind its own agent's
      // running run is waiting on that agent, not on the fleet. Only queued
      // rows whose agent has nothing running say the queue itself is stuck.
      // Written with explicit table names: inside the subquery drizzle
      // renders `${heartbeatRuns.agentId}` unqualified, which would bind to
      // the aliased inner table and make the not-exists always false.
      queuedWithNoRunningAgent: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'queued' and not exists (
        select 1 from heartbeat_runs as running_runs
        where running_runs.agent_id = heartbeat_runs.agent_id and running_runs.status = 'running'
      ))`.mapWith(Number),
      oldestQueuedAt: sql<Date | string | null>`min(${heartbeatRuns.createdAt}) filter (where ${heartbeatRuns.status} = 'queued')`,
      zombies: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'running' and greatest(
        coalesce(${heartbeatRuns.lastOutputAt}, to_timestamp(0)),
        coalesce(${heartbeatRuns.processStartedAt}, to_timestamp(0)),
        coalesce(${heartbeatRuns.startedAt}, to_timestamp(0)),
        coalesce(${heartbeatRuns.createdAt}, to_timestamp(0))
      ) < ${zombieCutoff}::timestamptz)`.mapWith(Number),
    })
    .from(heartbeatRuns)
    .where(inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]));

  const oldestQueuedAt = asDate(activeRow?.oldestQueuedAt);
  return {
    windowMinutes: Math.round(input.windowMs / 60_000),
    startedInWindow: asCount(windowRow?.started),
    succeededInWindow: asCount(windowRow?.succeeded),
    failedInWindow: asCount(windowRow?.failed),
    cancelledInWindow: asCount(windowRow?.cancelled),
    running: asCount(activeRow?.running),
    queued: asCount(activeRow?.queued),
    queuedWithNoRunningAgent: asCount(activeRow?.queuedWithNoRunningAgent),
    oldestQueuedWaitMs: oldestQueuedAt ? Math.max(0, input.now.getTime() - oldestQueuedAt.getTime()) : null,
    zombieCandidates: asCount(activeRow?.zombies),
    zombieSilenceMinutes: Math.round(input.zombieSilenceMs / 60_000),
  };
}

export async function loadFleetAgentCounts(db: Db, now: Date = new Date()): Promise<FleetAgentCounts> {
  const errorFilter = and(eq(agents.status, "error"), eq(companies.status, "active"));
  const [countRow] = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(agents)
    .innerJoin(companies, eq(companies.id, agents.companyId))
    .where(errorFilter);
  // Name + when only. The free-text error reason stays on the agent's own
  // page (company-scoped); this instance-wide signal never carries it.
  const sample = await db
    .select({
      id: agents.id,
      name: agents.name,
      companyId: agents.companyId,
      errorAt: agents.errorAt,
    })
    .from(agents)
    .innerJoin(companies, eq(companies.id, agents.companyId))
    .where(errorFilter)
    .orderBy(asc(agents.errorAt))
    .limit(FLEET_AGENTS_IN_ERROR_SAMPLE_LIMIT);

  return {
    inError: asCount(countRow?.count),
    inErrorSample: sample.map((row) => ({
      id: row.id,
      name: row.name,
      companyId: row.companyId,
      errorAt: row.errorAt ? new Date(row.errorAt).toISOString() : null,
      urlKey: fleetAgentUrlKey(row),
      reasonText: buildAgentInErrorReasonText({ errorAt: row.errorAt, now }),
    })),
  };
}

/** DUR-4001: same bound as the agents-in-error sample, for the same reason. */
export const FLEET_WAITING_AGENTS_SAMPLE_LIMIT = 10;

/**
 * DUR-3973: open tasks assigned to agents that cannot pick them up, right
 * now. Uses the same classifier as the recovery sweep
 * (services/assignee-pickup.ts), so this count and the sweep's "do not
 * dispatch, tell the operator once" decision can never disagree. Agents
 * switched off by quiet mode are judged by their own pre-quiet-mode settings,
 * so the nightly quiet window never inflates this number.
 */
export async function loadFleetWaitingOnUnavailableAgents(
  db: Db,
  quietMode: Pick<QuietModeState, "active" | "snapshot">,
): Promise<FleetWaitingOnUnavailableAgents> {
  const rows = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      reportsTo: agents.reportsTo,
      status: agents.status,
      pauseReason: agents.pauseReason,
      runtimeConfig: agents.runtimeConfig,
    })
    .from(agents)
    .innerJoin(companies, eq(companies.id, agents.companyId))
    .where(eq(companies.status, "active"));

  const orgRowsByCompany = new Map<string, AgentOrgRow[]>();
  for (const row of rows) {
    const companyRows = orgRowsByCompany.get(row.companyId);
    if (companyRows) companyRows.push(row);
    else orgRowsByCompany.set(row.companyId, [row]);
  }

  const unavailable = new Map<string, { row: (typeof rows)[number]; reason: AssigneeUnavailableReason }>();
  for (const row of rows) {
    const pickup = classifyAssigneePickup({
      agent: row,
      invokability: evaluateAgentInvokability(row, orgRowsByCompany.get(row.companyId) ?? []),
      companyActive: true,
      quietMode: { active: quietMode.active, snapshot: quietMode.snapshot ?? null },
    });
    if (pickup.kind === "unavailable") unavailable.set(row.id, { row, reason: pickup.reason });
  }
  if (unavailable.size === 0) return { tasks: 0, agents: 0, sample: [] };

  const counts = await db
    .select({ agentId: issues.assigneeAgentId, count: sql<number>`count(*)`.mapWith(Number) })
    .from(issues)
    .where(
      and(
        inArray(issues.assigneeAgentId, [...unavailable.keys()]),
        isNull(issues.assigneeUserId),
        isNull(issues.hiddenAt),
        inArray(issues.status, [...ASSIGNEE_PICKUP_WAITING_ISSUE_STATUSES]),
      ),
    )
    .groupBy(issues.assigneeAgentId);

  const waiting = counts
    .map((row) => {
      const entry = row.agentId ? unavailable.get(row.agentId) : undefined;
      const tasks = asCount(row.count);
      return entry && tasks > 0
        ? {
            id: entry.row.id,
            name: entry.row.name,
            companyId: entry.row.companyId,
            tasks,
            reason: entry.reason,
            urlKey: fleetAgentUrlKey(entry.row),
            reasonText: buildUnavailableAgentReasonText({ agentName: entry.row.name, reason: entry.reason, tasks }),
          }
        : null;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((left, right) => right.tasks - left.tasks || left.name.localeCompare(right.name));

  return {
    tasks: waiting.reduce((sum, row) => sum + row.tasks, 0),
    agents: waiting.length,
    sample: waiting.slice(0, FLEET_WAITING_AGENTS_SAMPLE_LIMIT),
  };
}

export async function loadFleetDatabaseLoad(db: Db): Promise<FleetDatabaseLoad> {
  const poolMax = getAppPoolMax();
  try {
    const result = await db.execute(sql`
      select
        count(*)::int as connections,
        count(*) filter (where state = 'active')::int as active,
        count(*) filter (where state = 'idle in transaction')::int as idle_in_transaction,
        count(*) filter (where wait_event_type = 'Lock')::int as waiting_on_locks
      from pg_stat_activity
      where datname = current_database() and backend_type = 'client backend'
    `);
    const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? [];
    const row = (rows[0] ?? {}) as Record<string, unknown>;
    return {
      available: true,
      poolMax,
      connections: asCount(row.connections),
      active: asCount(row.active),
      idleInTransaction: asCount(row.idle_in_transaction),
      waitingOnLocks: asCount(row.waiting_on_locks),
    };
  } catch (error) {
    logger.warn({ err: error }, "fleet health: pg_stat_activity probe failed");
    return { available: false, poolMax, connections: null, active: null, idleInTransaction: null, waitingOnLocks: null };
  }
}

export function computeFleetSlotUsage(globalMaxConcurrentRuns: number, running: number): FleetSlotUsage {
  const max = Math.max(0, Math.floor(globalMaxConcurrentRuns));
  const used = Math.max(0, running);
  return {
    max,
    used,
    available: Math.max(0, max - used),
    saturated: max > 0 && used >= max,
  };
}

/**
 * DUR-3965: LEGACY inference, kept only for quiet-mode state written before
 * `activatedReason` existed. It is a guess and a bad one -- the deploy runner
 * authenticates as an instance admin, so in production its activation reads
 * as a plain user actor, while "scheduler"/"system" activations that were
 * never a deploy read as one. Everything written from now on records the
 * reason explicitly; see isDeployQuietMode below.
 */
const DEPLOY_QUIET_MODE_ACTOR_TYPES: ReadonlySet<string> = new Set(["deploy_runner", "deploy-runner"]);

export function isDeployQuietModeActor(actorType: string | null | undefined): boolean {
  return DEPLOY_QUIET_MODE_ACTOR_TYPES.has(actorType ?? "");
}

/**
 * DUR-3965: was this quiet mode switched on by a deploy (nobody chose the
 * silence) or by a person (a decision)? Read off the reason recorded at
 * activation time; the actor-type guess above is used only when the state
 * predates that field.
 */
export function isDeployQuietMode(
  quietMode: Pick<QuietModeState, "activatedBy"> & { activatedReason?: string | null },
): boolean {
  const reason = quietMode.activatedReason?.trim();
  if (reason) return reason === QUIET_MODE_REASON_DEPLOY;
  return isDeployQuietModeActor(quietMode.activatedBy?.actorType);
}

/**
 * DUR-3965: how long THIS quiet mode may stay on before it is surfaced.
 *
 * A deploy's drain gets the short window (30 min): nothing about it was
 * chosen, and an instance sitting idle that long because a deploy failed is
 * the incident this whole ticket exists for. A person's quiet mode gets the
 * long-standing 24h window, sized above the ~22h overnight Claude-quota
 * window so that normal, deliberate use never trips it.
 */
export function quietModeThresholdMs(input: {
  activatedForDeploy: boolean;
  deployStuckAfterMs: number;
  manualStuckAfterMs?: number;
}): number {
  return input.activatedForDeploy
    ? input.deployStuckAfterMs
    : (input.manualStuckAfterMs ?? QUIET_MODE_STALE_AFTER_MS);
}

export function computeFleetQuietMode(
  quietMode: QuietModeState,
  input: { now: Date; deployStuckAfterMs: number; manualStuckAfterMs?: number },
): FleetQuietMode {
  if (!quietMode.active) {
    return {
      active: false,
      activatedAt: null,
      activeForMs: null,
      activatedReason: quietMode.activatedReason ?? null,
      stuckAfterMinutes: Math.max(1, Math.round(input.deployStuckAfterMs / 60_000)),
      stuck: false,
      activatedForDeploy: false,
    };
  }
  const activatedForDeploy = isDeployQuietMode(quietMode);
  const thresholdMs = quietModeThresholdMs({ activatedForDeploy, ...input });
  const activatedAt = asDate(quietMode.activatedAt);
  const activeForMs = activatedAt ? Math.max(0, input.now.getTime() - activatedAt.getTime()) : null;
  return {
    active: true,
    activatedAt: activatedAt ? activatedAt.toISOString() : null,
    activeForMs,
    activatedReason: quietMode.activatedReason ?? null,
    stuckAfterMinutes: Math.max(1, Math.round(thresholdMs / 60_000)),
    // A quiet mode with no recorded start time is past its window by
    // default: "we cannot tell how long the whole fleet has been paused" is
    // not a reason to stay silent (DUR-98 item 4). How loudly it is then
    // reported still depends on who switched it on.
    stuck: activeForMs === null || activeForMs >= thresholdMs,
    activatedForDeploy,
  };
}

const LEVEL_RANK: Record<FleetHealthLevel, number> = { ok: 0, warning: 1, critical: 2 };

function plural(count: number, singular: string, pluralWord = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralWord}`;
}

/**
 * Turns the raw numbers into what an operator needs to read: one headline,
 * a severity, and the findings behind it, in plain language. Pure so the
 * rules are unit-testable against the incidents they came from.
 */
/**
 * DUR-3991: the Now page sentence for a scheduler that has stopped completing
 * ticks. Three shapes, because the operator's next move differs:
 *   * nothing identified  -> the original wording, unchanged.
 *   * a step is stuck     -> name it, say how long, say the server will start a
 *                            fresh attempt by itself and when.
 *   * no restart left     -> name it, and say plainly that only a restart is
 *                            left, because the watchdog's bounded rescues are
 *                            spent (see MAX_RESCUES_PER_CHAIN_PER_WINDOW and
 *                            maxAbandonedInFlightFor in
 *                            scheduler-tick-single-flight.ts).
 * A step already retried once but with rescues left says the server will try
 * again by itself.
 */
export function buildStuckSchedulerNotice(since: string, stuck: FleetSchedulerStuckChain | null): string {
  const opening = `The scheduler has not completed a tick ${since}.`;
  if (!stuck) {
    return `${opening} Agents will not be woken until this is fixed (a server restart usually clears it).`;
  }
  const step = `The step that is stuck is ${stuck.label}, and it has been going for ${formatOperatorDuration(stuck.runningMs)}.`;
  // DUR-3991: the server now restarts a stuck step more than once (bounded),
  // so "already retried" no longer means "only a restart is left" -- the
  // server says which it is. Older payloads without the field keep the
  // original meaning.
  const restartNeeded = stuck.restartNeeded ?? stuck.freshAttemptAlreadyTried;
  if (stuck.restartNeeded === true) {
    const tried = stuck.freshAttemptAlreadyTried
      ? "The server already gave up on it and started it again as many times as it safely can, and it is still stuck"
      : "The server has used up its automatic restarts for it";
    return `${opening} ${step} ${tried}, so restarting the server is the only thing left.`;
  }
  if (restartNeeded) {
    return `${opening} ${step} The server already gave up on it once and started it again, and that is stuck too, so restarting the server is the only thing left.`;
  }
  if (stuck.freshAttemptAlreadyTried) {
    return `${opening} ${step} The server already gave up on it once and started it again; if this attempt is stuck too it will try again by itself after ${formatOperatorDuration(stuck.freshAttemptAfterMs)}, a limited number of times.`;
  }
  return `${opening} ${step} No agent is woken while this lasts. The server gives up on it and starts it again by itself after ${formatOperatorDuration(stuck.freshAttemptAfterMs)}; restart the server if it is still stuck after that.`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "03:12 UTC on 18 September": the server cannot know the reader's time zone, so it says which one it used. */
function formatOperatorClock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "an unknown time";
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC on ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
}

/** Findings about the last automatic rescue count as recent (amber) for this long. */
export const FLEET_SCHEDULER_RESCUE_RECENT_MS = 60 * 60_000;

/**
 * DUR-3991: "The scheduler got stuck while <phase in plain words> and was
 * restarted automatically at <time>." The stuck phase is read from inside the
 * abandoned tick at the moment it was given up on -- the only evidence of it.
 */
export function buildSchedulerRescueNotice(rescue: FleetSchedulerRescue, now: Date): string {
  let where: string;
  if (rescue.stuckPhase !== null) {
    where = `while ${rescue.stuckPhaseLabel} (part of ${rescue.label})`;
  } else if (rescue.phasesMeasured) {
    // The wait before the first step (the database connection) is reported as
    // its own phase, so a measured run with no phase in progress is between steps.
    where = `while ${rescue.label}, between two of its measured steps`;
  } else {
    where = `while ${rescue.label}`;
  }
  const agoMs = Math.max(0, now.getTime() - new Date(rescue.at).getTime());
  const stuckFor =
    rescue.stuckPhase !== null && rescue.stuckPhaseMs !== null
      ? ` It had been stuck at that point for ${formatOperatorDuration(rescue.stuckPhaseMs)}.`
      : "";
  return (
    `The scheduler got stuck ${where} and was restarted automatically at ${formatOperatorClock(rescue.at)} ` +
    `(${formatOperatorDuration(agoMs)} ago).${stuckFor}`
  );
}

export function summarizeFleetHealth(input: {
  runs: FleetRunCounts;
  slots: FleetSlotUsage;
  agents: FleetAgentCounts;
  scheduler: FleetSchedulerStatus;
  requests: FleetRequestLoad;
  database: FleetDatabaseLoad;
  quietMode: FleetQuietMode;
  /** DUR-3973; absent = nothing known to be waiting. */
  waitingOnUnavailableAgents?: FleetWaitingOnUnavailableAgents;
  /** For "how long ago"; defaults to the current time. */
  now?: Date;
}): FleetHealthSummary {
  const findings: Array<{ level: FleetHealthLevel; text: string }> = [];
  const { runs, slots, agents: agentCounts, scheduler, requests, database, quietMode } = input;

  // DUR-3965: first, because it outranks everything below it -- when quiet
  // mode is on, "no runs started" and "nothing queued" are consequences, not
  // separate problems, and an operator reading "Quiet: nothing started" with
  // no explanation is exactly the 27 minutes of unexplained silence this
  // finding exists to prevent.
  //
  // How loudly depends on WHO paused the fleet, and the difference matters
  // every single night: a deploy that never lifted its own drain is an
  // incident and goes critical after half an hour, while the operator's own
  // overnight quota window is a deliberate ~22h decision that must never
  // paint this strip red. See quietModeThresholdMs.
  if (quietMode.stuck) {
    findings.push({
      level: quietMode.activatedForDeploy ? "critical" : "warning",
      text: buildQuietModeNotice({
        activatedAt: quietMode.activatedAt,
        activeForMs: quietMode.activeForMs,
        activatedForDeploy: quietMode.activatedForDeploy,
      }),
    });
  } else if (quietMode.active) {
    findings.push({
      level: "ok",
      text:
        `Quiet mode is on, so no agent will start new work. It was switched on ` +
        `${formatOperatorDuration(quietMode.activeForMs)} ago; if that was not deliberate, clear it under ` +
        `Settings > Instance settings > General.`,
    });
  }

  if (!scheduler.enabled) {
    findings.push({
      level: "warning",
      text: "The scheduler is switched off on this server, so no agent will wake on its own timer.",
    });
  } else if (scheduler.stale) {
    const since = scheduler.sinceLastTickMs === null ? "since the server started" : `for ${formatOperatorDuration(scheduler.sinceLastTickMs)}`;
    findings.push({
      level: "critical",
      // DUR-3991: "something is stuck, restart the server" was true but not
      // actionable -- it never said WHAT was stuck, so the only move was a
      // restart. When the server knows which step is holding things up, say so
      // in words, say how long, and say whether waiting will fix it (the
      // watchdog in scheduler-tick-single-flight.ts starts a fresh attempt on
      // its own) or whether a restart is genuinely the only thing left.
      text: buildStuckSchedulerNotice(since, scheduler.stuckChain ?? null),
    });
  } else if (scheduler.lastTickError) {
    findings.push({
      level: "warning",
      text: `The scheduler's last tick failed: ${scheduler.lastTickError}`,
    });
  }

  // DUR-3991: the watchdog's bounded automatic restarts. A stuck step it will
  // no longer restart is critical; an exhausted budget with nothing stuck yet
  // is a warning (the next hang cannot heal itself); a recent rescue is worth
  // knowing about even though it healed itself.
  const rescues = scheduler.rescues ?? null;
  if (scheduler.enabled && rescues) {
    const alreadySaid = scheduler.stale && (scheduler.stuckChain?.restartNeeded ?? false);
    if (rescues.restartNeededFor.length > 0 && !alreadySaid) {
      const steps = rescues.restartNeededFor.join(", ");
      findings.push({
        level: "critical",
        text:
          `Part of the scheduler is stuck (${steps}) and the server has used up its automatic restarts for it, ` +
          "so it will stay stuck until the server is restarted.",
      });
    } else if (rescues.restartNeededFor.length === 0 && rescues.abandonedStillRunning >= rescues.maxAbandonedStillRunning) {
      findings.push({
        level: "warning",
        text:
          `The scheduler has given up on ${plural(rescues.abandonedStillRunning, "stuck step that has", "stuck steps that have")} ` +
          "still not finished, which is as many as it allows. Everything is running now, but if anything gets " +
          "stuck again the server cannot restart it by itself. Restart the server when convenient.",
      });
    }
    if (rescues.last) {
      const agoMs = Math.max(0, (input.now ?? new Date()).getTime() - new Date(rescues.last.at).getTime());
      findings.push({
        level: agoMs < FLEET_SCHEDULER_RESCUE_RECENT_MS ? "warning" : "ok",
        text: buildSchedulerRescueNotice(rescues.last, input.now ?? new Date()),
      });
    }
  }

  // DUR-3991: a completed tick whose slowest single step took longer than the
  // tick interval is the early shape of a hang. Stated, not alarmed.
  const slowest = scheduler.lastTickSlowestPhase ?? null;
  if (scheduler.enabled && !scheduler.stale && slowest && scheduler.intervalMs && slowest.ms >= scheduler.intervalMs) {
    findings.push({
      level: "ok",
      text:
        `The last scheduler tick finished, but spent ${formatOperatorDuration(slowest.ms)} ${slowest.label}, ` +
        "longer than the time between ticks.",
    });
  }

  if (requests.overloaded) {
    findings.push({
      level: "critical",
      text: `The server is handling ${plural(requests.inFlight, "request")} at once (its overload line is ${requests.overloadThreshold}). It is overloaded, not down; expect slow pages until this drains.`,
    });
  } else if (requests.slowInFlight > 0) {
    // Informational only. A handful of slow requests is normal (exports,
    // git work, a big page); the signal that something is wrong is the
    // overload line above, not one request taking a while.
    findings.push({
      level: "ok",
      text: `${plural(requests.slowInFlight, "request has", "requests have")} been waiting longer than ${Math.round(requests.slowThresholdMs / 1000)} seconds. That is fine on its own; it only matters if pages feel slow.`,
    });
  }

  if (database.available && database.poolMax !== null && database.active !== null && database.active >= database.poolMax) {
    findings.push({
      level: "warning",
      text: `Every database connection is busy (${database.active} of ${database.poolMax}); requests are queuing behind the database.`,
    });
  }

  const schedulerLooksAlive = scheduler.enabled && !scheduler.stale;
  if (schedulerLooksAlive && runs.queued > 0 && runs.startedInWindow === 0 && !slots.saturated) {
    // Overnight shape: one long run and its own agent's next run queued
    // behind it. Agents run one at a time, so that queued run is waiting on
    // its agent, not on the fleet, and a critical here would be a false
    // alarm. Only queued runs whose agent has nothing running mean the
    // queue itself is stuck.
    if (runs.queuedWithNoRunningAgent > 0) {
      findings.push({
        level: "critical",
        text: `${plural(runs.queuedWithNoRunningAgent, "run is", "runs are")} queued but none has started in the last ${runs.windowMinutes} minutes, even though ${plural(slots.available, "slot is", "slots are")} free. Something is holding the queue.`,
      });
    } else {
      findings.push({
        level: "ok",
        text: `${plural(runs.queued, "run is", "runs are")} queued behind a run the same agent already has going. Agents run one at a time, so ${runs.queued === 1 ? "it" : "they"} will start when that run finishes.`,
      });
    }
  }

  if (slots.saturated && runs.queued > 0) {
    const oldest = runs.oldestQueuedWaitMs ?? 0;
    const waited = oldest >= 60_000 ? ` (the oldest has waited ${formatOperatorDuration(oldest)})` : "";
    const level: FleetHealthLevel = oldest >= FLEET_QUEUE_WAIT_WARN_MS ? "warning" : "ok";
    findings.push({
      level,
      text: `All ${plural(slots.max, "run slot")} are in use and ${plural(runs.queued, "run is", "runs are")} waiting for one${waited}. Nothing is broken; raise "Max concurrent runs (whole instance)" under Settings > Instance settings > General to let more through.`,
    });
  }

  if (runs.zombieCandidates > 0) {
    findings.push({
      level: "warning",
      text: `${plural(runs.zombieCandidates, "run has", "runs have")} shown no output for ${runs.zombieSilenceMinutes}+ minutes and may be stuck, holding a slot. The watchdog ends a run once its process is gone, and stops one that stays silent or runs past the time limits under Settings > Instance settings > General.`,
    });
  }

  if (agentCounts.inError > 0) {
    const names = agentCounts.inErrorSample.map((agent) => agent.name).filter(Boolean);
    const shown = names.slice(0, 3).join(", ");
    const more = agentCounts.inError > names.slice(0, 3).length ? ` and ${agentCounts.inError - Math.min(3, names.length)} more` : "";
    findings.push({
      level: "warning",
      text: `${plural(agentCounts.inError, "agent has", "agents have")} stopped with an error and will not take work until someone clears it${shown ? `: ${shown}${more}` : ""}.`,
    });
  }

  // DUR-3973: tasks sitting with agents that cannot pick them up. Always
  // "ok" -- a statement of fact, never amber on its own. On this instance
  // whole companies' agents are paused on purpose for weeks; painting the
  // strip yellow for that would teach the operator to ignore the strip. The
  // one-time Activity notice per task is what flags a NEW case.
  const waiting = input.waitingOnUnavailableAgents;
  if (waiting && waiting.tasks > 0) {
    findings.push({
      level: "ok",
      text: buildFleetWaitingOnUnavailableAgentsNote({
        tasks: waiting.tasks,
        agents: waiting.agents,
        sample: waiting.sample.map((agent) => ({ agentName: agent.name, reason: agent.reason, tasks: agent.tasks })),
      }),
    });
  }

  const level = findings.reduce<FleetHealthLevel>(
    (worst, finding) => (LEVEL_RANK[finding.level] > LEVEL_RANK[worst] ? finding.level : worst),
    "ok",
  );
  const ordered = [...findings].sort((left, right) => LEVEL_RANK[right.level] - LEVEL_RANK[left.level]);

  const flowing =
    `Runs are flowing: ${runs.startedInWindow} started, ${runs.succeededInWindow} finished, ${runs.failedInWindow} failed in the last ${runs.windowMinutes} minutes. ` +
    `${slots.used} of ${slots.max} slots in use${runs.queued > 0 ? `, ${runs.queued} queued` : ""}.`;
  const quiet =
    `Quiet: nothing started in the last ${runs.windowMinutes} minutes and nothing is queued. ` +
    `${slots.used} of ${slots.max} slots in use.`;
  const okHeadline = runs.startedInWindow > 0 || runs.queued > 0 || runs.running > 0 ? flowing : quiet;

  if (level === "ok") {
    return { level, headline: okHeadline, notes: ordered.map((finding) => finding.text) };
  }
  const [headline, ...rest] = ordered;
  return {
    level,
    headline: headline!.text,
    notes: [...rest.map((finding) => finding.text), okHeadline],
  };
}

export async function computeFleetHealth(db: Db, options: ComputeFleetHealthOptions): Promise<FleetHealthSnapshot> {
  const now = options.now ?? new Date();
  const windowMs = options.windowMs ?? FLEET_HEALTH_WINDOW_MS;

  // One read of the general settings covers the run cap, the watchdog's
  // silence window AND (DUR-3965) the quiet-mode state; it is skipped only
  // when every one of those was passed in (tests on a mocked db).
  const general =
    options.globalMaxConcurrentRuns !== undefined && options.zombieSilenceMs !== undefined && options.quietMode !== undefined
      ? null
      : await instanceSettingsService(db).getGeneral();
  const globalMaxConcurrentRuns = options.globalMaxConcurrentRuns ?? general!.globalMaxConcurrentRuns;
  // DUR-3940 item 2: "may be stuck" uses the same silence window the
  // watchdog actually enforces, so the count on screen matches what the
  // watchdog is about to act on.
  const zombieSilenceMs =
    options.zombieSilenceMs ??
    (general && general.silentRunTimeoutMinutes > 0 ? general.silentRunTimeoutMinutes * 60_000 : FLEET_ZOMBIE_SILENCE_MS);

  const quietModeState = options.quietMode ?? general!.quietMode;
  const quietMode = computeFleetQuietMode(quietModeState, {
    now,
    deployStuckAfterMs: options.quietModeStuckMs ?? resolveQuietModeStuckMs(),
    manualStuckAfterMs: options.quietModeManualStuckMs,
  });

  const [runs, agentCounts, database, waitingOnUnavailableAgents] = await Promise.all([
    loadFleetRunCounts(db, { now, windowMs, zombieSilenceMs }),
    loadFleetAgentCounts(db, now),
    options.includeDatabaseLoad === false
      ? Promise.resolve<FleetDatabaseLoad>({
          available: false,
          poolMax: null,
          connections: null,
          active: null,
          idleInTransaction: null,
          waitingOnLocks: null,
        })
      : loadFleetDatabaseLoad(db),
    loadFleetWaitingOnUnavailableAgents(db, quietModeState),
  ]);
  const slots = computeFleetSlotUsage(globalMaxConcurrentRuns, runs.running);
  const summary = summarizeFleetHealth({
    runs,
    slots,
    agents: agentCounts,
    scheduler: options.scheduler,
    requests: options.requests,
    database,
    quietMode,
    waitingOnUnavailableAgents,
    now,
  });

  return {
    available: true,
    computedAt: now.toISOString(),
    runs,
    slots,
    agents: agentCounts,
    scheduler: options.scheduler,
    requests: options.requests,
    database,
    quietMode,
    waitingOnUnavailableAgents,
    summary,
  };
}
