#!/usr/bin/env node
/**
 * DUR-3998: run the prebuilt Paperclip CLI from tsx's command-line entry.
 *
 * In the Docker image this file REPLACES tsx's own command-line entry at
 * cli/node_modules/tsx/dist/cli.mjs (scripts/build-cli-prebuilt.mjs installs
 * it at image build time; a developer checkout is never touched). Agent
 * instructions, skills, docs, the deploy runner and the Telegram bridge all
 * start the CLI as
 *
 *     node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts <command...>
 *
 * which used to compile the CLI's TypeScript on every call: tsx starts an
 * `esbuild` helper process, compiles cli/ and the workspace packages it
 * imports (the compile cache is off on purpose -- TSX_DISABLE_CACHE=1, DUR-3994
 * Stage 2 -- because /tmp is a folder every agent can write) and only then
 * runs the command. That made every agent command slow and, until the
 * container got an init process, left one dead helper behind per call.
 *
 * Now the CLI is bundled once, at image build time, into cli/dist/index.js and
 * this file runs that bundle in-process: no tsx, no esbuild, no compile. The
 * command line above is unchanged, so nothing that runs the CLI has to change.
 *
 * Only the CLI entry is taken over. When the first argument is anything but
 * cli/src/index.ts (another script, a tsx flag, nothing at all), or the bundle
 * is missing, the real tsx runs exactly as before: the installer keeps it next
 * to this file as tsx-cli.mjs (a link into tsx's own package, so its relative
 * imports still resolve).
 *
 * Paths are worked out from this file's own location, so the same file works
 * in the image (/app/cli/...) and in a test layout.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // <root>/cli/node_modules/tsx/dist
const cliDir = path.resolve(here, "..", "..", ".."); // <root>/cli
const CLI_ENTRY = path.join(cliDir, "src", "index.ts");
const PREBUILT = path.join(cliDir, "dist", "index.js");
const REAL_TSX = path.join(here, "tsx-cli.mjs");

function realOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function isCliEntry(arg) {
  if (typeof arg !== "string" || arg.length === 0 || arg.startsWith("-")) return false;
  return realOrSelf(path.resolve(arg)) === realOrSelf(CLI_ENTRY);
}

if (isCliEntry(process.argv[2]) && fs.existsSync(PREBUILT)) {
  // What Node gives a program it starts directly: [node, program, ...args].
  // The CLI (commander) reads its command from process.argv.slice(2), the same
  // as it did in the child process tsx used to start.
  process.argv = [process.argv[0], PREBUILT, ...process.argv.slice(3)];
  await import(pathToFileURL(PREBUILT).href);
} else {
  await import(pathToFileURL(REAL_TSX).href);
}
