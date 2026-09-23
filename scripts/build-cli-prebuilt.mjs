#!/usr/bin/env node
/**
 * DUR-3998: build the Paperclip CLI once, for the Docker image.
 *
 * Every agent command runs the CLI as
 *
 *     node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts <command...>
 *
 * (baked into agent instructions, skills, docs, the deploy runner and the
 * Telegram bridge). Until now that compiled the CLI's TypeScript on every
 * call: tsx starts an `esbuild` helper process, compiles cli/ plus the
 * workspace packages it imports, and only then runs the command -- with the
 * compile cache off on purpose (TSX_DISABLE_CACHE=1, DUR-3994 Stage 2), since
 * /tmp is a folder every agent can write. Slow, and until the container got an
 * init process, one dead helper per call.
 *
 * This script, run in the Dockerfile's build stage, makes the same command
 * line run a prebuilt program instead:
 *
 *   1. Bundles the CLI with esbuild into cli/dist/index.js using the same
 *      configuration as the npm build (cli/esbuild.config.mjs: one file, the
 *      workspace packages bundled in, third-party packages left external),
 *      targeting the Node this runs on and without a source map.
 *   2. Links the external packages the bundle imports but that only a
 *      workspace package (not cli/) depends on -- so Node can find them from
 *      cli/dist/index.js -- as cli/dist/node_modules/<name> -> that package's
 *      own copy. (The npm build gets the same effect by merging every
 *      package's dependencies into the published package.json.)
 *   3. With --install-shim (the image only; never a developer checkout):
 *      replaces cli/node_modules/tsx -- pnpm's link into the shared tsx
 *      package -- with a folder that mirrors that package link by link,
 *      except that dist/cli.mjs is scripts/cli-prebuilt-shim.mjs, which runs
 *      the bundle in-process when asked for cli/src/index.ts and hands
 *      anything else to the real tsx (kept as dist/tsx-cli.mjs). The server's
 *      own tsx loader (server/node_modules/tsx/dist/loader.mjs) is untouched.
 *   4. Runs the result: the bundle, and (with the shim) the exact command line
 *      above, with esbuild made unusable -- so a build in which the shim still
 *      reached tsx fails here, not on the box.
 *
 * Usage:
 *   node scripts/build-cli-prebuilt.mjs                 # bundle, link, smoke-run
 *   node scripts/build-cli-prebuilt.mjs --install-shim  # ...and take over tsx's CLI entry
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import config, { externals, workspacePaths } from "../cli/esbuild.config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliDir = path.join(repoRoot, "cli");
const distDir = path.join(cliDir, "dist");
const bundle = path.join(distDir, "index.js");
const shimSource = path.join(repoRoot, "scripts", "cli-prebuilt-shim.mjs");
const tsxDir = path.join(cliDir, "node_modules", "tsx");
const realTsxCliName = "tsx-cli.mjs";
const installShim = process.argv.includes("--install-shim");

function log(message) {
  console.log(`[build-cli-prebuilt] ${message}`);
}

function fail(message) {
  console.error(`[build-cli-prebuilt] ERROR: ${message}`);
  process.exit(1);
}

function relativeLink(linkPath, targetPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(linkPath), targetPath), linkPath);
}

// ── 1. Bundle ─────────────────────────────────────────────────────────────────
const nodeMajor = process.versions.node.split(".")[0];
fs.rmSync(distDir, { recursive: true, force: true });
await esbuild.build({
  ...config,
  absWorkingDir: cliDir,
  target: `node${nodeMajor}`,
  sourcemap: false,
  logLevel: "warning",
});
fs.chmodSync(bundle, 0o755);
log(`bundled cli/src/index.ts -> cli/dist/index.js (${fs.statSync(bundle).size} bytes, target node${nodeMajor})`);

// ── 2. Link the externals Node could not find from cli/dist/index.js ─────────
// Node looks a bare import up in node_modules folders from the importing
// file's folder upwards: cli/dist, cli, the repository root.
function findableFromBundle(name) {
  return [distDir, cliDir, repoRoot].some((dir) => fs.existsSync(path.join(dir, "node_modules", name)));
}

const linked = [];
const notInstalled = [];
for (const name of [...externals].sort()) {
  if (findableFromBundle(name)) continue;
  const owner = workspacePaths.find((p) => fs.existsSync(path.join(repoRoot, p, "node_modules", name)));
  if (!owner) {
    notInstalled.push(name); // an optional dependency that is not installed
    continue;
  }
  relativeLink(path.join(distDir, "node_modules", name), path.join(repoRoot, owner, "node_modules", name));
  linked.push(`${name} -> ${owner}/node_modules/${name}`);
}
log(`linked ${linked.length} external package(s) next to the bundle${linked.length ? ": " + linked.join(", ") : ""}`);
if (notInstalled.length) log(`not installed anywhere (left to fail at use, as before): ${notInstalled.join(", ")}`);

// ── 3. Take over tsx's CLI entry (image only) ─────────────────────────────────
if (installShim) {
  const shimPath = path.join(tsxDir, "dist", "cli.mjs");
  const realTsxCli = path.join(tsxDir, "dist", realTsxCliName);
  let stat;
  try {
    stat = fs.lstatSync(tsxDir);
  } catch {
    fail(`${path.relative(repoRoot, tsxDir)} does not exist: run pnpm install first`);
  }
  if (stat.isSymbolicLink()) {
    const real = fs.realpathSync(tsxDir);
    fs.unlinkSync(tsxDir);
    fs.mkdirSync(path.join(tsxDir, "dist"), { recursive: true });
    for (const entry of fs.readdirSync(real)) {
      if (entry !== "dist") relativeLink(path.join(tsxDir, entry), path.join(real, entry));
    }
    for (const entry of fs.readdirSync(path.join(real, "dist"))) {
      if (entry !== "cli.mjs") relativeLink(path.join(tsxDir, "dist", entry), path.join(real, "dist", entry));
    }
    relativeLink(realTsxCli, path.join(real, "dist", "cli.mjs"));
    log(`replaced the ${path.relative(repoRoot, tsxDir)} link with a mirror of ${path.relative(repoRoot, real)}`);
  } else if (!fs.existsSync(realTsxCli)) {
    fail(
      `${path.relative(repoRoot, tsxDir)} is a plain folder without dist/${realTsxCliName}: ` +
        "neither pnpm's link nor an earlier install of the shim; refusing to touch it",
    );
  }
  fs.copyFileSync(shimSource, shimPath);
  fs.chmodSync(shimPath, 0o755);
  log(`installed scripts/cli-prebuilt-shim.mjs as ${path.relative(repoRoot, shimPath)} (real tsx kept as dist/${realTsxCliName})`);
}

// ── 4. Run it ─────────────────────────────────────────────────────────────────
function run(label, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    timeout: 120_000,
  });
  if (result.error) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) fail(`${label}: exit ${result.status}\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

const expectedVersion = JSON.parse(fs.readFileSync(path.join(cliDir, "package.json"), "utf8")).version;
const direct = run("node cli/dist/index.js --version", [bundle, "--version"]);
if (direct !== expectedVersion) fail(`node cli/dist/index.js --version printed "${direct}", expected "${expectedVersion}"`);
run("node cli/dist/index.js issue --help", [bundle, "issue", "--help"]);
log(`cli/dist/index.js runs (version ${direct})`);

if (installShim) {
  // With ESBUILD_BINARY_PATH pointing at a program that is not esbuild, any
  // attempt to compile TypeScript fails outright ("The service was stopped").
  // The shim must never get there for the CLI entry...
  const noEsbuild = { ESBUILD_BINARY_PATH: "/bin/false" };
  const entry = ["cli/node_modules/tsx/dist/cli.mjs", "cli/src/index.ts"];
  const viaShim = run("the CLI command line with esbuild unusable", [...entry, "--version"], noEsbuild);
  if (viaShim !== expectedVersion) fail(`the CLI command line printed "${viaShim}", expected "${expectedVersion}"`);
  run("the CLI command line: issue --help", [...entry, "issue", "--help"], noEsbuild);
  // ...and must still be tsx for anything else.
  const tsxVersion = run("tsx's own --version through the shim", ["cli/node_modules/tsx/dist/cli.mjs", "--version"]);
  if (!/^tsx v\d/.test(tsxVersion)) fail(`the shim did not hand "--version" to the real tsx (got "${tsxVersion}")`);
  log(`the CLI command line runs the bundle without esbuild; other scripts still get ${tsxVersion}`);
}
