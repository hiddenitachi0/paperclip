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

export type FrozenRunStopReason = "too_long" | "silent";

export interface FrozenRunStopWordingInput {
  reason: FrozenRunStopReason;
  /** The limit that was crossed (max run duration, or the silence window). */
  limitMs: number;
  /** Whether a fresh run was queued to pick the work up again. */
  retryQueued: boolean;
}

/**
 * DUR-3940 item 2 / run cap: the sentence stored as the run's own error
 * (shown on the run row and the agent page). Plain language, states the
 * limit and what happens next.
 */
export function buildFrozenRunErrorMessage(input: FrozenRunStopWordingInput): string {
  const limit = formatOperatorDuration(input.limitMs);
  const what =
    input.reason === "too_long"
      ? `Stopped after ${limit} with no result`
      : `Stopped after ${limit} without any output`;
  const next = input.retryQueued
    ? "it will be retried."
    : "this was already the retry, so the agent has been flagged for attention.";
  return `${what}; ${next}`;
}

export interface TurnCapContinuationNoteInput {
  /** The turn limit that was hit (null when the adapter did not report it). */
  turns: number | null;
  outcome: "continued" | "exhausted" | "not_continued";
  /** For "exhausted": how many cap hits in a row this made on the same task. */
  timesInARow?: number;
  /** For "not_continued": why no fresh run was queued, in plain words. */
  reason?: string | null;
}

/**
 * DUR-3943 item 4: the sentence stored as the error of a run that ended
 * because it hit its turn cap (shown on the run row and the agent page).
 */
export function buildTurnCapContinuationNote(input: TurnCapContinuationNoteInput): string {
  const stopped = input.turns && input.turns > 0
    ? `Stopped after ${input.turns} turns, the limit for one run`
    : "Stopped at the turn limit for one run";
  if (input.outcome === "continued") {
    return `${stopped}; the work continues in a fresh run.`;
  }
  if (input.outcome === "exhausted") {
    const times = input.timesInARow && input.timesInARow > 1 ? `${input.timesInARow} times in a row` : "again";
    return `${stopped}. This task has hit the limit ${times}, so no further fresh run was queued; it needs a look.`;
  }
  const reason = input.reason?.trim();
  return `${stopped}; the work was not continued${reason ? ` because ${lowerFirst(reason)}` : ""}.`;
}

export interface TurnCapRepeatedOperatorNoticeInput {
  agentName: string | null | undefined;
  issueIdentifier: string | null | undefined;
  issueTitle: string | null | undefined;
  turns: number | null;
  timesInARow: number;
}

/**
 * DUR-3943 item 4: the Activity-feed notice written only when the same task
 * has hit the turn cap repeatedly (three times in a row by default) and the
 * platform stopped queuing fresh runs for it.
 */
export function buildTurnCapRepeatedOperatorNotice(input: TurnCapRepeatedOperatorNoticeInput): string {
  const who = input.agentName?.trim() ? input.agentName.trim() : "An agent";
  const task = input.issueTitle?.trim()
    ? `"${input.issueTitle.trim()}"${input.issueIdentifier ? ` (${input.issueIdentifier})` : ""}`
    : input.issueIdentifier
      ? `task ${input.issueIdentifier}`
      : "its task";
  const limit = input.turns && input.turns > 0 ? `${input.turns} turns` : "the turn limit";
  const times = input.timesInARow > 1 ? `${input.timesInARow} times in a row` : "again";
  return (
    `${who} hit the limit of ${limit} per run on ${task} ${times}. ` +
    `Paperclip stopped queuing fresh runs for it, because a task that keeps running out of turns is usually stuck, too big, or unclear. ` +
    `Have a look at the task, then split it, clarify it, or wake the agent again when it is ready to continue.`
  );
}

function lowerFirst(text: string): string {
  return text.length > 0 ? text[0].toLowerCase() + text.slice(1) : text;
}

export interface StoppedRunOperatorNoticeInput extends FrozenRunStopWordingInput {
  agentName: string | null | undefined;
  /** How long the run had been going when it was stopped. */
  ranForMs: number | null;
  /** How long the run had shown no output when it was stopped. */
  silentForMs: number | null;
  /** Whether the agent was left in "error" and now needs a person. */
  agentMarkedError: boolean;
}

/**
 * DUR-3940 item 2 / run cap: the Activity-feed notice written when the
 * watchdog stops a run that is alive but frozen (silent for too long) or
 * simply running for longer than any real run ever finishes in.
 */
export function buildStoppedRunOperatorNotice(input: StoppedRunOperatorNoticeInput): string {
  const who = input.agentName?.trim() ? input.agentName.trim() : "An agent";
  const limit = formatOperatorDuration(input.limitMs);
  const why =
    input.reason === "too_long"
      ? `it had been going for ${formatOperatorDuration(input.ranForMs)} without finishing (the limit is ${limit})`
      : `its process was still running but had shown no output for ${formatOperatorDuration(input.silentForMs)} (the limit is ${limit})`;
  const then = input.retryQueued
    ? "Paperclip ended it and queued a fresh run to pick the work up again."
    : input.agentMarkedError
      ? `Paperclip ended it. That was already the retry, so ${who} is now marked as needing attention and will not take new work until someone clears the error.`
      : `Paperclip ended it. ${who} is free to take work again.`;
  return `${who}'s run was stopped: ${why}. ${then}`;
}
