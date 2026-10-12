import { cn } from "../lib/utils";

/** What the API sends for a task with sub-tasks (dates arrive as text). */
export interface IssueProgressView {
  completedCount: number;
  totalCount: number;
  percent: number;
  etaLabel?: string | null;
  planGrewLabel?: string | null;
}

/** Reads the progress the API attaches to a task; null when there is none. */
export function readIssueProgress(issue: object | null | undefined): IssueProgressView | null {
  const progress = (issue as { progress?: IssueProgressView | null } | null | undefined)?.progress;
  return progress && progress.totalCount > 0 ? progress : null;
}

export function issueProgressText(progress: IssueProgressView, compact = false): string {
  const parts = [`${progress.completedCount} of ${progress.totalCount}`, `${progress.percent}%`];
  if (progress.etaLabel) parts.push(progress.etaLabel);
  if (!compact && progress.planGrewLabel) {
    parts.push(progress.planGrewLabel.includes("(weight)") ? "plan got bigger" : progress.planGrewLabel);
  }
  return parts.join(" · ");
}

export function IssueProgressBar({
  progress,
  compact = false,
  className,
}: {
  progress: IssueProgressView | null | undefined;
  compact?: boolean;
  className?: string;
}) {
  if (!progress || progress.totalCount <= 0) return null;
  const percent = Math.min(100, Math.max(0, progress.percent));
  const text = issueProgressText(progress, compact);
  return (
    <div
      data-testid="issue-progress"
      className={cn("flex min-w-0 items-center gap-2", compact ? "text-[10px]" : "text-xs", className)}
    >
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={`Sub-tasks done: ${text}`}
        className={cn("shrink-0 overflow-hidden rounded-full bg-muted/70", compact ? "h-1.5 w-16" : "h-2 w-40")}
      >
        <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-200" style={{ width: `${percent}%` }} />
      </div>
      <span className="min-w-0 truncate text-muted-foreground">{text}</span>
    </div>
  );
}
