import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import {
  extractProductGrabberUrlSchema,
  reviewProductGrabberStagedItemSchema,
  updateProductGrabberSettingsSchema,
} from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScope } from "../middleware/company-scope.js";
import { productGrabberService, type ProductGrabberServiceDeps } from "../services/product-grabber/service.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/**
 * Product grabber (DUR-4187): staging-list extraction + review API.
 *
 * Who may do what, same shape as watchers.ts:
 *   * any active member of the company (board) can see the settings and the
 *     staging list;
 *   * only the company's owner or admin (or an instance admin, or the local
 *     single-user board) can turn the feature on/off, trigger an extraction,
 *     or approve/reject a staged item.
 * Agents are refused on every route -- this is an operator-facing approval
 * surface, not something an agent can push rows into or approve for itself.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGING_STATUS_RE = /^(pending|approved|rejected)$/;

function assertCompanyOwnerOrAdmin(req: Request, companyId: string) {
  assertBoard(req);
  if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
    const membership = (req.actor.memberships ?? []).find((item) => item.companyId === companyId);
    const role = membership?.status === "active" ? membership.membershipRole : null;
    if (role !== "owner" && role !== "admin") {
      throw forbidden("Only a company owner or admin can change the product grabber. You can see it, but not change it.");
    }
  }
  assertCompanyAccess(req, companyId);
}

function idParam(req: Request, name: string, what: string): string {
  const value = req.params[name] as string;
  if (!UUID_RE.test(value)) throw notFound(`That ${what} was not found.`);
  return value;
}

export function productGrabberRoutes(rawDb: Db, deps: ProductGrabberServiceDeps = {}) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = productGrabberService(db, deps);

  function memberScope() {
    return companyScope(rawDb, (req) => {
      assertBoard(req);
      const companyId = req.params.companyId;
      if (typeof companyId !== "string") return undefined;
      assertCompanyAccess(req, companyId);
      return companyId;
    });
  }

  function ownerOrAdminScope() {
    return companyScope(rawDb, (req) => {
      const companyId = req.params.companyId;
      if (typeof companyId !== "string") return undefined;
      assertCompanyOwnerOrAdmin(req, companyId);
      return companyId;
    });
  }

  function actorOf(req: Request) {
    return { userId: req.actor.type === "board" ? req.actor.userId ?? null : null };
  }

  router.get("/companies/:companyId/product-grabber/settings", memberScope(), async (req, res) => {
    res.json(await svc.settings.get(req.params.companyId as string));
  });

  router.patch(
    "/companies/:companyId/product-grabber/settings",
    ownerOrAdminScope(),
    validate(updateProductGrabberSettingsSchema),
    async (req, res) => {
      res.json(await svc.settings.setEnabled(req.params.companyId as string, req.body.enabled));
    },
  );

  router.get("/companies/:companyId/product-grabber/staged-items", memberScope(), async (req, res) => {
    const statusParam = req.query.status;
    const status = typeof statusParam === "string" && STAGING_STATUS_RE.test(statusParam) ? (statusParam as "pending" | "approved" | "rejected") : undefined;
    res.json({ items: await svc.list(req.params.companyId as string, status) });
  });

  router.post(
    "/companies/:companyId/product-grabber/extract",
    ownerOrAdminScope(),
    validate(extractProductGrabberUrlSchema),
    async (req, res) => {
      res.status(201).json(await svc.extractAndStage(req.params.companyId as string, req.body, actorOf(req)));
    },
  );

  router.post(
    "/companies/:companyId/product-grabber/staged-items/:itemId/review",
    ownerOrAdminScope(),
    validate(reviewProductGrabberStagedItemSchema),
    async (req, res) => {
      res.json(
        await svc.review(
          req.params.companyId as string,
          idParam(req, "itemId", "staged product"),
          req.body,
          actorOf(req),
        ),
      );
    },
  );

  return router;
}
