import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScope } from "../middleware/company-scope.js";
import { webSearchService, type WebSearchServiceDeps } from "../services/web-search.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/**
 * Company settings → Connections → Web search: which of the company's saved
 * secrets is its Brave Search key, and how many searches its quick agents made
 * today. Any active member may read the card; only the company owner or an
 * admin (or an instance admin, or the local board) may pick or remove the key.
 * Agents are refused on both routes. The body carries a secret id, never a
 * value, and no route here ever returns a key.
 */

const putWebSearchSchema = z
  .object({
    secretId: z.string().uuid().nullable(),
  })
  .strict();

function assertCompanyOwnerOrAdmin(req: Request, companyId: string) {
  assertBoard(req);
  if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
    const membership = (req.actor.memberships ?? []).find((item) => item.companyId === companyId);
    const role = membership?.status === "active" ? membership.membershipRole : null;
    if (role !== "owner" && role !== "admin") {
      throw forbidden("Only a company owner or admin can change the web search key. You can see it, but not change it.");
    }
  }
  assertCompanyAccess(req, companyId);
}

export function webSearchRoutes(rawDb: Db, deps: WebSearchServiceDeps = {}) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = webSearchService(db, deps);

  const memberScope = () =>
    companyScope(rawDb, (req) => {
      assertBoard(req);
      const companyId = req.params.companyId;
      if (typeof companyId !== "string") return undefined;
      assertCompanyAccess(req, companyId);
      return companyId;
    });

  const ownerOrAdminScope = () =>
    companyScope(rawDb, (req) => {
      const companyId = req.params.companyId;
      if (typeof companyId !== "string") return undefined;
      assertCompanyOwnerOrAdmin(req, companyId);
      return companyId;
    });

  router.get("/companies/:companyId/web-search", memberScope(), async (req, res) => {
    res.json(await svc.getSettings(req.params.companyId as string));
  });

  router.put("/companies/:companyId/web-search", ownerOrAdminScope(), validate(putWebSearchSchema), async (req, res) => {
    const { secretId } = req.body as z.infer<typeof putWebSearchSchema>;
    const settings = await svc.setKey(req.params.companyId as string, secretId, {
      userId: req.actor.type === "board" ? req.actor.userId ?? null : null,
    });
    res.json(settings);
  });

  return router;
}
