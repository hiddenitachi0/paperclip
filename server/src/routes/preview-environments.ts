import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { isPreviewableApprovalPayload } from "@paperclipai/shared";
import { approvalService, issueApprovalService } from "../services/index.js";
import { previewEnvironmentService, type PreviewEnvironmentService, type PreviewApprovalContext } from "../services/preview-environments.js";
import { companyScope } from "../middleware/company-scope.js";
import { notFound, unprocessable } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/**
 * "Preview this before approving" — the three things the approval card needs:
 * ask what is running, start one, throw it away.
 *
 * Every route here is operator-only (`assertBoard`). An agent must never be
 * able to start a process from an approval it filed itself, so there is no
 * agent path into any of this.
 */
export function previewEnvironmentRoutes(
  rawDb: Db,
  opts: { service?: PreviewEnvironmentService } = {},
) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = approvalService(db);
  const rawSvc = approvalService(rawDb);
  const issueApprovals = issueApprovalService(db);
  const previews = opts.service ?? previewEnvironmentService(rawDb);

  const scopeFromApproval = companyScope(rawDb, async (req) => {
    // Operator check first: a caller who may not use previews at all must not
    // learn from the response whether an approval id exists.
    assertBoard(req);
    const approval = await rawSvc.getById(req.params.id as string);
    if (!approval) throw notFound("Approval not found");
    assertCompanyAccess(req, approval.companyId);
    return approval.companyId;
  });

  /**
   * Which project a card's code belongs to. A deploy card names it outright; a
   * merge card is reached through the tasks it is filed against.
   */
  async function resolveContext(req: Request): Promise<PreviewApprovalContext> {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) throw notFound("Approval not found");
    const payload = (approval.payload ?? {}) as Record<string, unknown>;
    if (!isPreviewableApprovalPayload(approval.type, payload)) {
      throw unprocessable("Only a merge or a deploy card has code to look at.");
    }

    let projectId = typeof payload.projectId === "string" ? payload.projectId : null;
    if (!projectId) {
      const linked = await issueApprovals.listIssuesForApproval(id);
      projectId = linked.find((issue) => typeof issue.projectId === "string")?.projectId ?? null;
    }

    return {
      approvalId: id,
      companyId: approval.companyId,
      type: approval.type,
      payload,
      projectId,
    };
  }

  router.get("/approvals/:id/preview", scopeFromApproval, async (req, res) => {
    const context = await resolveContext(req);
    res.json(await previews.describeForApproval(context));
  });

  router.post("/approvals/:id/preview", scopeFromApproval, async (req, res) => {
    const context = await resolveContext(req);
    const started = await previews.start(context);
    if (!started.ok) {
      res.status(422).json({ error: started.reason });
      return;
    }
    const view = await previews.describeForApproval(context);
    res.status(202).json(view);
  });

  router.delete("/approvals/:id/preview", scopeFromApproval, async (req, res) => {
    const context = await resolveContext(req);
    await previews.stopForApproval(context.approvalId, "preview_stopped_by_operator");
    res.json(await previews.describeForApproval(context));
  });

  return router;
}
