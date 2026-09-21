/**
 * External adapter plugin loader.
 *
 * Loads external adapter packages from the adapter-plugin-store and returns
 * their ServerAdapterModule instances. The caller (registry.ts) is
 * responsible for registering them.
 *
 * This avoids circular initialization: plugin-loader imports only
 * adapter-utils, never registry.ts.
 */

import fs from "node:fs";
import path from "node:path";
import type { ServerAdapterModule } from "./types.js";
import { logger } from "../middleware/logger.js";

import {
  listAdapterPlugins,
  getAdapterPluginsDir,
  getAdapterPluginByType,
} from "../services/adapter-plugin-store.js";
import type { AdapterPluginRecord } from "../services/adapter-plugin-store.js";
import {
  adapterCodeRoot,
  detectTrustedCodeMode,
  getConfiguredTrustedCode,
  isPathInside,
  waitForConfiguredTrustedCode,
  type TrustedCodeSubject,
} from "../services/trusted-code.js";

// ---------------------------------------------------------------------------
// DUR-3994 Stage 2: add-on code fingerprints
// ---------------------------------------------------------------------------

/**
 * How long the external-adapter loader (which starts when this module is
 * first imported, before the server has a database) waits for the server to
 * set up the trusted-code check. The server does that right after its
 * database migrations, well within this.
 */
const TRUSTED_CODE_WAIT_MS = 10 * 60 * 1000;

function adapterSubject(record: Pick<AdapterPluginRecord, "localPath" | "type">): TrustedCodeSubject {
  return {
    kind: "adapter",
    codeRoot: adapterCodeRoot(record, getAdapterPluginsDir()),
    label: record.type,
  };
}

/**
 * Refuse (throw, with a plain message) to load an external adapter whose
 * files changed since Paperclip installed it. Enforced only where the
 * server's own program files are read-only (see services/trusted-code.ts);
 * elsewhere it returns at once without waiting for anything.
 */
async function assertAdapterCodeTrusted(record: Pick<AdapterPluginRecord, "localPath" | "type">): Promise<void> {
  const configured = getConfiguredTrustedCode();
  if (!configured && detectTrustedCodeMode() === "off") return;
  const service = configured ?? (await waitForConfiguredTrustedCode(TRUSTED_CODE_WAIT_MS));
  if (!service) {
    throw new Error(
      `Paperclip did not start the adapter "${record.type}" because it could not check its files ` +
        `(the trusted-code check was never set up).`,
    );
  }
  await service.assertTrusted(adapterSubject(record));
}

/**
 * Record an external adapter's code folder as trusted, right after Paperclip
 * itself installed it (install / reinstall routes). Throws if the files could
 * not be recorded while the check is enforced.
 */
export async function recordExternalAdapterCode(
  record: Pick<AdapterPluginRecord, "localPath" | "type">,
  reason: "install" | "reinstall" | "uninstall",
): Promise<void> {
  const configured = getConfiguredTrustedCode();
  if (!configured) {
    if (detectTrustedCodeMode() === "off") return;
    throw new Error("the trusted-code check is not set up yet");
  }
  await configured.record(adapterSubject(record), reason);
}

/**
 * Before Paperclip runs npm in the shared managed adapter folder (install,
 * reinstall, uninstall): make sure the folder is still what was recorded,
 * or set it aside so the install starts clean (see
 * TrustedCodeService.prepareSharedFolder). Throws only if the check could
 * not be done while it is enforced.
 */
export async function prepareManagedAdapterFolder(): Promise<{ movedAsideTo: string | null }> {
  const configured = getConfiguredTrustedCode();
  if (!configured) {
    if (detectTrustedCodeMode() === "off") return { movedAsideTo: null };
    throw new Error("the trusted-code check is not set up yet");
  }
  return configured.prepareSharedFolder({
    kind: "adapter",
    codeRoot: adapterCodeRoot({ localPath: undefined }, getAdapterPluginsDir()),
    label: "managed adapter folder",
  });
}

// ---------------------------------------------------------------------------
// In-memory UI parser cache
// ---------------------------------------------------------------------------

const uiParserCache = new Map<string, string>();

export function getUiParserSource(adapterType: string): string | undefined {
  return uiParserCache.get(adapterType);
}

/**
 * On cache miss, attempt on-demand extraction from the plugin store.
 * Makes the ui-parser.js endpoint self-healing.
 */
export function getOrExtractUiParserSource(adapterType: string): string | undefined {
  const cached = uiParserCache.get(adapterType);
  if (cached) return cached;

  const record = getAdapterPluginByType(adapterType);
  if (!record) return undefined;
  if (!record.localPath && !isSafeNpmPackageName(record.packageName)) return undefined;

  const packageDir = resolvePackageDir(record);
  const source = extractUiParserSource(packageDir, record.packageName, record);
  if (source) {
    uiParserCache.set(adapterType, source);
    logger.info(
      { type: adapterType, packageName: record.packageName, origin: "lazy" },
      "UI parser extracted on-demand (cache miss)",
    );
  }
  return source;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * An npm package name as npm itself allows it: "name" or "@scope/name", with
 * no absolute path and no "." / ".." part. The name of an npm-installed
 * adapter comes from adapter-plugins.json, which agents can write; without
 * this, "../../somewhere" (or "/somewhere") made the server import a folder
 * outside the checked managed folder.
 */
const NPM_PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

export function isSafeNpmPackageName(packageName: unknown): packageName is string {
  if (typeof packageName !== "string" || packageName.length === 0 || packageName.length > 214) return false;
  if (!NPM_PACKAGE_NAME_RE.test(packageName)) return false;
  return packageName.split("/").every((part) => part !== "." && part !== "..");
}

function managedPackageDir(packageName: string): string {
  if (!isSafeNpmPackageName(packageName)) {
    throw new Error(
      `Paperclip did not load the adapter package "${packageName}": that is not a valid npm package name ` +
        `(adapter-plugins.json may have been edited).`,
    );
  }
  return path.resolve(getAdapterPluginsDir(), "node_modules", packageName);
}

function resolvePackageDir(record: Pick<AdapterPluginRecord, "localPath" | "packageName">): string {
  return record.localPath ? path.resolve(record.localPath) : managedPackageDir(record.packageName);
}

function realpathOrResolve(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * DUR-3994 Stage 2: the package folder and the file that gets imported must
 * both be inside the folder whose fingerprint was just checked. Otherwise a
 * record, a package.json "main"/"exports" or a symbolic link could send the
 * import to code nobody checked. Enforced only where the check is.
 */
function assertAdapterModuleInsideCodeRoot(
  record: Pick<AdapterPluginRecord, "localPath" | "type">,
  packageDir: string,
  modulePath: string,
): void {
  const configured = getConfiguredTrustedCode();
  const enforced = configured ? configured.mode === "enforce" : detectTrustedCodeMode() === "enforce";
  if (!enforced) return;
  const codeRoot = realpathOrResolve(adapterSubject(record).codeRoot);
  for (const candidate of [packageDir, modulePath]) {
    if (!isPathInside(realpathOrResolve(candidate), codeRoot)) {
      throw new Error(
        `Paperclip did not load the adapter "${record.type}" because its code (${candidate}) is outside ` +
          `its own checked folder (${codeRoot}).`,
      );
    }
  }
}

function resolvePackageEntryPoint(packageDir: string): string {
  const pkgJsonPath = path.join(packageDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));

  if (pkg.exports && typeof pkg.exports === "object" && pkg.exports["."]) {
    const exp = pkg.exports["."];
    return typeof exp === "string" ? exp : (exp.import ?? exp.default ?? "index.js");
  }
  return pkg.main ?? "index.js";
}

// ---------------------------------------------------------------------------
// UI parser extraction
// ---------------------------------------------------------------------------

const SUPPORTED_PARSER_CONTRACT = "1";

function extractUiParserSource(
  packageDir: string,
  packageName: string,
  trustedRecord?: Pick<AdapterPluginRecord, "localPath" | "type">,
): string | undefined {
  const pkgJsonPath = path.join(packageDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));

  if (!pkg.exports || typeof pkg.exports !== "object" || !pkg.exports["./ui-parser"]) {
    return undefined;
  }

  const contractVersion = pkg.paperclip?.adapterUiParser;
  if (contractVersion) {
    const major = contractVersion.split(".")[0];
    if (major !== SUPPORTED_PARSER_CONTRACT) {
      logger.warn(
        { packageName, contractVersion, supported: `${SUPPORTED_PARSER_CONTRACT}.x` },
        "Adapter declares unsupported UI parser contract version — skipping UI parser",
      );
      return undefined;
    }
  } else {
    logger.info(
      { packageName },
      "Adapter has ./ui-parser export but no paperclip.adapterUiParser version — loading anyway (future versions may require it)",
    );
  }

  const uiParserExp = pkg.exports["./ui-parser"];
  const uiParserFile = typeof uiParserExp === "string"
    ? uiParserExp
    : (uiParserExp.import ?? uiParserExp.default);
  const uiParserPath = path.resolve(packageDir, uiParserFile);

  if (!uiParserPath.startsWith(packageDir + path.sep) && uiParserPath !== packageDir) {
    logger.warn(
      { packageName, uiParserFile },
      "UI parser path escapes package directory — skipping",
    );
    return undefined;
  }

  if (!fs.existsSync(uiParserPath)) {
    return undefined;
  }

  // DUR-3994 Stage 2: this source is sent to the board's browser and run
  // there. Serve it only if the file is exactly what Paperclip installed.
  if (trustedRecord) {
    const configured = getConfiguredTrustedCode();
    const enforced = configured ? configured.mode === "enforce" : detectTrustedCodeMode() === "enforce";
    if (enforced && !(configured?.checkFileSync(adapterSubject(trustedRecord), uiParserPath) ?? false)) {
      logger.warn(
        { packageName, uiParserFile },
        "Refusing the adapter's UI parser: the file changed after the adapter was installed",
      );
      return undefined;
    }
  }

  try {
    const source = fs.readFileSync(uiParserPath, "utf-8");
    logger.info(
      { packageName, uiParserFile, size: source.length },
      `Loaded UI parser from adapter package${contractVersion ? "" : " (no version declared)"}`,
    );
    return source;
  } catch (err) {
    logger.warn({ err, packageName, uiParserFile }, "Failed to read UI parser from adapter package");
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Load / reload
// ---------------------------------------------------------------------------

function validateAdapterModule(mod: unknown, packageName: string): ServerAdapterModule {
  const m = mod as Record<string, unknown>;
  const createServerAdapter = m.createServerAdapter;
  if (typeof createServerAdapter !== "function") {
    throw new Error(
      `Package "${packageName}" does not export createServerAdapter(). ` +
      `Ensure the package's main entry exports a createServerAdapter function.`,
    );
  }

  const adapterModule = createServerAdapter() as ServerAdapterModule;
  if (!adapterModule || !adapterModule.type) {
    throw new Error(
      `createServerAdapter() from "${packageName}" returned an invalid module (missing "type").`,
    );
  }
  return adapterModule;
}

export async function loadExternalAdapterPackage(
  packageName: string,
  localPath?: string,
  trustedRecord?: Pick<AdapterPluginRecord, "localPath" | "type">,
): Promise<ServerAdapterModule> {
  const packageDir = localPath ? path.resolve(localPath) : managedPackageDir(packageName);

  const entryPoint = resolvePackageEntryPoint(packageDir);
  const modulePath = path.resolve(packageDir, entryPoint);
  assertAdapterModuleInsideCodeRoot(
    trustedRecord ?? { localPath, type: packageName },
    packageDir,
    modulePath,
  );
  const uiParserSource = extractUiParserSource(packageDir, packageName, trustedRecord);

  logger.info({ packageName, packageDir, entryPoint, modulePath, hasUiParser: !!uiParserSource }, "Loading external adapter package");

  const mod = await import(modulePath);
  const adapterModule = validateAdapterModule(mod, packageName);

  if (uiParserSource) {
    uiParserCache.set(adapterModule.type, uiParserSource);
  }

  return adapterModule;
}

async function loadFromRecord(record: AdapterPluginRecord): Promise<ServerAdapterModule | null> {
  try {
    // DUR-3994 Stage 2: checked before anything from the package is imported.
    await assertAdapterCodeTrusted(record);
    return await loadExternalAdapterPackage(record.packageName, record.localPath, record);
  } catch (err) {
    logger.warn(
      { err, packageName: record.packageName, type: record.type },
      "Failed to dynamically load external adapter; skipping",
    );
    return null;
  }
}

/**
 * Reload an external adapter at runtime (dev iteration without server restart).
 * Busts the ESM module cache via a cache-busting query string.
 */
export async function reloadExternalAdapter(
  type: string,
): Promise<ServerAdapterModule | null> {
  const record = getAdapterPluginByType(type);
  if (!record) return null;

  // DUR-3994 Stage 2: reloading reads the files from disk again; refuse if
  // they changed since Paperclip installed them.
  await assertAdapterCodeTrusted(record);

  const packageDir = resolvePackageDir(record);
  const entryPoint = resolvePackageEntryPoint(packageDir);
  const modulePath = path.resolve(packageDir, entryPoint);
  assertAdapterModuleInsideCodeRoot(record, packageDir, modulePath);
  const fileUrl = `file://${modulePath}`;

  // Bust ESM module cache so re-import loads fresh code from disk.
  // Query-string trick (?t=...) works in Node; Bun may need the file:// URL
  // to be evicted from its internal registry first.
  try {
    // @ts-expect-error -- Bun internal module cache
    const bunCache = globalThis.Bun?.__moduleCache as Map<string, unknown> | undefined;
    if (bunCache) {
      bunCache.delete(fileUrl);
      bunCache.delete(modulePath);
    }
  } catch {
    // Ignore — query-string fallback still works in Node
  }

  const cacheBustUrl = `${fileUrl}?t=${Date.now()}`;

  logger.info(
    { type, packageName: record.packageName, modulePath, cacheBustUrl },
    "Reloading external adapter (cache bust)",
  );

  const mod = await import(cacheBustUrl);
  const adapterModule = validateAdapterModule(mod, record.packageName);

  uiParserCache.delete(type);
  const uiParserSource = extractUiParserSource(packageDir, record.packageName, record);
  if (uiParserSource) {
    uiParserCache.set(adapterModule.type, uiParserSource);
  }

  logger.info(
    { type, packageName: record.packageName, hasUiParser: !!uiParserSource },
    "Successfully reloaded external adapter",
  );

  return adapterModule;
}

/**
 * Build all external adapter modules from the plugin store.
 */
export async function buildExternalAdapters(): Promise<ServerAdapterModule[]> {
  const results: ServerAdapterModule[] = [];

  const storeRecords = listAdapterPlugins();
  for (const record of storeRecords) {
    const adapter = await loadFromRecord(record);
    if (adapter) {
      results.push(adapter);
    }
  }

  if (results.length > 0) {
    logger.info(
      { count: results.length, adapters: results.map((a) => a.type) },
      "Loaded external adapters from plugin store",
    );
  }

  return results;
}
