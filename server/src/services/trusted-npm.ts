/**
 * DUR-3994 Stage 2: run npm for add-on installs without reading settings
 * agents can write.
 *
 * Paperclip records whatever npm leaves in an add-on folder as trusted code
 * (services/trusted-code.ts). npm normally reads settings from places every
 * agent can write, because agents run as the same user as the server:
 *   - the user's ~/.npmrc (which registry to download from, per-scope
 *     registries, ...);
 *   - npm_config_* environment variables;
 *   - its download cache in ~/.npm.
 * An agent could point npm at its own registry, or plant a package in the
 * cache, and the next install an admin does would fetch the agent's code and
 * trust it. So every install/uninstall Paperclip runs gets:
 *   - empty user and global settings files of its own;
 *   - an explicit registry (the public npm registry, or
 *     PAPERCLIP_NPM_REGISTRY from the server's own settings);
 *   - a fresh, private download cache, removed afterwards;
 *   - an environment without any npm_config_* variable.
 * The folder being installed into is checked first (its .npmrc and
 * package.json are part of it): see TrustedCodeService.prepareSharedFolder.
 *
 * Install scripts are left as each call site had them: they are part of the
 * package the admin chose, run as the same user agents already are, and
 * whatever they write is fingerprinted with the rest.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/";

export interface IsolatedNpmInvocation {
  args: string[];
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

export function npmRegistryForInstalls(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PAPERCLIP_NPM_REGISTRY?.trim();
  if (configured && /^https?:\/\//i.test(configured)) return configured;
  return DEFAULT_NPM_REGISTRY;
}

/** The server's environment without anything that changes npm's settings. */
export function npmSafeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^npm_config_/i.test(key)) continue;
    if (key === "NPM_TOKEN" || key === "NODE_AUTH_TOKEN") continue;
    out[key] = value;
  }
  return out;
}

export async function buildIsolatedNpmInvocation(
  baseArgs: string[],
  options: { env?: NodeJS.ProcessEnv; tmpRoot?: string } = {},
): Promise<IsolatedNpmInvocation> {
  const sourceEnv = options.env ?? process.env;
  const dir = await fsp.mkdtemp(path.join(options.tmpRoot ?? os.tmpdir(), "paperclip-npm-"));
  const userConfig = path.join(dir, "user-npmrc");
  const globalConfig = path.join(dir, "global-npmrc");
  const cacheDir = path.join(dir, "cache");
  await fsp.writeFile(userConfig, "", { mode: 0o600 });
  await fsp.writeFile(globalConfig, "", { mode: 0o600 });
  await fsp.mkdir(cacheDir, { mode: 0o700 });
  return {
    args: [
      ...baseArgs,
      "--userconfig",
      userConfig,
      "--globalconfig",
      globalConfig,
      "--registry",
      npmRegistryForInstalls(sourceEnv),
      "--cache",
      cacheDir,
      "--no-audit",
      "--no-fund",
      "--no-update-notifier",
    ],
    env: npmSafeEnv(sourceEnv),
    cleanup: () => fsp.rm(dir, { recursive: true, force: true }),
  };
}

type ExecFileAsync = (
  file: string,
  args: string[],
  options: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv },
) => Promise<unknown>;

/** Run `npm <args>` with the isolation above. */
export async function runIsolatedNpm(
  execFileAsync: ExecFileAsync,
  baseArgs: string[],
  options: { cwd?: string; timeout?: number } = {},
): Promise<void> {
  const invocation = await buildIsolatedNpmInvocation(baseArgs);
  try {
    await execFileAsync("npm", invocation.args, { ...options, env: invocation.env });
  } finally {
    await invocation.cleanup().catch(() => {});
  }
}
