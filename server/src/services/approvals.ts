import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentInstructionsRevisions, approvalComments, approvals } from "@paperclipai/db";
import {
  instructionsChangeRequestPayloadSchema,
  modelBoostRequestPayloadSchema,
  toolGrantRequestPayloadSchema,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { agentInstructionsService } from "./agent-instructions.js";
import { agentService } from "./agents.js";
import { budgetService } from "./budgets.js";
import { escalationGrantService } from "./escalation-grants.js";
import { notifyHireApproved } from "./hire-hook.js";
import { instanceSettingsService } from "./instance-settings.js";
import { describeToolCapability, summarizeMcpServer } from "./agent-tool-audit.js";

function isModelBoostApproval(approval: Pick<typeof approvals.$inferSelect, "type" | "payload">) {
  return approval.type === "request_board_approval" && approval.payload?.kind === "model_boost";
}

function isToolGrantApproval(approval: Pick<typeof approvals.$inferSelect, "type" | "payload">) {
  return approval.type === "request_board_approval" && approval.payload?.kind === "tool_grant";
}

/**
 * `request_board_approval` approvals whose payload carries `kind:"instructions_change"`
 * (DUR-69/DUR-109). Approving one is the ONLY place a boss-proposed instructions
 * change is ever actually written to disk -- see the branch below in `approve`.
 */
function isInstructionsChangeApproval(approval: Pick<typeof approvals.$inferSelect, "type" | "payload">) {
  return approval.type === "request_board_approval" && approval.payload?.kind === "instructions_change";
}

export interface InstructionsChangeApplyResult {
  agentId: string;
  companyId: string;
  relativePath: string;
  proposedByAgentId: string | null;
}

export interface ToolGrantApplyResult {
  agentId: string;
  companyId: string;
  serverName: string;
  capability: string;
}

export function approvalService(db: Db) {
  const agentsSvc = agentService(db);
  const instructionsSvc = agentInstructionsService();
  const budgets = budgetService(db);
  const escalationGrants = escalationGrantService(db);
  const instanceSettings = instanceSettingsService(db);
  const canResolveStatuses = new Set(["pending", "revision_requested"]);
  const resolvableStatuses = Array.from(canResolveStatuses);
  type ApprovalRecord = typeof approvals.$inferSelect;
  type ResolutionResult = { approval: ApprovalRecord; applied: boolean; toolGrant?: ToolGrantApplyResult | null };

  function redactApprovalComment<T extends { body: string }>(comment: T, censorUsernameInLogs: boolean): T {
    return {
      ...comment,
      body: redactCurrentUserText(comment.body, { enabled: censorUsernameInLogs }),
    };
  }

  async function getExistingApproval(id: string) {
    const existing = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, id))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Approval not found");
    return existing;
  }

  async function resolveApproval(
    id: string,
    targetStatus: "approved" | "rejected",
    decidedByUserId: string,
    decisionNote: string | null | undefined,
  ): Promise<ResolutionResult> {
    const existing = await getExistingApproval(id);
    if (!canResolveStatuses.has(existing.status)) {
      if (existing.status === targetStatus) {
        return { approval: existing, applied: false };
      }
      throw unprocessable(
        `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
      );
    }

    const now = new Date();
    const updated = await db
      .update(approvals)
      .set({
        status: targetStatus,
        decidedByUserId,
        decisionNote: decisionNote ?? null,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(eq(approvals.id, id), inArray(approvals.status, resolvableStatuses)))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      return { approval: updated, applied: true };
    }

    const latest = await getExistingApproval(id);
    if (latest.status === targetStatus) {
      return { approval: latest, applied: false };
    }

    throw unprocessable(
      `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
    );
  }

  return {
    list: (companyId: string, status?: string) => {
      const conditions = [eq(approvals.companyId, companyId)];
      if (status) conditions.push(eq(approvals.status, status));
      return db.select().from(approvals).where(and(...conditions));
    },

    getById: (id: string) =>
      db
        .select()
        .from(approvals)
        .where(eq(approvals.id, id))
        .then((rows) => rows[0] ?? null),

    findOpenHireApprovalForAgent: async (companyId: string, agentId: string) => {
      const rows = await db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            eq(approvals.type, "hire_agent"),
            inArray(approvals.status, resolvableStatuses),
            sql`${approvals.payload} ->> 'agentId' = ${agentId}`,
          ),
        );
      return rows[0] ?? null;
    },

    // DUR-101: same-target duplicate detection at filing time. Distinct from
    // findOpenHireApprovalForAgent (which dedups a re-activation of one already-
    // hired agent) -- this dedups a brand new hire request for the same role,
    // which is the "six approvals for three roles" incident from DUR-98.
    findOpenHireApprovalForRole: async (companyId: string, role: string) => {
      const rows = await db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            eq(approvals.type, "hire_agent"),
            inArray(approvals.status, resolvableStatuses),
            sql`${approvals.payload} ->> 'role' = ${role}`,
          ),
        );
      return rows[0] ?? null;
    },

    findOpenMergePrApproval: async (companyId: string, repo: string, prNumber: string) => {
      const rows = await db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            eq(approvals.type, "request_board_approval"),
            inArray(approvals.status, resolvableStatuses),
            sql`${approvals.payload} ->> 'kind' = 'merge_pr'`,
            sql`${approvals.payload} ->> 'repo' = ${repo}`,
            sql`${approvals.payload} ->> 'prNumber' = ${prNumber}`,
          ),
        );
      return rows[0] ?? null;
    },

    findOpenInstructionsChangeApproval: async (companyId: string, agentId: string, relativePath: string) => {
      const rows = await db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            eq(approvals.type, "request_board_approval"),
            inArray(approvals.status, resolvableStatuses),
            sql`${approvals.payload} ->> 'kind' = 'instructions_change'`,
            sql`${approvals.payload} ->> 'agentId' = ${agentId}`,
            sql`${approvals.payload} ->> 'relativePath' = ${relativePath}`,
          ),
        );
      return rows[0] ?? null;
    },

    findOpenDeployApproval: async (companyId: string, projectId: string, workspaceId: string) => {
      const rows = await db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            eq(approvals.type, "request_board_approval"),
            inArray(approvals.status, resolvableStatuses),
            sql`${approvals.payload} ->> 'kind' = 'deploy'`,
            sql`${approvals.payload} ->> 'projectId' = ${projectId}`,
            sql`${approvals.payload} ->> 'workspaceId' = ${workspaceId}`,
          ),
        );
      return rows[0] ?? null;
    },

    create: (companyId: string, data: Omit<typeof approvals.$inferInsert, "companyId">) =>
      db
        .insert(approvals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    approve: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const { approval: updated, applied } = await resolveApproval(
        id,
        "approved",
        decidedByUserId,
        decisionNote,
      );

      let hireApprovedAgentId: string | null = null;
      const now = new Date();
      if (applied && updated.type === "hire_agent") {
        const payload = updated.payload as Record<string, unknown>;
        const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
        if (payloadAgentId) {
          await agentsSvc.activatePendingApproval(payloadAgentId);
          hireApprovedAgentId = payloadAgentId;
        } else {
          const created = await agentsSvc.create(updated.companyId, {
            name: String(payload.name ?? "New Agent"),
            role: String(payload.role ?? "general"),
            title: typeof payload.title === "string" ? payload.title : null,
            reportsTo: typeof payload.reportsTo === "string" ? payload.reportsTo : null,
            capabilities: typeof payload.capabilities === "string" ? payload.capabilities : null,
            adapterType: String(payload.adapterType ?? "process"),
            adapterConfig:
              typeof payload.adapterConfig === "object" && payload.adapterConfig !== null
                ? (payload.adapterConfig as Record<string, unknown>)
                : {},
            budgetMonthlyCents:
              typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0,
            metadata:
              typeof payload.metadata === "object" && payload.metadata !== null
                ? (payload.metadata as Record<string, unknown>)
                : null,
            status: "idle",
            spentMonthlyCents: 0,
            permissions: undefined,
            lastHeartbeatAt: null,
          });
          hireApprovedAgentId = created?.id ?? null;
        }
        if (hireApprovedAgentId) {
          const budgetMonthlyCents =
            typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0;
          if (budgetMonthlyCents > 0) {
            await budgets.upsertPolicy(
              updated.companyId,
              {
                scopeType: "agent",
                scopeId: hireApprovedAgentId,
                amount: budgetMonthlyCents,
                windowKind: "calendar_month_utc",
              },
              decidedByUserId,
            );
          }
          void notifyHireApproved(db, {
            companyId: updated.companyId,
            agentId: hireApprovedAgentId,
            source: "approval",
            sourceId: id,
            approvedAt: now,
          }).catch(() => {});
        }
      }

      if (applied && isModelBoostApproval(updated)) {
        const payload = modelBoostRequestPayloadSchema.parse(updated.payload);
        await escalationGrants.createFromApproval({
          companyId: updated.companyId,
          approvalId: updated.id,
          payload,
        });
      }

      let toolGrant: ToolGrantApplyResult | null = null;
      if (applied && isToolGrantApproval(updated)) {
        // Approving a tool_grant is the operator's explicit, named grant --
        // this is the only place a new tool connection (adapterConfig.mcpServers
        // entry) is ever actually applied for an agent-requested grant; nothing
        // takes effect just because the agent asked. Mirrors how hire_agent
        // above is the only place a pending-approval agent actually activates.
        const payload = toolGrantRequestPayloadSchema.parse(updated.payload);
        const targetAgent = await agentsSvc.getById(payload.agentId);
        if (targetAgent) {
          const existingAdapterConfig =
            targetAgent.adapterConfig && typeof targetAgent.adapterConfig === "object"
              && !Array.isArray(targetAgent.adapterConfig)
              ? (targetAgent.adapterConfig as Record<string, unknown>)
              : {};
          const existingServers = Array.isArray(existingAdapterConfig.mcpServers)
            ? (existingAdapterConfig.mcpServers as unknown[])
            : [];
          const nextServers = [
            ...existingServers.filter((server) => {
              const summary = summarizeMcpServer(server);
              return !summary || summary.name !== payload.server.name;
            }),
            payload.server,
          ];
          await agentsSvc.update(
            targetAgent.id,
            { adapterConfig: { ...existingAdapterConfig, mcpServers: nextServers } },
            { recordRevision: { createdByUserId: decidedByUserId, source: "tool_grant_approval" } },
          );
          const summary = summarizeMcpServer(payload.server) ?? {
            name: payload.server.name,
            kind: "command" as const,
            target: payload.server.command ?? payload.server.url ?? "",
          };
          toolGrant = {
            agentId: targetAgent.id,
            companyId: targetAgent.companyId,
            serverName: payload.server.name,
            capability: describeToolCapability(summary),
          };
        }
      }

      let instructionsChange: InstructionsChangeApplyResult | null = null;
      if (applied && isInstructionsChangeApproval(updated)) {
        // This is the ONLY place a boss-proposed instructions change is
        // actually applied -- proposing never writes anything (OPERATOR
        // RULING 2/3, DUR-69). Both the proposer and this approver are named
        // on the agent_instructions_revisions row the operator ruling
        // requires, distinct from agent_config_revisions which only ever
        // names a single actor for a given write.
        const payload = instructionsChangeRequestPayloadSchema.parse(updated.payload);
        const targetAgent = await agentsSvc.getById(payload.agentId);
        if (targetAgent) {
          const written = await instructionsSvc.writeFile(targetAgent, payload.relativePath, payload.afterContent);
          await agentsSvc.update(
            targetAgent.id,
            { adapterConfig: written.adapterConfig, instructionsReviewedAt: now },
            {
              recordRevision: {
                createdByUserId: decidedByUserId,
                source: "instructions_change_approval",
              },
            },
          );
          await db.insert(agentInstructionsRevisions).values({
            companyId: updated.companyId,
            agentId: targetAgent.id,
            approvalId: updated.id,
            proposedByAgentId: updated.requestedByAgentId,
            approvedByUserId: decidedByUserId,
            reason: payload.reason,
            relativePath: payload.relativePath,
            beforeContent: payload.beforeContent,
            afterContent: payload.afterContent,
          });
          instructionsChange = {
            agentId: targetAgent.id,
            companyId: targetAgent.companyId,
            relativePath: payload.relativePath,
            proposedByAgentId: updated.requestedByAgentId,
          };
        }
      }

      return { approval: updated, applied, toolGrant, instructionsChange };
    },

    reject: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const { approval: updated, applied } = await resolveApproval(
        id,
        "rejected",
        decidedByUserId,
        decisionNote,
      );

      if (applied && updated.type === "hire_agent") {
        const payload = updated.payload as Record<string, unknown>;
        const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
        if (payloadAgentId) {
          await agentsSvc.terminate(payloadAgentId);
        }
      }

      return { approval: updated, applied };
    },

    requestRevision: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "pending") {
        throw unprocessable("Only pending approvals can request revision");
      }

      const now = new Date();
      return db
        .update(approvals)
        .set({
          status: "revision_requested",
          decidedByUserId,
          decisionNote: decisionNote ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(approvals.id, id))
        .returning()
        .then((rows) => rows[0]);
    },

    resubmit: async (id: string, payload?: Record<string, unknown>) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "revision_requested") {
        throw unprocessable("Only revision requested approvals can be resubmitted");
      }

      const now = new Date();
      return db
        .update(approvals)
        .set({
          status: "pending",
          payload: payload ?? existing.payload,
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
          updatedAt: now,
        })
        .where(eq(approvals.id, id))
        .returning()
        .then((rows) => rows[0]);
    },

    // DUR-141: the requesting agent's own self-serve way to kill a
    // not-yet-decided approval it filed (e.g. a duplicate merge_pr request
    // whose PR was since closed) without needing a board actor to reject it.
    // Reuses the "cancelled" terminal status, which existed in
    // APPROVAL_STATUSES but was never actually set anywhere before this.
    withdraw: async (id: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);
      if (!canResolveStatuses.has(existing.status)) {
        throw unprocessable("Only pending or revision requested approvals can be withdrawn");
      }

      const now = new Date();
      const updated = await db
        .update(approvals)
        .set({
          status: "cancelled",
          decisionNote: decisionNote ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(and(eq(approvals.id, id), inArray(approvals.status, resolvableStatuses)))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!updated) {
        throw unprocessable("Only pending or revision requested approvals can be withdrawn");
      }
      return updated;
    },

    listComments: async (approvalId: string) => {
      const existing = await getExistingApproval(approvalId);
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      return db
        .select()
        .from(approvalComments)
        .where(
          and(
            eq(approvalComments.approvalId, approvalId),
            eq(approvalComments.companyId, existing.companyId),
          ),
        )
        .orderBy(asc(approvalComments.createdAt))
        .then((comments) => comments.map((comment) => redactApprovalComment(comment, censorUsernameInLogs)));
    },

    addComment: async (
      approvalId: string,
      body: string,
      actor: { agentId?: string; userId?: string },
    ) => {
      const existing = await getExistingApproval(approvalId);
      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };
      const redactedBody = redactCurrentUserText(body, currentUserRedactionOptions);
      return db
        .insert(approvalComments)
        .values({
          companyId: existing.companyId,
          approvalId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          body: redactedBody,
        })
        .returning()
        .then((rows) => redactApprovalComment(rows[0], currentUserRedactionOptions.enabled));
    },
  };
}
