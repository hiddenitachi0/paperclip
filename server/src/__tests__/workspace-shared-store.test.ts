import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatBytes,
  formatWorktreeFootprint,
  measureWorktreeFootprint,
  prepareSharedPackageStore,
} from "../services/workspace-shared-store.ts";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function tempDir(prefix: string) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("prepareSharedPackageStore (DUR-5268)", () => {
  it("creates an empty store next to the worktrees and points pnpm 9 and 11 at it", async () => {
    const repoRoot = await tempDir("shared-store-repo-");
    const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", "PAP-1");
    await fs.mkdir(worktreePath, { recursive: true });

    const store = await prepareSharedPackageStore({ repoRoot, worktreePath, parentEnv: {} });

    expect(store.storeDir).toBe(path.join(repoRoot, ".paperclip", "shared", "pnpm-store"));
    expect(store.sameFilesystem).toBe(true);
    expect(store.warnings).toEqual([]);
    await expect(fs.readdir(store.storeDir)).resolves.toEqual([]);
    expect(store.env).toMatchObject({
      npm_config_store_dir: store.storeDir,
      pnpm_config_store_dir: store.storeDir,
      npm_config_prefer_offline: "true",
      pnpm_config_prefer_offline: "true",
      PAPERCLIP_SHARED_VENV_DIR: path.join(repoRoot, ".paperclip", "shared", "venv"),
    });
  });

  it("keeps a store the operator already configured", async () => {
    const repoRoot = await tempDir("shared-store-repo-");
    const operatorStore = path.join(await tempDir("operator-store-"), "store");
    const worktreePath = path.join(repoRoot, "wt");
    await fs.mkdir(worktreePath, { recursive: true });

    const store = await prepareSharedPackageStore({
      repoRoot,
      worktreePath,
      parentEnv: { npm_config_store_dir: operatorStore },
    });

    expect(store.storeDir).toBe(operatorStore);
    expect(store.env.npm_config_store_dir).toBe(operatorStore);
  });

  it("does not hand out a store it cannot create", async () => {
    const repoRoot = await tempDir("shared-store-repo-");
    const blocker = path.join(repoRoot, "blocker");
    await fs.writeFile(blocker, "not a directory");
    const worktreePath = path.join(repoRoot, "wt");
    await fs.mkdir(worktreePath);

    const store = await prepareSharedPackageStore({
      repoRoot,
      worktreePath,
      parentEnv: { PAPERCLIP_SHARED_DIR: path.join(blocker, "shared") },
    });

    expect(store.env).toEqual({});
    expect(store.warnings.join(" ")).toContain("could not be created");
  });
});

describe("measureWorktreeFootprint (DUR-5268)", () => {
  it("separates private bytes from files hard-linked to a shared store", async () => {
    const root = await tempDir("footprint-");
    const store = path.join(root, "store");
    const worktree = path.join(root, "wt");
    await fs.mkdir(store);
    await fs.mkdir(path.join(worktree, "node_modules", "pkg"), { recursive: true });
    await fs.mkdir(path.join(worktree, "dist"), { recursive: true });
    await fs.writeFile(path.join(store, "big.js"), "x".repeat(10_000));
    await fs.link(path.join(store, "big.js"), path.join(worktree, "node_modules", "pkg", "big.js"));
    await fs.writeFile(path.join(worktree, "src.ts"), "y".repeat(100));
    await fs.writeFile(path.join(worktree, "dist", "out.js"), "z".repeat(50));
    await fs.writeFile(path.join(worktree, ".git"), "gitdir: elsewhere");

    const footprint = await measureWorktreeFootprint(worktree);

    expect(footprint.totalBytes).toBe(10_150);
    expect(footprint.privateBytes).toBe(150);
    expect(footprint.nodeModulesBytes).toBe(10_000);
    expect(footprint.buildOutputBytes).toBe(50);
    expect(footprint.fileCount).toBe(3);
    expect(formatWorktreeFootprint(footprint, { storeDir: store, sameFilesystem: true })).toContain(
      "150 B of it private",
    );
    expect(formatBytes(1.9 * 1024 ** 3)).toBe("1.9 GiB");
  });
});

describe("real pnpm install against the shared store (DUR-5268)", () => {
  it("links node_modules from the store, works when the store starts empty, and stays far smaller than a copy", async () => {
    const root = await tempDir("pnpm-store-");
    const repoRoot = path.join(root, "repo");
    const dep = path.join(repoRoot, "dep");
    await fs.mkdir(dep, { recursive: true });
    // A tarball dependency goes through the store, unlike a plain directory dependency.
    await fs.writeFile(path.join(dep, "package.json"), JSON.stringify({ name: "shared-dep", version: "1.0.0" }));
    await fs.writeFile(path.join(dep, "index.js"), `module.exports = "${"x".repeat(200_000)}";\n`);
    await execFileAsync("tar", ["-czf", path.join(repoRoot, "shared-dep.tgz"), "-C", repoRoot, "--transform", "s,^dep,package,", "dep"]);

    const worktreeA = path.join(repoRoot, ".paperclip", "worktrees", "A");
    const worktreeB = path.join(repoRoot, ".paperclip", "worktrees", "B");
    for (const wt of [worktreeA, worktreeB]) {
      await fs.mkdir(wt, { recursive: true });
      await fs.writeFile(
        path.join(wt, "package.json"),
        JSON.stringify({ name: "app", version: "1.0.0", dependencies: { "shared-dep": "file:../../../shared-dep.tgz" } }),
      );
    }

    const store = await prepareSharedPackageStore({ repoRoot, worktreePath: worktreeA, parentEnv: {} });
    expect(await fs.readdir(store.storeDir)).toEqual([]);
    const env = { ...process.env, ...store.env, CI: "true", NODE_ENV: "development" };
    for (const wt of [worktreeA, worktreeB]) {
      await execFileAsync("pnpm", ["install", "--offline", "--ignore-workspace", "--no-frozen-lockfile"], {
        cwd: wt,
        env,
      });
    }

    expect((await fs.readdir(store.storeDir)).length).toBeGreaterThan(0);
    const fileA = path.join(worktreeA, "node_modules", "shared-dep", "index.js");
    const fileB = path.join(worktreeB, "node_modules", "shared-dep", "index.js");
    const [statA, statB] = await Promise.all([fs.stat(fileA), fs.stat(fileB)]);
    expect(statA.ino).toBe(statB.ino);
    expect(statA.nlink).toBeGreaterThanOrEqual(3);

    const footprint = await measureWorktreeFootprint(worktreeB);
    expect(footprint.nodeModulesBytes).toBeGreaterThan(200_000);
    expect(footprint.privateBytes).toBeLessThan(footprint.totalBytes / 4);
  }, 120_000);
});
