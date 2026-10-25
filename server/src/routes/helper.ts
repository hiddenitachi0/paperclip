import { Router, type Request, type RequestHandler } from "express";
import { ZodError, type ZodSchema } from "zod";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import {
  helperAskSchema,
  startHelperInvestigationSchema,
  updateHelperSettingsSchema,
  type HelperAskRequest,
  type StartHelperInvestigationRequest,
  type UpdateHelperSettings,
} from "@paperclipai/shared";
import { badRequest, forbidden } from "../errors.js";
import { companyScope } from "../middleware/company-scope.js";
import { helperService, type HelperServiceOptions } from "../services/helper.js";
import { helperInvestigationService, type HelperInvestigationServiceOptions } from "../services/helper-investigations.js";
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
 * Phase 3, "Investigate deeper" (services/helper-investigations.ts):
 *   GET  /companies/:companyId/helper/investigations  the person's OWN investigations + whether one can start
 *   POST /companies/:companyId/helper/investigations  hand a question to the company's investigation agent
 * Any board member of the company who may give that agent work (the same
 * "tasks:assign" decision as the task routes) can start one; records and
 * pictures they may not see are left out or refused. Each one is a normal
 * task created by the person; owners/admins see everyone's in the task list,
 * the panel lists only the person's own.
 *
 * Agents are refused everywhere: the helper is for people on the board. The
 * ask route offers the model no tools at all (see services/helper.ts).
 */

/**
 * The helper's own body check: a refusal is worded for the person in the
 * panel ("Your question is too long…"), not "Validation error". Custom
 * messages written into the schemas ("Type a question first.") are kept.
 */
export function plainHelperValidationMessage(err: ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "Something in the request could not be read. Try again.";
  const field = String(issue.path[0] ?? "");
  const custom = issue.message && !/^(Required|Invalid|String must|Array must|Expected|Number must|Unrecognized key)/.test(issue.message);
  if (custom) return issue.message;
  switch (field) {
    case "message":
    case "question":
      return issue.code === "too_big"
        ? "Your question is too long. Shorten it and try again."
        : "Type a question first.";
    case "context":
      return "The page text is too long to send. Mark a smaller area and try again.";
    case "history":
      return "The conversation is too long to send. Press “New conversation” and ask again.";
    case "pictures":
      return "One of the pictures could not be used. Remove it and attach it again.";
    case "directoryEntryId":
      return "The picked model could not be found. Pick another model and try again.";
    case "references":
      return "One of the marked records could not be read. Mark the area again and try once more.";
    case "quickAnswer":
      return "The earlier answer is too long to hand over. Ask the question again without it.";
    default:
      return "Something in the request could not be read. Reload the page and try again.";
  }
}

function validatePlain(schema: ZodSchema): RequestHandler {
  return (req, _res, next) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        next(badRequest(plainHelperValidationMessage(err), { code: "HELPER_INVALID_REQUEST", issues: err.issues }));
        return;
      }
      next(err);
    }
  };
}

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
/** Starting an investigation takes the same pictures, so it gets the same body limit. */
export const HELPER_INVESTIGATIONS_API_PATH = "/api/companies/:companyId/helper/investigations";

export function helperRoutes(
  rawDb: Db,
  options: { helper?: HelperServiceOptions; investigations?: HelperInvestigationServiceOptions } = {},
) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const helper = helperService(db, options.helper);
  // The ask route makes a model call that can take many seconds, so it does
  // not hold a company-scoped connection open for it (same as the quick-agent
  // routes): it checks access itself and every query filters by company.
  const askHelper = helperService(rawDb, options.helper);
  // Same for investigations: pictures are checked and stored, then a task is
  // made through issueService (which opens its own company-scoped transaction).
  const investigations = helperInvestigationService(rawDb, options.investigations);

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

  router.post("/companies/:companyId/helper/ask", boardOfCompany, validatePlain(helperAskSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const body = req.body as HelperAskRequest;
    const result = await askHelper.ask({
      companyId,
      userId: userIdOf(req),
      actor: req.actor,
      message: body.message,
      context: body.context ?? null,
      pageRoute: body.pageRoute ?? null,
      directoryEntryId: body.directoryEntryId ?? null,
      history: body.history,
      pictures: body.pictures,
    });
    res.json(result);
  });

  router.get("/companies/:companyId/helper/investigations", boardOfCompany, async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = userIdOf(req);
    if (!userId) throw forbidden("Sign in as a person to see your investigations.");
    res.json(await investigations.list(companyId, { ...req.actor, userId }, { canConfigure: isOwnerOrAdmin(req, companyId) }));
  });

  router.post(
    "/companies/:companyId/helper/investigations",
    boardOfCompany,
    validatePlain(startHelperInvestigationSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const userId = userIdOf(req);
      if (!userId) throw forbidden("Sign in as a person to start an investigation.");
      const body = req.body as StartHelperInvestigationRequest;
      const view = await investigations.start({
        companyId,
        // The person's own rights decide what may be handed to the agent.
        actor: { ...req.actor, userId },
        question: body.question,
        context: body.context ?? null,
        pageRoute: body.pageRoute ?? null,
        references: body.references ?? [],
        quickAnswer: body.quickAnswer ?? null,
        pictures: body.pictures,
        applyTargets: body.applyTargets ?? [],
        canConfigure: isOwnerOrAdmin(req, companyId),
      });
      res.status(201).json(view);
    },
  );

  router.get("/companies/:companyId/helper/settings", scope(false), async (req, res) => {
    const companyId = req.params.companyId as string;
    res.json(await helper.getSettings(companyId, { canEdit: isOwnerOrAdmin(req, companyId) }));
  });

  router.put("/companies/:companyId/helper/settings", scope(true), validatePlain(updateHelperSettingsSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await helper.updateSettings(companyId, req.body as UpdateHelperSettings, { userId: userIdOf(req) });
    res.json(await helper.getSettings(companyId, { canEdit: true }));
  });

  return router;
}
