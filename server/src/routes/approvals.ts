import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { companies, heartbeatRuns, issues, projects, type Db } from "@paperclipai/db";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  deployRequestPayloadSchema,
  formatApprovalTechnicalReference,
  formatApprovalTitle,
  modelBoostRequestPayloadSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  approvalService,
  accessService,
  escalationGrantService,
  heartbeatService,
  issueApprovalService,
  issueThreadInteractionService,
  logActivity,
  secretService,
} from "../services/index.js";
import { resolveProjectDeployBranches, type ProjectDeployBranches } from "../services/deploy-branches.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { redactEventPayload } from "../redaction.js";
import { unprocessable } from "../errors.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { isStatusOnlyCheapRecoveryContext } from "../services/recovery/model-profile-hint.js";
import { recordCheapRunEscalation } from "../services/recovery/cheap-run-escalation.js";

function redactApprovalPayload<T extends { payload: Record<string, unknown> }>(approval: T): T {
  return {
    ...approval,
    payload: redactEventPayload(approval.payload) ?? {},
  };
}

/**
 * `request_board_approval` approvals whose payload carries `kind:"deploy"` follow
 * the deploy-request convention (see deploy-poller.sh) and must validate against
 * deployRequestPayloadSchema before an operator ever sees them.
 */
function isDeployRequestApproval(type: unknown, payload: Record<string, unknown>) {
  return type === "request_board_approval" && payload.kind === "deploy";
}

/**
 * `request_board_approval` approvals whose payload carries `kind:"model_boost"`
 * follow the temporary model/effort escalation convention (DUR-31) and must
 * validate against modelBoostRequestPayloadSchema before an operator sees them.
 */
function isModelBoostRequestApproval(type: unknown, payload: Record<string, unknown>) {
  return type === "request_board_approval" && payload.kind === "model_boost";
}

/**
 * `request_board_approval` approvals whose payload carries `kind:"merge_pr"`
 * ask an operator to merge a pull request. DUR-40: a merge approval targeting
 * a project's declared upstream-mirror branch (read-only, never deployed)
 * must be refused before it ever reaches the operator — see DUR-38/DUR-39,
 * where an approval worded "merges this into master" was approved exactly as
 * filed and the feature it shipped never went live.
 */
function isMergePrRequestApproval(type: unknown, payload: Record<string, unknown>) {
  return type === "request_board_approval" && payload.kind === "merge_pr";
}

/**
 * Resolve the plain-words label an operator-facing approval title should lead
 * with: the linked issue's project name, falling back to the company name.
 * Never the repository slug — see DUR-24.
 */
async function resolveApprovalProjectLabel(db: Db, companyId: string, issueIds: string[]) {
  for (const issueId of issueIds) {
    const issueRow = await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!issueRow?.projectId) continue;
    const projectRow = await db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, issueRow.projectId))
      .then((rows) => rows[0] ?? null);
    if (projectRow?.name) return projectRow.name;
  }
  const companyRow = await db
    .select({ name: companies.name })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  return companyRow?.name ?? "Paperclip";
}

/**
 * `request_board_approval` is the type agents use to file merge/deploy/etc.
 * approvals by hand. Rewrite the title through the shared formatter so the
 * "<project> — <what this does>" convention can't drift per agent, and lift
 * any technical PR/branch/commit fields into a separate secondary field
 * instead of leaving them in the headline.
 */
/**
 * DUR-40 item 2: state the branch's consequence in plain words, in the text
 * an operator actually reads — not a bare branch name (that's the DUR-38/39
 * defect: "merges this into master" was true and still misleading, because
 * nothing said what "master" meant). Always computed and applied by the
 * system regardless of what the filing agent wrote or omitted — an operator
 * can't be the last line of defence against wording an agent happened to
 * choose (or forgot to include: unlike the earlier draft of this function,
 * this always sets `plainSummary` when we know something worth saying, even
 * if the agent never supplied one at all).
 */
function appendMergeConsequenceSentence(
  payload: Record<string, unknown>,
  deployBranches: ProjectDeployBranches | null,
) {
  if (payload.kind !== "merge_pr") return;
  const base = typeof payload.base === "string" ? payload.base.trim() : "";
  if (!base || !deployBranches?.deployBranch) return;

  const consequence =
    base === deployBranches.deployBranch
      ? `This goes to "${deployBranches.deployBranch}", the branch we deploy from. Approving the ` +
        "merge does not deploy it by itself — a separate deploy approval is still required before it goes live."
      : `This will land on "${base}", not "${deployBranches.deployBranch}" (the branch we deploy ` +
        "from) — confirm that is where you intend it before approving.";

  const existing = typeof payload.plainSummary === "string" ? payload.plainSummary.trim() : "";
  if (existing.includes(consequence)) return;
  payload.plainSummary = existing ? `${existing}\n\n${consequence}` : consequence;
}

async function normalizeRequestBoardApprovalPayload(
  db: Db,
  companyId: string,
  issueIds: string[],
  payload: Record<string, unknown>,
  mergePrDeployBranches: ProjectDeployBranches | null = null,
) {
  appendMergeConsequenceSentence(payload, mergePrDeployBranches);
  if (typeof payload.title !== "string" || !payload.title.trim()) return payload;
  const projectLabel = await resolveApprovalProjectLabel(db, companyId, issueIds);
  payload.title = formatApprovalTitle(projectLabel, payload.title);
  if (!payload.technicalReference) {
    const technicalReference = formatApprovalTechnicalReference({
      repo: typeof payload.repo === "string" ? payload.repo : null,
      prNumber:
        typeof payload.prNumber === "number" || typeof payload.prNumber === "string"
          ? payload.prNumber
          : null,
      branch: typeof payload.branch === "string" ? payload.branch : null,
      base: typeof payload.base === "string" ? payload.base : null,
      commit: typeof payload.commit === "string" ? payload.commit : null,
    });
    if (technicalReference) payload.technicalReference = technicalReference;
  }
  return payload;
}

async function firstLinkedIssueId(
  issueApprovalsSvc: { listIssuesForApproval: (approvalId: string) => Promise<Array<{ id: string }>> },
  approvalId: string,
): Promise<string | null> {
  const linked = await issueApprovalsSvc.listIssuesForApproval(approvalId);
  return Array.isArray(linked) ? linked[0]?.id ?? null : null;
}

function readIssueIdForEscalation(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const rawIssueIds = (body as Record<string, unknown>).issueIds;
  if (!Array.isArray(rawIssueIds)) return null;
  const first = rawIssueIds.find((value): value is string => typeof value === "string" && value.length > 0);
  return first ?? null;
}

function describeApprovalMutationForEscalation(body: unknown): string {
  if (body && typeof body === "object") {
    const payload = (body as Record<string, unknown>).payload;
    const kind = payload && typeof payload === "object" ? (payload as Record<string, unknown>).kind : undefined;
    if (typeof kind === "string" && kind) return `file a "${kind}" approval`;
  }
  return "file an approval";
}

export function approvalRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const svc = approvalService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const issueApprovalsSvc = issueApprovalService(db);
  const interactionsSvc = issueThreadInteractionService(db);
  const secretsSvc = secretService(db);
  const escalationGrantsSvc = escalationGrantService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  async function requireApprovalAccess(req: Request, id: string) {
    const approval = await svc.getById(id);
    if (!approval) {
      return null;
    }
    assertCompanyAccess(req, approval.companyId);
    return approval;
  }

  async function assertApprovalAccessAllowed(req: Request, res: any, companyId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Approvals are outside this actor's authorization boundary" });
    return false;
  }

  async function assertApprovalMutationAllowedByRunContext(
    req: Request,
    res: any,
    companyId: string,
    opts: {
      describeBlockedAction?: () => string;
      resolveIssueId?: () => Promise<string | null>;
    } = {},
  ) {
    if (req.actor.type !== "agent") return true;
    const runId = req.actor.runId?.trim();
    if (!runId || !req.actor.agentId) return true;

    const run = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run || run.companyId !== companyId || run.agentId !== req.actor.agentId) return true;
    if (!isStatusOnlyCheapRecoveryContext(run.contextSnapshot)) return true;

    // DUR-45: this cheap run genuinely cannot take this action, but the issue
    // must not be left to rot -- hand the action to a normal-model run on the
    // same issue instead of just refusing and hoping the agent finds another way.
    const issueId = opts.resolveIssueId
      ? await opts.resolveIssueId()
      : readIssueIdForEscalation(req.body);
    let escalation: Awaited<ReturnType<typeof recordCheapRunEscalation>> | null = null;
    if (issueId) {
      escalation = await recordCheapRunEscalation(db, heartbeat.wakeup, {
        companyId,
        issueId,
        agentId: run.agentId,
        sourceRunId: run.id,
        blockedAction: (opts.describeBlockedAction ?? (() => "create or modify an approval"))(),
      });
    }

    res.status(403).json({
      error: "Cheap status-only recovery runs cannot create or modify approvals",
      details: {
        companyId,
        runId: run.id,
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        resumeRequiresNormalModel: true,
        escalation,
      },
    });
    return false;
  }

  router.get("/companies/:companyId/approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertApprovalAccessAllowed(req, res, companyId))) return;
    const status = req.query.status as string | undefined;
    const result = await svc.list(companyId, status);
    res.json(result.map((approval) => redactApprovalPayload(approval)));
  });

  router.get("/approvals/:id", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    if (!(await assertApprovalAccessAllowed(req, res, approval.companyId))) return;
    res.json(redactApprovalPayload(approval));
  });

  router.post("/companies/:companyId/approvals", validate(createApprovalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertApprovalAccessAllowed(req, res, companyId))) return;
    if (
      !(await assertApprovalMutationAllowedByRunContext(req, res, companyId, {
        describeBlockedAction: () => describeApprovalMutationForEscalation(req.body),
      }))
    ) return;
    const rawIssueIds = req.body.issueIds;
    const issueIds = Array.isArray(rawIssueIds)
      ? rawIssueIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const uniqueIssueIds = Array.from(new Set(issueIds));
    const { issueIds: _issueIds, ...approvalInput } = req.body;
    const actor = getActorInfo(req);
    if (isDeployRequestApproval(approvalInput.type, approvalInput.payload)) {
      deployRequestPayloadSchema.parse(approvalInput.payload);
    }
    if (isModelBoostRequestApproval(approvalInput.type, approvalInput.payload)) {
      const boostPayload = modelBoostRequestPayloadSchema.parse(approvalInput.payload);
      const requestingAgentId =
        approvalInput.requestedByAgentId ?? (actor.actorType === "agent" ? actor.actorId : null);
      if (actor.actorType === "agent" && actor.actorId !== boostPayload.agentId) {
        res.status(403).json({ error: "An agent can only request a boost for itself" });
        return;
      }
      if (!requestingAgentId) {
        res.status(422).json({ error: "A boost request must be filed by the requesting agent" });
        return;
      }
      await escalationGrantsSvc.assertRequestAllowed({
        companyId,
        issueId: boostPayload.issueId,
        agentId: boostPayload.agentId,
        reason: boostPayload.reason,
      });
    }
    let mergePrDeployBranches: ProjectDeployBranches | null = null;
    if (isMergePrRequestApproval(approvalInput.type, approvalInput.payload)) {
      const base =
        typeof approvalInput.payload.base === "string" ? approvalInput.payload.base.trim() : "";
      if (base) {
        mergePrDeployBranches = await resolveProjectDeployBranches(db, uniqueIssueIds);
        if (mergePrDeployBranches?.mirrorBranch && base === mergePrDeployBranches.mirrorBranch) {
          const correctBranch = mergePrDeployBranches.deployBranch ?? "the branch we deploy from";
          throw unprocessable(
            `"${base}" is a read-only mirror of the upstream project and is never deployed — merging there will not ship this change. File the merge approval with base "${correctBranch}" instead.`,
            { base, mirrorBranch: mergePrDeployBranches.mirrorBranch, deployBranch: mergePrDeployBranches.deployBranch },
          );
        }
      }
    }
    let normalizedPayload =
      approvalInput.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            companyId,
            approvalInput.payload,
            { strictMode: strictSecretsMode },
          )
        : approvalInput.payload;
    if (approvalInput.type === "request_board_approval") {
      normalizedPayload = await normalizeRequestBoardApprovalPayload(
        db,
        companyId,
        uniqueIssueIds,
        normalizedPayload,
        mergePrDeployBranches,
      );
    }

    const approval = await svc.create(companyId, {
      ...approvalInput,
      payload: normalizedPayload,
      requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
      requestedByAgentId:
        approvalInput.requestedByAgentId ?? (actor.actorType === "agent" ? actor.actorId : null),
      status: "pending",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    if (uniqueIssueIds.length > 0) {
      await issueApprovalsSvc.linkManyForApproval(approval.id, uniqueIssueIds, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.created",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type, issueIds: uniqueIssueIds },
    });

    res.status(201).json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/issues", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    if (!(await assertApprovalAccessAllowed(req, res, approval.companyId))) return;
    const issues = await issueApprovalsSvc.listIssuesForApproval(id);
    res.json(issues);
  });

  router.post("/approvals/:id/approve", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await requireApprovalAccess(req, id))) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const decidedByUserId = req.actor.userId ?? "board";
    const { approval, applied } = await svc.approve(id, decidedByUserId, req.body.decisionNote);

    if (applied) {
      // DUR-29: an agent may have raised a request_confirmation for the same decision as
      // this approval — resolve it now so the operator doesn't have to answer it separately.
      await interactionsSvc.resolveInteractionsLinkedToApproval(approval, {
        agentId: null,
        userId: req.actor.userId ?? "board",
      });

      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);
      const primaryIssueId = linkedIssueIds[0] ?? null;

      // DUR-40 item 4: whether this merge_pr approval eventually needs a
      // "no deploy approval followed" note on its issue is checked later by
      // mergeDeployVisibilityService's scheduled tick (server/src/index.ts),
      // not here. Checking synchronously at approval time would be wrong: a
      // deploy approval can only be filed AFTER a merge is approved, so an
      // immediate check would flag every single normal merge, not just the
      // ones that were actually forgotten.

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.approved",
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: approval.type,
          requestedByAgentId: approval.requestedByAgentId,
          linkedIssueIds,
        },
      });

      if (approval.requestedByAgentId) {
        try {
          const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "approval_approved",
            payload: {
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
            },
            requestedByActorType: "user",
            requestedByActorId: req.actor.userId ?? "board",
            contextSnapshot: {
              source: "approval.approved",
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
              taskId: primaryIssueId,
              wakeReason: "approval_approved",
            },
          });

          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.requester_wakeup_queued",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              wakeRunId: wakeRun?.id ?? null,
              linkedIssueIds,
            },
          });
        } catch (err) {
          logger.warn(
            {
              err,
              approvalId: approval.id,
              requestedByAgentId: approval.requestedByAgentId,
            },
            "failed to queue requester wakeup after approval",
          );
          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.requester_wakeup_failed",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              linkedIssueIds,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post("/approvals/:id/reject", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await requireApprovalAccess(req, id))) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const decidedByUserId = req.actor.userId ?? "board";
    const { approval, applied } = await svc.reject(id, decidedByUserId, req.body.decisionNote);

    if (applied) {
      // DUR-29: resolve any request_confirmation linked to this approval too.
      await interactionsSvc.resolveInteractionsLinkedToApproval(approval, {
        agentId: null,
        userId: req.actor.userId ?? "board",
      });

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.rejected",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post(
    "/approvals/:id/request-revision",
    validate(requestApprovalRevisionSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      if (!(await requireApprovalAccess(req, id))) {
        res.status(404).json({ error: "Approval not found" });
        return;
      }
      const decidedByUserId = req.actor.userId ?? "board";
      const approval = await svc.requestRevision(id, decidedByUserId, req.body.decisionNote);

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.revision_requested",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });

      res.json(redactApprovalPayload(approval));
    },
  );

  router.post("/approvals/:id/resubmit", validate(resubmitApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (
      !(await assertApprovalMutationAllowedByRunContext(req, res, existing.companyId, {
        describeBlockedAction: () => "resubmit an approval",
        resolveIssueId: () => firstLinkedIssueId(issueApprovalsSvc, existing.id),
      }))
    ) return;

    if (req.actor.type === "agent" && req.actor.agentId !== existing.requestedByAgentId) {
      res.status(403).json({ error: "Only requesting agent can resubmit this approval" });
      return;
    }

    if (req.body.payload && isDeployRequestApproval(existing.type, req.body.payload)) {
      deployRequestPayloadSchema.parse(req.body.payload);
    }
    const normalizedPayload = req.body.payload
      ? existing.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            existing.companyId,
            req.body.payload,
            { strictMode: strictSecretsMode },
          )
        : req.body.payload
      : undefined;
    const approval = await svc.resubmit(id, normalizedPayload);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.resubmitted",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });
    res.json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const comments = await svc.listComments(id);
    res.json(comments);
  });

  router.post("/approvals/:id/comments", validate(addApprovalCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    if (
      !(await assertApprovalMutationAllowedByRunContext(req, res, approval.companyId, {
        describeBlockedAction: () => "comment on an approval",
        resolveIssueId: () => firstLinkedIssueId(issueApprovalsSvc, approval.id),
      }))
    ) return;
    const actor = getActorInfo(req);
    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.comment_added",
      entityType: "approval",
      entityId: approval.id,
      details: { commentId: comment.id },
    });

    res.status(201).json(comment);
  });

  return router;
}
