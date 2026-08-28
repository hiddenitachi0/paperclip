import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import {
  createCostEventSchema,
  createFinanceEventSchema,
  normalizeIssueIdentifier,
  resolveBudgetIncidentSchema,
  updateBudgetSchema,
  upsertBudgetPolicySchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  budgetService,
  costService,
  financeService,
  companyService,
  agentService,
  issueService,
  heartbeatService,
  accessService,
  logActivity,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { fetchAllQuotaWindows } from "../services/quota-windows.js";
import { badRequest, notFound } from "../errors.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { companyScope, companyScopeFromParam } from "../middleware/company-scope.js";

export function parseCostDateRange(query: Record<string, unknown>) {
  const fromRaw = query.from as string | undefined;
  const toRaw = query.to as string | undefined;
  const from = fromRaw ? new Date(fromRaw) : undefined;
  const to = toRaw ? new Date(toRaw) : undefined;
  if (from && isNaN(from.getTime())) throw badRequest("invalid 'from' date");
  if (to && isNaN(to.getTime())) throw badRequest("invalid 'to' date");
  return (from || to) ? { from, to } : undefined;
}

export function parseCostLimit(query: Record<string, unknown>) {
  const raw = Array.isArray(query.limit) ? query.limit[0] : query.limit;
  if (raw == null || raw === "") return 100;
  const limit = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(limit) || limit <= 0 || limit > 500) {
    throw badRequest("invalid 'limit' value");
  }
  return limit;
}

export function costRoutes(
  rawDb: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  // DUR-348 (DUR-277 Wave 2): this file's own request-scoped instance; rawDb
  // stays unwrapped for the pre-scope issue/agent lookups the (b)-category
  // routes below need before their companyId is known. See
  // middleware/company-scope.ts.
  const db = createRequestScopedDb(rawDb);
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const budgetHooks = {
    cancelWorkForScope: heartbeat.cancelBudgetScopeWork,
  };
  const costs = costService(db, budgetHooks);
  const finance = financeService(db);
  const budgets = budgetService(db, budgetHooks);
  const companies = companyService(db);
  const agents = agentService(db);
  const issues = issueService(db);
  const access = accessService(db);
  const rawIssues = issueService(rawDb);
  const rawAgents = agentService(rawDb);

  async function resolveIssueByRef(svc: typeof issues, rawId: string) {
    const identifier = normalizeIssueIdentifier(rawId);
    if (identifier) {
      return svc.getByIdentifier(identifier);
    }
    return svc.getById(rawId);
  }

  async function assertCompanyCostReadAllowed(req: Parameters<typeof assertCompanyAccess>[0], res: any, companyId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Costs are outside this actor's authorization boundary" });
    return false;
  }

  async function assertIssueCostReadAllowed(req: Parameters<typeof assertCompanyAccess>[0], res: any, issue: {
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
    res.status(403).json({ error: "Issue costs are outside this actor's authorization boundary" });
    return false;
  }

  router.post(
    "/companies/:companyId/cost-events",
    companyScopeFromParam(rawDb, assertCompanyAccess),
    validate(createCostEventSchema),
    async (req, res) => {
    const companyId = req.params.companyId as string;

    if (req.actor.type === "agent" && req.actor.agentId !== req.body.agentId) {
      res.status(403).json({ error: "Agent can only report its own costs" });
      return;
    }

    const event = await costs.createEvent(companyId, {
      ...req.body,
      occurredAt: new Date(req.body.occurredAt),
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "cost.reported",
      entityType: "cost_event",
      entityId: event.id,
      details: { costCents: event.costCents, model: event.model },
    });

    res.status(201).json(event);
    },
  );

  router.post(
    "/companies/:companyId/finance-events",
    companyScopeFromParam(rawDb, assertCompanyAccess),
    validate(createFinanceEventSchema),
    async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);

    const event = await finance.createEvent(companyId, {
      ...req.body,
      occurredAt: new Date(req.body.occurredAt),
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "finance_event.reported",
      entityType: "finance_event",
      entityId: event.id,
      details: {
        amountCents: event.amountCents,
        biller: event.biller,
        eventKind: event.eventKind,
        direction: event.direction,
      },
    });

    res.status(201).json(event);
    },
  );

  router.get(
    "/companies/:companyId/costs/summary",
    companyScopeFromParam(rawDb, assertCompanyAccess),
    async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const summary = await costs.summary(companyId, range);
    res.json(summary);
    },
  );

  router.get(
    "/issues/:id/cost-summary",
    companyScope(rawDb, async (req) => {
      const issue = await resolveIssueByRef(rawIssues, req.params.id as string);
      if (!issue) throw notFound("Issue not found");
      assertCompanyAccess(req, issue.companyId);
      return issue.companyId;
    }),
    async (req, res) => {
    const rawId = req.params.id as string;
    const issue = await resolveIssueByRef(issues, rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertIssueCostReadAllowed(req, res, issue))) return;
    const excludeRoot = req.query.excludeRoot === "true" || req.query.excludeRoot === "1";
    const summary = await costs.issueTreeSummary(issue.companyId, issue.id, { excludeRoot });
    res.json(summary);
    },
  );

  router.get(
    "/companies/:companyId/costs/by-agent",
    companyScopeFromParam(rawDb, assertCompanyAccess),
    async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const rows = await costs.byAgent(companyId, range);
    res.json(rows);
    },
  );

  router.get(
    "/companies/:companyId/costs/by-agent-model",
    companyScopeFromParam(rawDb, assertCompanyAccess),
    async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const rows = await costs.byAgentModel(companyId, range);
    res.json(rows);
    },
  );

  router.get(
    "/companies/:companyId/costs/by-provider",
    companyScopeFromParam(rawDb, assertCompanyAccess),
    async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const rows = await costs.byProvider(companyId, range);
    res.json(rows);
    },
  );

  router.get(
    "/companies/:companyId/costs/by-biller",
    companyScopeFromParam(rawDb, assertCompanyAccess),
    async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const rows = await costs.byBiller(companyId, range);
    res.json(rows);
    },
  );

  router.get(
    "/companies/:companyId/costs/finance-summary",
    companyScopeFromParam(rawDb, assertCompanyAccess),
    async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const summary = await finance.summary(companyId, range);
    res.json(summary);
    },
  );

  router.get(
    "/companies/:companyId/costs/finance-by-biller",
    companyScopeFromParam(rawDb, assertCompanyAccess),
    async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const rows = await finance.byBiller(companyId, range);
    res.json(rows);
    },
  );

  router.get(
    "/companies/:companyId/costs/finance-by-kind",
    companyScopeFromParam(rawDb, assertCompanyAccess),
    async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const rows = await finance.byKind(companyId, range);
    res.json(rows);
    },
  );

  router.get(
    "/companies/:companyId/costs/finance-events",
    companyScopeFromParam(rawDb, assertCompanyAccess),
    async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const limit = parseCostLimit(req.query);
    const rows = await finance.list(companyId, range, limit);
    res.json(rows);
    },
  );

  router.get(
    "/companies/:companyId/costs/window-spend",
    companyScopeFromParam(rawDb, assertCompanyAccess),
    async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const rows = await costs.windowSpend(companyId);
    res.json(rows);
    },
  );

  router.get(
    "/companies/:companyId/costs/quota-windows",
    companyScopeFromParam(rawDb, assertCompanyAccess),
    async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    // validate companyId resolves to a real company so the "__none__" sentinel
    // and any forged ids are rejected before we touch provider credentials
    const company = await companies.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const results = await fetchAllQuotaWindows();
    res.json(results);
    },
  );

  router.get(
    "/companies/:companyId/budgets/overview",
    companyScopeFromParam(rawDb, assertCompanyAccess),
    async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const overview = await budgets.overview(companyId);
    res.json(overview);
    },
  );

  router.post(
    "/companies/:companyId/budgets/policies",
    companyScope(rawDb, (req) => {
      assertBoard(req);
      const value = req.params.companyId;
      if (typeof value !== "string") return undefined;
      assertCompanyAccess(req, value);
      return value;
    }),
    validate(upsertBudgetPolicySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const summary = await budgets.upsertPolicy(companyId, req.body, req.actor.userId ?? "board");
      res.json(summary);
    },
  );

  router.post(
    "/companies/:companyId/budget-incidents/:incidentId/resolve",
    companyScope(rawDb, (req) => {
      assertBoard(req);
      const value = req.params.companyId;
      if (typeof value !== "string") return undefined;
      assertCompanyAccess(req, value);
      return value;
    }),
    validate(resolveBudgetIncidentSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const incidentId = req.params.incidentId as string;
      const incident = await budgets.resolveIncident(companyId, incidentId, req.body, req.actor.userId ?? "board");
      res.json(incident);
    },
  );

  router.get(
    "/companies/:companyId/costs/by-project",
    companyScopeFromParam(rawDb, assertCompanyAccess),
    async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const rows = await costs.byProject(companyId, range);
    res.json(rows);
    },
  );

  router.patch(
    "/companies/:companyId/budgets",
    companyScope(rawDb, (req) => {
      assertBoard(req);
      const value = req.params.companyId;
      if (typeof value !== "string") return undefined;
      assertCompanyAccess(req, value);
      return value;
    }),
    validate(updateBudgetSchema),
    async (req, res) => {
    const companyId = req.params.companyId as string;
    const company = await companies.update(companyId, { budgetMonthlyCents: req.body.budgetMonthlyCents });
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.budget_updated",
      entityType: "company",
      entityId: companyId,
      details: { budgetMonthlyCents: req.body.budgetMonthlyCents },
    });

    await budgets.upsertPolicy(
      companyId,
      {
        scopeType: "company",
        scopeId: companyId,
        amount: req.body.budgetMonthlyCents,
        windowKind: "calendar_month_utc",
      },
      req.actor.userId ?? "board",
    );

    res.json(company);
    },
  );

  router.patch(
    "/agents/:agentId/budgets",
    companyScope(rawDb, async (req) => {
      const agentId = req.params.agentId as string;
      const agent = await rawAgents.getById(agentId);
      if (!agent) throw notFound("Agent not found");
      assertCompanyAccess(req, agent.companyId);
      assertBoard(req);
      return agent.companyId;
    }),
    validate(updateBudgetSchema),
    async (req, res) => {
    const agentId = req.params.agentId as string;
    const agent = await agents.getById(agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const updated = await agents.update(agentId, { budgetMonthlyCents: req.body.budgetMonthlyCents });
    if (!updated) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: updated.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "agent.budget_updated",
      entityType: "agent",
      entityId: updated.id,
      details: { budgetMonthlyCents: updated.budgetMonthlyCents },
    });

    await budgets.upsertPolicy(
      updated.companyId,
      {
        scopeType: "agent",
        scopeId: updated.id,
        amount: updated.budgetMonthlyCents,
        windowKind: "calendar_month_utc",
      },
      req.actor.type === "board" ? req.actor.userId ?? "board" : null,
    );

    res.json(updated);
    },
  );

  return router;
}
