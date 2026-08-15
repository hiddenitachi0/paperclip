import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, costEvents, heartbeatRuns, issueComments } from "@paperclipai/db";
import type {
  IssueExecutionMonitorPolicy,
  IssueExecutionMonitorState,
  IssueExecutionPolicy,
  IssueExecutionState,
  ModelProfileKey,
  GoalConditionVerdict,
} from "@paperclipai/shared";

/**
 * DUR-32: "keep going until done" — a plain-English finish line on a task, re-checked
 * after every round by an INDEPENDENT judge (not the agent that did the work), looping
 * the worker until the judge agrees or a round/spend/time cap is hit. Composes with the
 * self-review pass (self-review-gate.ts): self-review runs first, then (if a goal
 * condition is set) the judge decides whether another round is needed.
 *
 * Reuses the existing `issues.executionPolicy.monitor` shape (kind "goal_condition") and
 * its `maxAttempts`/`timeoutAt` bounds rather than building a second loop engine.
 */

export const GOAL_CONDITION_JUDGE_REASON = "goal_condition_judge";
export const GOAL_CONDITION_WORKER_RETRY_REASON = "goal_condition_not_met";

// Marker carried in a run's contextSnapshot so a run started to JUDGE a goal condition
// (and anything scheduled from it) is recognized without re-gating it as worker output.
export const GOAL_CONDITION_JUDGE_CONTEXT_KEY = "goalConditionJudge";

export const GOAL_CONDITION_VERDICT_LINE_PREFIX = "GOAL_CONDITION_VERDICT:";

const DEFAULT_EVALUATOR_MODEL_PROFILE: ModelProfileKey = "cheap";

export function isGoalConditionJudgeContext(contextSnapshot: unknown): boolean {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return false;
  const context = contextSnapshot as Record<string, unknown>;
  return context[GOAL_CONDITION_JUDGE_CONTEXT_KEY] === true || context.wakeReason === GOAL_CONDITION_JUDGE_REASON;
}

/** Recognizes a run that IS the independent judge pass, however it was scheduled. */
export function isGoalConditionJudgeRun(run: {
  scheduledRetryReason?: string | null;
  contextSnapshot?: unknown;
}): boolean {
  if (run.scheduledRetryReason === GOAL_CONDITION_JUDGE_REASON) return true;
  return isGoalConditionJudgeContext(run.contextSnapshot);
}

export async function isGoalConditionJudgeRunId(db: Db, runId: string | null | undefined): Promise<boolean> {
  if (!runId) return false;
  const run = await db
    .select({ scheduledRetryReason: heartbeatRuns.scheduledRetryReason, contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!run) return false;
  return isGoalConditionJudgeRun(run);
}

export function readGoalConditionMonitorPolicy(
  policy: IssueExecutionPolicy | Record<string, unknown> | null | undefined,
): IssueExecutionMonitorPolicy | null {
  const monitor = (policy as { monitor?: IssueExecutionMonitorPolicy | null } | null | undefined)?.monitor;
  if (!monitor || monitor.kind !== "goal_condition") return null;
  if (!monitor.condition || !monitor.condition.trim()) return null;
  return monitor;
}

export function issueHasGoalCondition(
  policy: IssueExecutionPolicy | Record<string, unknown> | null | undefined,
): boolean {
  return readGoalConditionMonitorPolicy(policy) !== null;
}

/** The round the judge is about to evaluate (1-indexed). */
export function nextGoalConditionRound(state: IssueExecutionMonitorState | null | undefined): number {
  return (state?.attemptCount ?? 0) + 1;
}

/**
 * How long a "met" verdict is trusted to wave a transition through without re-judging.
 *
 * A verdict is only meant to cover the SAME work session's retry of the handoff it
 * unblocked (the worker gets 409'd, the judge says met, the worker's resumed wake retries
 * the same PATCH) — not an indefinitely-reusable pass. Round numbers alone can't tell those
 * apart: they only increment when a judge runs, not when new work happens, so a reopened
 * issue that gets new work and is closed again would otherwise reuse a stale "met" from
 * hours or days earlier without ever being re-checked. Bounding by recency closes that gap
 * without needing to track heartbeat run lineage.
 */
const GOAL_CONDITION_VERDICT_TRUST_WINDOW_MS = 30 * 60 * 1000;

/** True once a judge has already confirmed the condition met for the CURRENT round's work, recently enough to still trust it. */
export function goalConditionAlreadyMetForRound(
  state: IssueExecutionMonitorState | null | undefined,
  round: number,
  now: Date = new Date(),
): boolean {
  if (!state) return false;
  if (state.lastVerdict !== "met" || state.attemptCount < round - 1) return false;
  if (!state.lastTriggeredAt) return false;
  return now.getTime() - new Date(state.lastTriggeredAt).getTime() <= GOAL_CONDITION_VERDICT_TRUST_WINDOW_MS;
}

export function buildGoalConditionJudgeIdempotencyKey(input: { issueId: string; sourceRunId: string; round: number }) {
  return [GOAL_CONDITION_JUDGE_REASON, input.issueId, input.sourceRunId, input.round].join(":");
}

export function buildGoalConditionJudgeInstruction(input: {
  issueIdentifier: string | null;
  condition: string;
  round: number;
  maxAttempts: number | null;
  priorVerdictReason: string | null;
}): string {
  const issueLabel = input.issueIdentifier ?? "this task";
  const lines = [
    `You are acting as an INDEPENDENT EVALUATOR for ${issueLabel} — not the agent who did the work, and you must not take its word for anything.`,
    "",
    `Finish line (round ${input.round}${input.maxAttempts ? ` of ${input.maxAttempts}` : ""}): "${input.condition}"`,
    "",
    "Verify this against real evidence, not narrative: read the diff, run the relevant commands (grep counts, tests, the actual feature), and check the claim is true right now — not merely attempted or partially done.",
  ];
  if (input.priorVerdictReason) {
    lines.push(
      "",
      `A prior round was judged not met for this reason: "${input.priorVerdictReason}". Check specifically whether that gap is now closed.`,
    );
  }
  lines.push(
    "",
    "Do not edit files, fix anything, or change the issue status yourself — your only job is to verify and report.",
    "",
    "When you're done, post a single issue comment whose FIRST LINE is exactly one of:",
    `${GOAL_CONDITION_VERDICT_LINE_PREFIX} met`,
    `${GOAL_CONDITION_VERDICT_LINE_PREFIX} not_met — <short plain-English reason naming the specific gap>`,
  );
  return lines.join("\n");
}

export async function postGoalConditionJudgeNoticeComment(
  db: Db,
  input: { companyId: string; issueId: string; sourceRunId?: string | null; body: string },
): Promise<void> {
  await db.insert(issueComments).values({
    companyId: input.companyId,
    issueId: input.issueId,
    authorType: "system",
    body: input.body,
    createdByRunId: input.sourceRunId ?? null,
  });
}

export async function findExistingGoalConditionJudgeNoticeCommentForRun(
  db: Db,
  input: { companyId: string; issueId: string; sourceRunId: string; body: string },
) {
  return db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.createdByRunId, input.sourceRunId),
        eq(issueComments.body, input.body),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

const IDEMPOTENT_GOAL_CONDITION_WAKE_STATUSES = ["queued", "deferred_issue_execution", "claimed", "completed"] as const;

export async function findExistingGoalConditionJudgeWake(
  db: Db,
  input: { companyId: string; idempotencyKey: string },
) {
  return db
    .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        inArray(agentWakeupRequests.status, [...IDEMPOTENT_GOAL_CONDITION_WAKE_STATUSES]),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

/** Parses a judge's verdict comment. Anything that doesn't clearly say "met" is treated as not met — never a silent pass. */
export function parseGoalConditionVerdict(
  commentBody: string | null | undefined,
): { verdict: GoalConditionVerdict; reason: string | null } | null {
  if (!commentBody) return null;
  const line = commentBody
    .split("\n")
    .map((raw) => raw.trim())
    .find((raw) => raw.toUpperCase().startsWith(GOAL_CONDITION_VERDICT_LINE_PREFIX));
  if (!line) return null;
  const rest = line.slice(GOAL_CONDITION_VERDICT_LINE_PREFIX.length).trim();
  if (/^met\b/i.test(rest)) {
    return { verdict: "met", reason: null };
  }
  if (/^not_met\b/i.test(rest)) {
    const reasonMatch = rest.match(/^not_met\s*[—-]\s*(.+)$/i);
    const reason = reasonMatch?.[1]?.trim() || null;
    return { verdict: "not_met", reason };
  }
  return null;
}

export async function findGoalConditionVerdictCommentForRun(
  db: Db,
  input: { companyId: string; issueId: string; runId: string },
) {
  return db
    .select({ id: issueComments.id, body: issueComments.body })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.createdByRunId, input.runId),
      ),
    )
    .orderBy(desc(issueComments.createdAt))
    .then((rows) => rows.find((row) => parseGoalConditionVerdict(row.body) !== null) ?? null);
}

/** Sum of cost_events.costCents for this issue — the same spend-cap query pattern as escalation-grants.ts. */
export async function computeGoalConditionSpendCents(db: Db, issueId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision` })
    .from(costEvents)
    .where(eq(costEvents.issueId, issueId));
  return Number(row?.total ?? 0);
}

export type GoalConditionBoundsExceeded =
  | { exceeded: false }
  | { exceeded: true; reason: "max_attempts_exhausted" | "timeout_exceeded" | "spend_cap_exceeded"; detail: string };

export function evaluateGoalConditionBounds(input: {
  policy: IssueExecutionMonitorPolicy;
  round: number;
  now: Date;
  spentCents: number;
}): GoalConditionBoundsExceeded {
  if (input.policy.maxAttempts != null && input.round > input.policy.maxAttempts) {
    return {
      exceeded: true,
      reason: "max_attempts_exhausted",
      detail: `${input.policy.maxAttempts} round${input.policy.maxAttempts === 1 ? "" : "s"}`,
    };
  }
  if (input.policy.timeoutAt && new Date(input.policy.timeoutAt).getTime() <= input.now.getTime()) {
    return { exceeded: true, reason: "timeout_exceeded", detail: input.policy.timeoutAt };
  }
  if (input.policy.spendCapCents != null && input.spentCents >= input.policy.spendCapCents) {
    return {
      exceeded: true,
      reason: "spend_cap_exceeded",
      detail: `$${(input.policy.spendCapCents / 100).toFixed(2)}`,
    };
  }
  return { exceeded: false };
}

export function resolveEvaluatorModelProfile(
  policy: IssueExecutionMonitorPolicy | null | undefined,
): ModelProfileKey {
  return policy?.evaluatorModelProfile ?? DEFAULT_EVALUATOR_MODEL_PROFILE;
}

export function buildGoalConditionEscalationSummary(input: {
  condition: string;
  round: number;
  maxAttempts: number | null;
  lastVerdictReason: string | null;
  spentCents: number;
  spendCapCents: number | null;
  boundReason: "max_attempts_exhausted" | "timeout_exceeded" | "spend_cap_exceeded";
}): { title: string; plainSummary: string } {
  const boundLabel =
    input.boundReason === "max_attempts_exhausted"
      ? `hit the round cap (${input.maxAttempts ?? input.round})`
      : input.boundReason === "timeout_exceeded"
        ? "ran out of time"
        : `hit the spend cap ($${((input.spendCapCents ?? 0) / 100).toFixed(2)})`;
  const spent = `$${(input.spentCents / 100).toFixed(2)}`;
  const plainSummary = [
    `Finish line: "${input.condition}"`,
    `Rounds spent: ${input.round}${input.maxAttempts ? ` of ${input.maxAttempts}` : ""}. Spend so far: ${spent}.`,
    `Stopped because it ${boundLabel}.`,
    input.lastVerdictReason
      ? `The independent judge's last verdict: not met — ${input.lastVerdictReason}`
      : "The independent judge never confirmed the condition was met.",
  ].join("\n");
  return {
    title: "a task's finish line still isn't met after its round/spend cap",
    plainSummary,
  };
}

/**
 * Evaluates whether an agent-initiated transition to in_review/done should be deferred so an
 * independent judge can check the task's goal condition first. Returns null when the
 * transition should proceed (no goal condition set, already judged "met" this round, or the
 * actor IS the judge run itself).
 */
export type GoalConditionGateWakeup = (
  agentId: string,
  opts: {
    source?: "timer" | "assignment" | "on_demand" | "automation";
    triggerDetail?: "manual" | "ping" | "callback" | "system";
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    idempotencyKey?: string | null;
    requestedByActorType?: "user" | "agent" | "system";
    requestedByActorId?: string | null;
    contextSnapshot?: Record<string, unknown>;
  },
) => Promise<unknown>;

export async function evaluateGoalConditionDoneGate(input: {
  db: Db;
  wakeup: GoalConditionGateWakeup;
  issue: {
    id: string;
    identifier: string | null;
    companyId: string;
    executionPolicy: unknown;
    executionState: unknown;
  };
  actor: { actorType: string; agentId: string | null; runId: string | null };
  requestedStatus: string | undefined;
  currentStatus: string;
}): Promise<{ message: string } | null> {
  if (input.requestedStatus !== "in_review" && input.requestedStatus !== "done") return null;
  if (input.currentStatus === input.requestedStatus) return null;
  if (input.actor.actorType !== "agent" || !input.actor.agentId || !input.actor.runId) return null;

  const monitorPolicy = readGoalConditionMonitorPolicy(input.issue.executionPolicy as IssueExecutionPolicy | null);
  if (!monitorPolicy) return null;

  // The judge's own run must be allowed through — it never itself transitions the issue.
  if (await isGoalConditionJudgeRunId(input.db, input.actor.runId)) return null;

  const monitorState = (input.issue.executionState as { monitor?: IssueExecutionMonitorState | null } | null)
    ?.monitor ?? null;
  const round = nextGoalConditionRound(monitorState);
  if (goalConditionAlreadyMetForRound(monitorState, round)) return null;

  const sourceRunId = input.actor.runId;
  const idempotencyKey = buildGoalConditionJudgeIdempotencyKey({ issueId: input.issue.id, sourceRunId, round });
  const existingWake = await findExistingGoalConditionJudgeWake(input.db, {
    companyId: input.issue.companyId,
    idempotencyKey,
  });

  const message =
    "This task has a finish line that hasn't been independently confirmed yet. I've asked an independent judge to check it before this can move to review or done.";

  if (existingWake) return { message };

  const instruction = buildGoalConditionJudgeInstruction({
    issueIdentifier: input.issue.identifier,
    condition: monitorPolicy.condition as string,
    round,
    maxAttempts: monitorPolicy.maxAttempts ?? null,
    priorVerdictReason: monitorState?.lastVerdictReason ?? null,
  });

  try {
    await input.wakeup(input.actor.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: GOAL_CONDITION_JUDGE_REASON,
      payload: {
        issueId: input.issue.id,
        taskId: input.issue.id,
        instruction,
      },
      contextSnapshot: {
        issueId: input.issue.id,
        wakeReason: GOAL_CONDITION_JUDGE_REASON,
        [GOAL_CONDITION_JUDGE_CONTEXT_KEY]: true,
        // Fresh, non-resumed session: the judge must not inherit the worker's own
        // narrative/context — see goal-condition-judge.ts module doc for why.
        forceFreshSession: true,
        modelProfile: resolveEvaluatorModelProfile(monitorPolicy),
        originalWorkerRunId: sourceRunId,
        goalConditionRound: round,
      },
      idempotencyKey,
      requestedByActorType: "system",
      requestedByActorId: "issue_goal_condition_gate",
    });
  } catch {
    // Scheduling the judge failed (e.g. agent paused / over budget). Don't let scheduling
    // failure block a real disposition — let the transition through as requested.
    return null;
  }

  try {
    await postGoalConditionJudgeNoticeComment(input.db, {
      companyId: input.issue.companyId,
      issueId: input.issue.id,
      sourceRunId,
      body: `Before this moves on, an independent judge is checking the finish line: "${monitorPolicy.condition}"`,
    });
  } catch {
    // Best-effort — the wake itself is what enforces the gate.
  }

  return { message };
}

function blankGoalConditionExecutionState(): IssueExecutionState {
  return {
    status: "idle",
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: null,
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    monitor: null,
  };
}

/**
 * Merges a new monitor state into an issue's full executionState, preserving whatever
 * review/approval stage fields are already there (those are a separate mechanism — see
 * issue-execution-policy.ts applyIssueExecutionStageTransition).
 */
export function mergeGoalConditionMonitorState(
  existingState: IssueExecutionState | null,
  monitorState: IssueExecutionMonitorState | null,
): IssueExecutionState {
  const base = existingState ? { ...existingState } : blankGoalConditionExecutionState();
  return { ...base, monitor: monitorState };
}

/**
 * Builds the goal_condition monitor state after a judge verdict, plus the flat DB patch
 * (mirroring the shape issue-execution-policy.ts's buildIssueMonitorTriggeredPatch/
 * buildIssueMonitorClearedPatch produce for the sibling "external_service" monitor kind).
 * `monitorNextCheckAt` is always null here — goal_condition is driven by the run-finish
 * hook, not the periodic monitor sweep (tickDueIssueMonitors), so it must never be picked
 * up by that poll loop.
 */
export function buildGoalConditionVerdictMonitorPatch(input: {
  existingExecutionState: IssueExecutionState | null;
  monitorPolicy: IssueExecutionMonitorPolicy;
  round: number;
  verdict: GoalConditionVerdict;
  verdictReason: string | null;
  judgeRunId: string;
  spentCents: number;
  clearReason?: "goal_condition_met" | "max_attempts_exhausted" | "timeout_exceeded" | "spend_cap_exceeded" | null;
}) {
  const now = new Date();
  const monitorState: IssueExecutionMonitorState = {
    status: input.clearReason ? "cleared" : "triggered",
    nextCheckAt: null,
    lastTriggeredAt: now.toISOString(),
    attemptCount: input.round,
    notes: null,
    scheduledBy: "assignee",
    kind: "goal_condition",
    serviceName: null,
    externalRef: null,
    timeoutAt: input.monitorPolicy.timeoutAt ?? null,
    maxAttempts: input.monitorPolicy.maxAttempts ?? null,
    recoveryPolicy: null,
    clearedAt: input.clearReason ? now.toISOString() : null,
    clearReason: input.clearReason ?? null,
    condition: input.monitorPolicy.condition ?? null,
    evaluatorModelProfile: resolveEvaluatorModelProfile(input.monitorPolicy),
    spendCapCents: input.monitorPolicy.spendCapCents ?? null,
    lastVerdict: input.verdict,
    lastVerdictReason: input.verdictReason,
    lastJudgeRunId: input.judgeRunId,
    spentCentsAtLastVerdict: input.spentCents,
  };
  return {
    executionState: mergeGoalConditionMonitorState(input.existingExecutionState, monitorState) as unknown as Record<
      string,
      unknown
    >,
    monitorNextCheckAt: null,
    monitorWakeRequestedAt: null,
    monitorLastTriggeredAt: now,
    monitorAttemptCount: input.round,
    monitorNotes: null as string | null,
    monitorScheduledBy: "assignee" as const,
  };
}
