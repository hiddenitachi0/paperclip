import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { ackPaymentNoticeOutboxSchema } from "@paperclipai/shared";
import { badRequest, forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyScope } from "../middleware/company-scope.js";
import { paymentNoticesService } from "../services/payment-notices.js";
import { companyPaymentSettingsService } from "../services/company-payment-settings.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idParam(req: Request, name: string, what: string): string {
  const value = req.params[name] as string;
  if (!UUID_RE.test(value)) throw notFound(`That ${what} was not found.`);
  return value;
}

/** Same bar as changing a watcher (routes/watchers.ts): owner/admin, not any board member. */
function assertCompanyOwnerOrAdmin(req: Request, companyId: string) {
  assertBoard(req);
  if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
    const membership = (req.actor.memberships ?? []).find((item) => item.companyId === companyId);
    const role = membership?.status === "active" ? membership.membershipRole : null;
    if (role !== "owner" && role !== "admin") {
      throw forbidden("Only a company owner or admin can change payment settings. You can see them, but not change them.");
    }
  }
  assertCompanyAccess(req, companyId);
}

/**
 * Payment notices: the receipts/hand-over outbox for the browser/booking
 * flow (DUR-4037), modelled on `routes/watchers.ts`'s "Telegram bridge's
 * outbox" section. The outbox and its ack are for the bridge, which signs in
 * with the operator's board credential through the on-box CLI, so both need
 * board access to the company like the watcher outbox does. The booking kill
 * switch (payment-settings) is owner/admin-only, same bar as changing a
 * watcher.
 */
export function paymentNoticesRoutes(rawDb: Db) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const notices = paymentNoticesService(db);
  const settings = companyPaymentSettingsService(db);

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

  router.get("/companies/:companyId/payment-notices-outbox", memberScope(), async (req, res) => {
    res.json({ notices: await notices.outbox(req.params.companyId as string) });
  });

  router.post(
    "/companies/:companyId/payment-notices-outbox/:noticeId/ack",
    memberScope(),
    validate(ackPaymentNoticeOutboxSchema),
    async (req, res) => {
      res.json(await notices.ack(req.params.companyId as string, idParam(req, "noticeId", "notice"), req.body));
    },
  );

  router.get("/companies/:companyId/payment-settings", memberScope(), async (req, res) => {
    res.json(await settings.get(req.params.companyId as string));
  });

  router.put("/companies/:companyId/payment-settings/booking-enabled", ownerOrAdminScope(), async (req, res) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== "boolean") throw badRequest("Body must be { enabled: boolean }");
    res.json(await settings.setBookingEnabled(req.params.companyId as string, enabled));
  });

  return router;
}
