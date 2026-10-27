import { Router, type NextFunction, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import {
  aggregateContractTermQuerySchema,
  contractTermKeySchema,
  createContractDeadlineSchema,
  createContractPartySchema,
  createContractSchema,
  linkPreviousContractVersionSchema,
  listContractDeadlinesQuerySchema,
  listContractsQuerySchema,
  updateContractDeadlineSchema,
  updateContractPartySchema,
  updateContractSchema,
  upsertContractTermSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { companyScopeFromParam } from "../middleware/company-scope.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { badRequest, forbidden } from "../errors.js";
import { logActivity } from "../services/index.js";
import { agentMayUseContracts, contractService } from "../services/contracts.js";

/**
 * Contract register routes (Legal Phase 1, DUR-4852 under DUR-4851).
 *
 * Contracts are confidential, so access is narrower than the rest of the
 * company API:
 *   - Board members of the company, except read-only "viewer" members.
 *   - Agents of the same company that hold the Legal Advisor position or an
 *     explicit `contracts:access` grant. Every other agent gets 403.
 *   - Deleting a contract is board-only.
 * Every route is company-scoped through `companyScopeFromParam` (RLS plus the
 * company check), then `contractAccess()` decides inside that scope.
 *
 * Activity-log entries carry ids, enum values and the names of changed fields
 * only: never a title, summary, extracted text or term value.
 */
export function contractRoutes(rawDb: Db) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = contractService(db, rawDb);

  function scope() {
    return companyScopeFromParam(rawDb, assertCompanyAccess);
  }

  /** Runs inside the company scope, after assertCompanyAccess has accepted the actor. */
  function contractAccess() {
    return async (req: Request, _res: Response, next: NextFunction) => {
      try {
        const companyId = req.params.companyId as string;
        if (req.actor.type === "agent") {
          if (!(await agentMayUseContracts(db, companyId, req.actor))) {
            throw forbidden("This agent does not have access to contracts");
          }
        } else if (req.actor.type === "board") {
          if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
            const membership = req.actor.memberships?.find((item) => item.companyId === companyId);
            if (!membership || membership.status !== "active" || membership.membershipRole === "viewer") {
              throw forbidden("This member does not have access to contracts");
            }
          }
        } else {
          throw forbidden("This caller does not have access to contracts");
        }
        next();
      } catch (error) {
        next(error);
      }
    };
  }

  const access = () => [scope(), contractAccess()];
  const boardAccess = () => [
    companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
    }),
    contractAccess(),
  ];

  function actorRef(actor: ReturnType<typeof getActorInfo>) {
    return { agentId: actor.agentId, userId: actor.actorType === "user" ? actor.actorId : null };
  }

  async function log(
    req: Request,
    companyId: string,
    action: string,
    entityType: string,
    entityId: string,
    details: Record<string, unknown>,
  ) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action,
      entityType,
      entityId,
      details,
    });
  }

  // --- Term registry / aggregation (declared before the :id routes) ---
  router.get("/companies/:companyId/contract-terms", ...access(), async (req, res) => {
    res.json({ keys: await svc.listTermKeys(req.params.companyId as string) });
  });

  router.get("/companies/:companyId/contract-terms/:key/aggregate", ...access(), async (req, res) => {
    const key = contractTermKeySchema.safeParse(req.params.key);
    if (!key.success) throw badRequest("Invalid term key");
    const query = aggregateContractTermQuerySchema.safeParse(req.query);
    if (!query.success) throw badRequest("Invalid query", query.error.flatten());
    res.json(await svc.aggregateTerm(req.params.companyId as string, key.data, query.data));
  });

  // --- Deadlines across the company ---
  router.get("/companies/:companyId/contract-deadlines", ...access(), async (req, res) => {
    const query = listContractDeadlinesQuerySchema.safeParse(req.query);
    if (!query.success) throw badRequest("Invalid query", query.error.flatten());
    res.json(await svc.listDeadlines(req.params.companyId as string, query.data));
  });

  // --- Contracts ---
  router.get("/companies/:companyId/contracts", ...access(), async (req, res) => {
    const query = listContractsQuerySchema.safeParse(req.query);
    if (!query.success) throw badRequest("Invalid query", query.error.flatten());
    res.json(await svc.listContracts(req.params.companyId as string, query.data));
  });

  router.post("/companies/:companyId/contracts", ...access(), validate(createContractSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const created = await svc.createContract(companyId, req.body, actorRef(getActorInfo(req)));
    await log(req, companyId, "contract.created", "contract", created.id, {
      type: created.type,
      status: created.status,
      partyCount: Array.isArray(req.body.parties) ? req.body.parties.length : 0,
      hasFile: Boolean(created.assetId),
    });
    res.status(201).json(created);
  });

  router.get("/companies/:companyId/contracts/:id", ...access(), async (req, res) => {
    const includeText = req.query.includeText === "true";
    res.json(await svc.getContract(req.params.companyId as string, req.params.id as string, { includeText }));
  });

  router.patch("/companies/:companyId/contracts/:id", ...access(), validate(updateContractSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    const updated = await svc.updateContract(companyId, id, req.body);
    await log(req, companyId, "contract.updated", "contract", id, {
      changed: Object.keys(req.body).sort(),
      status: updated.status,
    });
    res.json(updated);
  });

  router.delete("/companies/:companyId/contracts/:id", ...boardAccess(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    const removed = await svc.removeContract(companyId, id);
    await log(req, companyId, "contract.deleted", "contract", id, { type: removed.type });
    res.json({ ok: true });
  });

  // --- Version chain ---
  router.get("/companies/:companyId/contracts/:id/versions", ...access(), async (req, res) => {
    res.json(await svc.getVersionLog(req.params.companyId as string, req.params.id as string));
  });

  router.post(
    "/companies/:companyId/contracts/:id/link-previous-version",
    ...access(),
    validate(linkPreviousContractVersionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      const result = await svc.linkPreviousVersion(companyId, id, req.body);
      await log(req, companyId, "contract.version_linked", "contract", id, {
        previousContractId: result.previousContractId,
        versionNo: result.versionNo,
        carryDeadlines: result.carryDeadlines,
        movedDeadlines: result.movedDeadlines,
        supersededDeadlines: result.supersededDeadlines,
      });
      res.json(result);
    },
  );

  // --- Parties ---
  router.post(
    "/companies/:companyId/contracts/:id/parties",
    ...access(),
    validate(createContractPartySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const created = await svc.addParty(companyId, req.params.id as string, req.body);
      await log(req, companyId, "contract.party_added", "contract", req.params.id as string, {
        partyId: created.id,
        role: created.role,
        organizationId: created.organizationId,
      });
      res.status(201).json(created);
    },
  );

  router.patch(
    "/companies/:companyId/contracts/:id/parties/:partyId",
    ...access(),
    validate(updateContractPartySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const updated = await svc.updateParty(companyId, req.params.id as string, req.params.partyId as string, req.body);
      await log(req, companyId, "contract.party_updated", "contract", req.params.id as string, {
        partyId: updated.id,
        changed: Object.keys(req.body).sort(),
      });
      res.json(updated);
    },
  );

  router.delete("/companies/:companyId/contracts/:id/parties/:partyId", ...access(), async (req, res) => {
    const companyId = req.params.companyId as string;
    await svc.removeParty(companyId, req.params.id as string, req.params.partyId as string);
    await log(req, companyId, "contract.party_removed", "contract", req.params.id as string, {
      partyId: req.params.partyId,
    });
    res.json({ ok: true });
  });

  // --- Deadlines ---
  router.post(
    "/companies/:companyId/contracts/:id/deadlines",
    ...access(),
    validate(createContractDeadlineSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const created = await svc.addDeadline(companyId, req.params.id as string, req.body);
      await log(req, companyId, "contract.deadline_added", "contract", req.params.id as string, {
        deadlineId: created.id,
        kind: created.kind,
        dueDate: created.dueDate,
      });
      res.status(201).json(created);
    },
  );

  router.patch(
    "/companies/:companyId/contracts/:id/deadlines/:deadlineId",
    ...access(),
    validate(updateContractDeadlineSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const updated = await svc.updateDeadline(
        companyId,
        req.params.id as string,
        req.params.deadlineId as string,
        req.body,
      );
      await log(req, companyId, "contract.deadline_updated", "contract", req.params.id as string, {
        deadlineId: updated.id,
        changed: Object.keys(req.body).sort(),
        state: updated.state,
      });
      res.json(updated);
    },
  );

  router.delete("/companies/:companyId/contracts/:id/deadlines/:deadlineId", ...access(), async (req, res) => {
    const companyId = req.params.companyId as string;
    await svc.removeDeadline(companyId, req.params.id as string, req.params.deadlineId as string);
    await log(req, companyId, "contract.deadline_removed", "contract", req.params.id as string, {
      deadlineId: req.params.deadlineId,
    });
    res.json({ ok: true });
  });

  // --- Terms ---
  router.get("/companies/:companyId/contracts/:id/terms", ...access(), async (req, res) => {
    res.json(await svc.listTerms(req.params.companyId as string, req.params.id as string));
  });

  router.put(
    "/companies/:companyId/contracts/:id/terms/:key",
    ...access(),
    validate(upsertContractTermSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const key = contractTermKeySchema.safeParse(req.params.key);
      if (!key.success) throw badRequest("Invalid term key");
      const term = await svc.upsertTerm(companyId, req.params.id as string, key.data, req.body);
      await log(req, companyId, "contract.term_set", "contract", req.params.id as string, {
        key: term.key,
        valueKind: term.valueKind,
      });
      res.json(term);
    },
  );

  router.delete("/companies/:companyId/contracts/:id/terms/:key", ...access(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const key = contractTermKeySchema.safeParse(req.params.key);
    if (!key.success) throw badRequest("Invalid term key");
    await svc.removeTerm(companyId, req.params.id as string, key.data);
    await log(req, companyId, "contract.term_removed", "contract", req.params.id as string, { key: key.data });
    res.json({ ok: true });
  });

  return router;
}
