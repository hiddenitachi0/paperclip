import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { accessService } from "../services/index.js";
import { goalAdoptionService } from "../services/goal-adoption.js";
import { assertCompanyAccess } from "./authz.js";
import { badRequest } from "../errors.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";

/**
 * DUR-375: read-only goal-adoption dashboard routes (current snapshot +
 * daily trend). Mirrors the read-gate pattern used by
 * `routes/costs.ts#assertCompanyCostReadAllowed` -- any actor with
 * `company_scope:read` on the target company can view it (board members and
 * instance admins; not a board-only mutation gate, since nothing here
 * writes).
 */

export function parseGoalAdoptionTrendDays(query: Record<string, unknown>): number | undefined {
  const raw = Array.isArray(query.days) ? query.days[0] : query.days;
  if (raw == null || raw === "") return undefined;
  const days = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(days) || days <= 0 || days > 180) {
    throw badRequest("invalid 'days' value");
  }
  return days;
}

export function goalAdoptionRoutes(rawDb: Db) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const goalAdoption = goalAdoptionService(db);
  const access = accessService(db);

  async function assertCompanyGoalAdoptionReadAllowed(
    req: Parameters<typeof assertCompanyAccess>[0],
    res: import("express").Response,
    companyId: string,
  ) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Goal adoption data is outside this actor's authorization boundary" });
    return false;
  }

  router.get(
    "/companies/:companyId/goal-adoption/snapshot",
    companyScopeFromParam(rawDb, assertCompanyAccess),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      if (!(await assertCompanyGoalAdoptionReadAllowed(req, res, companyId))) return;
      const snapshot = await goalAdoption.snapshot(companyId);
      res.json(snapshot);
    },
  );

  router.get(
    "/companies/:companyId/goal-adoption/trend",
    companyScopeFromParam(rawDb, assertCompanyAccess),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      if (!(await assertCompanyGoalAdoptionReadAllowed(req, res, companyId))) return;
      const days = parseGoalAdoptionTrendDays(req.query);
      const trend = await goalAdoption.trend(companyId, { days });
      res.json(trend);
    },
  );

  return router;
}
