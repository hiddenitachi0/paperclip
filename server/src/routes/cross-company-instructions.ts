import { Router } from "express";
import { createRequestScopedDb, type Db } from "@paperclipai/db";
import { sendCrossCompanyInstructionSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { crossCompanyInstructionService } from "../services/cross-company-instructions.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { unprocessable } from "../errors.js";

/**
 * Guarded cross-company instruction channel. Two routes, both keyed on the
 * caller's OWN company:
 *
 *   POST /companies/:companyId/cross-company-instructions   send one
 *   GET  /companies/:companyId/cross-company-instructions   sent + received
 *
 * Approving / rejecting happens on the receiving company's ordinary
 * approval routes (routes/approvals.ts), which is where delivery lives.
 * There is no route that reads the other company's side of anything.
 */
export function crossCompanyInstructionRoutes(rawDb: Db) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = crossCompanyInstructionService(db, { rawDb });

  router.post(
    "/companies/:companyId/cross-company-instructions",
    companyScopeFromParam(rawDb, assertCompanyAccess),
    validate(sendCrossCompanyInstructionSchema),
    async (req, res) => {
      const fromCompanyId = req.params.companyId as string;
      const actor = getActorInfo(req);
      // An agent always sends as itself. A board user must say which of
      // the company's agents the instruction is from (the liaison on the
      // other side answers to an agent, not to a person outside its company).
      const fromAgentId =
        actor.actorType === "agent"
          ? actor.actorId
          : (typeof req.query.fromAgentId === "string" ? req.query.fromAgentId : null);
      if (!fromAgentId) {
        throw unprocessable("A board user must name the sending agent with ?fromAgentId=<agent id>");
      }
      const created = await svc.send(fromCompanyId, req.body, {
        actorType: actor.actorType,
        actorId: actor.actorId,
        fromAgentId,
      });
      res.status(201).json(created);
    },
  );

  router.get(
    "/companies/:companyId/cross-company-instructions",
    companyScopeFromParam(rawDb, assertCompanyAccess),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      res.json(await svc.listForCompany(companyId));
    },
  );

  return router;
}
