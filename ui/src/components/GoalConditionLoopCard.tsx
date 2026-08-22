import type { Issue } from "@paperclipai/shared";
import { formatCents } from "@/lib/utils";

/**
 * DUR-32: surfaces the "keep going until done" loop on a task — the plain-English finish
 * line, which round it's on, what the independent judge said last time, and spend so far.
 * Sibling to IssueMonitorActivityCard, which is scheduled-time based (nextCheckAt) and
 * never applies to a goal_condition monitor (it has no nextCheckAt — see
 * goal-condition-judge.ts, which always persists monitorNextCheckAt: null for this kind).
 */
function resolveGoalConditionMonitor(issue: Issue) {
  const policyMonitor = issue.executionPolicy?.monitor;
  const stateMonitor = issue.executionState?.monitor;
  const kind = stateMonitor?.kind ?? policyMonitor?.kind;
  if (kind !== "goal_condition") return null;
  const condition = stateMonitor?.condition ?? policyMonitor?.condition;
  if (!condition) return null;

  return {
    condition,
    round: stateMonitor?.attemptCount ?? 0,
    maxAttempts: stateMonitor?.maxAttempts ?? policyMonitor?.maxAttempts ?? null,
    lastVerdict: stateMonitor?.lastVerdict ?? null,
    lastVerdictReason: stateMonitor?.lastVerdictReason ?? null,
    spentCents: stateMonitor?.spentCentsAtLastVerdict ?? null,
    spendCapCents: stateMonitor?.spendCapCents ?? policyMonitor?.spendCapCents ?? null,
    clearReason: stateMonitor?.clearReason ?? null,
  };
}

export function GoalConditionLoopCard({ issue }: { issue: Issue }) {
  const monitor = resolveGoalConditionMonitor(issue);
  if (!monitor) return null;

  const roundLabel = monitor.round > 0 ? `Round ${monitor.round}${monitor.maxAttempts ? ` of ${monitor.maxAttempts}` : ""}` : "Not started yet";
  const verdictLabel =
    monitor.lastVerdict === "met"
      ? "Independent check: met"
      : monitor.lastVerdict === "not_met"
        ? "Independent check: not met yet"
        : "Awaiting independent check";

  return (
    <div className="mb-3 rounded-lg border border-border bg-muted/30 px-3 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">Goal</div>
        <div className="mt-0.5 text-xs text-muted-foreground">&ldquo;{monitor.condition}&rdquo;</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{roundLabel}</span>
          <span>{verdictLabel}</span>
          {monitor.spentCents != null ? (
            <span>
              {formatCents(monitor.spentCents)}
              {monitor.spendCapCents != null ? ` of ${formatCents(monitor.spendCapCents)} spent` : " spent"}
            </span>
          ) : null}
        </div>
        {monitor.lastVerdictReason ? (
          <div className="mt-1 text-xs text-muted-foreground">Judge said: {monitor.lastVerdictReason}</div>
        ) : null}
        {monitor.clearReason && monitor.clearReason !== "goal_condition_met" ? (
          <div className="mt-1 text-xs text-amber-600 dark:text-amber-500">
            Stopped — escalated to the operator ({monitor.clearReason.replaceAll("_", " ")}).
          </div>
        ) : null}
      </div>
    </div>
  );
}
