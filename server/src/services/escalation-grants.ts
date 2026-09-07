import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, costEvents, escalationGrants } from "@paperclipai/db";
import {
  ESCALATION_GRANT_DEFAULT_DURATION_MINUTES,
  type EscalationGrant,
  type EscalationGrantWithSpend,
  type ModelBoostBossReviewState,
  type ModelBoostRequestPayload,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { issueService } from "./issues.js";
import { readBossReview, type BossCandidate } from "./model-boost-boss-review.js";

export { buildBossReviewStamp, readBossReview, type BossCandidate } from "./model-boost-boss-review.js";

type EscalationGrantRow = typeof escalationGrants.$inferSelect;
type ApprovalRow = typeof approvals.$inferSelect;

/** A boss who can actually answer: exists, same company, and not switched off. */
const BOSS_INELIGIBLE_STATUSES = new Set(["terminated", "paused", "pending_approval"]);

function isPendingModelBoostApproval(row: Pick<ApprovalRow, "type" | "status" | "payload">): boolean {
  return (
    row.type === "request_board_approval" &&
    row.payload?.kind === "model_boost" &&
    (row.status === "pending" || row.status === "revision_requested")
  );
}

function toReadModel(row: EscalationGrantRow): EscalationGrant {
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    agentId: row.agentId,
    approvalId: row.approvalId,
    grantedModel: row.grantedModel,
    grantedEffort: row.grantedEffort,
    reason: row.reason,
    maxSpendCents: row.maxSpendCents,
    expiresAt: row.expiresAt,
    status: row.status as EscalationGrant["status"],
    expiredReason: row.expiredReason as EscalationGrant["expiredReason"],
    expiredAt: row.expiredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeReasonForComparison(reason: string): string {
  return reason.trim().toLowerCase().replace(/\s+/g, " ");
}

export function escalationGrantService(db: Db) {
  const issuesSvc = issueService(db);

  async function computeSpendCents(issueId: string): Promise<number> {
    const [row] = await db
      .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision` })
      .from(costEvents)
      .where(eq(costEvents.issueId, issueId));
    return Number(row?.total ?? 0);
  }

  async function postExpiryNote(grant: EscalationGrantRow, reason: "time_expired" | "budget_exhausted") {
    const message =
      reason === "budget_exhausted"
        ? "The temporary boost has used its budget and has ended — back to the normal setting."
        : "The temporary boost's time window has ended — back to the normal setting.";
    await issuesSvc.addComment(
      grant.issueId,
      message,
      {},
      { authorType: "system" },
    );
  }

  async function expireGrant(
    grant: EscalationGrantRow,
    reason: "time_expired" | "budget_exhausted",
  ): Promise<EscalationGrantRow> {
    const [updated] = await db
      .update(escalationGrants)
      .set({
        status: "expired",
        expiredReason: reason,
        expiredAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(escalationGrants.id, grant.id), eq(escalationGrants.status, "active")))
      .returning();
    if (updated) {
      await postExpiryNote(updated, reason);
      return updated;
    }
    return grant;
  }

  async function findLatestActive(
    companyId: string,
    agentId: string,
    issueId: string,
  ): Promise<EscalationGrantRow | null> {
    const rows = await db
      .select()
      .from(escalationGrants)
      .where(
        and(
          eq(escalationGrants.companyId, companyId),
          eq(escalationGrants.agentId, agentId),
          eq(escalationGrants.issueId, issueId),
          eq(escalationGrants.status, "active"),
        ),
      )
      .orderBy(desc(escalationGrants.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Checks a still-`active` grant against its time/money caps and expires it
   * (posting the plain-language note) if either has been reached. Returns the
   * live grant row -- `null` once it's no longer usable for dispatch.
   */
  async function checkAndMaybeExpire(grant: EscalationGrantRow): Promise<EscalationGrantRow | null> {
    if (grant.status !== "active") return null;
    if (grant.expiresAt.getTime() <= Date.now()) {
      await expireGrant(grant, "time_expired");
      return null;
    }
    const spentCents = await computeSpendCents(grant.issueId);
    if (spentCents >= grant.maxSpendCents) {
      await expireGrant(grant, "budget_exhausted");
      return null;
    }
    return grant;
  }

  return {
    /**
     * Precedence: agent base < model profile < active grant < explicit issue
     * override (see mergeModelProfileAdapterConfig in heartbeat.ts). Called at
     * dispatch time, scoped to the current assignee + issue only.
     */
    resolveActiveGrantForDispatch: async (input: {
      companyId: string;
      agentId: string;
      issueId: string;
    }): Promise<EscalationGrant | null> => {
      const grant = await findLatestActive(input.companyId, input.agentId, input.issueId);
      if (!grant) return null;
      const live = await checkAndMaybeExpire(grant);
      return live ? toReadModel(live) : null;
    },

    /** Re-checks every active grant touched by a newly recorded cost event. */
    evaluateCostEvent: async (event: typeof costEvents.$inferSelect) => {
      if (!event.issueId) return;
      const rows = await db
        .select()
        .from(escalationGrants)
        .where(and(eq(escalationGrants.issueId, event.issueId), eq(escalationGrants.status, "active")));
      for (const grant of rows) {
        await checkAndMaybeExpire(grant);
      }
    },

    createFromApproval: async (input: {
      companyId: string;
      approvalId: string;
      payload: ModelBoostRequestPayload;
    }): Promise<EscalationGrant> => {
      const durationMinutes = input.payload.durationMinutes ?? ESCALATION_GRANT_DEFAULT_DURATION_MINUTES;
      const expiresAt = new Date(Date.now() + durationMinutes * 60_000);
      const [row] = await db
        .insert(escalationGrants)
        .values({
          companyId: input.companyId,
          issueId: input.payload.issueId,
          agentId: input.payload.agentId,
          approvalId: input.approvalId,
          grantedModel: input.payload.requestedModel ?? null,
          grantedEffort: input.payload.requestedEffort ?? null,
          reason: input.payload.reason,
          maxSpendCents: input.payload.maxSpendCents,
          expiresAt,
          status: "active",
        })
        .returning();
      return toReadModel(row);
    },

    /**
     * Rate-limits re-asking (DUR-31 item 5): a pending or already-active grant
     * blocks a new ask outright, and a repeat of a just-denied reason (same
     * task, same agent) is rejected until something material changes.
     */
    assertRequestAllowed: async (input: {
      companyId: string;
      issueId: string;
      agentId: string;
      reason: string;
    }) => {
      const activeGrant = await findLatestActive(input.companyId, input.agentId, input.issueId);
      if (activeGrant) {
        throw conflict("An active boost grant already covers this task.");
      }

      const priorApprovals = await db
        .select({ status: approvals.status, payload: approvals.payload, createdAt: approvals.createdAt })
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, input.companyId),
            eq(approvals.type, "request_board_approval"),
            eq(approvals.requestedByAgentId, input.agentId),
            sql`${approvals.payload} ->> 'kind' = 'model_boost'`,
            sql`${approvals.payload} ->> 'issueId' = ${input.issueId}`,
          ),
        )
        .orderBy(desc(approvals.createdAt))
        .limit(1);

      const latest = priorApprovals[0] ?? null;
      if (!latest) return;

      if (latest.status === "pending" || latest.status === "revision_requested") {
        throw conflict("A boost request is already pending for this task.");
      }

      if (latest.status === "rejected") {
        const priorReason = typeof latest.payload.reason === "string" ? latest.payload.reason : "";
        if (normalizeReasonForComparison(priorReason) === normalizeReasonForComparison(input.reason)) {
          throw conflict(
            "The last boost request for this task was denied for the same reason. Nothing has changed since then.",
          );
        }
      }
    },

    /**
     * Boss-first routing: walk `reportsTo` up from the requester and return
     * the nearest boss who can actually answer (same company, not terminated
     * / paused / still awaiting hire approval). `null` means there is nobody
     * to ask first and the request goes straight to the operator.
     */
    resolveBossForAgent: async (companyId: string, agentId: string): Promise<BossCandidate | null> => {
      const seen = new Set<string>([agentId]);
      let cursor: string | null = agentId;
      for (let hops = 0; cursor && hops < 32; hops += 1) {
        const [current] = await db
          .select({ id: agents.id, companyId: agents.companyId, reportsTo: agents.reportsTo })
          .from(agents)
          .where(eq(agents.id, cursor))
          .limit(1);
        const nextId: string | null = current?.reportsTo ?? null;
        if (!nextId || seen.has(nextId)) return null;
        seen.add(nextId);
        const [boss] = await db
          .select({ id: agents.id, name: agents.name, companyId: agents.companyId, status: agents.status })
          .from(agents)
          .where(eq(agents.id, nextId))
          .limit(1);
        if (!boss || boss.companyId !== companyId) return null;
        if (!BOSS_INELIGIBLE_STATUSES.has(boss.status)) {
          return { id: boss.id, name: boss.name };
        }
        cursor = boss.id;
      }
      return null;
    },

    /**
     * The boss answers a direct report's boost ask. "decline" ends it there
     * (approval rejected, requester stays on its normal setting, the operator
     * is never bothered); "forward" sends it on to the operator with the
     * boss's take attached. Only the boss named on the ask may answer, and
     * only while it is still waiting on them.
     */
    recordBossDecision: async (input: {
      approvalId: string;
      bossAgentId: string;
      decision: "decline" | "forward";
      note?: string | null;
    }): Promise<ApprovalRow> => {
      const [existing] = await db.select().from(approvals).where(eq(approvals.id, input.approvalId)).limit(1);
      if (!existing) throw notFound("Approval not found");
      const review = readBossReview(existing.payload);
      if (!review || existing.payload?.kind !== "model_boost") {
        throw conflict("This approval is not a boost request waiting on a boss.");
      }
      if (review.bossAgentId !== input.bossAgentId) {
        throw forbidden("Only the boss this boost request is waiting on can answer it.");
      }
      if (!isPendingModelBoostApproval(existing)) {
        throw conflict("This boost request has already been decided.");
      }
      if (review.status !== "awaiting_boss") {
        throw conflict("This boost request is no longer waiting on the boss.");
      }

      const now = new Date();
      const note = input.note?.trim() || undefined;
      const nextReview: ModelBoostBossReviewState = {
        ...review,
        status: input.decision === "decline" ? "declined" : "forwarded",
        decidedAt: now.toISOString(),
        ...(note ? { note } : {}),
      };
      const nextPayload = { ...existing.payload, bossReview: nextReview };

      const [updated] = await db
        .update(approvals)
        .set(
          input.decision === "decline"
            ? {
                status: "rejected",
                payload: nextPayload,
                decisionNote: note ? `${review.bossName} said no: ${note}` : `${review.bossName} said no.`,
                decidedAt: now,
                updatedAt: now,
              }
            : { payload: nextPayload, updatedAt: now },
        )
        .where(and(eq(approvals.id, existing.id), eq(approvals.status, existing.status)))
        .returning();
      if (!updated) throw conflict("This boost request changed while the boss was answering. Try again.");
      return updated;
    },

    /**
     * Scheduler pass: any boost ask still waiting on its boss past the
     * deadline moves on to the operator by itself, so a silent boss can never
     * leave a report stuck. Returns the ids that moved on.
     */
    sweepBossReviewTimeouts: async (now: Date = new Date()): Promise<string[]> => {
      const rows = await db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.type, "request_board_approval"),
            eq(approvals.status, "pending"),
            sql`${approvals.payload} ->> 'kind' = 'model_boost'`,
            sql`${approvals.payload} -> 'bossReview' ->> 'status' = 'awaiting_boss'`,
          ),
        );
      const movedOn: string[] = [];
      for (const row of rows) {
        const review = readBossReview(row.payload);
        if (!review) continue;
        const deadline = new Date(review.deadlineAt);
        if (Number.isNaN(deadline.getTime()) || deadline.getTime() > now.getTime()) continue;
        const nextReview: ModelBoostBossReviewState = {
          ...review,
          status: "timed_out",
          decidedAt: now.toISOString(),
        };
        const [updated] = await db
          .update(approvals)
          .set({ payload: { ...row.payload, bossReview: nextReview }, updatedAt: now })
          .where(and(eq(approvals.id, row.id), eq(approvals.status, "pending")))
          .returning({ id: approvals.id });
        if (updated) movedOn.push(updated.id);
      }
      return movedOn;
    },

    getForIssue: async (companyId: string, issueId: string): Promise<EscalationGrantWithSpend | null> => {
      const rows = await db
        .select()
        .from(escalationGrants)
        .where(
          and(
            eq(escalationGrants.companyId, companyId),
            eq(escalationGrants.issueId, issueId),
            eq(escalationGrants.status, "active"),
          ),
        )
        .orderBy(desc(escalationGrants.createdAt))
        .limit(1);
      const grant = rows[0] ?? null;
      if (!grant) return null;
      const live = await checkAndMaybeExpire(grant);
      if (!live) return null;
      const spentCents = await computeSpendCents(issueId);
      return { ...toReadModel(live), spentCents };
    },
  };
}
