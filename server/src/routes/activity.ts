import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb, runInCompanyScope } from "@paperclipai/db";
import { normalizeIssueIdentifier } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { activityService, normalizeActivityLimit } from "../services/activity.js";
import { assertAuthenticated, assertBoard, assertCompanyAccess } from "./authz.js";
import { accessService, heartbeatService, issueService } from "../services/index.js";
import { sanitizeRecord } from "../redaction.js";
import { companyScope, companyScopeFromParam } from "../middleware/company-scope.js";
import { notFound } from "../errors.js";

const createActivitySchema = z.object({
  actorType: z.enum(["agent", "user", "system", "plugin"]).optional().default("system"),
  actorId: z.string().min(1),
  action: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  agentId: z.string().uuid().optional().nullable(),
  details: z.record(z.unknown()).optional().nullable(),
});

export function activityRoutes(rawDb: Db) {
  const router = Router();
  // DUR-348 (DUR-277 Wave 2): this file's own request-scoped instance; rawDb
  // stays unwrapped for the pre-scope issue/run lookups the (b)-category
  // routes below need before their companyId is known. See
  // middleware/company-scope.ts.
  const db = createRequestScopedDb(rawDb);
  const svc = activityService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db);
  const issueSvc = issueService(db);
  const rawIssueSvc = issueService(rawDb);
  const rawHeartbeat = heartbeatService(rawDb);

  async function assertCompanyScopeReadAllowed(req: Parameters<typeof assertCompanyAccess>[0], res: any, companyId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Activity is outside this actor's authorization boundary" });
    return false;
  }

  async function assertIssueReadAllowed(req: Parameters<typeof assertCompanyAccess>[0], res: any, issue: {
    id: string;
    companyId: string;
    projectId: string | null;
    parentId: string | null;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
    status: string;
  }) {
    const decision = await access.decide({
      actor: req.actor,
      action: "issue:read",
      resource: {
        type: "issue",
        companyId: issue.companyId,
        issueId: issue.id,
        projectId: issue.projectId,
        parentIssueId: issue.parentId,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        status: issue.status,
      },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Issue activity is outside this actor's authorization boundary" });
    return false;
  }

  async function resolveIssueByRef(svc: typeof issueSvc, rawId: string) {
    const identifier = normalizeIssueIdentifier(rawId);
    if (identifier) {
      return svc.getByIdentifier(identifier);
    }
    return svc.getById(rawId);
  }

  function scopeFromIssueIdParam(idParam: string) {
    return companyScope(rawDb, async (req) => {
      const issue = await resolveIssueByRef(rawIssueSvc, req.params[idParam] as string);
      if (!issue) throw notFound("Issue not found");
      assertCompanyAccess(req, issue.companyId);
      return issue.companyId;
    });
  }

  router.get(
    "/companies/:companyId/activity",
    companyScopeFromParam(rawDb, assertCompanyAccess),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      if (!(await assertCompanyScopeReadAllowed(req, res, companyId))) return;

      const filters = {
        companyId,
        agentId: req.query.agentId as string | undefined,
        entityType: req.query.entityType as string | undefined,
        entityId: req.query.entityId as string | undefined,
        limit: normalizeActivityLimit(Number(req.query.limit)),
      };
      const result = await svc.list(filters);
      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/activity",
    companyScope(rawDb, (req) => {
      assertBoard(req);
      const value = req.params.companyId;
      if (typeof value !== "string") return undefined;
      assertCompanyAccess(req, value);
      return value;
    }),
    validate(createActivitySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const event = await svc.create({
        companyId,
        ...req.body,
        details: req.body.details ? sanitizeRecord(req.body.details) : null,
      });
      res.status(201).json(event);
    },
  );

  router.get("/issues/:id/activity", scopeFromIssueIdParam("id"), async (req, res) => {
    const rawId = req.params.id as string;
    const issue = await resolveIssueByRef(issueSvc, rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const result = await svc.forIssue(issue.id);
    res.json(result);
  });

  router.get("/issues/:id/runs", scopeFromIssueIdParam("id"), async (req, res) => {
    const rawId = req.params.id as string;
    const issue = await resolveIssueByRef(issueSvc, rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const result = await svc.runsForIssue(issue.companyId, issue.id);
    res.json(result);
  });

  // Not wired through companyScope: a missing run replies 200 [] with no
  // company to scope by at all (existing behavior, kept as-is), so scope is
  // only established in the branch where a run -- and therefore a
  // companyId -- actually exists.
  router.get("/heartbeat-runs/:runId/issues", async (req, res) => {
    assertAuthenticated(req);
    const runId = req.params.runId as string;
    const run = await rawHeartbeat.getRun(runId);
    if (!run) {
      res.json([]);
      return;
    }
    assertCompanyAccess(req, run.companyId);
    await runInCompanyScope(rawDb, run.companyId, async () => {
      if (!(await assertCompanyScopeReadAllowed(req, res, run.companyId))) return;
      const result = await svc.issuesForRun(runId);
      res.json(result);
    });
  });

  return router;
}
