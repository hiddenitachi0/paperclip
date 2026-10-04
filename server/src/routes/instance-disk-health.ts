import { Router } from "express";
import type { DiskHealthService } from "../services/disk-health.js";
import { assertInstanceAdmin } from "./authz.js";

/**
 * DUR-4499: read-only disk usage report (data volume used/free, biggest
 * folders, 80%/90% level). Instance-wide, so gated on assertInstanceAdmin like
 * the database-backup routes; nothing here deletes or mutates anything.
 */
export function instanceDiskHealthRoutes(service: DiskHealthService) {
  const router = Router();
  router.get("/instance/disk-health", async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await service.getReport({ fresh: req.query.fresh === "1" }));
  });
  return router;
}
