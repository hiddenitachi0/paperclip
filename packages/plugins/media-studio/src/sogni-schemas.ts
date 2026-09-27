// Sogni's own published tool schemas, vendored unchanged under
// vendor/sogni/<package>@<version>/ (see its VENDORED.md, and
// scripts/sync-sogni-schemas.mjs to update them). vendor/sogni/current.json
// names the folder in use.
//
// The build copies vendor/ into dist/vendor/ (scripts/copy-vendor.mjs), so the
// built plugin carries its own copy: from dist/*.js the files are at
// ./vendor/sogni/, from src/*.ts (tests, tsx) at ../vendor/sogni/.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertSupportedSchema, type JsonSchema } from "./json-schema-check.js";

export interface SogniVendorInfo {
  package: string;
  version: string;
  /** The folder under vendor/sogni/ holding the files. */
  dir: string;
  files: string[];
}

const ROOT_CANDIDATES = [new URL("./vendor/sogni/", import.meta.url), new URL("../vendor/sogni/", import.meta.url)];

let cachedRoot: URL | null = null;

function vendorRoot(): URL {
  if (cachedRoot) return cachedRoot;
  const found = ROOT_CANDIDATES.find((candidate) => existsSync(fileURLToPath(new URL("current.json", candidate))));
  if (!found) {
    throw new Error("Media Studio's copy of Sogni's tool descriptions is missing (vendor/sogni). Rebuild the plugin.");
  }
  cachedRoot = found;
  return found;
}

function readJson(url: URL): unknown {
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

let cachedInfo: SogniVendorInfo | null = null;

/** Which package and version the vendored schemas come from. */
export function sogniVendorInfo(): SogniVendorInfo {
  if (cachedInfo) return cachedInfo;
  const raw = readJson(new URL("current.json", vendorRoot())) as Partial<SogniVendorInfo>;
  if (typeof raw.package !== "string" || typeof raw.version !== "string" || typeof raw.dir !== "string" || !Array.isArray(raw.files)) {
    throw new Error("vendor/sogni/current.json is not readable.");
  }
  cachedInfo = { package: raw.package, version: raw.version, dir: raw.dir, files: raw.files.filter((f): f is string => typeof f === "string") };
  return cachedInfo;
}

function vendoredFile(path: string): unknown {
  const info = sogniVendorInfo();
  if (!info.files.includes(path)) throw new Error(`${path} is not one of the vendored Sogni files (vendor/sogni/current.json).`);
  return readJson(new URL(`${info.dir}/${path}`, vendorRoot()));
}

const schemaCache = new Map<string, JsonSchema>();

/** Sogni's argument schema for one tool (e.g. "upscale_image"), exactly as published. */
export function sogniToolSchema(toolName: string): JsonSchema {
  const cached = schemaCache.get(toolName);
  if (cached) return cached;
  if (!/^[a-z0-9_]+$/.test(toolName)) throw new Error(`"${toolName}" is not a Sogni tool name.`);
  const schema = vendoredFile(`schemas/tools/${toolName}.schema.json`) as JsonSchema;
  assertSupportedSchema(schema, toolName);
  if (schema.type !== "object") throw new Error(`Sogni's ${toolName} schema does not describe a set of arguments.`);
  schemaCache.set(toolName, schema);
  return schema;
}

/** Sogni's canonical tool names (enums/tool-names.json): "hosted" run on Sogni's servers. */
export function sogniToolNames(): { hosted: string[]; all: string[] } {
  const raw = vendoredFile("enums/tool-names.json") as { hosted?: unknown; all?: unknown };
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  return { hosted: list(raw.hosted), all: list(raw.all) };
}
