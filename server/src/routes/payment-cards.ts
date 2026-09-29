import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { createRequestScopedDb } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity } from "../services/activity-log.js";
import { paymentCardService, type PaymentCardServiceDeps } from "../services/payment-cards.js";
import { companyScope, companyScopeFromParam } from "../middleware/company-scope.js";

const disablePaymentCardSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});

const markPaymentCardUsedUpSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});

/**
 * DUR-4040 (Maja browser step 5): board-only, same access rule as the rest of
 * the payment-card feature (companies.paymentsEnabled is a board-settable
 * field, never agent-writable). No create route here -- card creation is
 * decided by whichever ticket wires it to the secret it points at.
 */
export function paymentCardRoutes(rawDb: Db, deps: PaymentCardServiceDeps = {}) {
  const router = Router();
  const db = createRequestScopedDb(rawDb);
  const svc = paymentCardService(db, rawDb, deps);
  const rawSvc = paymentCardService(rawDb, rawDb, deps);

  router.get(
    "/companies/:companyId/payment-cards",
    companyScopeFromParam(rawDb, (req, companyId) => {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
    }),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      res.json(await svc.list(companyId));
    },
  );

  function scopeFromCard() {
    return companyScope(rawDb, async (req) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const existing = await rawSvc.getById(companyId, req.params.id as string);
      assertCompanyAccess(req, existing.companyId);
      return existing.companyId;
    });
  }

  router.post(
    "/companies/:companyId/payment-cards/:id/disable",
    validate(disablePaymentCardSchema),
    scopeFromCard(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      const updated = await svc.disable(companyId, id, { reason: req.body.reason ?? null });

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "payment_card.disabled",
        entityType: "payment_card",
        entityId: updated.id,
        details: { label: updated.label, last4: updated.last4, reason: req.body.reason ?? null },
      });

      res.json(updated);
    },
  );

  router.post(
    "/companies/:companyId/payment-cards/:id/mark-used-up",
    validate(markPaymentCardUsedUpSchema),
    scopeFromCard(),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      const updated = await svc.markAsUsedUp(companyId, id, { reason: req.body.reason ?? null });

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "payment_card.marked_used_up",
        entityType: "payment_card",
        entityId: updated.id,
        details: { label: updated.label, last4: updated.last4, reason: req.body.reason ?? null },
      });

      res.json(updated);
    },
  );

  return router;
}
