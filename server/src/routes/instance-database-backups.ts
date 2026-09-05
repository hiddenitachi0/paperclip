import { Router } from "express";
import type { BackupRetentionPolicy, RunDatabaseBackupResult } from "@paperclipai/db";
import { assertInstanceAdmin } from "./authz.js";

export type InstanceDatabaseBackupTrigger = "manual" | "scheduled";

export type InstanceDatabaseBackupRunResult = RunDatabaseBackupResult & {
  trigger: InstanceDatabaseBackupTrigger;
  backupDir: string;
  retention: BackupRetentionPolicy;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
};

export type InstanceDatabaseBackupService = {
  runManualBackup(): Promise<InstanceDatabaseBackupRunResult>;
};

/**
 * DUR-277/DUR-350 (Wave 4): deliberately stays bypass-scoped -- this route
 * doesn't even take a `Db` (it delegates to `service.runManualBackup()`,
 * which dumps the whole physical database via `pg_dump`, per DUR-271). A
 * database backup has no per-company boundary by definition: it captures
 * every company's data in one physical-file operation, so there is no
 * companyId to scope a request-level connection claim against. Gated on
 * `assertInstanceAdmin` instead, the instance-wide authz equivalent. See the
 * DUR-277 design doc §1 (instance-database-backups.ts: category (c)) and §2
 * (the scheduled backup tick is one of the four consumers that must stay
 * bypass-scoped for its whole tick body, for the same reason).
 */
export function instanceDatabaseBackupRoutes(service: InstanceDatabaseBackupService) {
  const router = Router();

  router.post("/instance/database-backups", async (req, res) => {
    assertInstanceAdmin(req);
    const result = await service.runManualBackup();
    res.status(201).json(result);
  });

  return router;
}
