import { Router } from "express";
import type { BackupRetentionPolicy, BackupStorageStats, RunDatabaseBackupResult } from "@paperclipai/db";
import { badRequest } from "../errors.js";
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
  /**
   * Current on-disk backup usage plus a projection under `retention`
   * (defaults to the saved instance retention when omitted).
   */
  getStorageStats(retention?: BackupRetentionPolicy): Promise<InstanceDatabaseBackupStorageStats>;
};

export type InstanceDatabaseBackupStorageStats = BackupStorageStats & {
  backupDir: string;
  retention: BackupRetentionPolicy;
};

function parseRetentionQuery(query: Record<string, unknown>): BackupRetentionPolicy | undefined {
  const keys = ["dailyDays", "weeklyWeeks", "monthlyMonths"] as const;
  const present = keys.filter((k) => query[k] !== undefined);
  if (present.length === 0) return undefined;
  if (present.length !== keys.length) throw badRequest("dailyDays, weeklyWeeks and monthlyMonths must be provided together");
  const out: Record<string, number> = {};
  for (const k of keys) {
    const raw = query[k];
    const n = typeof raw === "string" && /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 3650) throw badRequest(`${k} must be an integer between 1 and 3650`);
    out[k] = n;
  }
  return out as BackupRetentionPolicy;
}

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

  router.get("/instance/database-backups/stats", async (req, res) => {
    assertInstanceAdmin(req);
    const retention = parseRetentionQuery(req.query as Record<string, unknown>);
    res.json(await service.getStorageStats(retention));
  });

  return router;
}
