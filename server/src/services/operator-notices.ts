// DUR-98: "silence must mean healthy". When the platform itself notices that
// something went wrong -- the watchdog ending a run that stopped responding,
// an agent dropping into "error" -- the operator must learn about it without
// going looking. These builders produce the plain-language sentences those
// activity-log entries carry (rendered in the Activity feed and the agent
// page), so the wording lives in one place and is unit-tested rather than
// scattered across call sites.
//
// House rule (see build brief): plain human language, no ids/jargon as the
// only identifier, say what happened and what happens next.

export function formatOperatorDuration(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "an unknown amount of time";
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return "under a minute";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  return parts.join(" ");
}

export interface ReapedRunOperatorNoticeInput {
  agentName: string | null | undefined;
  /** How long the run had shown no sign of progress before it was ended. */
  silentForMs: number | null;
  /** Whether Paperclip knew the run's process (pid/process group) and found it gone. */
  processWasKnown: boolean;
  /** Whether a fresh run was queued to pick the work up again. */
  retryQueued: boolean;
  /** Whether the agent was left in "error" and now needs a person. */
  agentMarkedError: boolean;
}

export function buildReapedRunOperatorNotice(input: ReapedRunOperatorNoticeInput): string {
  const who = input.agentName?.trim() ? input.agentName.trim() : "An agent";
  const silence =
    input.silentForMs !== null && input.silentForMs >= 60_000
      ? ` after ${formatOperatorDuration(input.silentForMs)} without any output`
      : "";
  const why = input.processWasKnown
    ? `its process was no longer running${silence}`
    : `its process could not be found${silence} (most likely the server restarted)`;
  const then = input.retryQueued
    ? "Paperclip ended it and queued a fresh run to pick the work up again."
    : input.agentMarkedError
      ? `Paperclip ended it. ${who} is now marked as needing attention and will not take new work until someone clears the error.`
      : `Paperclip ended it. ${who} is free to take work again.`;
  return `${who}'s run stopped: ${why}. ${then}`;
}

export interface AgentEnteredErrorNoticeInput {
  agentName: string | null | undefined;
  reason: string | null | undefined;
}

export function buildAgentEnteredErrorNotice(input: AgentEnteredErrorNoticeInput): string {
  const who = input.agentName?.trim() ? input.agentName.trim() : "An agent";
  const reason = input.reason?.trim();
  const because = reason ? ` Last error: ${reason}` : "";
  return `${who} stopped taking work after a failed run and needs attention. Open the agent and use "Clear error" once the cause is fixed.${because}`;
}
