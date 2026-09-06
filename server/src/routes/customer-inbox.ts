import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { routineService } from "../services/index.js";

/**
 * The customer-inbox door (DUR-68): a company points any message source
 * (email, contact form, ...) at this address instead of the generic webhook
 * fire route. One publicId, one door — see `dispatchWebhookTrigger` in
 * `server/src/services/routines.ts` for why the generic fire route refuses
 * these same triggers.
 */
export function customerInboxRoutes(db: Db) {
  const router = Router();
  const svc = routineService(db);

  router.post("/customer-inbox/:publicId", async (req, res) => {
    const result = await svc.receiveCustomerInboxMessage(req.params.publicId as string, {
      authorizationHeader: req.header("authorization"),
      signatureHeader: req.header("x-paperclip-signature"),
      hubSignatureHeader: req.header("x-hub-signature-256"),
      timestampHeader: req.header("x-paperclip-timestamp"),
      idempotencyKeyHeader: req.header("idempotency-key"),
      rawBody: (req as { rawBody?: Buffer }).rawBody ?? null,
      payload: typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : null,
    });
    res.status(202).json(result);
  });

  return router;
}
