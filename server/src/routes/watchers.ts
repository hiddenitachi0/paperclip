import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { ackWatcherOutboxSchema, createWatcherSchema, updateWatcherSchema } from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScope } from "../middleware/company-scope.js";
import { watcherService, type WatcherServiceDeps } from "../services/watchers.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/**
 * Watchers: scheduled market-price checks that alert on Telegram.
 *
 * Who may do what:
 *   * any active member of the company (board) can see the watchers;
 *   * only the company's owner or admin (or an instance admin, or the local
 *     single-user board) can add, change, delete or test one;
 *   * the outbox (ready alerts) and its acknowledgement are for the
 *     Telegram bridge, which signs in with the operator's board credential
 *     through the on-box CLI; they need board access to the company.
 * Agents are refused on every route: an agent can neither set up a watcher
 * nor read or clear the outbox.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertCompanyOwnerOrAdmin(req: Request, companyId: string) {
  assertBoard(req);
  if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
    const membership = (req.actor.memberships ?? []).find((item) => item.companyId === companyId);
    const role = membership?.status === "active" ? membership.membershipRole : null;
    if (role !== "owner" && role !== "admin") {
      throw forbidden("Only a company owner or admin can change watchers. You can see them, but not change them.");
    }
  }
  assertCompanyAccess(req, companyId);
}

function idParam(req: Request, name: string, what: string): string {
  const value = req.params[name] as string;
  if (!UUID_RE.test(value)) throw notFound(`That ${what} was not found.`);
  return value;
}

export function watcherRoutes(rawDb: Db, deps: WatcherServiceDeps = {}) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = watcherService(db, deps);

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

  router.get("/companies/:companyId/watchers", memberScope(), async (req, res) => {
    res.json(await svc.list(req.params.companyId as string));
  });

  router.post("/companies/:companyId/watchers", ownerOrAdminScope(), validate(createWatcherSchema), async (req, res) => {
    res.status(201).json(await svc.create(req.params.companyId as string, req.body, actorOf(req)));
  });

  router.patch(
    "/companies/:companyId/watchers/:watcherId",
    ownerOrAdminScope(),
    validate(updateWatcherSchema),
    async (req, res) => {
      res.json(
        await svc.update(req.params.companyId as string, idParam(req, "watcherId", "watcher"), req.body, actorOf(req)),
      );
    },
  );

  router.delete("/companies/:companyId/watchers/:watcherId", ownerOrAdminScope(), async (req, res) => {
    await svc.remove(req.params.companyId as string, idParam(req, "watcherId", "watcher"), actorOf(req));
    res.status(204).end();
  });

  router.post("/companies/:companyId/watchers/:watcherId/test", ownerOrAdminScope(), async (req, res) => {
    res.status(202).json(await svc.testAlert(req.params.companyId as string, idParam(req, "watcherId", "watcher"), actorOf(req)));
  });

  // ── The Telegram bridge's outbox ────────────────────────────────────────

  router.get("/companies/:companyId/watcher-outbox", memberScope(), async (req, res) => {
    res.json({ alerts: await svc.outbox(req.params.companyId as string) });
  });

  router.post(
    "/companies/:companyId/watcher-outbox/:alertId/ack",
    memberScope(),
    validate(ackWatcherOutboxSchema),
    async (req, res) => {
      res.json(await svc.ack(req.params.companyId as string, idParam(req, "alertId", "alert"), req.body));
    },
  );

  return router;
}
