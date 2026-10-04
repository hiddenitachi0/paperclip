import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../middleware/logger.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { resolveRunLogBasePath } from "./run-log-store.js";

const execFileAsync = promisify(execFile);

/** DUR-4499: read-only disk reporting. Never deletes anything. */
export const DISK_WARN_PERCENT = 80;
export const DISK_CRITICAL_PERCENT = 90;

export type DiskHealthLevel = "ok" | "warn" | "critical";

export interface DiskFolderUsage {
  key: "backups" | "worktrees" | "runLogs" | "agentWorkspaces";
  label: string;
  path: string;
  /** null when the folder is missing or could not be measured in time. */
  bytes: number | null;
}

export interface DiskHealthReport {
  checkedAt: string;
  path: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
  level: DiskHealthLevel;
  warnAtPercent: number;
  criticalAtPercent: number;
  folders: DiskFolderUsage[];
  message: string | null;
}

export function diskLevel(usedPercent: number): DiskHealthLevel {
  if (usedPercent >= DISK_CRITICAL_PERCENT) return "critical";
  if (usedPercent >= DISK_WARN_PERCENT) return "warn";
  return "ok";
}

export function describeDiskLevel(level: DiskHealthLevel, usedPercent: number): string | null {
  if (level === "ok") return null;
  const pct = Math.round(usedPercent);
  return level === "critical"
    ? `Disk is ${pct}% full (over ${DISK_CRITICAL_PERCENT}%). Free space now: old backups, worktrees and run logs are the usual culprits.`
    : `Disk is ${pct}% full (over ${DISK_WARN_PERCENT}%). Check the biggest folders before it fills up.`;
}

async function duBytes(dir: string): Promise<number | null> {
  try {
    await fs.access(dir);
  } catch {
    return null;
  }
  try {
    const { stdout } = await execFileAsync("du", ["-sk", "-x", "--", dir], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    const kb = Number(stdout.split(/\s+/)[0]);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch (err) {
    // du exits non-zero on unreadable subdirs but still prints a total; timeouts yield null.
    const out = (err as { stdout?: string }).stdout;
    const kb = Number(String(out ?? "").split(/\s+/)[0]);
    return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
  }
}

export interface DiskHealthDeps {
  backupDir: string;
  statfs?: (p: string) => Promise<{ bsize: number; blocks: number; bfree: number; bavail: number }>;
  measure?: (dir: string) => Promise<number | null>;
  now?: () => number;
}

export function createDiskHealthService(deps: DiskHealthDeps, cacheMs = 5 * 60 * 1000) {
  const statfs = deps.statfs ?? ((p: string) => fs.statfs(p));
  const measure = deps.measure ?? duBytes;
  const now = deps.now ?? Date.now;
  let cached: { at: number; report: DiskHealthReport } | null = null;
  let inflight: Promise<DiskHealthReport> | null = null;

  async function compute(): Promise<DiskHealthReport> {
    const root = resolvePaperclipInstanceRoot();
    const folderDefs: Array<Omit<DiskFolderUsage, "bytes">> = [
      { key: "backups", label: "Backups", path: path.resolve(deps.backupDir) },
      { key: "worktrees", label: "Worktrees (projects)", path: path.resolve(root, "projects") },
      { key: "runLogs", label: "Run logs", path: path.resolve(resolveRunLogBasePath()) },
      { key: "agentWorkspaces", label: "Agent workspaces", path: path.resolve(root, "workspaces") },
    ];
    const probe = await fs.access(root).then(() => root, () => path.parse(root).root);
    const s = await statfs(probe);
    const totalBytes = s.blocks * s.bsize;
    const freeBytes = s.bavail * s.bsize;
    const usedBytes = Math.max(0, (s.blocks - s.bfree) * s.bsize);
    // df semantics: used / (used + available to unprivileged users).
    const denom = usedBytes + freeBytes;
    const usedPercent = denom > 0 ? Math.min(100, (usedBytes / denom) * 100) : 0;
    const folders: DiskFolderUsage[] = [];
    for (const f of folderDefs) folders.push({ ...f, bytes: await measure(f.path) });
    folders.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
    const level = diskLevel(usedPercent);
    return {
      checkedAt: new Date(now()).toISOString(),
      path: probe,
      totalBytes,
      usedBytes,
      freeBytes,
      usedPercent: Math.round(usedPercent * 10) / 10,
      level,
      warnAtPercent: DISK_WARN_PERCENT,
      criticalAtPercent: DISK_CRITICAL_PERCENT,
      folders,
      message: describeDiskLevel(level, usedPercent),
    };
  }

  return {
    async getReport(opts: { fresh?: boolean } = {}): Promise<DiskHealthReport> {
      if (!opts.fresh && cached && now() - cached.at < cacheMs) return cached.report;
      if (!inflight) {
        inflight = compute()
          .then((report) => {
            cached = { at: now(), report };
            return report;
          })
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    },
  };
}

export type DiskHealthService = ReturnType<typeof createDiskHealthService>;

/** Log-only transition watcher so a crossing is visible in server logs. */
export function logDiskLevelChange(prev: DiskHealthLevel | null, report: DiskHealthReport) {
  if (prev === report.level) return;
  if (report.level === "ok") logger.info({ usedPercent: report.usedPercent }, "disk usage back under warning threshold");
  else logger.warn({ usedPercent: report.usedPercent, level: report.level }, report.message ?? "disk usage high");
}
