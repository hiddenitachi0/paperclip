#!/usr/bin/env node
// Re-vendor Sogni's published tool schemas into vendor/sogni/.
//
//   node packages/plugins/media-studio/scripts/sync-sogni-schemas.mjs <version> [--keep-old]
//
// Downloads @sogni-ai/sogni-protocol@<version> with `npm pack` (a public
// download, no Sogni key), copies ONLY the files listed in
// vendor/sogni/current.json ("files") into vendor/sogni/sogni-protocol@<version>/,
// writes LICENSE and VENDORED.md next to them, and points current.json at the
// new folder. The old folder is removed unless --keep-old is given.
//
// Not run in CI. After running it: read the diff of the JSON files, run the
// media-studio tests (they check every vendored schema only uses what the
// plugin's validator understands), and build the plugin.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = "@sogni-ai/sogni-protocol";
const here = path.dirname(fileURLToPath(import.meta.url));
const vendorRoot = path.resolve(here, "../vendor/sogni");
const pointerPath = path.join(vendorRoot, "current.json");

const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith("--"));
const keepOld = args.includes("--keep-old");
if (!version || !/^[0-9A-Za-z.+-]+$/.test(version)) {
  console.error("Usage: sync-sogni-schemas.mjs <version> [--keep-old]   e.g. 1.0.0-alpha.46");
  process.exit(1);
}

const pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
const files = pointer.files;
if (!Array.isArray(files) || files.length === 0 || files.some((f) => typeof f !== "string" || f.includes(".."))) {
  console.error(`${pointerPath} has no usable "files" list.`);
  process.exit(1);
}

const work = mkdtempSync(path.join(tmpdir(), "sogni-protocol-"));
try {
  const tarball = execFileSync("npm", ["pack", `${PACKAGE}@${version}`, "--silent", "--pack-destination", work], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .pop();
  execFileSync("tar", ["-xzf", path.join(work, tarball), "-C", work]);
  const pkgDir = path.join(work, "package");
  const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  if (pkg.name !== PACKAGE || pkg.version !== version) throw new Error(`npm gave ${pkg.name}@${pkg.version}, not ${PACKAGE}@${version}.`);

  const dirName = `sogni-protocol@${version}`;
  const target = path.join(vendorRoot, dirName);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  const rows = [];
  for (const file of files) {
    const from = path.join(pkgDir, file);
    if (!existsSync(from)) throw new Error(`${PACKAGE}@${version} has no ${file}. Remove it from current.json or pick another version.`);
    JSON.parse(readFileSync(from, "utf8")); // must be JSON
    mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
    cpSync(from, path.join(target, file));
    rows.push(`| \`${file}\` | \`${createHash("sha256").update(readFileSync(from)).digest("hex")}\` |`);
  }

  // The licence: the package's own file when it ships one, else the text of
  // the licence its package.json declares (only ISC is known here).
  const licenceFile = readdirSync(pkgDir).find((name) => /^licen[sc]e(\.|$)/i.test(name));
  let licenceNote;
  if (licenceFile) {
    cpSync(path.join(pkgDir, licenceFile), path.join(target, "LICENSE"));
    licenceNote = `LICENSE is the package's own \`${licenceFile}\`, copied unchanged.`;
  } else if (pkg.license === "ISC") {
    writeFileSync(path.join(target, "LICENSE"), iscText(version));
    licenceNote =
      'The package ships no licence file; its package.json declares `"license": "ISC"`. LICENSE holds the standard ISC licence text that declaration refers to.';
  } else {
    throw new Error(`${PACKAGE}@${version} declares licence "${pkg.license}" and ships no licence file. Check the licence by hand before vendoring.`);
  }

  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    path.join(target, "VENDORED.md"),
    [
      `# Vendored: ${PACKAGE}@${version}`,
      "",
      `- Source: npm package \`${PACKAGE}\`, version \`${version}\` (${pkg.license} licence), from \`npm pack ${PACKAGE}@${version}\`.`,
      `- Protocol version: \`${readProtocolVersion(pkgDir)}\` (the package's version.json).`,
      `- Vendored on: ${today}, by \`packages/plugins/media-studio/scripts/sync-sogni-schemas.mjs\`.`,
      `- Licence: ${licenceNote}`,
      "- Only the files below are copied, unchanged. Media Studio builds its Sogni tools' parameters from them",
      "  (src/sogni-schemas.ts, src/sogni-tools.ts); nothing else in the package is used.",
      "",
      "| File | sha256 |",
      "|---|---|",
      ...rows,
      "",
    ].join("\n"),
  );

  const previous = pointer.dir;
  writeFileSync(pointerPath, `${JSON.stringify({ ...pointer, package: PACKAGE, version, dir: dirName }, null, 2)}\n`);
  if (!keepOld && previous && previous !== dirName) rmSync(path.join(vendorRoot, previous), { recursive: true, force: true });
  console.log(`Vendored ${files.length} files from ${PACKAGE}@${version} into vendor/sogni/${dirName}.`);
  console.log("Next: review the diff, run the media-studio tests, and build the plugin.");
} finally {
  rmSync(work, { recursive: true, force: true });
}

function readProtocolVersion(pkgDir) {
  try {
    return JSON.parse(readFileSync(path.join(pkgDir, "version.json"), "utf8")).protocolVersion ?? "unknown";
  } catch {
    return "unknown";
  }
}

function iscText(v) {
  return `This is the licence of the npm package ${PACKAGE}@${v}, which
declares "license": "ISC" in its package.json and ships no licence file of
its own. The standard ISC licence text follows.

ISC License

Copyright (c) the authors of ${PACKAGE} (Sogni-AI, https://github.com/Sogni-AI/sogni-protocol)

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
`;
}
