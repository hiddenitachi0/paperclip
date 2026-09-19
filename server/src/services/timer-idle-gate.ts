import { and, desc, eq, gt, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  approvalComments,
  approvals,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
  issueThreadInteractions,
  type Db,
} from "@paperclipai/db";
import { asBoolean, asNumber, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { extractAgentMentionIds } from "@paperclipai/shared";
import { readHeartbeatWakeFlags } from "./assignee-pickup.js";
import { isIssueWaitingOnlyOnBoardApproval } from "./board-approval-wait.js";
import { logger } from "../middleware/logger.js";

// DUR-3943 round 2: skip scheduled heartbeat wake-ups when nothing is new.
//
// Measured over 30 hours of production: 269 of 357 runs were timer wake-ups,
// and 228 of those (85%) changed nothing -- their only activity rows were a
// workspace lease taken and given back. Each still started a fresh Claude
// session and rewrote ~27K tokens of standing context, about $23/day, 43% of
// all spend. The existing DUR-42 gate (skipTimerWhenNoActionableWork, in
// heartbeat.ts) did not catch them: it only asks "does this agent have ANY
// open work?", and every one of those agents did -- the same standing issues,
// untouched since its previous run.
//
// This gate asks the next question: "has anything changed for this agent
// since its last run started?" It runs only for the plain scheduler tick
// (source "timer" with no issue/task/comment attached), after the DUR-42 gate
// has already said there is open work. Assignment, comment, mention,
// approval, recovery, retry and continuation wake-ups arrive through their
// own sources and are never gated.
//
// FAIL-OPEN, deliberately: any error, missing data or doubt means the run
// goes ahead. A skipped real task costs far more than one wasted run.
//
// Configuration, in runtimeConfig.heartbeat (the same object as intervalSec;
// the scheduler reads "...Sec" spellings, so this follows that convention):
//   skipTimerWhenNothingNew: false     -> never apply this gate (old behaviour)
//   nothingNewSafetyWindowSec: <sec>   -> force a full timer run once the last
//                                         run started longer ago than this
//                                         (default 7200 = 2h, clamped 60..86400)
// skipTimerWhenNoActionableWork: false (the DUR-42 opt-out, "always wake on
// the timer") switches this gate off too, since this gate is the stricter of
// the two.

export const TIMER_IDLE_SKIP_REASON = "heartbeat.timer.nothing_new";
export const DEFAULT_NOTHING_NEW_SAFETY_WINDOW_SEC = 7_200;
export const MIN_NOTHING_NEW_SAFETY_WINDOW_SEC = 60;
export const MAX_NOTHING_NEW_SAFETY_WINDOW_SEC = 86_400;
/** Key under agent_runtime_state.state_json where skips are counted. */
export const TIMER_IDLE_SKIP_STATE_KEY = "timerIdleSkips";
/**
 * Key under agent_runtime_state.state_json where the reasons a scheduled
 * wake-up was let through are counted (today and the previous day), with the
 * last reason. Visible at GET /api/agents/:id/runtime-state.
 */
export const TIMER_IDLE_RUN_STATE_KEY = "timerIdleRunReasons";
/** At most one summary log line per agent per this long. */
export const TIMER_IDLE_SUMMARY_LOG_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Wake-up requests that were turned down ("skipped") on purpose, for a reason
 * that has its own wake-up when it clears, so the record is not news for a
 * scheduled tick.
 *
 * issue_dependencies_blocked: the heartbeat parks a wake-up for a task whose
 * blockers are still open ("blocked descendants should stay idle until the
 * final blocker resolves"). Finishing the last blocker sends its own
 * issue_blockers_resolved wake-up, and the gate's blocker_resolved signal
 * covers that one being lost. The stranded-task sweep re-asks for such a task
 * every ~30 seconds when it never had a run, and each ask left a fresh
 * "skipped" row -- so counting these rows made every tick of that agent look
 * busy and the gate never skipped it (DUR-3943 round 3).
 *
 * Only "skipped" rows are ignored: a wake-up still queued or deferred counts
 * whatever its reason.
 */
export const TIMER_IDLE_GATE_IGNORED_SKIPPED_WAKE_REASONS = ["issue_dependencies_blocked"] as const;

/**
 * Issue rows carry no "who changed this" column, and a run's own finalisation
 * (releasing its execution lock, clearing a checkout) bumps issues.updated_at
 * just after the run finishes. Changes by anyone else during the run are seen
 * through the attributed signals (activity by others, comments by others,
 * wake-up requests); a bare updated_at bump only counts once it is this long
 * after the last run finished, so a run never makes its own next tick look busy.
 */
export const SELF_WRITE_GRACE_MS = 2 * 60 * 1000;

const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"] as const;
const ACTIVE_OR_PENDING_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const PENDING_WAKEUP_REQUEST_STATUSES = ["queued", "deferred_issue_execution", "claimed"] as const;
/** More comments than this since the last run: do not parse them, just run. */
const MENTION_SCAN_LIMIT = 200;
/** More held (in-progress / checked-out) issues than this: do not check each one, just run. */
const HELD_ISSUE_SCAN_LIMIT = 20;

export interface TimerIdleGatePolicy {
  enabled: boolean;
  safetyWindowSec: number;
}

export function readTimerIdleGatePolicy(runtimeConfig: unknown): TimerIdleGatePolicy {
  const heartbeat = parseObject(parseObject(runtimeConfig).heartbeat);
  const alwaysWakeOnTimer = asBoolean(heartbeat.skipTimerWhenNoActionableWork, true) === false;
  const enabled = !alwaysWakeOnTimer && asBoolean(heartbeat.skipTimerWhenNothingNew, true);
  const rawWindow = asNumber(heartbeat.nothingNewSafetyWindowSec, Number.NaN);
  const safetyWindowSec =
    Number.isFinite(rawWindow) && rawWindow > 0
      ? Math.min(MAX_NOTHING_NEW_SAFETY_WINDOW_SEC, Math.max(MIN_NOTHING_NEW_SAFETY_WINDOW_SEC, Math.floor(rawWindow)))
      : DEFAULT_NOTHING_NEW_SAFETY_WINDOW_SEC;
  return { enabled, safetyWindowSec };
}

/**
 * Every reason the gate lets a timer run go ahead. The first group are
 * standing rules; the rest are "something new since the last run started".
 */
export const TIMER_IDLE_GATE_RUN_SIGNALS = [
  // Standing rules
  "gate_disabled",
  "wake_on_demand_off",
  "check_failed",
  "no_previous_run",
  "previous_run_not_succeeded",
  "safety_window_elapsed",
  "run_active_or_pending",
  /** More in-progress / checked-out issues than can be checked one by one. */
  "holds_checked_out_or_in_progress_issue",
  // Something new
  /** An in-progress or checked-out issue changed since the last run (beyond its own clean-up). */
  "held_issue_changed",
  /** An issue's checkout belongs to a run that is no longer active. */
  "held_issue_stale_checkout",
  /** A held issue has a linked approval the operator sent back for changes. */
  "held_issue_approval_sent_back",
  "wakeup_request",
  "assigned_issue_created",
  "assigned_issue_updated",
  "issue_activity_by_others",
  "comment_on_assigned_issue",
  "mentioned_in_comment",
  "approval_decided",
  "approval_comment_by_others",
  "approval_waiting_for_agent",
  "interaction_changed",
  "blocker_resolved",
  "child_issue_closed",
  "issue_monitor_due",
  "recovery_action_changed",
  "execution_stage_changed",
] as const;
export type TimerIdleGateRunSignal = (typeof TIMER_IDLE_GATE_RUN_SIGNALS)[number];

/** A "something new" query that could not be run, and why. */
export interface TimerIdleGateSignalFailure {
  signal: TimerIdleGateRunSignal;
  message: string;
}

export type TimerIdleGateDecision =
  | {
    decision: "run";
    signal: TimerIdleGateRunSignal;
    /**
     * What exactly matched, in a few words (an issue identifier, a wake-up
     * reason). For diagnosis only; never shown to the operator.
     */
    detail?: string;
    error?: unknown;
    /** Signals whose query failed during this check (DUR-3981). */
    failedSignals?: TimerIdleGateSignalFailure[];
  }
  | { decision: "skip"; baselineRunId: string; baselineAt: Date };

/**
 * DUR-3943 rule 3 (two lists that must agree): every wake reason the server
 * code can pass to a wake-up, mapped to the signal(s) above that would still
 * make a scheduled tick run if that wake-up were lost. Every wake-up that
 * reaches enqueueWakeup leaves an agent_wakeup_requests row ("wakeup_request"),
 * so that signal backs every entry -- except a wake-up turned down for a
 * reason in TIMER_IDLE_GATE_IGNORED_SKIPPED_WAKE_REASONS, which has its own
 * wake-up when it clears; the data signals cover a wake-up that never got
 * that far (most are fire-and-forget).
 *
 * timer-idle-gate-wake-reasons.test.ts enumerates the real reasons from the
 * server source and fails if one is missing here, or if an entry here no
 * longer exists there.
 */
export const TIMER_IDLE_GATE_WAKE_REASON_COVERAGE: Readonly<Record<string, readonly TimerIdleGateRunSignal[]>> = {
  // Assignment and issue changes
  issue_assigned: ["assigned_issue_created", "assigned_issue_updated", "issue_activity_by_others", "wakeup_request"],
  issue_checked_out: ["held_issue_changed", "assigned_issue_updated", "issue_activity_by_others", "wakeup_request"],
  issue_status_changed: ["assigned_issue_updated", "issue_activity_by_others", "wakeup_request"],
  issue_tree_restored: ["assigned_issue_updated", "issue_activity_by_others", "wakeup_request"],
  task_watchdog_stopped_subtree: ["issue_activity_by_others", "wakeup_request"],
  plugin_issue_wakeup_requested: ["wakeup_request"],
  "customer_inbox.handoff": ["assigned_issue_created", "assigned_issue_updated", "wakeup_request"],
  "customer_inbox.unreadable_message": ["assigned_issue_created", "assigned_issue_updated", "wakeup_request"],
  "customer_inbox.conversation_continued": ["assigned_issue_updated", "comment_on_assigned_issue", "wakeup_request"],
  cross_company_instruction_approved: ["assigned_issue_created", "wakeup_request"],
  // Comments, mentions, interactions
  issue_commented: ["comment_on_assigned_issue", "interaction_changed", "wakeup_request"],
  issue_reopened_via_comment: ["comment_on_assigned_issue", "assigned_issue_updated", "wakeup_request"],
  issue_comment_mentioned: ["mentioned_in_comment", "wakeup_request"],
  // Approvals and execution stages (review / approve / changes requested)
  approval_approved: ["approval_decided", "wakeup_request"],
  approval_rejected: ["approval_decided", "wakeup_request"],
  model_boost_boss_review: ["approval_waiting_for_agent", "wakeup_request"],
  execution_review_requested: ["execution_stage_changed", "wakeup_request"],
  execution_approval_requested: ["execution_stage_changed", "wakeup_request"],
  execution_changes_requested: ["execution_stage_changed", "assigned_issue_updated", "wakeup_request"],
  // Blockers and sub-tasks
  issue_blockers_resolved: ["blocker_resolved", "wakeup_request"],
  issue_children_completed: ["child_issue_closed", "wakeup_request"],
  // Monitors and recovery
  issue_monitor_due: ["issue_monitor_due", "wakeup_request"],
  issue_monitor_recovery: ["issue_monitor_due", "wakeup_request"],
  issue_monitor_recovery_issue: ["assigned_issue_created", "wakeup_request"],
  source_scoped_recovery_action: ["recovery_action_changed", "wakeup_request"],
  issue_recovery_action_restored: ["recovery_action_changed", "issue_activity_by_others", "wakeup_request"],
  issue_assignment_recovery: ["run_active_or_pending", "wakeup_request"],
  issue_continuation_needed: ["run_active_or_pending", "wakeup_request"],
  execution_review_participant_recovery: ["run_active_or_pending", "wakeup_request"],
  cheap_run_escalation: ["run_active_or_pending", "wakeup_request"],
  // A wake-up parked behind another run's lock on the same issue, and the
  // same wake-up promoted to queued once the lock frees up. Both stay pending
  // agent_wakeup_requests rows, which count whatever their age.
  issue_execution_deferred: ["wakeup_request"],
  issue_execution_promoted: ["run_active_or_pending", "wakeup_request"],
  // Retries and continuations of a previous run: queued or scheduled runs,
  // or a previous run that did not succeed.
  transient_failure_retry: ["run_active_or_pending", "previous_run_not_succeeded", "wakeup_request"],
  process_lost_retry: ["run_active_or_pending", "previous_run_not_succeeded", "wakeup_request"],
  max_turns_continuation_retry: ["run_active_or_pending", "previous_run_not_succeeded", "wakeup_request"],
  missing_issue_comment: ["run_active_or_pending", "wakeup_request"],
  run_liveness_continuation: ["run_active_or_pending", "wakeup_request"],
  finish_successful_run_handoff: ["run_active_or_pending", "wakeup_request"],
  goal_condition_judge: ["run_active_or_pending", "wakeup_request"],
  goal_condition_not_met: ["run_active_or_pending", "wakeup_request"],
  self_review_pass: ["run_active_or_pending", "wakeup_request"],
};

/** Wake reasons deliberately NOT covered, and why. */
export const TIMER_IDLE_GATE_EXCLUDED_WAKE_REASONS: Readonly<Record<string, string>> = {
  heartbeat_timer: "This is the scheduled wake-up itself -- the one the gate decides on.",
};

function ms(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

async function exists(query: Promise<Array<unknown>>): Promise<boolean> {
  const rows = await query;
  return rows.length > 0;
}

/** The first matching row described in a few words, or null when there is none. */
async function firstDetail<T>(query: Promise<T[]>, describe: (row: T) => string): Promise<string | null> {
  const [row] = await query;
  return row === undefined ? null : describe(row);
}

function issueLabel(row: { identifier: string | null; id: string }): string {
  return row.identifier ?? row.id;
}

/**
 * Decides whether a plain scheduled wake-up may be skipped. Never throws: an
 * error anywhere returns { decision: "run", signal: "check_failed" }.
 */
export async function evaluateTimerIdleGate(
  db: Db,
  agent: { id: string; companyId: string; runtimeConfig: unknown },
  options: { now?: Date } = {},
): Promise<TimerIdleGateDecision> {
  try {
    return await evaluate(db, agent, options.now ?? new Date());
  } catch (error) {
    logger.warn({ err: error, agentId: agent.id }, "timer idle gate: check failed, letting the scheduled run go ahead");
    return { decision: "run", signal: "check_failed", error };
  }
}

async function evaluate(
  db: Db,
  agent: { id: string; companyId: string; runtimeConfig: unknown },
  now: Date,
): Promise<TimerIdleGateDecision> {
  const failures: TimerIdleGateSignalFailure[] = [];
  const run = (signal: TimerIdleGateRunSignal, detail?: string | null): TimerIdleGateDecision => ({
    decision: "run",
    signal,
    ...(detail ? { detail } : {}),
    ...(failures.length > 0 ? { failedSignals: [...failures] } : {}),
  });
  const policy = readTimerIdleGatePolicy(agent.runtimeConfig);
  if (!policy.enabled) return run("gate_disabled");
  // An agent that is not woken on demand hears about assignments, comments
  // and decisions ONLY through its timer (assignee-pickup.ts "on_timer"), so
  // there is nothing to fall back on: never gate it.
  if (!readHeartbeatWakeFlags(agent.runtimeConfig).wakeOnDemand) return run("wake_on_demand_off");

  const companyId = agent.companyId;
  const agentId = agent.id;

  // DUR-3981: each "something new" query answers for itself. A query that
  // fails is recorded and answers "I cannot tell" -- never "nothing new" --
  // and any such failure forces the run at the end of the check. Keeping the
  // signals independent means one broken query cannot hide the others, and a
  // test can prove a case passed because the rule said so, not because
  // something threw.
  //
  // A query answers true / a short description of what it found ("new"), or
  // false / null ("nothing new"). check() hands back the description (or ""
  // for a plain true) so the decision can say what matched.
  const check = async (
    signal: TimerIdleGateRunSignal,
    query: () => Promise<boolean | string | null>,
  ): Promise<string | null> => {
    try {
      const answer = await query();
      if (typeof answer === "string") return answer;
      return answer ? "" : null;
    } catch (error) {
      failures.push({ signal, message: error instanceof Error ? error.message : String(error) });
      logger.warn(
        { err: error, agentId, signal },
        "timer idle gate: a signal could not be checked; the scheduled run goes ahead",
      );
      return null;
    }
  };
  /** Runs the check; returns the decision when the signal fired, null otherwise. */
  const fired = async (
    signal: TimerIdleGateRunSignal,
    query: () => Promise<boolean | string | null>,
  ): Promise<TimerIdleGateDecision | null> => {
    const found = await check(signal, query);
    return found === null ? null : run(signal, found);
  };

  // Anything queued, running or scheduled for this agent: let the wake-up
  // through (enqueueWakeup coalesces it onto that run).
  const activeRun = await fired("run_active_or_pending", () => firstDetail(
    db
      .select({ status: heartbeatRuns.status, source: heartbeatRuns.invocationSource })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          inArray(heartbeatRuns.status, [...ACTIVE_OR_PENDING_RUN_STATUSES]),
        ),
      )
      .limit(1),
    (row) => `${row.source} run ${row.status}`,
  ));
  if (activeRun) return activeRun;

  const [lastRun] = await db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      createdAt: heartbeatRuns.createdAt,
    })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)))
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(1);
  if (!lastRun) return run("no_previous_run");
  if (lastRun.status !== "succeeded") return run("previous_run_not_succeeded", lastRun.status);

  // A run that never recorded a start is judged from when it was created,
  // which is earlier: more things count as new, never fewer.
  const baselineMs = ms(lastRun.startedAt) ?? ms(lastRun.createdAt);
  if (baselineMs === null) return run("no_previous_run");
  if (now.getTime() - baselineMs > policy.safetyWindowSec * 1000) return run("safety_window_elapsed");
  const since = new Date(baselineMs);
  const finishedMs = ms(lastRun.finishedAt) ?? now.getTime();
  const unattributedSince = new Date(Math.max(baselineMs, finishedMs + SELF_WRITE_GRACE_MS));

  const assignedToAgent = and(eq(issues.companyId, companyId), eq(issues.assigneeAgentId, agentId), isNull(issues.hiddenAt));
  const openAssigned = and(assignedToAgent, notInArray(issues.status, [...TERMINAL_ISSUE_STATUSES]));

  // In-progress and checked-out issues (DUR-3943 round 3).
  //
  // Holding one used to force every scheduled tick to run. On production that
  // kept Dashboard Boss running every 15 minutes for one in-progress task
  // that nothing had touched, while the work itself was being moved on by the
  // wake-ups that are never gated (execution promotion, continuation and
  // assignment recovery, blockers resolved, children completed). So holding
  // work is no longer news by itself. A held issue counts only when:
  //   - it changed since the last run started, beyond that run's own
  //     clean-up (the same grace as assigned_issue_updated), or
  //   - its checkout belongs to a run that is no longer active: nobody is
  //     working it, and a run of this agent can take the checkout over.
  // An issue waiting only on the operator's decision on a linked approval
  // (DUR-3979, board-approval-wait.ts) never counts for the checkout rule,
  // exactly as before; a change to it is still news through
  // assigned_issue_updated. Fail-open: a failed approval check answers "not
  // waiting", so the run goes ahead. One narrower rule stays unconditional
  // (a linked approval sent back for changes, below). Held work that nothing
  // else wakes gets a run at the latest when the safety window elapses.
  const heldIssues: Array<{
    id: string;
    identifier: string | null;
    updatedAt: Date;
    checkoutRunId: string | null;
    checkoutRunStatus: string | null;
  }> = [];
  // A failed lookup is recorded against held_issue_changed and forces the run
  // at the end of the check, like any other signal that cannot answer.
  await check("held_issue_changed", async () => {
    const rows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        updatedAt: issues.updatedAt,
        checkoutRunId: issues.checkoutRunId,
        checkoutRunStatus: heartbeatRuns.status,
      })
      .from(issues)
      .leftJoin(heartbeatRuns, eq(heartbeatRuns.id, issues.checkoutRunId))
      .where(and(openAssigned, or(eq(issues.status, "in_progress"), sql`${issues.checkoutRunId} is not null`)))
      .limit(HELD_ISSUE_SCAN_LIMIT + 1);
    heldIssues.push(...rows);
    return false;
  });
  if (heldIssues.length > HELD_ISSUE_SCAN_LIMIT) return run("holds_checked_out_or_in_progress_issue", `more than ${HELD_ISSUE_SCAN_LIMIT}`);
  for (const held of heldIssues) {
    const changed = (ms(held.updatedAt) ?? Number.POSITIVE_INFINITY) > unattributedSince.getTime();
    const staleCheckout =
      held.checkoutRunId !== null &&
      !(ACTIVE_OR_PENDING_RUN_STATUSES as readonly string[]).includes(held.checkoutRunStatus ?? "");
    if (changed) return run("held_issue_changed", issueLabel(held));
    if (staleCheckout && !(await isIssueWaitingOnlyOnBoardApproval(db, { companyId, issueId: held.id }))) {
      return run("held_issue_stale_checkout", `${issueLabel(held)} (checkout run ${held.checkoutRunStatus ?? "gone"})`);
    }
  }
  // The one held case kept on every tick: the operator sent a linked approval
  // back for changes. Nothing wakes the agent for that (the request-revision
  // route sends no wake-up; see board-approval-wait.ts), so the timer is its
  // only way back to the work, and dropping it could leave the send-back
  // unanswered for a whole safety window at a time. It stops counting the
  // moment the agent resubmits or the approval is otherwise settled.
  if (heldIssues.length > 0) {
    const sentBack = await fired("held_issue_approval_sent_back", () => firstDetail(
      db
        .select({ id: issues.id, identifier: issues.identifier })
        .from(issueApprovals)
        .innerJoin(approvals, eq(approvals.id, issueApprovals.approvalId))
        .innerJoin(issues, eq(issues.id, issueApprovals.issueId))
        .where(
          and(
            eq(issueApprovals.companyId, companyId),
            eq(approvals.companyId, companyId),
            inArray(issueApprovals.issueId, heldIssues.map((held) => held.id)),
            eq(approvals.status, "revision_requested"),
          ),
        )
        .limit(1),
      issueLabel,
    ));
    if (sentBack) return sentBack;
  }

  // DUR-3943: a wake-up still sitting in a pending status counts as outstanding
  // work -- but only for as long as it could still BE outstanding. Without a
  // bound, ONE stuck row disables this gate for that agent permanently, because
  // the gate then sees a pending wake-up on every single tick and must let the
  // run through. Measured on production: 71 rows stuck in `claimed`, the oldest
  // 25 days, and the three agents holding the most were exactly the three whose
  // scheduled runs cost money while changing nothing on the board.
  //
  // Two bounds, each answering a different way a row goes stale:
  //  * Liveness. `claimed` means some run picked the wake-up up. If that run is
  //    no longer active, nothing will ever finish it, so it is not pending in
  //    any useful sense. This is the `process_lost_retry` shape seen live -- a
  //    run died holding the wake-up it had claimed. All 56 stuck `claimed` rows
  //    on production are of exactly this shape.
  //  * Age. A `queued` or deferred wake-up that no run has acted on within a
  //    whole day is not news any more; whatever it was about is picked up by
  //    the ordinary checks below or by the safety window. Deliberately NOT
  //    bound to this agent's own safety window: the window forces a run, but
  //    that run need not have handled THIS wake-up, which is the very reason
  //    the row is still queued -- so "a window has passed" does not mean "it
  //    had its chance". MAX_NOTHING_NEW_SAFETY_WINDOW_SEC is used instead as
  //    the longest patience anyone can configure anywhere. The stale rows on
  //    production are 2.5 to 25 days old, far past any honest reading of
  //    "still outstanding".
  //
  // Both fail SAFE. Tripping either bound only stops a stale row from forcing a
  // run; a genuinely new wake-up still arrives through the `requestedAt > since`
  // arm, which is untouched.
  const pendingWakeupCutoff = new Date(now.getTime() - MAX_NOTHING_NEW_SAFETY_WINDOW_SEC * 1000);
  const pendingWakeupStillLive = sql`(
    ${agentWakeupRequests.status} <> 'claimed'
    or ${agentWakeupRequests.runId} is null
    or exists (
      select 1
      from ${heartbeatRuns}
      where ${heartbeatRuns.id} = ${agentWakeupRequests.runId}
        and ${heartbeatRuns.status} in (${sql.join(
          ACTIVE_OR_PENDING_RUN_STATUSES.map((status) => sql`${status}`),
          sql`, `,
        )})
    )
  )`;

  // Any non-timer wake-up asked for since the last run started, whatever
  // became of it (coalesced, deferred, skipped, failed), or one still pending
  // and not yet stale (see above) -- except one turned down on purpose for a
  // reason that has its own wake-up when it clears
  // (TIMER_IDLE_GATE_IGNORED_SKIPPED_WAKE_REASONS).
  const wakeupRequest = await fired("wakeup_request", () => firstDetail(
    db
      .select({ reason: agentWakeupRequests.reason, status: agentWakeupRequests.status, source: agentWakeupRequests.source })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, agentId),
          sql`${agentWakeupRequests.source} <> 'timer'`,
          or(
            gt(agentWakeupRequests.requestedAt, since),
            and(
              inArray(agentWakeupRequests.status, [...PENDING_WAKEUP_REQUEST_STATUSES]),
              gt(agentWakeupRequests.requestedAt, pendingWakeupCutoff),
              pendingWakeupStillLive,
            ),
          ),
          sql`not (${agentWakeupRequests.status} = 'skipped' and ${agentWakeupRequests.reason} in (${sql.join(
            TIMER_IDLE_GATE_IGNORED_SKIPPED_WAKE_REASONS.map((reason) => sql`${reason}`),
            sql`, `,
          )}))`,
        ),
      )
      .orderBy(desc(agentWakeupRequests.requestedAt))
      .limit(1),
    (row) => `${row.reason ?? "no reason"} (${row.source}, ${row.status})`,
  ));
  if (wakeupRequest) return wakeupRequest;

  const assignedCreated = await fired("assigned_issue_created", () => firstDetail(
    db
      .select({ id: issues.id, identifier: issues.identifier })
      .from(issues)
      .where(
        and(openAssigned, gt(issues.createdAt, since), sql`${issues.createdByAgentId} is distinct from ${agentId}::uuid`),
      )
      .limit(1),
    issueLabel,
  ));
  if (assignedCreated) return assignedCreated;

  const assignedUpdated = await fired("assigned_issue_updated", () => firstDetail(
    db
      .select({ id: issues.id, identifier: issues.identifier })
      .from(issues)
      .where(and(openAssigned, gt(issues.updatedAt, unattributedSince)))
      .limit(1),
    issueLabel,
  ));
  if (assignedUpdated) return assignedUpdated;

  // Activity on the agent's open issues by anyone but the agent itself or
  // one of its own runs.
  const activityByOthers = await fired("issue_activity_by_others", () => firstDetail(
    db
      .select({ action: activityLog.action, actorType: activityLog.actorType, actorId: activityLog.actorId })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityType, "issue"),
          gt(activityLog.createdAt, since),
          sql`${activityLog.entityId} in (select ${issues.id}::text from ${issues} where ${openAssigned})`,
          sql`not (${activityLog.actorType} = 'agent' and ${activityLog.actorId} = ${agentId})`,
          sql`(${activityLog.runId} is null or not exists (select 1 from ${heartbeatRuns} own_run where own_run.id = ${activityLog.runId} and own_run.agent_id = ${agentId}::uuid))`,
        ),
      )
      .limit(1),
    (row) => `${row.action} by ${row.actorType === "system" ? `system ${row.actorId}` : row.actorType}`,
  ));
  if (activityByOthers) return activityByOthers;

  // Comments by anyone else on any issue assigned to the agent (a comment on
  // a closed issue can reopen it).
  const commentByOthers = await fired("comment_on_assigned_issue", () => firstDetail(
    db
      .select({ id: issues.id, identifier: issues.identifier })
      .from(issueComments)
      .innerJoin(issues, eq(issues.id, issueComments.issueId))
      .where(
        and(
          assignedToAgent,
          eq(issueComments.companyId, companyId),
          gt(issueComments.createdAt, since),
          isNull(issueComments.deletedAt),
          sql`${issueComments.authorAgentId} is distinct from ${agentId}::uuid`,
        ),
      )
      .limit(1),
    issueLabel,
  ));
  if (commentByOthers) return commentByOthers;

  // Mentions anywhere in the company. The id prefilter is a superset; the
  // real parser the comment route uses decides.
  const mentioned = await fired("mentioned_in_comment", async () => {
    const mentionCandidates = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, companyId),
          gt(issueComments.createdAt, since),
          isNull(issueComments.deletedAt),
          sql`${issueComments.authorAgentId} is distinct from ${agentId}::uuid`,
          sql`strpos(${issueComments.body}, ${agentId}) > 0`,
        ),
      )
      .limit(MENTION_SCAN_LIMIT + 1);
    if (mentionCandidates.length > MENTION_SCAN_LIMIT) return `more than ${MENTION_SCAN_LIMIT} candidate comments`;
    return mentionCandidates.some((comment) => extractAgentMentionIds(comment.body).includes(agentId));
  });
  if (mentioned) return mentioned;

  // Approvals the agent asked for, or that sit on its issues, decided since.
  const approvalDecided = await fired("approval_decided", () => firstDetail(
    db
      .select({ type: approvals.type, status: approvals.status })
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, companyId),
          sql`${approvals.status} <> 'pending'`,
          or(gt(approvals.decidedAt, since), gt(approvals.updatedAt, since)),
          or(
            eq(approvals.requestedByAgentId, agentId),
            sql`exists (select 1 from ${issueApprovals} ia join ${issues} linked on linked.id = ia.issue_id where ia.approval_id = ${approvals.id} and linked.assignee_agent_id = ${agentId}::uuid)`,
          ),
        ),
      )
      .limit(1),
    (row) => `${row.type} ${row.status}`,
  ));
  if (approvalDecided) return approvalDecided;

  const approvalComment = await fired("approval_comment_by_others", () => exists(
    db
      .select({ id: approvalComments.id })
      .from(approvalComments)
      .innerJoin(approvals, eq(approvals.id, approvalComments.approvalId))
      .where(
        and(
          eq(approvalComments.companyId, companyId),
          eq(approvals.requestedByAgentId, agentId),
          gt(approvalComments.createdAt, since),
          sql`${approvalComments.authorAgentId} is distinct from ${agentId}::uuid`,
        ),
      )
      .limit(1),
  ));
  if (approvalComment) return approvalComment;

  // An approval waiting on THIS agent's answer (a boss review of a
  // teammate's boost ask) that arrived or changed since.
  const approvalWaiting = await fired("approval_waiting_for_agent", () => exists(
    db
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, companyId),
          eq(approvals.status, "pending"),
          sql`${approvals.payload} -> 'bossReview' ->> 'bossAgentId' = ${agentId}`,
          or(gt(approvals.createdAt, since), gt(approvals.updatedAt, since)),
        ),
      )
      .limit(1),
  ));
  if (approvalWaiting) return approvalWaiting;

  // Interactions (questions, confirmations, suggested tasks) the agent opened
  // or that live on its issues: a new one from someone else, or one answered.
  const interaction = await fired("interaction_changed", () => firstDetail(
    db
      .select({ kind: issueThreadInteractions.kind, status: issueThreadInteractions.status })
      .from(issueThreadInteractions)
      .leftJoin(issues, eq(issues.id, issueThreadInteractions.issueId))
      .where(
        and(
          eq(issueThreadInteractions.companyId, companyId),
          or(eq(issueThreadInteractions.createdByAgentId, agentId), eq(issues.assigneeAgentId, agentId)),
          or(
            and(
              gt(issueThreadInteractions.createdAt, since),
              sql`${issueThreadInteractions.createdByAgentId} is distinct from ${agentId}::uuid`,
            ),
            and(
              or(gt(issueThreadInteractions.resolvedAt, since), gt(issueThreadInteractions.updatedAt, since)),
              sql`${issueThreadInteractions.status} <> 'pending'`,
              sql`${issueThreadInteractions.resolvedByAgentId} is distinct from ${agentId}::uuid`,
            ),
          ),
        ),
      )
      .limit(1),
    (row) => `${row.kind} ${row.status}`,
  ));
  if (interaction) return interaction;

  // A blocker of one of its open issues finished (issue_relations: issue_id
  // blocks related_issue_id).
  const blockerResolved = await fired("blocker_resolved", () => firstDetail(
    db
      .select({ id: issues.id, identifier: issues.identifier })
      .from(issueRelations)
      .innerJoin(issues, eq(issues.id, issueRelations.relatedIssueId))
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "blocks"),
          openAssigned,
          sql`exists (select 1 from ${issues} blocker where blocker.id = ${issueRelations.issueId} and (blocker.completed_at > ${since.toISOString()}::timestamptz or blocker.cancelled_at > ${since.toISOString()}::timestamptz or (blocker.status in ('done', 'cancelled') and blocker.updated_at > ${since.toISOString()}::timestamptz)))`,
        ),
      )
      .limit(1),
    issueLabel,
  ));
  if (blockerResolved) return blockerResolved;

  const childClosed = await fired("child_issue_closed", () => firstDetail(
    db
      .select({ id: issues.id, identifier: issues.identifier })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          or(gt(issues.completedAt, since), gt(issues.cancelledAt, since)),
          sql`${issues.parentId} in (select parent.id from ${issues} parent where parent.company_id = ${companyId}::uuid and parent.assignee_agent_id = ${agentId}::uuid and parent.hidden_at is null and parent.status not in ('done', 'cancelled'))`,
        ),
      )
      .limit(1),
    issueLabel,
  ));
  if (childClosed) return childClosed;

  const monitorDue = await fired("issue_monitor_due", () => firstDetail(
    db
      .select({ id: issues.id, identifier: issues.identifier })
      .from(issues)
      .where(and(openAssigned, sql`${issues.monitorNextCheckAt} <= ${now.toISOString()}::timestamptz`))
      .limit(1),
    issueLabel,
  ));
  if (monitorDue) return monitorDue;

  const recoveryChanged = await fired("recovery_action_changed", () => firstDetail(
    db
      .select({ kind: issueRecoveryActions.kind, status: issueRecoveryActions.status })
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          or(eq(issueRecoveryActions.ownerAgentId, agentId), eq(issueRecoveryActions.returnOwnerAgentId, agentId)),
          gt(issueRecoveryActions.updatedAt, since),
        ),
      )
      .limit(1),
    (row) => `${row.kind} ${row.status}`,
  ));
  if (recoveryChanged) return recoveryChanged;

  // Review / approval stages: the agent is the current reviewer or approver,
  // or changes were requested back to it, on an issue that moved since.
  const stageChanged = await fired("execution_stage_changed", () => firstDetail(
    db
      .select({ id: issues.id, identifier: issues.identifier })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          isNull(issues.hiddenAt),
          notInArray(issues.status, [...TERMINAL_ISSUE_STATUSES]),
          gt(issues.updatedAt, since),
          or(
            sql`${issues.executionState} -> 'currentParticipant' ->> 'agentId' = ${agentId}`,
            sql`${issues.executionState} -> 'returnAssignee' ->> 'agentId' = ${agentId}`,
          ),
        ),
      )
      .limit(1),
    issueLabel,
  ));
  if (stageChanged) return stageChanged;

  // Nothing said "new". If any signal could not answer, that unanswered
  // signal is exactly the one that might have been holding work, so the run
  // goes ahead (fail-open) rather than the tick being skipped on partial
  // information.
  if (failures.length > 0) return run("check_failed", failures.map((failure) => failure.signal).join(", "));

  return { decision: "skip", baselineRunId: lastRun.id, baselineAt: since };
}

export interface TimerIdleSkipState {
  total: number;
  day: string;
  dayCount: number;
  previousDay: string | null;
  previousDayCount: number;
  lastSkippedAt: string;
  lastBaselineRunId: string;
  /** DUR-3981: set when a signal query failed and forced a run. */
  lastCheckError?: { at: string; signals: string; message: string };
}

/**
 * Counts a skipped wake-up on the agent's runtime state (one row per agent,
 * merged into state_json under "timerIdleSkips"): a running total, today's
 * and the previous day's count (UTC), and the last skip. No per-skip rows
 * anywhere. Visible at GET /api/agents/:id/runtime-state. Best-effort: a
 * failure is logged and the skip still stands.
 */
export async function recordTimerIdleSkip(
  db: Db,
  agent: { id: string; companyId: string; adapterType: string },
  decision: Extract<TimerIdleGateDecision, { decision: "skip" }>,
  now: Date = new Date(),
): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  const nowIso = now.toISOString();
  const key = TIMER_IDLE_SKIP_STATE_KEY;
  try {
    const fresh: TimerIdleSkipState = {
      total: 1,
      day,
      dayCount: 1,
      previousDay: null,
      previousDayCount: 0,
      lastSkippedAt: nowIso,
      lastBaselineRunId: decision.baselineRunId,
    };
    const current = sql`coalesce(${agentRuntimeState.stateJson} -> ${key}, '{}'::jsonb)`;
    await db
      .insert(agentRuntimeState)
      .values({
        agentId: agent.id,
        companyId: agent.companyId,
        adapterType: agent.adapterType,
        stateJson: { [key]: fresh },
      })
      .onConflictDoUpdate({
        target: agentRuntimeState.agentId,
        set: {
          stateJson: sql`coalesce(${agentRuntimeState.stateJson}, '{}'::jsonb) || jsonb_build_object(${key}::text, jsonb_build_object(
            'total', coalesce((${current} ->> 'total')::bigint, 0) + 1,
            'day', ${day}::text,
            'dayCount', case when ${current} ->> 'day' = ${day}::text then coalesce((${current} ->> 'dayCount')::bigint, 0) + 1 else 1 end,
            'previousDay', case when ${current} ->> 'day' = ${day}::text then ${current} -> 'previousDay' else ${current} -> 'day' end,
            'previousDayCount', case when ${current} ->> 'day' = ${day}::text then coalesce((${current} ->> 'previousDayCount')::bigint, 0) else coalesce((${current} ->> 'dayCount')::bigint, 0) end,
            'lastSkippedAt', ${nowIso}::text,
            'lastBaselineRunId', ${decision.baselineRunId}::text
          ))`,
        },
      });
  } catch (error) {
    logger.warn({ err: error, agentId: agent.id }, "timer idle gate: could not record skipped wake-up");
  }
}

/**
 * DUR-3981: records that the check could not be completed, on the same
 * runtime-state key as the skip counters (no row per tick). Without this a
 * permanently broken signal query is invisible: every tick quietly falls open
 * and runs, which looks exactly like a busy agent while costing full price.
 * Best-effort, like the skip counter.
 */
export async function recordTimerIdleCheckFailure(
  db: Db,
  agent: { id: string; companyId: string; adapterType: string },
  decision: Extract<TimerIdleGateDecision, { decision: "run" }>,
  now: Date = new Date(),
): Promise<void> {
  const failures = decision.failedSignals ?? [];
  if (failures.length === 0) return;
  const key = TIMER_IDLE_SKIP_STATE_KEY;
  const nowIso = now.toISOString();
  const lastCheckError = {
    at: nowIso,
    signals: failures.map((failure) => failure.signal).join(", "),
    message: failures[0]!.message,
  };
  try {
    await db
      .insert(agentRuntimeState)
      .values({
        agentId: agent.id,
        companyId: agent.companyId,
        adapterType: agent.adapterType,
        stateJson: { [key]: { lastCheckError } },
      })
      .onConflictDoUpdate({
        target: agentRuntimeState.agentId,
        set: {
          stateJson: sql`coalesce(${agentRuntimeState.stateJson}, '{}'::jsonb) || jsonb_build_object(${key}::text,
            coalesce(${agentRuntimeState.stateJson} -> ${key}, '{}'::jsonb) || jsonb_build_object('lastCheckError', ${JSON.stringify(lastCheckError)}::jsonb))`,
        },
      });
  } catch (error) {
    logger.warn({ err: error, agentId: agent.id }, "timer idle gate: could not record a failed check");
  }
}

export interface TimerIdleRunReasonState {
  /** UTC day the byReason counts are for. */
  day: string;
  /** How often each reason let a scheduled wake-up through on that day. */
  byReason: Partial<Record<TimerIdleGateRunSignal, number>>;
  previousDay: string | null;
  previousByReason: Partial<Record<TimerIdleGateRunSignal, number>> | null;
  lastReason: TimerIdleGateRunSignal;
  /** What exactly matched last time (an issue identifier, a wake-up reason), when known. */
  lastDetail: string | null;
  lastRanAt: string;
}

const MAX_DETAIL_CHARS = 200;

/**
 * DUR-3943 round 3: records WHY a scheduled wake-up was let through, on the
 * same runtime-state row as the skip counters (merged into state_json under
 * "timerIdleRunReasons"): a counter per reason for today and the previous day
 * (UTC), and the last reason with what matched and when. No row per decision
 * and no log line per tick. Visible at GET /api/agents/:id/runtime-state.
 * Best-effort: a failure is logged and the run still goes ahead.
 */
export async function recordTimerIdleGateRun(
  db: Db,
  agent: { id: string; companyId: string; adapterType: string },
  decision: Extract<TimerIdleGateDecision, { decision: "run" }>,
  now: Date = new Date(),
): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  const nowIso = now.toISOString();
  const key = TIMER_IDLE_RUN_STATE_KEY;
  const reason = decision.signal;
  const detail = decision.detail ? decision.detail.slice(0, MAX_DETAIL_CHARS) : null;
  try {
    const fresh: TimerIdleRunReasonState = {
      day,
      byReason: { [reason]: 1 },
      previousDay: null,
      previousByReason: null,
      lastReason: reason,
      lastDetail: detail,
      lastRanAt: nowIso,
    };
    const current = sql`coalesce(${agentRuntimeState.stateJson} -> ${key}::text, '{}'::jsonb)`;
    const sameDay = sql`(${current} ->> 'day') = ${day}::text`;
    await db
      .insert(agentRuntimeState)
      .values({
        agentId: agent.id,
        companyId: agent.companyId,
        adapterType: agent.adapterType,
        stateJson: { [key]: fresh },
      })
      .onConflictDoUpdate({
        target: agentRuntimeState.agentId,
        set: {
          stateJson: sql`coalesce(${agentRuntimeState.stateJson}, '{}'::jsonb) || jsonb_build_object(${key}::text, jsonb_build_object(
            'day', ${day}::text,
            'byReason', case when ${sameDay}
              then coalesce(${current} -> 'byReason', '{}'::jsonb) || jsonb_build_object(${reason}::text, coalesce((${current} -> 'byReason' ->> ${reason}::text)::bigint, 0) + 1)
              else jsonb_build_object(${reason}::text, 1) end,
            'previousDay', case when ${sameDay} then ${current} -> 'previousDay' else ${current} -> 'day' end,
            'previousByReason', case when ${sameDay} then ${current} -> 'previousByReason' else ${current} -> 'byReason' end,
            'lastReason', ${reason}::text,
            'lastDetail', ${detail}::text,
            'lastRanAt', ${nowIso}::text
          ))`,
        },
      });
  } catch (error) {
    logger.warn({ err: error, agentId: agent.id }, "timer idle gate: could not record why a scheduled wake-up ran");
  }
}

interface TimerIdleSummaryWindow {
  startedAt: number;
  skipped: number;
  ran: Record<string, number>;
}

const summaryWindows = new Map<string, TimerIdleSummaryWindow>();

/**
 * One info log line per agent per hour at most, summarising the gate's
 * decisions since the previous line: how many scheduled wake-ups were skipped
 * and, per reason, how many ran. Counted in memory (lost on restart, which
 * only shortens one window); nothing is written per tick. Returns true when
 * it logged.
 */
export function noteTimerIdleGateDecision(
  agent: { id: string; companyId: string; name?: string | null },
  decision: TimerIdleGateDecision,
  now: Date = new Date(),
): boolean {
  const nowMs = now.getTime();
  let window = summaryWindows.get(agent.id);
  if (!window) {
    window = { startedAt: nowMs, skipped: 0, ran: {} };
    summaryWindows.set(agent.id, window);
  }
  if (decision.decision === "skip") window.skipped += 1;
  else window.ran[decision.signal] = (window.ran[decision.signal] ?? 0) + 1;
  if (nowMs - window.startedAt < TIMER_IDLE_SUMMARY_LOG_INTERVAL_MS) return false;
  logger.info(
    {
      agentId: agent.id,
      companyId: agent.companyId,
      agentName: agent.name ?? undefined,
      since: new Date(window.startedAt).toISOString(),
      skipped: window.skipped,
      ran: window.ran,
    },
    "timer idle gate: hourly summary of scheduled wake-ups",
  );
  summaryWindows.set(agent.id, { startedAt: nowMs, skipped: 0, ran: {} });
  return true;
}

/** Test hook: forget every in-memory summary window. */
export function resetTimerIdleGateSummariesForTest(): void {
  summaryWindows.clear();
}
