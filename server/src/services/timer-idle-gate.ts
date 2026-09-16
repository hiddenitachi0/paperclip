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
  "holds_checked_out_or_in_progress_issue",
  // Something new
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
 * so that signal backs every entry; the data signals cover a wake-up that
 * never got that far (most are fire-and-forget).
 *
 * timer-idle-gate-wake-reasons.test.ts enumerates the real reasons from the
 * server source and fails if one is missing here, or if an entry here no
 * longer exists there.
 */
export const TIMER_IDLE_GATE_WAKE_REASON_COVERAGE: Readonly<Record<string, readonly TimerIdleGateRunSignal[]>> = {
  // Assignment and issue changes
  issue_assigned: ["assigned_issue_created", "assigned_issue_updated", "issue_activity_by_others", "wakeup_request"],
  issue_checked_out: ["holds_checked_out_or_in_progress_issue", "wakeup_request"],
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
  const run = (signal: TimerIdleGateRunSignal): TimerIdleGateDecision => ({
    decision: "run",
    signal,
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
  const check = async (signal: TimerIdleGateRunSignal, query: () => Promise<boolean>): Promise<boolean> => {
    try {
      return await query();
    } catch (error) {
      failures.push({ signal, message: error instanceof Error ? error.message : String(error) });
      logger.warn(
        { err: error, agentId, signal },
        "timer idle gate: a signal could not be checked; the scheduled run goes ahead",
      );
      return false;
    }
  };

  // Anything queued, running or scheduled for this agent: let the wake-up
  // through (enqueueWakeup coalesces it onto that run).
  if (
    await check("run_active_or_pending", () => exists(
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.agentId, agentId),
            inArray(heartbeatRuns.status, [...ACTIVE_OR_PENDING_RUN_STATUSES]),
          ),
        )
        .limit(1),
    ))
  ) {
    return run("run_active_or_pending");
  }

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
  if (lastRun.status !== "succeeded") return run("previous_run_not_succeeded");

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

  // DUR-3979: an in-progress or checked-out issue that waits only on the
  // operator's decision on a linked approval is not work to continue (see
  // board-approval-wait.ts); only the other held issues keep the timer on.
  // Fail-open: a failed check answers "not waiting", so the run goes ahead.
  const heldIssues = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(openAssigned, or(eq(issues.status, "in_progress"), sql`${issues.checkoutRunId} is not null`)))
    .limit(HELD_ISSUE_SCAN_LIMIT + 1);
  if (heldIssues.length > HELD_ISSUE_SCAN_LIMIT) return run("holds_checked_out_or_in_progress_issue");
  for (const held of heldIssues) {
    if (!(await isIssueWaitingOnlyOnBoardApproval(db, { companyId, issueId: held.id }))) {
      return run("holds_checked_out_or_in_progress_issue");
    }
  }

  // Any non-timer wake-up asked for since the last run started, whatever
  // became of it (coalesced, deferred, skipped, failed), or one still pending.
  if (
    await check("wakeup_request", () => exists(
      db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.agentId, agentId),
            sql`${agentWakeupRequests.source} <> 'timer'`,
            or(
              gt(agentWakeupRequests.requestedAt, since),
              inArray(agentWakeupRequests.status, [...PENDING_WAKEUP_REQUEST_STATUSES]),
            ),
          ),
        )
        .limit(1),
    ))
  ) {
    return run("wakeup_request");
  }

  if (
    await check("assigned_issue_created", () => exists(
      db
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(openAssigned, gt(issues.createdAt, since), sql`${issues.createdByAgentId} is distinct from ${agentId}::uuid`),
        )
        .limit(1),
    ))
  ) {
    return run("assigned_issue_created");
  }

  if (
    await check("assigned_issue_updated", () => exists(
      db
        .select({ id: issues.id })
        .from(issues)
        .where(and(openAssigned, gt(issues.updatedAt, unattributedSince)))
        .limit(1),
    ))
  ) {
    return run("assigned_issue_updated");
  }

  // Activity on the agent's open issues by anyone but the agent itself or
  // one of its own runs.
  if (
    await check("issue_activity_by_others", () => exists(
      db
        .select({ id: activityLog.id })
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
    ))
  ) {
    return run("issue_activity_by_others");
  }

  // Comments by anyone else on any issue assigned to the agent (a comment on
  // a closed issue can reopen it).
  if (
    await check("comment_on_assigned_issue", () => exists(
      db
        .select({ id: issueComments.id })
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
    ))
  ) {
    return run("comment_on_assigned_issue");
  }

  // Mentions anywhere in the company. The id prefilter is a superset; the
  // real parser the comment route uses decides.
  const mentioned = await check("mentioned_in_comment", async () => {
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
    if (mentionCandidates.length > MENTION_SCAN_LIMIT) return true;
    return mentionCandidates.some((comment) => extractAgentMentionIds(comment.body).includes(agentId));
  });
  if (mentioned) return run("mentioned_in_comment");

  // Approvals the agent asked for, or that sit on its issues, decided since.
  if (
    await check("approval_decided", () => exists(
      db
        .select({ id: approvals.id })
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
    ))
  ) {
    return run("approval_decided");
  }

  if (
    await check("approval_comment_by_others", () => exists(
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
    ))
  ) {
    return run("approval_comment_by_others");
  }

  // An approval waiting on THIS agent's answer (a boss review of a
  // teammate's boost ask) that arrived or changed since.
  if (
    await check("approval_waiting_for_agent", () => exists(
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
    ))
  ) {
    return run("approval_waiting_for_agent");
  }

  // Interactions (questions, confirmations, suggested tasks) the agent opened
  // or that live on its issues: a new one from someone else, or one answered.
  if (
    await check("interaction_changed", () => exists(
      db
        .select({ id: issueThreadInteractions.id })
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
    ))
  ) {
    return run("interaction_changed");
  }

  // A blocker of one of its open issues finished (issue_relations: issue_id
  // blocks related_issue_id).
  if (
    await check("blocker_resolved", () => exists(
      db
        .select({ id: issueRelations.id })
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
    ))
  ) {
    return run("blocker_resolved");
  }

  if (
    await check("child_issue_closed", () => exists(
      db
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            or(gt(issues.completedAt, since), gt(issues.cancelledAt, since)),
            sql`${issues.parentId} in (select parent.id from ${issues} parent where parent.company_id = ${companyId}::uuid and parent.assignee_agent_id = ${agentId}::uuid and parent.hidden_at is null and parent.status not in ('done', 'cancelled'))`,
          ),
        )
        .limit(1),
    ))
  ) {
    return run("child_issue_closed");
  }

  if (
    await check("issue_monitor_due", () => exists(
      db
        .select({ id: issues.id })
        .from(issues)
        .where(and(openAssigned, sql`${issues.monitorNextCheckAt} <= ${now.toISOString()}::timestamptz`))
        .limit(1),
    ))
  ) {
    return run("issue_monitor_due");
  }

  if (
    await check("recovery_action_changed", () => exists(
      db
        .select({ id: issueRecoveryActions.id })
        .from(issueRecoveryActions)
        .where(
          and(
            eq(issueRecoveryActions.companyId, companyId),
            or(eq(issueRecoveryActions.ownerAgentId, agentId), eq(issueRecoveryActions.returnOwnerAgentId, agentId)),
            gt(issueRecoveryActions.updatedAt, since),
          ),
        )
        .limit(1),
    ))
  ) {
    return run("recovery_action_changed");
  }

  // Review / approval stages: the agent is the current reviewer or approver,
  // or changes were requested back to it, on an issue that moved since.
  if (
    await check("execution_stage_changed", () => exists(
      db
        .select({ id: issues.id })
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
    ))
  ) {
    return run("execution_stage_changed");
  }

  // Nothing said "new". If any signal could not answer, that unanswered
  // signal is exactly the one that might have been holding work, so the run
  // goes ahead (fail-open) rather than the tick being skipped on partial
  // information.
  if (failures.length > 0) return run("check_failed");

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
