import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests } from "@paperclipai/db";
import { withRecoveryModelProfileHint } from "./model-profile-hint.js";

/**
 * DUR-45: a status_only (cheap) recovery run that hits the approval/deliverable
 * guard has no way to ask for a normal-model follow-up -- it can only write
 * "blocked" and stop, even when the only remaining step (e.g. filing an
 * approval) needs a bigger model. This fires exactly one automatic escalation
 * wake per issue, so the deadlock resolves itself instead of waiting on a human
 * to notice and nudge a new heartbeat.
 */
export const STATUS_ONLY_ESCALATION_REASON = "status_only_recovery_escalated_to_normal_model";

const IDEMPOTENT_ESCALATION_WAKE_STATUSES = ["queued", "deferred_issue_execution", "completed"];

export type StatusOnlyEscalationEnqueueWakeup = (
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

export type StatusOnlyEscalationAddComment = (issueId: string, body: string) => Promise<unknown>;

export function buildStatusOnlyEscalationIdempotencyKey(input: { issueId: string }) {
  return [STATUS_ONLY_ESCALATION_REASON, input.issueId].join(":");
}

export async function findExistingStatusOnlyEscalationWake(
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
        inArray(agentWakeupRequests.status, IDEMPOTENT_ESCALATION_WAKE_STATUSES),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export type StatusOnlyEscalationResult = {
  escalated: boolean;
  reason: string;
};

/**
 * Called from inside a status_only 403 guard. Bounded to one escalation per
 * issue (checked via the wakeup idempotency key, not a mutable counter) so a
 * flapping run can't spam full-model wakes.
 */
export async function attemptStatusOnlyEscalation(
  db: Db,
  enqueueWakeup: StatusOnlyEscalationEnqueueWakeup,
  addComment: StatusOnlyEscalationAddComment,
  input: {
    companyId: string;
    agentId: string;
    runId: string;
    issueId: string;
    blockedAction: string;
  },
): Promise<StatusOnlyEscalationResult> {
  const idempotencyKey = buildStatusOnlyEscalationIdempotencyKey({ issueId: input.issueId });
  const existing = await findExistingStatusOnlyEscalationWake(db, {
    companyId: input.companyId,
    idempotencyKey,
  });
  if (existing) {
    return { escalated: false, reason: "already escalated once for this issue" };
  }

  await enqueueWakeup(input.agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: STATUS_ONLY_ESCALATION_REASON,
    idempotencyKey,
    payload: withRecoveryModelProfileHint(
      {
        issueId: input.issueId,
        sourceIssueId: input.issueId,
        sourceRunId: input.runId,
        blockedAction: input.blockedAction,
        instruction:
          `The previous run needed a bigger model to ${input.blockedAction} and was denied because it was ` +
          "flagged cheap/status-only. This run has a normal model -- finish that action now.",
      },
      "normal_model",
    ),
    contextSnapshot: withRecoveryModelProfileHint(
      {
        issueId: input.issueId,
        taskId: input.issueId,
        wakeReason: STATUS_ONLY_ESCALATION_REASON,
        source: "status_only_recovery_escalation",
        sourceRunId: input.runId,
        blockedAction: input.blockedAction,
      },
      "normal_model",
    ),
    requestedByActorType: "system",
    requestedByActorId: "status_only_escalation",
  });

  await addComment(
    input.issueId,
    [
      `A cheap status-only run tried to ${input.blockedAction} and was blocked -- that action needs a normal model.`,
      "",
      "Paperclip escalated automatically: a fresh run with the normal model has been queued for this issue. " +
        "This is a one-time escalation per issue, so if the same wall is hit again it needs a human to look.",
    ].join("\n"),
  );

  return { escalated: true, reason: "escalation wake queued" };
}
