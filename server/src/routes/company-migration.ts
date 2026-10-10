import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { markCompanyMigratedSchema } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { companyScope } from "../middleware/company-scope.js";
import { companyMigrationService } from "../services/company-migration.js";
import { logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Franchise migration, phase B: the safe two-phase cutover.
 *
 *   GET  /companies/:companyId/migration/verify          any board member of the company (read-only)
 *   POST /companies/:companyId/migration/mark-migrated   owner/admin only
 *   POST /companies/:companyId/migration/undo            owner/admin only
 *
 * Agents can call none of these (assertBoard refuses agent keys), and the
 * owner/admin bar is decided from the actor's own membership rows, never
 * from anything in the request -- the same rule as jobSettingsRoutes and the
 * Connections page.
 */
export function companyMigrationRoutes(rawDb: Db) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = companyMigrationService(db, { instanceDb: rawDb });

  function memberScope() {
    return companyScope(rawDb, (req) => {
      assertBoard(req);
      const companyId = req.params.companyId;
      if (typeof companyId !== "string") return undefined;
      assertCompanyAccess(req, companyId);
      return companyId;
    });
  }

  function assertOwnerOrAdmin(req: Request, companyId: string) {
    assertBoard(req);
    if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
      const membership = (req.actor.memberships ?? []).find((item) => item.companyId === companyId);
      const role = membership?.status === "active" ? membership.membershipRole : null;
      if (role !== "owner" && role !== "admin") {
        throw forbidden("Only the company's owner or an admin can mark this company as moved, or undo it.");
      }
    }
    assertCompanyAccess(req, companyId);
  }

  function ownerOrAdminScope() {
    return companyScope(rawDb, (req) => {
      const companyId = req.params.companyId;
      if (typeof companyId !== "string") return undefined;
      assertOwnerOrAdmin(req, companyId);
      return companyId;
    });
  }

  router.get("/companies/:companyId/migration/verify", memberScope(), async (req, res) => {
    res.json(await svc.verifyDestination(req.params.companyId as string));
  });

  router.post("/companies/:companyId/migration/mark-migrated", ownerOrAdminScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const body = markCompanyMigratedSchema.parse(req.body ?? {});
    const actor = getActorInfo(req);
    const userId = req.actor.type === "board" ? (req.actor.userId ?? null) : null;
    const result = await svc.markMigrated(companyId, {
      destinationUrl: body.destinationUrl,
      confirmCompanyName: body.confirmCompanyName,
      userId,
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.marked_migrated",
      entityType: "company",
      entityId: companyId,
      details: {
        destinationUrl: result.migratedToUrl,
        agentsPaused: result.agentsPaused,
        routinesPaused: result.routinesPaused,
      },
    });
    res.json(result);
  });

  router.post("/companies/:companyId/migration/undo", ownerOrAdminScope(), async (req, res) => {
    const companyId = req.params.companyId as string;
    const actor = getActorInfo(req);
    const result = await svc.undoMigrated(companyId);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.migration_undone",
      entityType: "company",
      entityId: companyId,
      details: {
        agentsResumed: result.agentsResumed,
        routinesResumed: result.routinesResumed,
      },
    });
    res.json(result);
  });

  return router;
}
