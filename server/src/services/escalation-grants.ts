import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, costEvents, escalationGrants } from "@paperclipai/db";
import {
  ESCALATION_GRANT_DEFAULT_DURATION_MINUTES,
  type EscalationGrant,
  type EscalationGrantWithSpend,
  type ModelBoostRequestPayload,
} from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { issueService } from "./issues.js";

type EscalationGrantRow = typeof escalationGrants.$inferSelect;

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
