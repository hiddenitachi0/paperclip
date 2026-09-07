import { and, asc, desc, eq, gte, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  authUsers,
  companies,
  costEvents,
  heartbeatRuns,
  inboxDismissals,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { budgetService } from "./budgets.js";
import { inboxDismissalService } from "./inbox-dismissals.js";
import { issueService } from "./issues.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";

/**
 * DUR-62: the weekly check-up.
 *
 * Once per interval (default weekly) Paperclip looks over one company and
 * writes ONE plain-language report issue: what looks wrong, and what it
 * suggests. Every suggestion is a draft task on a `suggest_tasks` card the
 * operator can tick and accept; accepting creates a task for an agent, the
 * check-up itself never changes anything.
 *
 * Never-acts guarantees, as code:
 *   - `runCheckup` only ever writes the report issue, one
 *     `issue_thread_interactions` row and `activity_log` rows. It returns the
 *     set of tables it wrote so a test can assert exactly that.
 *   - It takes no wake-up dependency at all. Nothing here can start a run.
 *   - `dryRun: true` computes and renders everything and writes nothing.
 *
 * The report is deliberately unassigned (it is written for the operator, not
 * for an agent), which is why routes/issues.ts refuses every agent-authenticated
 * mutation of an `organization_checkup` issue -- see assertAgentIssueMutationAllowed.
 */

export const ORGANIZATION_CHECKUP_ORIGIN_KIND = "organization_checkup";
export const CHECKUP_FINDING_DISMISSAL_PREFIX = "checkup-finding:";
export const CHECKUP_DISMISSAL_WINDOW_DAYS = 28;

export const CHECKUP_SEVERITIES = ["money", "stuck", "risk", "tidy"] as const;
export type CheckupSeverity = (typeof CHECKUP_SEVERITIES)[number];

/** Fixed section headings, in the order they appear in the report. */
export const CHECKUP_SECTION_HEADINGS: Record<CheckupSeverity, string> = {
  money: "Costing you money",
  stuck: "Work that has stopped",
  risk: "Worth keeping an eye on",
  tidy: "Tidying up",
};

export type CheckupThresholds = {
  /** How far back run/cost history is read. */
  lookbackDays: number;
  /** An agent with at least this many failed runs, making up half or more of its runs, is reported. */
  repeatedFailureRuns: number;
  /** An open task that has not moved for this many days is reported. */
  stuckIssueDays: number;
  /** A task marked in progress with no run behind it for this many hours is reported. */
  inProgressWithoutRunHours: number;
  /** An active agent with no successful run for this many days is reported. */
  silentAgentDays: number;
  /** An agent has to spend this many times the typical agent's amount to be an outlier... */
  spendOutlierMultiplier: number;
  /** ...and at least this much, so tiny amounts are never reported. */
  spendOutlierFloorCents: number;
  /** An agent or company that has used this percentage of its monthly budget is reported. */
  budgetWarnPercent: number;
  /** An approval waiting for the operator longer than this is reported. */
  pendingApprovalDays: number;
  /** A question to the operator waiting longer than this is reported. */
  pendingQuestionDays: number;
  /** An agent stuck in error for longer than this is reported. */
  agentErrorMinutes: number;
};

export const DEFAULT_CHECKUP_THRESHOLDS: CheckupThresholds = {
  lookbackDays: 7,
  repeatedFailureRuns: 3,
  stuckIssueDays: 5,
  inProgressWithoutRunHours: 1,
  silentAgentDays: 7,
  spendOutlierMultiplier: 3,
  spendOutlierFloorCents: 500,
  budgetWarnPercent: 80,
  pendingApprovalDays: 3,
  pendingQuestionDays: 3,
  agentErrorMinutes: 10,
};

export type CheckupFinding = {
  /** Stable key for this finding; also the draft's clientKey and the mute key. */
  fingerprint: string;
  /** Only used to pick the section and sort within it. */
  severity: CheckupSeverity;
  /** One plain sentence saying what is wrong. */
  headline: string;
  /** Plain-language supporting lines. */
  evidence: string[];
  /** Machine-readable numbers behind the finding, for tests and later tooling. */
  evidenceJson: Record<string, unknown>;
  /** What the operator could do, and what changes if they accept it. */
  suggestion: string;
  /** The agent the finding is about, when there is one. Used to pick who gets the task. */
  subjectAgentId: string | null;
  /** The task that is created if the operator accepts this suggestion. */
  suggestedTask: { title: string; description: string; priority: "low" | "medium" | "high" };
};

export type CheckupWrittenTable = "issues" | "issue_thread_interactions" | "activity_log";

type AgentRow = typeof agents.$inferSelect;
type CompanyRow = typeof companies.$inferSelect;

type DetectorContext = {
  db: Db;
  company: CompanyRow;
  now: Date;
  thresholds: CheckupThresholds;
  /** Every agent in the company, including paused/terminated ones. */
  agents: AgentRow[];
};

type Detector = (ctx: DetectorContext) => Promise<CheckupFinding[]>;

const OPEN_ISSUE_STATUSES = ["todo", "in_progress", "in_review", "blocked"] as const;
const UNSUCCESSFUL_RUN_STATUSES = ["failed", "timed_out", "cancelled"] as const;
// Agents that could be doing work. "error" is left out on purpose: those are
// reported by detectAgentsInError, which says why they stopped.
const WORKING_AGENT_STATUSES = ["active", "idle", "running"] as const;
const OPERATOR_QUESTION_KINDS = [
  "ask_user_questions",
  "request_confirmation",
  "request_checkbox_confirmation",
] as const;
const MAX_LISTED_ITEMS = 10;

// ---------------------------------------------------------------------------
// Small formatting helpers. Everything here is written for a person who does
// not read code: money as $X.XX, durations in days/hours, no identifiers.
// ---------------------------------------------------------------------------

export function formatCents(cents: number) {
  const safe = Number.isFinite(cents) ? cents : 0;
  return `$${(safe / 100).toFixed(2)}`;
}

export function formatDuration(ms: number) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Error messages and status words come from machines. Strip anything that
 * would read as code (identifiers, underscores) before it reaches the report.
 */
export function humanizeMachineText(value: string | null | undefined, max = 160) {
  if (!value) return "";
  const cleaned = value
    .replace(UUID_PATTERN, "")
    .replace(/[`]/g, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 3)}...`;
}

function humanizeStatus(status: string) {
  return status.replace(/_/g, " ");
}

function issueLabel(issue: { identifier: string | null; title: string }) {
  return issue.identifier ? `${issue.identifier} "${issue.title}"` : `"${issue.title}"`;
}

function isoWeekKey(date: Date) {
  // ISO-8601 week number: weeks start on Monday, week 1 contains 4 January.
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(utc.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((utc.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function checkupFingerprintForWeek(date: Date) {
  return `checkup:${isoWeekKey(date)}`;
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function daysAgo(now: Date, days: number) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function buildThresholds(overrides?: Partial<CheckupThresholds>): CheckupThresholds {
  const merged = { ...DEFAULT_CHECKUP_THRESHOLDS, ...(overrides ?? {}) };
  for (const key of Object.keys(merged) as Array<keyof CheckupThresholds>) {
    const value = merged[key];
    if (!Number.isFinite(value) || value <= 0) merged[key] = DEFAULT_CHECKUP_THRESHOLDS[key];
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Detectors. Each is a cheap database read that returns zero or more findings.
// None of them writes anything.
// ---------------------------------------------------------------------------

/** D-A: an agent sitting in error, with the open tasks stranded behind it. */
const detectAgentsInError: Detector = async ({ db, company, now, thresholds, agents: companyAgents }) => {
  const cutoff = new Date(now.getTime() - thresholds.agentErrorMinutes * 60_000);
  const stuck = companyAgents.filter(
    (agent) => agent.status === "error" && (!agent.errorAt || agent.errorAt.getTime() <= cutoff.getTime()),
  );
  if (stuck.length === 0) return [];

  const strandedRows = await db
    .select({ agentId: issues.assigneeAgentId, count: sql<number>`count(*)::int` })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, company.id),
        isNull(issues.hiddenAt),
        inArray(issues.status, [...OPEN_ISSUE_STATUSES]),
        inArray(issues.assigneeAgentId, stuck.map((agent) => agent.id)),
      ),
    )
    .groupBy(issues.assigneeAgentId);
  const strandedByAgent = new Map(strandedRows.map((row) => [row.agentId, Number(row.count)]));

  return stuck.map((agent) => {
    const stranded = strandedByAgent.get(agent.id) ?? 0;
    const since = agent.errorAt ? formatDuration(now.getTime() - agent.errorAt.getTime()) : null;
    const reason = humanizeMachineText(agent.errorReason);
    const evidence = [
      since ? `${agent.name} has been stopped for ${since}.` : `${agent.name} is stopped; how long ago is not recorded.`,
      reason ? `The last thing it reported was: "${reason}".` : "It did not say why.",
      stranded > 0
        ? `${plural(stranded, "open task")} ${stranded === 1 ? "is" : "are"} assigned to it and cannot move until it is working again.`
        : "No open tasks are assigned to it right now.",
    ];
    return {
      fingerprint: `agent_error:${agent.id}`,
      severity: "stuck",
      headline: stranded > 0
        ? `${agent.name} has stopped with an error and ${plural(stranded, "task")} ${stranded === 1 ? "is" : "are"} waiting on it.`
        : `${agent.name} has stopped with an error.`,
      evidence,
      evidenceJson: {
        agentId: agent.id,
        errorAt: agent.errorAt?.toISOString() ?? null,
        errorReason: agent.errorReason ?? null,
        strandedOpenIssues: stranded,
      },
      suggestion: `Find out why ${agent.name} stopped and get it working again. If it cannot be fixed quickly, move its ${plural(stranded, "open task")} to another agent so they do not sit still.`,
      subjectAgentId: agent.id,
      suggestedTask: {
        title: `Get ${agent.name} working again`,
        description: [
          `${agent.name} is stopped with an error${since ? ` and has been for ${since}` : ""}.`,
          reason ? `It reported: "${reason}".` : "",
          `${plural(stranded, "open task")} ${stranded === 1 ? "is" : "are"} assigned to it.`,
          "",
          "Find the cause, fix it, and clear the error so the agent picks its work up again. If that is not possible, reassign its open tasks and say why in a comment.",
        ].filter((line) => line !== "").join("\n"),
        priority: stranded > 0 ? "high" : "medium",
      },
    } satisfies CheckupFinding;
  });
};

/** Runs that keep failing: money spent on work that produced nothing. */
const detectRepeatedRunFailures: Detector = async ({ db, company, now, thresholds, agents: companyAgents }) => {
  const since = daysAgo(now, thresholds.lookbackDays);
  const rows = await db
    .select({
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      count: sql<number>`count(*)::int`,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, company.id),
        gte(heartbeatRuns.createdAt, since),
        inArray(heartbeatRuns.status, ["succeeded", ...UNSUCCESSFUL_RUN_STATUSES]),
      ),
    )
    .groupBy(heartbeatRuns.agentId, heartbeatRuns.status);

  const perAgent = new Map<string, { failed: number; succeeded: number }>();
  for (const row of rows) {
    const entry = perAgent.get(row.agentId) ?? { failed: 0, succeeded: 0 };
    if (row.status === "succeeded") entry.succeeded += Number(row.count);
    else entry.failed += Number(row.count);
    perAgent.set(row.agentId, entry);
  }

  const findings: CheckupFinding[] = [];
  for (const [agentId, counts] of perAgent) {
    const total = counts.failed + counts.succeeded;
    if (counts.failed < thresholds.repeatedFailureRuns) continue;
    if (counts.failed * 2 < total) continue;
    const agent = companyAgents.find((row) => row.id === agentId);
    if (!agent) continue;

    const failedRuns = await db
      .select({ id: heartbeatRuns.id, error: heartbeatRuns.error, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, company.id),
          eq(heartbeatRuns.agentId, agentId),
          gte(heartbeatRuns.createdAt, since),
          inArray(heartbeatRuns.status, [...UNSUCCESSFUL_RUN_STATUSES]),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(200);
    const failedRunIds = failedRuns.map((run) => run.id);
    const costRow = failedRunIds.length > 0
      ? await db
        .select({ cents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
        .from(costEvents)
        .where(and(eq(costEvents.companyId, company.id), inArray(costEvents.heartbeatRunId, failedRunIds)))
        .then((r) => r[0])
      : { cents: 0 };
    const wastedCents = Number(costRow?.cents ?? 0);
    const latestError = humanizeMachineText(failedRuns.find((run) => run.error)?.error ?? null);

    findings.push({
      fingerprint: `repeated_failures:${agentId}`,
      severity: "money",
      headline: `${agent.name} had ${plural(counts.failed, "run")} fail or get cut off in the last ${plural(thresholds.lookbackDays, "day")}, out of ${total}.`,
      evidence: [
        `Those failed runs cost ${formatCents(wastedCents)} and produced nothing.`,
        latestError ? `The most recent failure said: "${latestError}".` : "The runs did not record a reason for failing.",
      ],
      evidenceJson: {
        agentId,
        failedRuns: counts.failed,
        succeededRuns: counts.succeeded,
        wastedCents,
        latestError: latestError || null,
      },
      suggestion: `Pause ${agent.name} until someone has looked at why its runs keep failing. While paused it spends nothing; once the cause is fixed, resume it.`,
      subjectAgentId: agentId,
      suggestedTask: {
        title: `Find out why ${agent.name}'s runs keep failing`,
        description: [
          `${plural(counts.failed, "run")} by ${agent.name} failed or were cut off in the last ${plural(thresholds.lookbackDays, "day")} (${counts.succeeded} succeeded).`,
          `The failed runs cost ${formatCents(wastedCents)}.`,
          latestError ? `Most recent failure: "${latestError}".` : "",
          "",
          "Look at the failed runs, find the shared cause, and fix it. If the agent cannot work until it is fixed, pause it and say so in a comment.",
        ].filter((line) => line !== "").join("\n"),
        priority: "high",
      },
    });
  }
  return findings;
};

/** Open tasks that have not moved for a while, plus D-C: in progress with nobody actually on it. */
const detectStuckIssues: Detector = async ({ db, company, now, thresholds, agents: companyAgents }) => {
  const findings: CheckupFinding[] = [];
  const agentName = (id: string | null) => companyAgents.find((row) => row.id === id)?.name ?? null;

  // D-C first: "in progress" with no run attached. This is the status an
  // operator trusts most, so a task that lies in this particular way is worse
  // than one that is honestly stuck.
  const noRunCutoff = new Date(now.getTime() - thresholds.inProgressWithoutRunHours * 60 * 60_000);
  const inProgressWithoutRun = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      assigneeAgentId: issues.assigneeAgentId,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, company.id),
        isNull(issues.hiddenAt),
        eq(issues.status, "in_progress"),
        isNull(issues.executionRunId),
        sql`${issues.updatedAt} < ${noRunCutoff.toISOString()}::timestamptz`,
        sql`${issues.originKind} <> ${ORGANIZATION_CHECKUP_ORIGIN_KIND}`,
      ),
    )
    .orderBy(asc(issues.updatedAt))
    .limit(50);
  if (inProgressWithoutRun.length > 0) {
    const listed = inProgressWithoutRun.slice(0, MAX_LISTED_ITEMS).map((issue) => {
      const who = agentName(issue.assigneeAgentId);
      return `${issueLabel(issue)}${who ? `, assigned to ${who}` : ""}, untouched for ${formatDuration(now.getTime() - issue.updatedAt.getTime())}.`;
    });
    findings.push({
      fingerprint: "in_progress_without_run",
      severity: "stuck",
      headline: `${plural(inProgressWithoutRun.length, "task")} ${inProgressWithoutRun.length === 1 ? "says" : "say"} someone is working on ${inProgressWithoutRun.length === 1 ? "it" : "them"}, and nobody is.`,
      evidence: [
        "These are marked in progress but have no run behind them, so no agent is actually doing the work.",
        ...listed,
        ...(inProgressWithoutRun.length > MAX_LISTED_ITEMS ? [`...and ${inProgressWithoutRun.length - MAX_LISTED_ITEMS} more.`] : []),
      ],
      evidenceJson: {
        count: inProgressWithoutRun.length,
        issueIds: inProgressWithoutRun.map((issue) => issue.id),
      },
      suggestion: "Put these back in the queue so an agent picks them up fresh. Nothing is lost; they just stop pretending to be in hand.",
      subjectAgentId: null,
      suggestedTask: {
        title: "Put tasks that nobody is working on back in the queue",
        description: [
          "These tasks are marked in progress but have no run behind them, so nobody is actually working on them:",
          ...inProgressWithoutRun.slice(0, MAX_LISTED_ITEMS).map((issue) => `- ${issueLabel(issue)}`),
          "",
          "For each one: check whether the work was actually finished, and if not, set it back to todo so it is picked up again. Leave a one-line comment on each saying what you did.",
        ].join("\n"),
        priority: "high",
      },
    });
  }

  const stuckCutoff = daysAgo(now, thresholds.stuckIssueDays);
  const stuckIssues = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, company.id),
        isNull(issues.hiddenAt),
        inArray(issues.status, [...OPEN_ISSUE_STATUSES]),
        sql`${issues.updatedAt} < ${stuckCutoff.toISOString()}::timestamptz`,
        sql`${issues.originKind} <> ${ORGANIZATION_CHECKUP_ORIGIN_KIND}`,
        inProgressWithoutRun.length > 0
          ? notInArray(issues.id, inProgressWithoutRun.map((issue) => issue.id))
          : undefined,
      ),
    )
    .orderBy(asc(issues.updatedAt))
    .limit(50);
  if (stuckIssues.length > 0) {
    const listed = stuckIssues.slice(0, MAX_LISTED_ITEMS).map((issue) => {
      const who = agentName(issue.assigneeAgentId);
      return `${issueLabel(issue)} has been "${humanizeStatus(issue.status)}"${who ? ` with ${who}` : " with nobody assigned"} and untouched for ${formatDuration(now.getTime() - issue.updatedAt.getTime())}.`;
    });
    findings.push({
      fingerprint: "stuck_issues",
      severity: "stuck",
      headline: `${plural(stuckIssues.length, "open task")} ${stuckIssues.length === 1 ? "has" : "have"} not moved in more than ${plural(thresholds.stuckIssueDays, "day")}.`,
      evidence: [
        ...listed,
        ...(stuckIssues.length > MAX_LISTED_ITEMS ? [`...and ${stuckIssues.length - MAX_LISTED_ITEMS} more.`] : []),
      ],
      evidenceJson: {
        count: stuckIssues.length,
        issueIds: stuckIssues.map((issue) => issue.id),
        thresholdDays: thresholds.stuckIssueDays,
      },
      suggestion: "Have someone go through them and either restart the work, hand it to another agent, or close the ones that no longer matter.",
      subjectAgentId: null,
      suggestedTask: {
        title: `Review ${plural(stuckIssues.length, "task")} that ${stuckIssues.length === 1 ? "has" : "have"} not moved in over ${plural(thresholds.stuckIssueDays, "day")}`,
        description: [
          "These open tasks have not changed in a while:",
          ...stuckIssues.slice(0, MAX_LISTED_ITEMS).map((issue) => `- ${issueLabel(issue)} (${humanizeStatus(issue.status)})`),
          "",
          "For each one decide: restart it, hand it to someone else, or close it with a short note saying why. Do not leave any of them as they are.",
        ].join("\n"),
        priority: "medium",
      },
    });
  }

  return findings;
};

/** Active agents that have not managed a single successful run in the window. */
const detectSilentAgents: Detector = async ({ db, company, now, thresholds, agents: companyAgents }) => {
  const since = daysAgo(now, thresholds.silentAgentDays);
  const candidates = companyAgents.filter(
    (agent) =>
      (WORKING_AGENT_STATUSES as readonly string[]).includes(agent.status) &&
      agent.createdAt.getTime() <= since.getTime(),
  );
  if (candidates.length === 0) return [];
  const candidateIds = candidates.map((agent) => agent.id);

  const [successRows, attemptRows, openWorkRows] = await Promise.all([
    db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, company.id),
          inArray(heartbeatRuns.agentId, candidateIds),
          eq(heartbeatRuns.status, "succeeded"),
          gte(heartbeatRuns.createdAt, since),
        ),
      )
      .groupBy(heartbeatRuns.agentId),
    db
      .select({ agentId: heartbeatRuns.agentId, count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, company.id),
          inArray(heartbeatRuns.agentId, candidateIds),
          gte(heartbeatRuns.createdAt, since),
        ),
      )
      .groupBy(heartbeatRuns.agentId),
    db
      .select({ agentId: issues.assigneeAgentId, count: sql<number>`count(*)::int` })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, company.id),
          isNull(issues.hiddenAt),
          inArray(issues.status, [...OPEN_ISSUE_STATUSES]),
          inArray(issues.assigneeAgentId, candidateIds),
        ),
      )
      .groupBy(issues.assigneeAgentId),
  ]);
  const succeeded = new Set(successRows.map((row) => row.agentId));
  const attempts = new Map(attemptRows.map((row) => [row.agentId, Number(row.count)]));
  const openWork = new Map(openWorkRows.map((row) => [row.agentId, Number(row.count)]));

  const findings: CheckupFinding[] = [];
  for (const agent of candidates) {
    if (succeeded.has(agent.id)) continue;
    const open = openWork.get(agent.id) ?? 0;
    const heartbeat = (agent.runtimeConfig as { heartbeat?: { enabled?: unknown } } | null)?.heartbeat;
    const timerOn = heartbeat?.enabled === true;
    // An agent with nothing assigned and no timer is simply idle, not silent.
    if (open === 0 && !timerOn) continue;
    const tried = attempts.get(agent.id) ?? 0;
    findings.push({
      fingerprint: `silent_agent:${agent.id}`,
      severity: "stuck",
      headline: `${agent.name} has not finished a single run successfully in the last ${plural(thresholds.silentAgentDays, "day")}.`,
      evidence: [
        tried > 0
          ? `It tried ${plural(tried, "time")} and none of those runs succeeded.`
          : "It has not run at all in that time.",
        open > 0
          ? `${plural(open, "open task")} ${open === 1 ? "is" : "are"} assigned to it.`
          : "It is set to wake on a timer but has nothing assigned.",
      ],
      evidenceJson: {
        agentId: agent.id,
        attemptedRuns: tried,
        openIssues: open,
        timerEnabled: timerOn,
        windowDays: thresholds.silentAgentDays,
      },
      suggestion: open > 0
        ? `Check whether ${agent.name} is set up correctly, and if it cannot work, move its ${plural(open, "task")} to an agent that can.`
        : `Check whether ${agent.name} is still needed. If not, pause it so it stops waking up for nothing.`,
      subjectAgentId: agent.id,
      suggestedTask: {
        title: `Check why ${agent.name} has done no work for ${plural(thresholds.silentAgentDays, "day")}`,
        description: [
          `${agent.name} has had no successful run in the last ${plural(thresholds.silentAgentDays, "day")}.`,
          tried > 0 ? `It attempted ${plural(tried, "run")}, none succeeded.` : "It did not run at all.",
          open > 0 ? `${plural(open, "open task")} ${open === 1 ? "is" : "are"} assigned to it.` : "Nothing is assigned to it.",
          "",
          "Find out whether it is misconfigured, blocked, or simply not needed. Fix it, reassign its work, or pause it, and say which in a comment.",
        ].join("\n"),
        priority: open > 0 ? "high" : "low",
      },
    });
  }
  return findings;
};

/** Spend that stands out, either against the other agents or against a set budget. */
const detectSpendOutliers: Detector = async ({ db, company, now, thresholds, agents: companyAgents }) => {
  const since = daysAgo(now, thresholds.lookbackDays);
  const rows = await db
    .select({ agentId: costEvents.agentId, cents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
    .from(costEvents)
    .where(and(eq(costEvents.companyId, company.id), gte(costEvents.occurredAt, since)))
    .groupBy(costEvents.agentId);
  const spendByAgent = new Map(rows.map((row) => [row.agentId, Number(row.cents)]));
  const findings: CheckupFinding[] = [];

  const spenders = [...spendByAgent.values()].filter((cents) => cents > 0);
  const typical = median(spenders);
  if (spenders.length >= 3 && typical > 0) {
    for (const [agentId, cents] of spendByAgent) {
      if (cents < thresholds.spendOutlierFloorCents) continue;
      if (cents < typical * thresholds.spendOutlierMultiplier) continue;
      const agent = companyAgents.find((row) => row.id === agentId);
      if (!agent) continue;
      const multiple = Math.round((cents / typical) * 10) / 10;
      findings.push({
        fingerprint: `spend_outlier:${agentId}`,
        severity: "money",
        headline: `${agent.name} spent ${formatCents(cents)} in the last ${plural(thresholds.lookbackDays, "day")}, about ${multiple} times what a typical agent here spends.`,
        evidence: [
          `The typical agent in this company spent ${formatCents(typical)} over the same period.`,
          "High spend is not wrong by itself, but it is worth checking that the work justified it.",
        ],
        evidenceJson: { agentId, spendCents: cents, medianCents: typical, multiple },
        suggestion: `Look at what ${agent.name} spent the money on. If it was busywork, give it a daily run cap or a monthly budget so it cannot run away again.`,
        subjectAgentId: agentId,
        suggestedTask: {
          title: `Check what ${agent.name} spent ${formatCents(cents)} on`,
          description: [
            `${agent.name} spent ${formatCents(cents)} in the last ${plural(thresholds.lookbackDays, "day")}; the typical agent spent ${formatCents(typical)}.`,
            "",
            "Look at its recent runs and say in a comment whether the spend was justified. If it was not, propose a daily run cap or a monthly budget for this agent.",
          ].join("\n"),
          priority: "medium",
        },
      });
    }
  }

  for (const agent of companyAgents) {
    if (agent.budgetMonthlyCents <= 0) continue;
    const percent = Math.floor((agent.spentMonthlyCents / agent.budgetMonthlyCents) * 100);
    if (percent < thresholds.budgetWarnPercent) continue;
    findings.push({
      fingerprint: `budget_nearly_used:${agent.id}`,
      severity: percent >= 100 ? "money" : "risk",
      headline: percent >= 100
        ? `${agent.name} has used all of its monthly budget (${formatCents(agent.spentMonthlyCents)} of ${formatCents(agent.budgetMonthlyCents)}).`
        : `${agent.name} has used ${percent}% of its monthly budget (${formatCents(agent.spentMonthlyCents)} of ${formatCents(agent.budgetMonthlyCents)}).`,
      evidence: [
        percent >= 100
          ? "It will stop working when the hard stop kicks in, or it already has."
          : `There is ${formatCents(agent.budgetMonthlyCents - agent.spentMonthlyCents)} left for the rest of the month.`,
      ],
      evidenceJson: {
        agentId: agent.id,
        spentMonthlyCents: agent.spentMonthlyCents,
        budgetMonthlyCents: agent.budgetMonthlyCents,
        percent,
      },
      suggestion: `Decide whether ${agent.name} should get more budget this month or should slow down. Raising the budget lets it keep working; leaving it means it stops when the money runs out.`,
      subjectAgentId: agent.id,
      suggestedTask: {
        title: `Decide what to do about ${agent.name}'s budget`,
        description: [
          `${agent.name} has used ${percent}% of its monthly budget (${formatCents(agent.spentMonthlyCents)} of ${formatCents(agent.budgetMonthlyCents)}).`,
          "",
          "Look at what it has been spending on and propose one of: raise the budget, leave it and let it stop, or reduce how often it wakes. Put the recommendation in a comment for the operator to decide.",
        ].join("\n"),
        priority: "medium",
      },
    });
  }

  if (company.budgetMonthlyCents > 0) {
    const percent = Math.floor((company.spentMonthlyCents / company.budgetMonthlyCents) * 100);
    if (percent >= thresholds.budgetWarnPercent) {
      findings.push({
        fingerprint: "company_budget_nearly_used",
        severity: percent >= 100 ? "money" : "risk",
        headline: `The company has used ${percent}% of its monthly budget (${formatCents(company.spentMonthlyCents)} of ${formatCents(company.budgetMonthlyCents)}).`,
        evidence: [
          percent >= 100
            ? "Every agent stops when the company budget is exhausted."
            : `There is ${formatCents(company.budgetMonthlyCents - company.spentMonthlyCents)} left for the rest of the month.`,
        ],
        evidenceJson: {
          spentMonthlyCents: company.spentMonthlyCents,
          budgetMonthlyCents: company.budgetMonthlyCents,
          percent,
        },
        suggestion: "Decide whether to raise the company budget or let work slow down for the rest of the month.",
        subjectAgentId: null,
        suggestedTask: {
          title: "Recommend what to do about the company budget",
          description: [
            `The company has used ${percent}% of its monthly budget (${formatCents(company.spentMonthlyCents)} of ${formatCents(company.budgetMonthlyCents)}).`,
            "",
            "Summarise where the money went this month and recommend whether to raise the budget or pause low-value work. Put the recommendation in a comment for the operator to decide.",
          ].join("\n"),
          priority: "medium",
        },
      });
    }
  }

  return findings;
};

/** Approvals that have been waiting for the operator for days. */
const detectPendingApprovals: Detector = async ({ db, company, now, thresholds, agents: companyAgents }) => {
  const cutoff = daysAgo(now, thresholds.pendingApprovalDays);
  const rows = await db
    .select({
      id: approvals.id,
      type: approvals.type,
      payload: approvals.payload,
      requestedByAgentId: approvals.requestedByAgentId,
      createdAt: approvals.createdAt,
    })
    .from(approvals)
    .where(
      and(
        eq(approvals.companyId, company.id),
        inArray(approvals.status, ["pending", "revision_requested"]),
        sql`${approvals.createdAt} < ${cutoff.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(approvals.createdAt))
    .limit(50);
  if (rows.length === 0) return [];

  const describe = (row: (typeof rows)[number]) => {
    const payloadTitle = typeof row.payload?.title === "string" ? row.payload.title : null;
    const title = humanizeMachineText(payloadTitle ?? row.type, 120);
    const who = companyAgents.find((agent) => agent.id === row.requestedByAgentId)?.name ?? null;
    return `"${title}"${who ? ` from ${who}` : ""}, waiting ${formatDuration(now.getTime() - row.createdAt.getTime())}.`;
  };
  return [{
    fingerprint: "pending_approvals",
    severity: "risk",
    headline: `${plural(rows.length, "approval")} ${rows.length === 1 ? "has" : "have"} been waiting for you for more than ${plural(thresholds.pendingApprovalDays, "day")}.`,
    evidence: [
      "The work behind each of these is standing still until you decide.",
      ...rows.slice(0, MAX_LISTED_ITEMS).map(describe),
      ...(rows.length > MAX_LISTED_ITEMS ? [`...and ${rows.length - MAX_LISTED_ITEMS} more.`] : []),
    ],
    evidenceJson: { count: rows.length, approvalIds: rows.map((row) => row.id), thresholdDays: thresholds.pendingApprovalDays },
    suggestion: "Go through them and approve or reject each one. If some are no longer relevant, have an agent withdraw them so they stop cluttering your list.",
    subjectAgentId: null,
    suggestedTask: {
      title: `Tidy up ${plural(rows.length, "approval")} that ${rows.length === 1 ? "has" : "have"} been waiting over ${plural(thresholds.pendingApprovalDays, "day")}`,
      description: [
        "These approvals have been waiting for the operator for a while:",
        ...rows.slice(0, MAX_LISTED_ITEMS).map((row) => `- ${describe(row)}`),
        "",
        "For each one: check whether it is still relevant. Cancel the ones that are not, and for the rest add a one-line comment saying plainly what happens if it is approved, so the operator can decide quickly.",
      ].join("\n"),
      priority: "medium",
    },
  }];
};

/** Questions to the operator that have gone unanswered on open tasks. */
const detectPendingQuestions: Detector = async ({ db, company, now, thresholds, agents: companyAgents }) => {
  const cutoff = daysAgo(now, thresholds.pendingQuestionDays);
  const rows = await db
    .select({
      id: issueThreadInteractions.id,
      title: issueThreadInteractions.title,
      createdAt: issueThreadInteractions.createdAt,
      createdByAgentId: issueThreadInteractions.createdByAgentId,
      issueId: issues.id,
      issueIdentifier: issues.identifier,
      issueTitle: issues.title,
    })
    .from(issueThreadInteractions)
    .innerJoin(issues, eq(issues.id, issueThreadInteractions.issueId))
    .where(
      and(
        eq(issueThreadInteractions.companyId, company.id),
        inArray(issueThreadInteractions.kind, [...OPERATOR_QUESTION_KINDS]),
        eq(issueThreadInteractions.status, "pending"),
        sql`${issueThreadInteractions.createdAt} < ${cutoff.toISOString()}::timestamptz`,
        isNull(issues.hiddenAt),
        inArray(issues.status, [...OPEN_ISSUE_STATUSES]),
      ),
    )
    .orderBy(asc(issueThreadInteractions.createdAt))
    .limit(50);
  if (rows.length === 0) return [];

  const issueIds = [...new Set(rows.map((row) => row.issueId))];
  const describe = (row: (typeof rows)[number]) => {
    const who = companyAgents.find((agent) => agent.id === row.createdByAgentId)?.name ?? null;
    const question = row.title ? `"${humanizeMachineText(row.title, 120)}"` : "a question";
    return `${who ? `${who} asked ` : ""}${question} on ${issueLabel({ identifier: row.issueIdentifier, title: row.issueTitle })}, ${formatDuration(now.getTime() - row.createdAt.getTime())} ago.`;
  };
  return [{
    fingerprint: "unanswered_questions",
    severity: "risk",
    headline: `${plural(rows.length, "question")} ${rows.length === 1 ? "was" : "were"} asked of you more than ${plural(thresholds.pendingQuestionDays, "day")} ago and never answered.`,
    evidence: [
      `The work on ${plural(issueIds.length, "task")} has been waiting on an answer since.`,
      ...rows.slice(0, MAX_LISTED_ITEMS).map(describe),
      ...(rows.length > MAX_LISTED_ITEMS ? [`...and ${rows.length - MAX_LISTED_ITEMS} more.`] : []),
    ],
    evidenceJson: { count: rows.length, issueCount: issueIds.length, interactionIds: rows.map((row) => row.id), issueIds },
    suggestion: "Answer the ones that still matter. For the rest, have an agent withdraw the question and carry on with a sensible default.",
    subjectAgentId: null,
    suggestedTask: {
      title: `Sort out ${plural(rows.length, "unanswered question")} on open tasks`,
      description: [
        "These questions to the operator have gone unanswered:",
        ...rows.slice(0, MAX_LISTED_ITEMS).map((row) => `- ${describe(row)}`),
        "",
        "For each one: if the task still matters, re-ask the question in one short plain sentence with a recommended answer. If it does not, cancel the question and close or park the task with a note.",
      ].join("\n"),
      priority: "medium",
    },
  }];
};

export const CHECKUP_DETECTORS: Detector[] = [
  detectAgentsInError,
  detectRepeatedRunFailures,
  detectStuckIssues,
  detectSilentAgents,
  detectSpendOutliers,
  detectPendingApprovals,
  detectPendingQuestions,
];

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export type CheckupDismissal = {
  fingerprint: string;
  dismissedAt: Date;
  userName: string;
};

export function renderCheckupTitle(companyName: string, findings: CheckupFinding[], now: Date) {
  if (findings.length === 0) {
    return `Weekly check-up for ${companyName}, ${formatDate(now)}: nothing needs your attention`;
  }
  return `Weekly check-up for ${companyName}, ${formatDate(now)}: ${plural(findings.length, "thing")} to look at`;
}

export function renderCheckupBody(input: {
  companyName: string;
  now: Date;
  findings: CheckupFinding[];
  thresholds: CheckupThresholds;
  dismissals: CheckupDismissal[];
  intervalDays: number;
}) {
  const { companyName, now, findings, thresholds, dismissals, intervalDays } = input;
  const lines: string[] = [];
  lines.push(
    `Paperclip looked over ${companyName} on ${formatDate(now)}. Here is what looks wrong and what it suggests.`,
    "",
    "Nothing has been changed. Each suggestion below is also a tick-box on the card under this report: tick the ones you agree with and press accept, and Paperclip creates a task for the right agent to make that change. Accepting wakes that agent and costs a little money, so each suggestion says what would change.",
    "",
  );

  if (findings.length === 0) {
    lines.push("Nothing needs your attention this time. Agents are running, tasks are moving, and nothing is waiting on you.", "");
  }

  for (const severity of CHECKUP_SEVERITIES) {
    const section = findings.filter((finding) => finding.severity === severity);
    lines.push(`## ${CHECKUP_SECTION_HEADINGS[severity]}`, "");
    if (section.length === 0) {
      lines.push("Nothing here this time.", "");
      continue;
    }
    for (const finding of section) {
      lines.push(`### ${finding.headline}`, "");
      for (const line of finding.evidence) lines.push(`- ${line}`);
      lines.push("", `**Suggestion:** ${finding.suggestion}`, "");
    }
  }

  lines.push(
    "---",
    "",
    "**How this check-up decides what to report.** These are the current settings; tell your assistant if you want them changed:",
    "",
    `- A run counts as repeatedly failing after ${thresholds.repeatedFailureRuns} failures in ${plural(thresholds.lookbackDays, "day")}, when half or more of the agent's runs failed.`,
    `- A task counts as stuck after ${plural(thresholds.stuckIssueDays, "day")} without any change, or after ${plural(thresholds.inProgressWithoutRunHours, "hour")} marked in progress with nobody on it.`,
    `- An agent counts as silent after ${plural(thresholds.silentAgentDays, "day")} without a successful run.`,
    `- Spend stands out at ${thresholds.spendOutlierMultiplier} times the typical agent's spend (and at least ${formatCents(thresholds.spendOutlierFloorCents)}), or at ${thresholds.budgetWarnPercent}% of a monthly budget.`,
    `- An approval or question counts as waiting after ${plural(thresholds.pendingApprovalDays, "day")}.`,
    `- The next check-up is due in ${plural(intervalDays, "day")}.`,
    "",
  );

  if (dismissals.length > 0) {
    lines.push("**Hidden for now.** These findings were hidden by someone on the board and will come back after a month:", "");
    for (const dismissal of dismissals) {
      lines.push(`- ${describeFingerprint(dismissal.fingerprint)}, hidden by ${dismissal.userName} on ${formatDate(dismissal.dismissedAt)}.`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function describeFingerprint(fingerprint: string) {
  const [kind] = fingerprint.split(":");
  switch (kind) {
    case "agent_error": return "an agent stopped with an error";
    case "repeated_failures": return "an agent whose runs keep failing";
    case "in_progress_without_run": return "tasks marked in progress with nobody on them";
    case "stuck_issues": return "tasks that have not moved";
    case "silent_agent": return "an agent with no successful runs";
    case "spend_outlier": return "an agent spending far more than the others";
    case "budget_nearly_used": return "an agent close to its monthly budget";
    case "company_budget_nearly_used": return "the company close to its monthly budget";
    case "pending_approvals": return "approvals waiting on you";
    case "unanswered_questions": return "questions waiting on you";
    default: return "a finding";
  }
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export type RunCheckupResult = {
  companyId: string;
  dryRun: boolean;
  /** "created": a new report was written. "existing": an open report already covered this. "clean"/"dry_run": nothing written. */
  outcome: "created" | "existing" | "dry_run";
  reportIssueId: string | null;
  reportIdentifier: string | null;
  title: string;
  body: string;
  findings: CheckupFinding[];
  suppressedFindings: CheckupFinding[];
  writtenTables: CheckupWrittenTable[];
  /** Set when the outcome is "existing": the date the open report was written. */
  existingReportCreatedAt: Date | null;
};

/**
 * What the dashboard card and the sidebar badge need to know about the open
 * check-up, without loading the whole report.
 */
export type OpenCheckupSummary = {
  report: {
    id: string;
    identifier: string | null;
    title: string;
    status: string;
    createdAt: Date;
  };
  /** Drafts on the report's accept card that nobody has accepted or rejected yet. */
  pendingSuggestionCount: number;
  /** Total drafts the report proposed, whatever happened to them since. */
  suggestionCount: number;
  /** "pending" while the operator has not decided; "accepted"/"rejected" after; "none" for a clean report. */
  suggestionsStatus: "pending" | "accepted" | "rejected" | "none";
};

export function organizationCheckupService(db: Db) {
  const issuesSvc = issueService(db);
  const interactionsSvc = issueThreadInteractionService(db);
  const budgets = budgetService(db);
  const dismissalsSvc = inboxDismissalService(db);

  async function getCompany(companyId: string) {
    return db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
  }

  async function listCompanyAgents(companyId: string) {
    return db.select().from(agents).where(eq(agents.companyId, companyId)).orderBy(asc(agents.createdAt), asc(agents.id));
  }

  async function findOpenCheckup(companyId: string) {
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, ORGANIZATION_CHECKUP_ORIGIN_KIND),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  /**
   * The open check-up plus how many of its suggestions still wait on the
   * operator. One small query on top of findOpenCheckup; read by the
   * dashboard card and the sidebar badge, so it must stay cheap.
   */
  async function summarizeOpenCheckup(companyId: string): Promise<OpenCheckupSummary | null> {
    const open = await findOpenCheckup(companyId);
    if (!open) return null;
    const card = await db
      .select({
        status: issueThreadInteractions.status,
        payload: issueThreadInteractions.payload,
        result: issueThreadInteractions.result,
      })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, companyId),
          eq(issueThreadInteractions.issueId, open.id),
          eq(issueThreadInteractions.kind, "suggest_tasks"),
        ),
      )
      .orderBy(desc(issueThreadInteractions.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    const payload = (card?.payload ?? null) as { tasks?: unknown[] } | null;
    const suggestionCount = Array.isArray(payload?.tasks) ? payload.tasks.length : 0;
    const suggestionsStatus: OpenCheckupSummary["suggestionsStatus"] =
      !card || suggestionCount === 0
        ? "none"
        : card.status === "pending"
          ? "pending"
          : card.status === "accepted"
            ? "accepted"
            : "rejected";

    return {
      report: {
        id: open.id,
        identifier: open.identifier ?? null,
        title: open.title,
        status: open.status,
        createdAt: open.createdAt,
      },
      pendingSuggestionCount: suggestionsStatus === "pending" ? suggestionCount : 0,
      suggestionCount,
      suggestionsStatus,
    };
  }

  /**
   * "Hide this for a month": one inbox dismissal per finding, keyed
   * `checkup-finding:<fingerprint>`, stamped with the board user who hid it.
   * Any board user's dismissal hides the finding company-wide for 28 days
   * (see listActiveDismissals), and the next report says who hid what.
   * Called by the accept route for every draft the operator left unticked.
   */
  async function hideFindings(opts: { companyId: string; userId: string; fingerprints: string[]; now?: Date }) {
    const now = opts.now ?? new Date();
    const fingerprints = [...new Set(opts.fingerprints.map((value) => value.trim()).filter((value) => value.length > 0))];
    const itemKeys: string[] = [];
    for (const fingerprint of fingerprints) {
      const itemKey = `${CHECKUP_FINDING_DISMISSAL_PREFIX}${fingerprint}`;
      await dismissalsSvc.dismiss(opts.companyId, opts.userId, itemKey, now);
      itemKeys.push(itemKey);
    }
    if (itemKeys.length > 0) {
      await logActivity(db, {
        companyId: opts.companyId,
        actorType: "user",
        actorId: opts.userId,
        action: "inbox.dismissed",
        entityType: "company",
        entityId: opts.companyId,
        details: {
          userId: opts.userId,
          itemKeys,
          dismissedAt: now,
          source: "organization_checkup.hide_findings",
          hiddenForDays: CHECKUP_DISMISSAL_WINDOW_DAYS,
        },
      });
    }
    return { itemKeys, dismissedAt: now };
  }

  async function findNewestCheckup(companyId: string) {
    return db
      .select({ id: issues.id, createdAt: issues.createdAt })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, ORGANIZATION_CHECKUP_ORIGIN_KIND)))
      .orderBy(desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  function isAgentInvokable(agent: AgentRow | null | undefined) {
    return Boolean(agent && !["paused", "terminated", "pending_approval"].includes(agent.status));
  }

  /**
   * Who gets the task if the operator accepts a suggestion: the subject's
   * manager when there is a subject, else the CTO, else the CEO. Skips
   * paused/terminated/budget-blocked agents. The budget check deliberately
   * runs without an issue scope -- there is no source issue for a check-up.
   */
  async function resolveAdviceOwnerAgentId(companyId: string, subjectAgentId: string | null, companyAgents?: AgentRow[]) {
    const roster = companyAgents ?? (await listCompanyAgents(companyId));
    const byId = new Map(roster.map((agent) => [agent.id, agent]));
    const candidates: string[] = [];
    if (subjectAgentId) {
      const subject = byId.get(subjectAgentId);
      if (subject?.reportsTo) candidates.push(subject.reportsTo);
    }
    for (const role of ["cto", "ceo"]) {
      for (const agent of roster) {
        if (agent.role === role) candidates.push(agent.id);
      }
    }
    const seen = new Set<string>();
    for (const candidateId of candidates) {
      if (seen.has(candidateId)) continue;
      seen.add(candidateId);
      const candidate = byId.get(candidateId);
      if (!candidate || candidate.companyId !== companyId || !isAgentInvokable(candidate)) continue;
      try {
        const block = await budgets.getInvocationBlock(companyId, candidate.id);
        if (!block) return candidate.id;
      } catch (err) {
        logger.warn({ err, companyId, candidateId }, "organization check-up could not check a candidate owner's budget; skipping it");
      }
    }
    return null;
  }

  /** Any board user's dismissal in the last 28 days hides a finding company-wide, and the report says who. */
  async function listActiveDismissals(companyId: string, now: Date): Promise<CheckupDismissal[]> {
    const cutoff = daysAgo(now, CHECKUP_DISMISSAL_WINDOW_DAYS);
    const rows = await db
      .select({
        itemKey: inboxDismissals.itemKey,
        dismissedAt: inboxDismissals.dismissedAt,
        userId: inboxDismissals.userId,
        userName: authUsers.name,
      })
      .from(inboxDismissals)
      .leftJoin(authUsers, eq(authUsers.id, inboxDismissals.userId))
      .where(
        and(
          eq(inboxDismissals.companyId, companyId),
          sql`${inboxDismissals.itemKey} like ${`${CHECKUP_FINDING_DISMISSAL_PREFIX}%`}`,
          gte(inboxDismissals.dismissedAt, cutoff),
        ),
      );
    return rows.map((row) => ({
      fingerprint: row.itemKey.slice(CHECKUP_FINDING_DISMISSAL_PREFIX.length),
      dismissedAt: row.dismissedAt,
      userName: row.userName ?? "someone on the board",
    }));
  }

  async function collectFindings(company: CompanyRow, now: Date, thresholds: CheckupThresholds) {
    const companyAgents = await listCompanyAgents(company.id);
    const ctx: DetectorContext = { db, company, now, thresholds, agents: companyAgents };
    const findings: CheckupFinding[] = [];
    for (const detector of CHECKUP_DETECTORS) {
      findings.push(...(await detector(ctx)));
    }
    const order = new Map(CHECKUP_SEVERITIES.map((severity, index) => [severity, index]));
    findings.sort((a, b) => (order.get(a.severity)! - order.get(b.severity)!) || a.fingerprint.localeCompare(b.fingerprint));
    return { findings, companyAgents };
  }

  /**
   * Scan one company and, unless dry-running, write the report. Never wakes
   * anything. Returns everything it computed plus the tables it wrote.
   */
  async function runCheckup(opts: {
    companyId: string;
    now?: Date;
    thresholds?: Partial<CheckupThresholds>;
    dryRun?: boolean;
    intervalDays?: number;
  }): Promise<RunCheckupResult> {
    const now = opts.now ?? new Date();
    const thresholds = buildThresholds(opts.thresholds);
    const dryRun = opts.dryRun ?? false;
    const intervalDays = opts.intervalDays && opts.intervalDays > 0 ? Math.floor(opts.intervalDays) : 7;
    const written = new Set<CheckupWrittenTable>();

    const company = await getCompany(opts.companyId);
    if (!company) throw new Error("Company not found");

    const [{ findings: allFindings, companyAgents }, dismissals] = await Promise.all([
      collectFindings(company, now, thresholds),
      listActiveDismissals(company.id, now),
    ]);
    const hidden = new Set(dismissals.map((dismissal) => dismissal.fingerprint));
    const findings = allFindings.filter((finding) => !hidden.has(finding.fingerprint));
    const suppressedFindings = allFindings.filter((finding) => hidden.has(finding.fingerprint));
    const relevantDismissals = dismissals.filter((dismissal) => hidden.has(dismissal.fingerprint) && suppressedFindings.some((f) => f.fingerprint === dismissal.fingerprint));

    const title = renderCheckupTitle(company.name, findings, now);
    const body = renderCheckupBody({ companyName: company.name, now, findings, thresholds, dismissals: relevantDismissals, intervalDays });

    const base = { companyId: company.id, dryRun, title, body, findings, suppressedFindings };
    if (dryRun) {
      return { ...base, outcome: "dry_run", reportIssueId: null, reportIdentifier: null, writtenTables: [], existingReportCreatedAt: null };
    }

    // One open check-up per company: if one is still open, hand it back
    // instead of piling up a second one.
    const existing = await findOpenCheckup(company.id);
    if (existing) {
      return {
        ...base,
        outcome: "existing",
        reportIssueId: existing.id,
        reportIdentifier: existing.identifier,
        writtenTables: [],
        existingReportCreatedAt: existing.createdAt,
      };
    }

    let report: Awaited<ReturnType<typeof issuesSvc.create>>;
    try {
      report = await issuesSvc.create(company.id, {
        title,
        description: body,
        // A clean report is filed already closed: it is a record, not a chore.
        status: findings.length === 0 ? "done" : "todo",
        priority: "medium",
        assigneeAgentId: null,
        assigneeUserId: null,
        originKind: ORGANIZATION_CHECKUP_ORIGIN_KIND,
        originId: company.id,
        originFingerprint: checkupFingerprintForWeek(now),
      });
    } catch (error) {
      // issueService.create refuses a second open ticket with the same
      // origin fingerprint (409), and the DB may also race two scans. Either
      // way the right answer is the report that already exists.
      const maybe = error as { status?: number; code?: string };
      if (maybe.status !== 409 && maybe.code !== "23505") throw error;
      const raced = await findOpenCheckup(company.id);
      if (!raced) throw error;
      return {
        ...base,
        outcome: "existing",
        reportIssueId: raced.id,
        reportIdentifier: raced.identifier,
        writtenTables: [],
        existingReportCreatedAt: raced.createdAt,
      };
    }
    written.add("issues");
    await db.update(issues).set({ createdAt: now, updatedAt: now }).where(eq(issues.id, report.id));

    if (findings.length > 0) {
      const tasks = [];
      for (const finding of findings) {
        const assigneeAgentId = await resolveAdviceOwnerAgentId(company.id, finding.subjectAgentId, companyAgents);
        tasks.push({
          clientKey: finding.fingerprint,
          title: finding.suggestedTask.title,
          description: finding.suggestedTask.description,
          priority: finding.suggestedTask.priority,
          assigneeAgentId,
        });
      }
      await interactionsSvc.create(
        { id: report.id, companyId: company.id },
        {
          kind: "suggest_tasks",
          title: "Suggested fixes",
          summary: "Tick the suggestions you agree with and press accept. Each one becomes a task for an agent; nothing happens to the ones you leave unticked.",
          // Explicit: the column defaults to wake_assignee, and this report has no assignee to wake.
          continuationPolicy: "none",
          idempotencyKey: `organization-checkup:${report.id}`,
          payload: { version: 1, defaultParentId: null, tasks },
        },
        { agentId: null, userId: null },
      );
      written.add("issue_thread_interactions");
    }

    await logActivity(db, {
      companyId: company.id,
      actorType: "system",
      actorId: "organization_checkup",
      action: "issue.organization_checkup_created",
      entityType: "issue",
      entityId: report.id,
      details: {
        source: "organization_checkup.run",
        findingCount: findings.length,
        suppressedCount: suppressedFindings.length,
        fingerprints: findings.map((finding) => finding.fingerprint),
        thresholds,
      },
    });
    written.add("activity_log");

    return {
      ...base,
      outcome: "created",
      reportIssueId: report.id,
      reportIdentifier: report.identifier ?? null,
      writtenTables: [...written].sort(),
      existingReportCreatedAt: null,
    };
  }

  /**
   * Scheduler entry point. Off unless the caller says which companies are on
   * (an empty list means every active company, but the caller still has to
   * opt in -- see config.weeklyCheckupEnabled). A company is due when its
   * newest check-up is older than the interval and none is still open.
   */
  async function reconcileOrganizationCheckups(opts?: {
    now?: Date;
    companyId?: string;
    companyIds?: string[];
    intervalDays?: number;
    dryRun?: boolean;
    thresholds?: Partial<CheckupThresholds>;
  }) {
    const now = opts?.now ?? new Date();
    const intervalDays = opts?.intervalDays && opts.intervalDays > 0 ? Math.floor(opts.intervalDays) : 7;
    const dryRun = opts?.dryRun ?? false;
    const dueBefore = daysAgo(now, intervalDays);

    const candidateCompanies = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(
        and(
          eq(companies.status, "active"),
          opts?.companyId ? eq(companies.id, opts.companyId) : undefined,
          opts?.companyIds && opts.companyIds.length > 0 ? inArray(companies.id, opts.companyIds) : undefined,
        ),
      )
      .orderBy(asc(companies.createdAt), asc(companies.id));

    const result = {
      scanned: candidateCompanies.length,
      created: 0,
      existing: 0,
      notDue: 0,
      dryRun: 0,
      failed: 0,
      reportIssueIds: [] as string[],
      failedCompanyIds: [] as string[],
    };

    for (const company of candidateCompanies) {
      try {
        const open = await findOpenCheckup(company.id);
        if (open) {
          result.existing += 1;
          continue;
        }
        const newest = await findNewestCheckup(company.id);
        if (newest && newest.createdAt.getTime() > dueBefore.getTime()) {
          result.notDue += 1;
          continue;
        }
        const outcome = await runCheckup({ companyId: company.id, now, dryRun, intervalDays, thresholds: opts?.thresholds });
        if (outcome.outcome === "created") {
          result.created += 1;
          if (outcome.reportIssueId) result.reportIssueIds.push(outcome.reportIssueId);
        } else if (outcome.outcome === "existing") {
          result.existing += 1;
        } else {
          result.dryRun += 1;
          logger.info(
            { companyId: company.id, companyName: company.name, findings: outcome.findings.map((f) => f.headline) },
            "organization check-up dry run: report not written",
          );
        }
      } catch (err) {
        result.failed += 1;
        result.failedCompanyIds.push(company.id);
        logger.warn({ err, companyId: company.id }, "organization check-up failed for a company; continuing with the rest");
      }
    }

    return result;
  }

  return {
    runCheckup,
    reconcileOrganizationCheckups,
    resolveAdviceOwnerAgentId,
    findOpenCheckup,
    summarizeOpenCheckup,
    hideFindings,
  };
}
