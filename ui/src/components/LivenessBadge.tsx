import { describeRunLiveness, type RunActivityTimestamps } from "../lib/runLiveness";
import { cn } from "../lib/utils";

/**
 * Plain-language "is this run alive" pill: "working — last activity 3m ago"
 * or, once quiet past the stall threshold, "has been quiet for 22 minutes —
 * might be stuck". Pass the live run's activity timestamps; renders nothing
 * when there's no run to describe.
 */
export function LivenessBadge({
  activity,
  className,
}: {
  activity: RunActivityTimestamps | null | undefined;
  className?: string;
}) {
  const info = describeRunLiveness(activity);
  if (!info) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
        info.stalled
          ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
          : "border-cyan-500/30 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
        className,
      )}
      title={info.stalled ? "No recent activity — check whether this run needs a nudge" : undefined}
    >
      {info.text}
    </span>
  );
}
