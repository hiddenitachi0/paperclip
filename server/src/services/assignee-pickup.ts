import { asBoolean, asNumber, parseObject } from "@paperclipai/adapter-utils/server-utils";
import type { AssigneeUnavailableReason, QuietModeAgentSnapshotEntry } from "@paperclipai/shared";
import type { AgentInvokability } from "./agent-invokability.js";

// DUR-3973: "can the agent this task is assigned to actually pick it up?"
//
// Before this, the recovery sweep only asked whether the agent was paused or
// terminated. An agent whose heartbeat and wake-on-demand were both switched
// off (the 25 Aug wind-down) passed that check, so the sweep queued a wake-up
// for its task every 30 seconds, the heartbeat rejected every one
// ("heartbeat.wakeOnDemand.disabled"), and nobody was ever told. One task
// produced 10,178 rejected rows in five days.
//
// This module is the single answer to that question. The recovery sweep uses
// it to decide whether to queue a wake-up at all, and the fleet-health strip
// uses it to count waiting tasks, so the two can never disagree. The heartbeat's
// own wake gate reads its flags through readHeartbeatWakeFlags below, and a
// test drives the real enqueueWakeup across a matrix of agent setups to prove
// that "wake_on_demand" here means "the heartbeat accepts the wake-up".

export interface HeartbeatWakeFlags {
  /** "Heartbeat on interval". */
  enabled: boolean;
  intervalSec: number;
  /** "Wake on demand" (assignments, API calls, UI actions, automations). */
  wakeOnDemand: boolean;
}

/**
 * How an agent's runtime config says it may be woken. The ONE parser for
 * these flags: heartbeat.ts's parseHeartbeatPolicy (the real wake gate and
 * the timer tick), instance-settings.ts's quiet-mode snapshot, and the
 * pickup classifier below all read them through here.
 */
export function readHeartbeatWakeFlags(runtimeConfig: unknown): HeartbeatWakeFlags {
  const heartbeat = parseObject(parseObject(runtimeConfig).heartbeat);
  return {
    enabled: asBoolean(heartbeat.enabled, false),
    intervalSec: Math.max(0, asNumber(heartbeat.intervalSec, 0)),
    wakeOnDemand: asBoolean(
      heartbeat.wakeOnDemand ?? heartbeat.wakeOnAssignment ?? heartbeat.wakeOnOnDemand ?? heartbeat.wakeOnAutomation,
      true,
    ),
  };
}

/** True when the timer tick would ever wake this agent (tickTimers skips it otherwise). */
export function hasWorkingHeartbeatTimer(flags: Pick<HeartbeatWakeFlags, "enabled" | "intervalSec">): boolean {
  return flags.enabled && flags.intervalSec > 0;
}

export type AssigneePickup =
  /** A wake-up queued now is accepted. The only case the sweep dispatches. */
  | { kind: "wake_on_demand" }
  /**
   * Wake-on-demand is off but its heartbeat timer is on: a wake-up queued now
   * is rejected, but the agent picks its assigned work up on its next timer
   * tick. Nothing to dispatch and nothing to tell anyone.
   */
  | { kind: "on_timer" }
  /**
   * Quiet mode switched this agent off, and it comes back when quiet mode
   * ends. Quiet mode has its own notice (DUR-3965) and is on most nights, so
   * this must never produce a per-task notice.
   */
  | { kind: "held_by_quiet_mode" }
  /** The company is paused or archived: a company-level decision, silent. */
  | { kind: "company_inactive" }
  /**
   * The agent cannot be woken now, but whether quiet mode did that could not
   * be read. Nothing is dispatched (it would be rejected) and nothing is said
   * (it might be quiet mode). Fail-closed on the notice, on purpose: a false
   * "this agent is switched off" every night is worse than one missed sweep.
   */
  | { kind: "cannot_wake_unconfirmed" }
  /** The agent cannot pick the task up until a person does something. */
  | { kind: "unavailable"; reason: AssigneeUnavailableReason };

export interface ClassifyAssigneePickupInput {
  agent: {
    id: string;
    status: string;
    pauseReason?: string | null;
    runtimeConfig: unknown;
  };
  invokability: AgentInvokability;
  companyActive: boolean;
  /**
   * Instance quiet-mode state, or null when it could not be read. `snapshot`
   * holds each agent's own flags from before quiet mode switched them off.
   */
  quietMode: { active: boolean; snapshot: QuietModeAgentSnapshotEntry[] | null } | null;
}

function unavailableReasonForInvokability(
  agent: ClassifyAssigneePickupInput["agent"],
  invokability: Extract<AgentInvokability, { invokable: false }>,
): AssigneeUnavailableReason {
  switch (invokability.reason) {
    case "paused":
      return agent.pauseReason === "budget" ? "paused_for_budget" : "paused";
    case "terminated":
      return "terminated";
    case "pending_approval":
      return "pending_approval";
    case "manager_missing":
    case "manager_company_mismatch":
    case "manager_terminated":
    case "reporting_cycle":
    case "reporting_chain_too_deep":
      return "reporting_line_broken";
    default:
      return "unknown_status";
  }
}

export function classifyAssigneePickup(input: ClassifyAssigneePickupInput): AssigneePickup {
  const { agent, invokability, quietMode } = input;

  // Company first: archiving a company pauses every one of its agents
  // (pauseReason "company_archived"), and that must not read as dozens of
  // individually paused agents with waiting work.
  if (!input.companyActive || agent.pauseReason === "company_archived") return { kind: "company_inactive" };

  if (!invokability.invokable) {
    return { kind: "unavailable", reason: unavailableReasonForInvokability(agent, invokability) };
  }

  const current = readHeartbeatWakeFlags(agent.runtimeConfig);
  if (current.wakeOnDemand) return { kind: "wake_on_demand" };
  if (hasWorkingHeartbeatTimer(current)) return { kind: "on_timer" };

  // It cannot be woken right now. Was that the agent's own setting, or quiet
  // mode (which switches every agent's flags off and restores them after)?
  if (quietMode === null) return { kind: "cannot_wake_unconfirmed" };
  if (quietMode.active) {
    // State written without a snapshot cannot tell us the agent's own
    // settings, and quiet mode IS on, so that is the true explanation.
    if (quietMode.snapshot === null) return { kind: "held_by_quiet_mode" };
    const before = quietMode.snapshot.find((entry) => entry.agentId === agent.id);
    // Not in the snapshot = created while quiet mode was on, so quiet mode
    // never touched its flags and the current ones are its own.
    if (before && (before.wakeOnDemand || hasWorkingHeartbeatTimer({ enabled: before.enabled, intervalSec: current.intervalSec }))) {
      return { kind: "held_by_quiet_mode" };
    }
  }
  return { kind: "unavailable", reason: "switched_off" };
}
