// DUR-5268: new task worktrees share one package store instead of each holding
// a full copy of node_modules and build output (127 folders ~ 24 GB filled the
// production volume). Two helpers:
//  - prepareSharedPackageStore(): picks a store on the same filesystem as the
//    worktree and returns the environment that points pnpm at it.
//  - measureWorktreeFootprint(): reports what a fresh worktree actually costs.
import fs from "node:fs/promises";
import path from "node:path";

const MAX_WALKED_ENTRIES = 500_000;
const BUILD_OUTPUT_DIR_NAMES = new Set(["dist", ".turbo", ".next", ".cache", "build", ".vite", "coverage"]);

export interface SharedPackageStore {
  /** Folder shared by every worktree of the repository (pnpm store, shared virtualenv). */
  sharedDir: string;
  storeDir: string;
  /** False when the store is on a different filesystem than the worktree: pnpm would copy, not link. */
  sameFilesystem: boolean;
  /** Variables to add to the workspace setup command's environment; empty when linking is not possible. */
  env: Record<string, string>;
  warnings: string[];
}

export function resolveSharedWorkspaceDir(repoRoot: string, env: NodeJS.ProcessEnv = process.env) {
  const configured = env.PAPERCLIP_SHARED_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(repoRoot, ".paperclip", "shared");
}

export async function prepareSharedPackageStore(input: {
  repoRoot: string;
  worktreePath: string;
  /** Environment the setup command would inherit; an operator-set pnpm store is respected. */
  parentEnv?: NodeJS.ProcessEnv;
}): Promise<SharedPackageStore> {
  const parentEnv = input.parentEnv ?? process.env;
  const sharedDir = resolveSharedWorkspaceDir(input.repoRoot, parentEnv);
  const operatorStore = (parentEnv.pnpm_config_store_dir ?? parentEnv.npm_config_store_dir)?.trim();
  const storeDir = operatorStore ? path.resolve(operatorStore) : path.join(sharedDir, "pnpm-store");
  const warnings: string[] = [];
  const unusable = (reason: string, sameFilesystem: boolean): SharedPackageStore => ({
    sharedDir,
    storeDir,
    sameFilesystem,
    env: {},
    warnings: [...warnings, reason],
  });

  try {
    // An empty or missing store is fine: pnpm fills it on the first install.
    await fs.mkdir(storeDir, { recursive: true });
  } catch (error) {
    return unusable(
      `Shared package store ${storeDir} could not be created (${error instanceof Error ? error.message : String(error)}); this worktree installs its own packages.`,
      false,
    );
  }

  let sameFilesystem = false;
  try {
    const [storeStat, worktreeStat] = await Promise.all([fs.stat(storeDir), fs.stat(input.worktreePath)]);
    sameFilesystem = storeStat.dev === worktreeStat.dev;
  } catch {
    sameFilesystem = false;
  }
  if (!sameFilesystem) {
    return unusable(
      `Shared package store ${storeDir} is on a different filesystem than ${input.worktreePath}, so pnpm would copy every package instead of linking. Not using it; put the store on the same disk as the worktrees (PAPERCLIP_SHARED_DIR).`,
      false,
    );
  }

  return {
    sharedDir,
    storeDir,
    sameFilesystem: true,
    warnings,
    env: {
      // pnpm 9 reads npm_config_*, pnpm 11 reads pnpm_config_*. (PNPM_STORE_DIR is not read by either.)
      npm_config_store_dir: storeDir,
      pnpm_config_store_dir: storeDir,
      npm_config_prefer_offline: "true",
      pnpm_config_prefer_offline: "true",
      PAPERCLIP_SHARED_DIR: sharedDir,
      PAPERCLIP_SHARED_PNPM_STORE_DIR: storeDir,
      PAPERCLIP_SHARED_VENV_DIR: path.join(sharedDir, "venv"),
    },
  };
}

export interface WorktreeFootprint {
  totalBytes: number;
  /** Bytes in files that no other path hard-links to; this is what the worktree really adds to the disk. */
  privateBytes: number;
  nodeModulesBytes: number;
  buildOutputBytes: number;
  fileCount: number;
  truncated: boolean;
}

export async function measureWorktreeFootprint(worktreePath: string): Promise<WorktreeFootprint> {
  const result: WorktreeFootprint = {
    totalBytes: 0,
    privateBytes: 0,
    nodeModulesBytes: 0,
    buildOutputBytes: 0,
    fileCount: 0,
    truncated: false,
  };
  const seenInodes = new Set<string>();
  let walked = 0;

  async function visit(dir: string, inNodeModules: boolean, inBuildOutput: boolean): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (result.truncated) return;
      if (++walked > MAX_WALKED_ENTRIES) {
        result.truncated = true;
        return;
      }
      if (dir === worktreePath && entry.name === ".git") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(
          fullPath,
          inNodeModules || entry.name === "node_modules",
          inBuildOutput || BUILD_OUTPUT_DIR_NAMES.has(entry.name),
        );
        continue;
      }
      let stat: import("node:fs").Stats;
      try {
        stat = await fs.lstat(fullPath);
      } catch {
        continue;
      }
      const inodeKey = `${stat.dev}:${stat.ino}`;
      if (stat.nlink > 1 && seenInodes.has(inodeKey)) continue;
      if (stat.nlink > 1) seenInodes.add(inodeKey);
      result.fileCount += 1;
      result.totalBytes += stat.size;
      if (stat.nlink <= 1) result.privateBytes += stat.size;
      if (inNodeModules) result.nodeModulesBytes += stat.size;
      else if (inBuildOutput) result.buildOutputBytes += stat.size;
    }
  }

  await visit(worktreePath, false, false);
  return result;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function formatWorktreeFootprint(
  footprint: WorktreeFootprint,
  store: Pick<SharedPackageStore, "storeDir" | "sameFilesystem">,
): string {
  const storeNote = store.sameFilesystem
    ? `shared package store ${store.storeDir}`
    : "no shared package store (different filesystem)";
  return (
    `New worktree size: ${formatBytes(footprint.totalBytes)} in ${footprint.fileCount} files` +
    `${footprint.truncated ? " (counted partially)" : ""}, ` +
    `${formatBytes(footprint.privateBytes)} of it private to this folder (the rest is linked from elsewhere). ` +
    `node_modules ${formatBytes(footprint.nodeModulesBytes)}, build output ${formatBytes(footprint.buildOutputBytes)}; ${storeNote}.\n`
  );
}
