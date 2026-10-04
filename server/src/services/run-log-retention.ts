import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "../middleware/logger.js";
import { resolveRunLogBasePath } from "./run-log-store.js";

/** Default retention period for run log files: 30 days. */
export const DEFAULT_RUN_LOG_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PruneRunLogsResult {
  filesDeleted: number;
  bytesFreed: number;
  dirsRemoved: number;
}

/**
 * Delete run log files under `baseDir` whose mtime is older than `retentionDays`.
 *
 * Safety: the walk never follows symlinks (symlinked files/dirs are skipped,
 * never unlinked or entered), only regular files are deleted, and every path
 * is re-checked to be strictly inside the resolved base dir before removal.
 * A missing or empty base dir is a no-op, so repeated runs are idempotent.
 *
 * Refuses to run against a dangerous root (empty/`/`/`process.cwd()`/relative):
 * a blank or misconfigured base path must never widen the sweep beyond the
 * intended run-logs directory.
 */
export async function pruneRunLogs(
  baseDir: string = resolveRunLogBasePath(),
  retentionDays: number = DEFAULT_RUN_LOG_RETENTION_DAYS,
  now: number = Date.now(),
): Promise<PruneRunLogsResult> {
  const result: PruneRunLogsResult = { filesDeleted: 0, bytesFreed: 0, dirsRemoved: 0 };
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return result;
  if (!baseDir || !path.isAbsolute(baseDir)) {
    logger.warn({ baseDir }, "Run log retention refused: base dir is empty or not absolute");
    return result;
  }

  const root = path.resolve(baseDir);
  if (root === path.parse(root).root || root === process.cwd()) {
    logger.warn({ root }, "Run log retention refused: base dir resolves to filesystem root or cwd");
    return result;
  }
  const rootPrefix = root + path.sep;
  const cutoff = now - retentionDays * DAY_MS;

  const inside = (p: string) => p.startsWith(rootPrefix);

  async function walk(dir: string): Promise<boolean> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
    let remaining = entries.length;
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (!inside(full)) continue;
      try {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          const emptied = await walk(full);
          if (emptied) {
            await fs.rmdir(full);
            result.dirsRemoved++;
            remaining--;
          }
        } else if (entry.isFile()) {
          const st = await fs.lstat(full);
          if (st.isFile() && st.mtimeMs < cutoff) {
            await fs.unlink(full);
            result.filesDeleted++;
            result.bytesFreed += st.size;
            remaining--;
          }
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          remaining--;
          continue;
        }
        if (code === "ENOTEMPTY") continue;
        logger.warn({ err, path: full }, "Run log retention failed to prune entry");
      }
    }
    return remaining <= 0;
  }

  try {
    await walk(root);
  } catch (err) {
    logger.warn({ err }, "Run log retention sweep failed");
  }

  if (result.filesDeleted > 0) {
    logger.info({ ...result, retentionDays }, "Pruned expired run logs");
  }
  return result;
}

/** Run once at startup, then on an interval (default daily). Returns a stop fn. */
export function startRunLogRetention(
  intervalMs: number = DAY_MS,
  retentionDays: number = DEFAULT_RUN_LOG_RETENTION_DAYS,
): () => void {
  const run = () =>
    pruneRunLogs(undefined, retentionDays).catch((err) => {
      logger.warn({ err }, "Run log retention sweep failed");
    });
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  void run();
  return () => clearInterval(timer);
}
