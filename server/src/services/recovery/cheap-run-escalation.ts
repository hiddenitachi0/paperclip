import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, issueComments } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { withRecoveryModelProfileHint } from "./model-profile-hint.js";
import { RECOVERY_REASON_KINDS } from "./origins.js";

/**
 * DUR-45: a cheap/status-only recovery run that hits `resumeRequiresNormalModel`
 * (see model-profile-hint.ts) is not stuck -- it can hand the blocked action to a
 * normal-model run on the same issue instead of failing and leaving the issue to
 * rot as `blocked`. This module decides whether that hand-off is allowed and
 * builds the wake that performs it. Bounding rule: at most
 * DEFAULT_MAX_CHEAP_RUN_ESCALATIONS_PER_ISSUE escalations per issue, ever, and at
 * most one in-flight escalation per (issue, source run) pair -- see
 * decideCheapRunEscalation for how those two checks compose to make looping
 * structurally impossible rather than merely unlikely.
 */

export const CHEAP_RUN_ESCALATION_REASON = RECOVERY_REASON_KINDS.cheapRunEscalation;
export const DEFAULT_MAX_CHEAP_RUN_ESCALATIONS_PER_ISSUE = 3;
// Rough, deliberately conservative estimate of the extra cost a single normal-tier
// run adds over the cheap-tier run it replaces, purely for operator visibility.
export const CHEAP_RUN_ESCALATION_ESTIMATED_COST_CENTS = 50;

const IDEMPOTENT_WAKE_STATUSES = ["queued", "deferred_issue_execution", "coalesced", "completed"];

// Deliberately loose: callers pass heartbeatService(db).wakeup directly, whose
// concrete opts/return types are richer than this module needs to know about.
export type WakeupFn = (agentId: string, opts: Record<string, unknown>) => Promise<any>;

export function buildCheapRunEscalationIdempotencyKey(input: { issueId: string; sourceRunId: string }): string {
  return [CHEAP_RUN_ESCALATION_REASON, input.issueId, input.sourceRunId].join(":");
}

export async function findExistingCheapRunEscalationWake(
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
        inArray(agentWakeupRequests.status, IDEMPOTENT_WAKE_STATUSES),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export async function countCheapRunEscalationsForIssue(
  db: Db,
  input: { companyId: string; issueId: string },
): Promise<number> {
  const rows = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.reason, CHEAP_RUN_ESCALATION_REASON),
        sql`${agentWakeupRequests.payload} ->> 'issueId' = ${input.issueId}`,
      ),
    );
  return rows.length;
}

export type CheapRunEscalationDecision =
  | { kind: "enqueue"; idempotencyKey: string; payload: Record<string, unknown>; contextSnapshot: Record<string, unknown> }
  | { kind: "already_pending"; idempotencyKey: string }
  | { kind: "capped"; count: number; maxCount: number };

/**
 * Pure decision function -- no DB, no side effects -- mirroring
 * decideRunLivenessContinuation. Two independent guards make an escalation loop
 * structurally impossible:
 *  1. `idempotentWakeExists` -- the SAME source run can never enqueue a second
 *     escalation wake (the idempotency key is scoped to issueId+sourceRunId), so
 *     one blocked run can never fan out into more than one escalation.
 *  2. `priorEscalationCount` -- a hard lifetime cap per issue, so even a string of
 *     distinct wakes/runs that each independently hit the wall cannot escalate
 *     forever; once capped, the issue needs an operator, not another auto-retry.
 */
export function decideCheapRunEscalation(input: {
  issueId: string;
  sourceRunId: string;
  blockedAction: string;
  priorEscalationCount: number;
  idempotentWakeExists: boolean;
  maxEscalations?: number;
}): CheapRunEscalationDecision {
  const maxEscalations = input.maxEscalations ?? DEFAULT_MAX_CHEAP_RUN_ESCALATIONS_PER_ISSUE;
  const idempotencyKey = buildCheapRunEscalationIdempotencyKey({
    issueId: input.issueId,
    sourceRunId: input.sourceRunId,
  });

  if (input.idempotentWakeExists) {
    return { kind: "already_pending", idempotencyKey };
  }
  if (input.priorEscalationCount >= maxEscalations) {
    return { kind: "capped", count: input.priorEscalationCount, maxCount: maxEscalations };
  }

  const payload = withRecoveryModelProfileHint(
    {
      issueId: input.issueId,
      sourceRunId: input.sourceRunId,
      blockedAction: input.blockedAction,
      instruction:
        `A cheap status-only run could not ${input.blockedAction} because that requires a normal-sized ` +
        "model. This run is a normal-tier escalation of the same issue -- take that action now.",
    },
    "normal_model",
  );

  return {
    kind: "enqueue",
    idempotencyKey,
    payload,
    contextSnapshot: withRecoveryModelProfileHint(
      {
        issueId: input.issueId,
        taskId: input.issueId,
        wakeReason: CHEAP_RUN_ESCALATION_REASON,
        escalationBlockedAction: input.blockedAction,
        escalationSourceRunId: input.sourceRunId,
      },
      "normal_model",
    ),
  };
}

export type CheapRunEscalationOutcome =
  | { escalated: true; alreadyPending: boolean; capped: false; failed: false; escalationRunId: string | null; count: number }
  | { escalated: false; alreadyPending: false; capped: true; failed: false; count: number; maxCount: number }
  | { escalated: false; alreadyPending: false; capped: false; failed: true };

/**
 * Orchestrates the decision above against real state: looks up any in-flight
 * escalation wake and the issue's lifetime escalation count, enqueues a
 * normal-model wake for the same agent/issue when allowed, and leaves a
 * plain-language comment on the issue either way so an operator can see that an
 * escalation happened (and its estimated cost) or that the cap was hit and the
 * issue now needs a human. Never throws on the caller's behalf and never touches
 * issue.status -- callers decide what, if anything, to do with the outcome. A
 * failure partway through (e.g. the wake could not be scheduled) is reported as
 * `{ failed: true }` rather than thrown: nothing is persisted before the wake
 * succeeds, so a failed attempt leaves no state behind and a later retry is free
 * to try again from scratch.
 */
export async function recordCheapRunEscalation(
  db: Db,
  wakeup: WakeupFn,
  input: {
    companyId: string;
    issueId: string;
    agentId: string;
    sourceRunId: string;
    blockedAction: string;
  },
): Promise<CheapRunEscalationOutcome> {
  try {
    const idempotencyKey = buildCheapRunEscalationIdempotencyKey({
      issueId: input.issueId,
      sourceRunId: input.sourceRunId,
    });
    const [existingWake, priorEscalationCount] = await Promise.all([
      findExistingCheapRunEscalationWake(db, { companyId: input.companyId, idempotencyKey }),
      countCheapRunEscalationsForIssue(db, { companyId: input.companyId, issueId: input.issueId }),
    ]);

    const decision = decideCheapRunEscalation({
      issueId: input.issueId,
      sourceRunId: input.sourceRunId,
      blockedAction: input.blockedAction,
      priorEscalationCount,
      idempotentWakeExists: Boolean(existingWake),
    });

    if (decision.kind === "already_pending") {
      return {
        escalated: true,
        alreadyPending: true,
        capped: false,
        failed: false,
        escalationRunId: existingWake?.id ?? null,
        count: priorEscalationCount,
      };
    }

    if (decision.kind === "capped") {
      await db.insert(issueComments).values({
        companyId: input.companyId,
        issueId: input.issueId,
        authorType: "system",
        createdByRunId: input.sourceRunId,
        body: [
          `This issue has hit its cheap-run escalation cap (${decision.count}/${decision.maxCount}).`,
          "",
          `A cheap, status-only run could not ${input.blockedAction}, and automatic escalation to a ` +
            "normal-sized run is capped to keep this from looping. An operator needs to look at this issue directly.",
        ].join("\n"),
      });
      return {
        escalated: false,
        alreadyPending: false,
        capped: true,
        failed: false,
        count: decision.count,
        maxCount: decision.maxCount,
      };
    }

    const wakeRun = await wakeup(input.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: CHEAP_RUN_ESCALATION_REASON,
      payload: decision.payload,
      contextSnapshot: decision.contextSnapshot,
      idempotencyKey: decision.idempotencyKey,
      requestedByActorType: "system",
      requestedByActorId: "heartbeat",
    });

    const nextCount = priorEscalationCount + 1;
    await db.insert(issueComments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      authorType: "system",
      createdByRunId: input.sourceRunId,
      body: [
        "Escalating to a normal-sized run to finish one action a cheap run could not take:",
        "",
        `- Action: ${input.blockedAction}`,
        `- Escalation ${nextCount} of ${DEFAULT_MAX_CHEAP_RUN_ESCALATIONS_PER_ISSUE} for this issue`,
        `- Estimated extra cost: ~${CHEAP_RUN_ESCALATION_ESTIMATED_COST_CENTS}c (one normal-tier run in place of the cheap one)`,
      ].join("\n"),
    });

    return {
      escalated: true,
      alreadyPending: false,
      capped: false,
      failed: false,
      escalationRunId: wakeRun?.id ?? null,
      count: nextCount,
    };
  } catch (err) {
    logger.error(
      { err, companyId: input.companyId, issueId: input.issueId, sourceRunId: input.sourceRunId },
      "cheap-run escalation failed; leaving the caller's own response unaffected",
    );
    return { escalated: false, alreadyPending: false, capped: false, failed: true };
  }
}
