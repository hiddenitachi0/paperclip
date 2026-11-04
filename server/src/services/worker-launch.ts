import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export interface WorkerLaunch {
  url: URL;
  /** Left undefined for the compiled worker so the thread inherits the parent's flags. */
  execArgv?: string[];
}

/**
 * Where a worker thread starts, and with which Node flags. Shared by every
 * service that starts a `worker_threads` Worker from this directory (candle
 * store, past-data tests and template reports, contract extraction).
 *
 * Compiled worker: `execArgv` is deliberately left out. An explicit array,
 * even an empty one, replaces Node's default of inheriting the parent's
 * flags, and the server is started with `--import tsx` (the workspace packages
 * are loaded from `.ts` source) and `--require node-module-guard.cjs` (the
 * trusted-code module guard, DUR-3994). Passing `[]` made the worker lose both
 * (DUR-5129, DUR-5161): it could not resolve `./client.js` to `client.ts`, and
 * it would have run outside the module guard.
 *
 * Spread the result with `...(execArgv ? { execArgv } : {})`, never pass
 * `execArgv` through unconditionally. A test enforces this for every Worker
 * in this directory.
 *
 * `base` is the worker's file name without extension, e.g. "trading-candle-worker".
 * `from` is the importing module's `import.meta.url`.
 */
export function resolveWorkerLaunch(
  base: string,
  from: string | URL,
  compiledExists: boolean = existsSync(new URL(`./${base}.js`, from)),
): WorkerLaunch {
  if (compiledExists) return { url: new URL(`./${base}.js`, from) };
  // Source run (tsx / vitest): load the .ts worker through tsx. Resolve tsx from
  // the importing file, not the process cwd: tests run from the repo root, where it is not installed.
  const tsx = pathToFileURL(createRequire(from).resolve("tsx/esm")).href;
  return { url: new URL(`./${base}.ts`, from), execArgv: ["--import", tsx] };
}

/** Worker constructor options for a launch: `execArgv` only when the launch sets it. */
export function workerLaunchOptions(launch: WorkerLaunch): { execArgv?: string[] } {
  return launch.execArgv ? { execArgv: launch.execArgv } : {};
}
