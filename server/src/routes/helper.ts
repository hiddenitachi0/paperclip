import { Router, type Request, type RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { helperAskSchema, updateHelperSettingsSchema, type HelperAskRequest, type UpdateHelperSettings } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScope } from "../middleware/company-scope.js";
import { helperService, type HelperServiceOptions } from "../services/helper.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/**
 * "Ask Paperclip" helper (Phase 1).
 *
 *   POST /companies/:companyId/helper/ask       any board member of the company
 *   GET  /companies/:companyId/helper/settings  any board member (models + key status, never a key)
 *   PUT  /companies/:companyId/helper/settings  owner/admin only
 *
 * Phase 2: a question may carry up to 4 pictures the person attached
 * (upload, paste, or one of the company's Files). Same permission as asking.
 *
 * Agents are refused everywhere: the helper is for people on the board. The
 * ask route offers the model no tools at all (see services/helper.ts).
 */

function isOwnerOrAdmin(req: Request, companyId: string): boolean {
  if (req.actor.type !== "board") return false;
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
  const membership = (req.actor.memberships ?? []).find((item) => item.companyId === companyId);
  const role = membership?.status === "active" ? membership.membershipRole : null;
  return role === "owner" || role === "admin";
}

/** The ask route takes up to 4 pictures of 5 MB as base64 in JSON, more than the default body limit. */
export const HELPER_ASK_API_PATH = "/api/companies/:companyId/helper/ask";
export const HELPER_ASK_JSON_BODY_LIMIT = "30mb";

export function helperRoutes(rawDb: Db, options: { helper?: HelperServiceOptions } = {}) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const helper = helperService(db, options.helper);
  // The ask route makes a model call that can take many seconds, so it does
  // not hold a company-scoped connection open for it (same as the quick-agent
  // routes): it checks access itself and every query filters by company.
  const askHelper = helperService(rawDb, options.helper);

  const scope = (requireAdmin: boolean) =>
    companyScope(rawDb, (req) => {
      assertBoard(req);
      const companyId = req.params.companyId;
      if (typeof companyId !== "string") return undefined;
      assertCompanyAccess(req, companyId);
      if (requireAdmin && !isOwnerOrAdmin(req, companyId)) {
        throw forbidden("Only a company owner or admin can change the helper's settings. You can see them, but not change them.");
      }
      return companyId;
    });

  const userIdOf = (req: Request) => (req.actor.type === "board" ? req.actor.userId ?? null : null);

  const boardOfCompany: RequestHandler = (req, _res, next) => {
    try {
      assertBoard(req);
      assertCompanyAccess(req, req.params.companyId as string);
      next();
    } catch (err) {
      next(err);
    }
  };

  router.post("/companies/:companyId/helper/ask", boardOfCompany, validate(helperAskSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const body = req.body as HelperAskRequest;
    const result = await askHelper.ask({
      companyId,
      userId: userIdOf(req),
      message: body.message,
      context: body.context ?? null,
      pageRoute: body.pageRoute ?? null,
      directoryEntryId: body.directoryEntryId ?? null,
      history: body.history,
      pictures: body.pictures,
    });
    res.json(result);
  });

  router.get("/companies/:companyId/helper/settings", scope(false), async (req, res) => {
    const companyId = req.params.companyId as string;
    res.json(await helper.getSettings(companyId, { canEdit: isOwnerOrAdmin(req, companyId) }));
  });

  router.put("/companies/:companyId/helper/settings", scope(true), validate(updateHelperSettingsSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await helper.updateSettings(companyId, req.body as UpdateHelperSettings, { userId: userIdOf(req) });
    res.json(await helper.getSettings(companyId, { canEdit: true }));
  });

  return router;
}
