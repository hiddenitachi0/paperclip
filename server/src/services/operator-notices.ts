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

import type { AssigneeUnavailableReason } from "@paperclipai/shared";

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

/**
 * DUR-3965: the wall-clock time an operator would read off their own screen,
 * as HH:MM in the server's own timezone. Used where "27 minutes ago" alone is
 * not enough to recognise the event ("...was put in quiet mode at 13:20").
 */
export function formatOperatorClockTime(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const when = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(when.getTime())) return null;
  return `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
}

export interface QuietModeNoticeInput {
  /** When quiet mode was switched on (ISO), if known. */
  activatedAt: string | null;
  /** How long it has been on, in ms. */
  activeForMs: number | null;
  /**
   * True when quiet mode was switched on BY A DEPLOY (recorded at activation
   * time, see QUIET_MODE_REASON_DEPLOY) rather than by a person. This picks
   * which of the two sentences below is written, and they are deliberately
   * very different: one reports an incident, the other reports a fact.
   */
  activatedForDeploy?: boolean;
}

/**
 * DUR-3965: the sentence written when the whole instance is paused, as the
 * fleet-health finding on the Now page strip AND as an Activity-feed notice
 * (DUR-98), so an operator who is not looking at the Now page still finds out.
 *
 * Two cases, on purpose:
 *
 * - A DEPLOY switched it on and never switched it back off. Nobody chose that
 *   silence, so it is an incident and reads like one -- this is the
 *   2026-09-10 shape, 27 minutes of a completely idle fleet.
 * - A PERSON switched it on. That is a decision, and Filip makes it most
 *   nights (the overnight Claude-quota window is about 22 hours of exactly
 *   this). It is stated as a fact, with no suggestion anyone forgot anything,
 *   and only after the long QUIET_MODE_STALE_AFTER_MS window.
 *
 * Neither promises the platform will fix it: the server never auto-clears
 * quiet mode, because someone may have set it on purpose.
 */
export function buildQuietModeNotice(input: QuietModeNoticeInput): string {
  const clock = formatOperatorClockTime(input.activatedAt);
  const when = clock
    ? ` at ${clock}${input.activeForMs !== null ? ` (${formatOperatorDuration(input.activeForMs)} ago)` : ""}`
    : input.activeForMs !== null
      ? ` ${formatOperatorDuration(input.activeForMs)} ago`
      : "";
  if (input.activatedForDeploy) {
    return (
      `Everything is paused. Paperclip was put in quiet mode for a deploy${when} and never taken out of it; ` +
      `no agent in any company will do any work until it is cleared. ` +
      `Clear it under Settings > Instance settings > General, using the quiet-mode switch.`
    );
  }
  return (
    `Quiet mode has been on${when} and is still on, so no agent in any company is starting new work. ` +
    `If that is still what you want, nothing needs doing. ` +
    `To start the agents again, switch it off under Settings > Instance settings > General.`
  );
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
  /**
   * For "not_continued": the retry gate's error code (for example
   * "issue_not_in_progress" from scheduleBoundedRetryForRun, or
   * "policy_disabled"). It is translated to a plain sentence here; the
   * internal code never reaches the operator.
   */
  reasonCode?: string | null;
}

/**
 * DUR-3943 item 4: plain-language reasons for "the work was not continued",
 * keyed by the error code the retry gate reports. Anything unknown falls
 * back to a generic sentence rather than leaking the code.
 */
const TURN_CAP_NOT_CONTINUED_REASONS: Record<string, string> = {
  policy_disabled: "automatic continuation is switched off for this agent",
  issue_not_in_progress: "the task is no longer in progress",
  issue_terminal_status: "the task was finished in the meantime",
  issue_cancelled: "the task was cancelled in the meantime",
  issue_not_found: "the task no longer exists",
  issue_reassigned: "the task was handed to someone else",
  issue_assignee_changed: "the task was handed to someone else",
  lock_released_on_reassignment: "the task was handed to someone else",
  issue_execution_lock_changed: "another run has taken over the task",
  issue_execution_lock_held_by_live_run: "another run is already working on the task",
  issue_review_participant_changed: "the task is waiting on someone else's review",
  issue_continuation_waiting_on_review: "the task is waiting on someone else's review",
  issue_paused: "the task is paused",
  issue_dependencies_blocked: "the task is waiting on other tasks that are not done yet",
  agent_not_invokable: "the agent is not available to run right now (it may be paused or switched off)",
  agent_not_found: "the agent no longer exists",
  budget_blocked: "the agent's budget does not allow another run right now",
};

const TURN_CAP_NOT_CONTINUED_FALLBACK_REASON = "the task could not be picked up again automatically";

export function describeTurnCapNotContinuedReason(reasonCode: string | null | undefined): string {
  const code = reasonCode?.trim();
  if (!code) return TURN_CAP_NOT_CONTINUED_FALLBACK_REASON;
  return TURN_CAP_NOT_CONTINUED_REASONS[code] ?? TURN_CAP_NOT_CONTINUED_FALLBACK_REASON;
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
  return `${stopped}; the work was not continued because ${describeTurnCapNotContinuedReason(input.reasonCode)}.`;
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

// ---------------------------------------------------------------------------
// DUR-3973: tasks waiting on an agent that cannot pick them up.
//
// Every sentence says which task, which agent, why that agent cannot pick it
// up, and the one thing the operator can do about it -- and never suggests an
// action that does not exist (a terminated agent is not "switched back on").
// Paperclip never reassigns the task itself: that is the operator's call.
// ---------------------------------------------------------------------------

export interface AssigneeUnavailableTaskRef {
  identifier: string | null | undefined;
  title: string | null | undefined;
}

export interface AssigneeUnavailableEntry {
  task: AssigneeUnavailableTaskRef;
  agentId: string;
  agentName: string | null | undefined;
  reason: AssigneeUnavailableReason;
}

function agentLabel(name: string | null | undefined): string {
  return name?.trim() ? name.trim() : "the assigned agent";
}

function taskRef(task: AssigneeUnavailableTaskRef): string {
  const identifier = task.identifier?.trim();
  const title = task.title?.trim();
  if (identifier && title) return `${identifier} "${title}"`;
  if (identifier) return identifier;
  if (title) return `"${title}"`;
  return "A task";
}

function taskShortRef(task: AssigneeUnavailableTaskRef): string {
  return task.identifier?.trim() || (task.title?.trim() ? `"${task.title.trim()}"` : "an untitled task");
}

/** "Automations is switched off (...)" -- the full why, for one agent. */
export function describeAssigneeUnavailableState(agentName: string | null | undefined, reason: AssigneeUnavailableReason): string {
  const who = agentLabel(agentName);
  switch (reason) {
    case "switched_off":
      return `${who} is switched off ("Heartbeat on interval" and "Wake on demand" are both off in its settings)`;
    case "paused":
      return `${who} is paused`;
    case "paused_for_budget":
      return `${who} is paused because it reached its budget limit`;
    case "terminated":
      return `${who} has been terminated`;
    case "pending_approval":
      return `${who} is still waiting for its hiring to be approved`;
    case "reporting_line_broken":
      return `${who} cannot work because the agent it reports to is gone`;
    case "unknown_status":
    default:
      return `${who} is in a state where it cannot take work`;
  }
}

/** "paused", "switched off", ... -- the short why, for lists. */
export function describeAssigneeUnavailableShort(reason: AssigneeUnavailableReason): string {
  switch (reason) {
    case "switched_off":
      return "switched off";
    case "paused":
      return "paused";
    case "paused_for_budget":
      return "paused, budget limit reached";
    case "terminated":
      return "terminated";
    case "pending_approval":
      return "waiting for hiring approval";
    case "reporting_line_broken":
      return "reports to an agent that is gone";
    case "unknown_status":
    default:
      return "cannot take work";
  }
}

/** The one thing to do, for one agent. */
export function describeAssigneeUnavailableFix(
  agentName: string | null | undefined,
  reason: AssigneeUnavailableReason,
  taskCount: number,
): string {
  const who = agentLabel(agentName);
  const task = taskCount === 1 ? "task" : "tasks";
  switch (reason) {
    case "switched_off":
      return `Switch ${who} back on (turn on "Wake on demand" in its settings), or give the ${task} to another agent.`;
    case "paused":
      return `Resume ${who}, or give the ${task} to another agent.`;
    case "paused_for_budget":
      return `Raise the budget for ${who}, or give the ${task} to another agent.`;
    case "pending_approval":
      return `Approve the hiring of ${who}, or give the ${task} to another agent.`;
    case "reporting_line_broken":
      return `Change who ${who} reports to, or give the ${task} to another agent.`;
    case "terminated":
    case "unknown_status":
    default:
      return `Give the ${task} to another agent.`;
  }
}

/** One task, one agent: the sentence recorded on the task itself. */
export function buildAssigneeUnavailableTaskSentence(entry: Omit<AssigneeUnavailableEntry, "agentId">): string {
  return (
    `${taskRef(entry.task)} is assigned to ${agentLabel(entry.agentName)}, but ` +
    `${describeAssigneeUnavailableState(entry.agentName, entry.reason)}, so nobody will start it. ` +
    describeAssigneeUnavailableFix(entry.agentName, entry.reason, 1)
  );
}

const LISTED_TASKS_LIMIT = 3;
const LISTED_AGENTS_LIMIT = 5;
/** Reasons where the agent was switched off by a decision, not by an accident. */
const DELIBERATE_UNAVAILABLE_REASONS: ReadonlySet<AssigneeUnavailableReason> = new Set(["paused", "switched_off"]);

function pluralTasks(count: number): string {
  return `${count} ${count === 1 ? "task" : "tasks"}`;
}

export interface UnavailableAgentGroup {
  agentName: string | null | undefined;
  reason: AssigneeUnavailableReason;
  tasks: number;
}

function formatAgentGroups(groups: UnavailableAgentGroup[], totalAgents = groups.length): string {
  const sorted = [...groups].sort((left, right) => right.tasks - left.tasks);
  const shown = sorted
    .slice(0, LISTED_AGENTS_LIMIT)
    .map((group) => `${agentLabel(group.agentName)} (${describeAssigneeUnavailableShort(group.reason)}, ${pluralTasks(group.tasks)})`);
  const more = totalAgents - shown.length;
  return `${shown.join(", ")}${more > 0 ? ` and ${more} more ${more === 1 ? "agent" : "agents"}` : ""}`;
}

function multiAgentFix(groups: Array<{ reason: AssigneeUnavailableReason }>): string {
  const anyTerminated = groups.some((group) => group.reason === "terminated" || group.reason === "unknown_status");
  return (
    `Switch those agents back on, or give their tasks to other agents.` +
    (anyTerminated ? ` A terminated agent cannot be switched back on, so its tasks need another agent.` : "")
  );
}

/**
 * The Activity-feed notice for everything one recovery sweep newly found in
 * one company. One task reads as one plain sentence; a backlog (the first
 * sweep after this shipped, or pausing an agent that has work) reads as ONE
 * line with counts per agent instead of a wall of identical alarms.
 */
export function buildAssigneeUnavailableNotice(entries: AssigneeUnavailableEntry[]): string {
  if (entries.length === 0) return "";
  if (entries.length === 1) return buildAssigneeUnavailableTaskSentence(entries[0]!);

  const byAgent = new Map<string, { agentName: string | null | undefined; reason: AssigneeUnavailableReason; entries: AssigneeUnavailableEntry[] }>();
  for (const entry of entries) {
    const group = byAgent.get(entry.agentId);
    if (group) group.entries.push(entry);
    else byAgent.set(entry.agentId, { agentName: entry.agentName, reason: entry.reason, entries: [entry] });
  }
  const groups = [...byAgent.values()];
  const deliberate = groups.every((group) => DELIBERATE_UNAVAILABLE_REASONS.has(group.reason));
  const calm = deliberate ? " If that is deliberate, nothing needs doing." : "";

  if (groups.length === 1) {
    const group = groups[0]!;
    const refs = group.entries.slice(0, LISTED_TASKS_LIMIT).map((entry) => taskShortRef(entry.task));
    const more = group.entries.length - refs.length;
    return (
      `${pluralTasks(group.entries.length)} are assigned to ${agentLabel(group.agentName)}, but ` +
      `${describeAssigneeUnavailableState(group.agentName, group.reason)}, so nobody will start them: ` +
      `${refs.join(", ")}${more > 0 ? ` and ${more} more` : ""}. ` +
      describeAssigneeUnavailableFix(group.agentName, group.reason, group.entries.length) +
      calm
    );
  }

  return (
    `${pluralTasks(entries.length)} are waiting on agents that cannot pick them up, so nobody will start them: ` +
    `${formatAgentGroups(groups.map((group) => ({ agentName: group.agentName, reason: group.reason, tasks: group.entries.length })))}. ` +
    multiAgentFix(groups) +
    calm
  );
}

/**
 * The at-a-glance line on the fleet-health strip: how many open tasks are
 * waiting on agents that cannot pick them up, right now. Informational, never
 * an alarm on its own -- on this instance whole companies' agents are paused
 * on purpose for weeks at a time.
 */
export function buildFleetWaitingOnUnavailableAgentsNote(input: {
  tasks: number;
  agents: number;
  sample: UnavailableAgentGroup[];
}): string {
  const them = input.tasks === 1 ? "it" : "them";
  const opening =
    input.tasks === 1
      ? "1 open task is assigned to an agent that cannot pick it up"
      : `${input.tasks} open tasks are assigned to ${input.agents === 1 ? "an agent" : "agents"} that cannot pick them up`;
  return (
    `${opening}, so nobody will start ${them}: ${formatAgentGroups(input.sample, input.agents)}. ` +
    `They wait until the agent is switched back on or the task is given to another agent.`
  );
}

/**
 * DUR-4001: the one-line entry for one agent that cannot pick up its work,
 * shown on the Now page next to the agent's linked name -- so it starts with
 * the state, not the name, and names the agent only in the thing to do:
 * "Paused, with 3 tasks waiting. Resume Sales agent 1, or give the tasks to
 * another agent."
 */
export function buildUnavailableAgentReasonText(input: {
  agentName: string | null | undefined;
  reason: AssigneeUnavailableReason;
  tasks: number;
}): string {
  const state = describeAssigneeUnavailableShort(input.reason);
  const opening = state.charAt(0).toUpperCase() + state.slice(1);
  return `${opening}, with ${pluralTasks(input.tasks)} waiting. ${describeAssigneeUnavailableFix(input.agentName, input.reason, input.tasks)}`;
}

/**
 * DUR-4001: the one-line entry for one agent that has stopped with an error,
 * shown on the Now page next to the agent's linked name. Says how long it has
 * been stuck and what unblocks it. Carries no error text on purpose: the
 * fleet signal is instance-wide, and the free-text reason stays on the
 * agent's own (company-scoped) page.
 */
export function buildAgentInErrorReasonText(input: {
  errorAt: string | Date | null | undefined;
  now?: Date;
}): string {
  const when = input.errorAt instanceof Date ? input.errorAt : input.errorAt ? new Date(input.errorAt) : null;
  const sinceMs = when && !Number.isNaN(when.getTime()) ? (input.now ?? new Date()).getTime() - when.getTime() : null;
  const since = sinceMs === null ? "" : ` ${formatOperatorDuration(Math.max(0, sinceMs))} ago`;
  return `Stopped with an error${since} and will not take work until someone clears it.`;
}
