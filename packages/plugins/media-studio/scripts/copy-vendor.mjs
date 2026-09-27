#!/usr/bin/env node
// Part of the build: copy the vendored Sogni schemas in use (vendor/sogni/
// current.json and the folder it names) into dist/vendor/sogni/, so the built
// plugin carries them (src/sogni-schemas.ts reads ./vendor/sogni/ next to the
// built files). Plain file copies, no dependencies.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "vendor", "sogni");
const to = path.join(root, "dist", "vendor", "sogni");

const pointer = JSON.parse(readFileSync(path.join(from, "current.json"), "utf8"));
const folder = path.join(from, pointer.dir);
for (const file of pointer.files) {
  if (!existsSync(path.join(folder, file))) {
    console.error(`vendor/sogni/${pointer.dir}/${file} is missing. Run scripts/sync-sogni-schemas.mjs ${pointer.version}.`);
    process.exit(1);
  }
}
rmSync(path.join(root, "dist", "vendor"), { recursive: true, force: true });
mkdirSync(to, { recursive: true });
cpSync(path.join(from, "current.json"), path.join(to, "current.json"));
cpSync(folder, path.join(to, pointer.dir), { recursive: true });
console.log(`Copied Sogni schemas (${pointer.package}@${pointer.version}) into dist/vendor/sogni.`);
