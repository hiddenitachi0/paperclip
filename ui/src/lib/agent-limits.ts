import type { AgentLimits } from "@paperclipai/shared";

/** DUR-4000: true when the job's limits box carries anything worth sending. */
export function hasAnyAgentLimit(limits: AgentLimits | null | undefined): boolean {
  if (!limits) return false;
  return (
    limits.dailyImageGenerations != null ||
    limits.dailyPosts != null ||
    limits.dailyRuns != null ||
    Boolean(limits.notes && limits.notes.trim())
  );
}
