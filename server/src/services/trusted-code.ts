/**
 * DUR-3994 Stage 2: agents can't plant code the server will run.
 *
 * Every agent runs as the same Linux user (`node`) as the Paperclip server,
 * so anything the server can write, an agent can write too. Two kinds of code
 * the server runs used to be writable that way:
 *
 *   1. Paperclip's own program files in /app. The Docker image now copies
 *      them in owned by root, so `node` (the server and every agent) can only
 *      read them. Nothing needs checking there at run time.
 *   2. Add-on code installed at run time: plugins (under
 *      ~/.paperclip/plugins or a local folder) and external adapters (under
 *      $PAPERCLIP_HOME/adapter-plugins or a local folder). These folders HAVE
 *      to stay writable -- installing an add-on writes them -- so ownership
 *      cannot protect them. Instead, when Paperclip itself installs an add-on
 *      it records a fingerprint (a sha256 of every file) of that code folder
 *      in the database, which agents cannot reach; before it loads the code it
 *      hashes the folder again and refuses to run it if anything changed. A
 *      refusal is logged in plain words in every company's Activity feed.
 *
 * Which code is checked
 *   A "code root" is the folder a plugin or adapter is loaded from: its own
 *   folder for a local-path install, or the whole managed install folder for
 *   an npm install (its dependencies sit next to it in that folder's
 *   node_modules and are loaded too). Code roots inside Paperclip's own
 *   program folder are protected by ownership instead and are not hashed.
 *
 * Enforce or off
 *   The check only means something when Paperclip's own program files are
 *   read-only too -- otherwise an agent could simply edit the server itself.
 *   So the server enforces it exactly when it cannot write its own program
 *   file (the hardened Docker image), and does nothing otherwise (a developer
 *   checkout, where editing a local plugin and reloading it is the normal
 *   workflow, and every existing test). That condition is set by the image
 *   and cannot be changed by an agent: an agent cannot make a root-owned file
 *   writable.
 *
 * Existing installs
 *   The first time a server with this check starts, it records the add-ons
 *   that are installed at that moment as trusted (once; a marker row makes
 *   sure it never happens again). From then on, only an install, upgrade or
 *   reinstall through Paperclip records new fingerprints; an add-on that
 *   appears any other way (for example a record an agent adds to
 *   adapter-plugins.json) is refused.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, plugins, trustedCodeFingerprints } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";

export type TrustedCodeMode = "enforce" | "off";
export type TrustedCodeKind = "plugin" | "adapter";
export type TrustedCodeRecordReason = "install" | "upgrade" | "reinstall" | "uninstall" | "first_start";

export interface TrustedCodeSubject {
  kind: TrustedCodeKind;
  /** The folder the code is loaded from (see "code root" above). */
  codeRoot: string;
  /** What a person would call it: the plugin key or adapter type. */
  label: string;
}

export type UntrustedCodeReason = "changed" | "unknown" | "unverifiable";

export class UntrustedCodeError extends Error {
  readonly reason: UntrustedCodeReason;
  readonly subject: TrustedCodeSubject;
  constructor(subject: TrustedCodeSubject, reason: UntrustedCodeReason, detail?: string) {
    super(describeRefusal(subject, reason, detail));
    this.name = "UntrustedCodeError";
    this.reason = reason;
    this.subject = subject;
  }
}

const MODULE_FILE = fileURLToPath(import.meta.url);
/** server/src/services or server/dist/services -> the repo / image root (/app). */
const DEFAULT_APP_ROOT = path.resolve(path.dirname(MODULE_FILE), "../../..");

export const FIRST_START_BASELINE_MARKER = "paperclip:first-start-baseline";
/** Refuse to fingerprint (and so to trust) a folder bigger than this. */
export const MAX_FINGERPRINT_FILES = 50_000;
/** Build-tool caches some packages write at run time; never loaded as code. */
const EXCLUDED_DIR_SUFFIXES = [`node_modules${path.sep}.cache`];

function describeKind(kind: TrustedCodeKind): string {
  return kind === "plugin" ? "plugin" : "adapter";
}

function describeRefusal(subject: TrustedCodeSubject, reason: UntrustedCodeReason, detail?: string): string {
  const what = `the ${describeKind(subject.kind)} "${subject.label}"`;
  const fix =
    `Nothing from it runs until an instance admin installs it again ` +
    `(Settings > ${subject.kind === "plugin" ? "Plugins" : "Adapters"}), which tells Paperclip the files now there are the trusted ones` +
    ` -- so if nobody on your side changed it, install a fresh copy rather than the files that are there now.`;
  switch (reason) {
    case "changed":
      return (
        `Paperclip did not start ${what} because its files were changed after it was installed ` +
        `(in ${subject.codeRoot}). An agent may have edited them. ${fix}`
      );
    case "unknown":
      return (
        `Paperclip did not start ${what} because it was not installed through Paperclip, ` +
        `so its files (in ${subject.codeRoot}) were never recorded as trusted. ${fix}`
      );
    case "unverifiable":
    default:
      return (
        `Paperclip did not start ${what} because it could not check its files ` +
        `(in ${subject.codeRoot})${detail ? `: ${detail}` : ""}. ${fix}`
      );
  }
}

// ---------------------------------------------------------------------------
// Mode and the app root
// ---------------------------------------------------------------------------

/**
 * "enforce" when this process cannot write its own program file (the
 * hardened image, where /app is owned by root), otherwise "off". Any failure
 * of the check counts as "cannot write": enforcing is the safe side.
 */
export function detectTrustedCodeMode(programFile: string = MODULE_FILE): TrustedCodeMode {
  try {
    fs.accessSync(programFile, fs.constants.W_OK);
    return "off";
  } catch {
    return "enforce";
  }
}

function realpathOrResolve(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

export interface CodeFingerprint {
  digest: string;
  /** Relative path (as walked from the code root) -> sha256 of the file. */
  files: Record<string, string>;
  fileCount: number;
}

export class FingerprintTooLargeError extends Error {
  constructor(root: string, maxFiles: number) {
    super(`more than ${maxFiles} files under ${root}`);
    this.name = "FingerprintTooLargeError";
  }
}

interface CachedFileHash {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  sha256: string;
}

/**
 * sha256 of one file, cached by inode, size, mtime and ctime. ctime cannot
 * be set by a user (utimes() can fake mtime, not ctime), so an edit always
 * misses the cache -- except an edit within the same clock tick as the
 * hashing, which is why a file changed in the last few seconds is never
 * cached (the same "racy file" rule git uses for its index).
 */
const fileHashCache = new Map<string, CachedFileHash>();
const RACY_WINDOW_MS = 3_000;

function rememberFileHash(realFile: string, st: fs.Stats, sha256: string): void {
  if (Date.now() - st.ctimeMs < RACY_WINDOW_MS || Date.now() - st.mtimeMs < RACY_WINDOW_MS) return;
  fileHashCache.set(realFile, {
    dev: st.dev,
    ino: st.ino,
    size: st.size,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    sha256,
  });
}

async function hashFile(realFile: string, st: fs.Stats): Promise<string> {
  const cached = fileHashCache.get(realFile);
  if (
    cached &&
    cached.dev === st.dev &&
    cached.ino === st.ino &&
    cached.size === st.size &&
    cached.mtimeMs === st.mtimeMs &&
    cached.ctimeMs === st.ctimeMs
  ) {
    return cached.sha256;
  }
  const sha256 = createHash("sha256").update(await fsp.readFile(realFile)).digest("hex");
  rememberFileHash(realFile, st, sha256);
  return sha256;
}

function hashFileSync(realFile: string): string {
  const st = fs.statSync(realFile);
  const cached = fileHashCache.get(realFile);
  if (
    cached &&
    cached.dev === st.dev &&
    cached.ino === st.ino &&
    cached.size === st.size &&
    cached.mtimeMs === st.mtimeMs &&
    cached.ctimeMs === st.ctimeMs
  ) {
    return cached.sha256;
  }
  const sha256 = createHash("sha256").update(fs.readFileSync(realFile)).digest("hex");
  rememberFileHash(realFile, st, sha256);
  return sha256;
}

/**
 * Fingerprint every file under `root`. Symbolic links are followed (their
 * targets are what gets loaded) and their link text is part of the digest;
 * links into the app root are recorded but not followed (that code is
 * protected by ownership). Directory cycles are recorded, not followed.
 */
export async function computeCodeFingerprint(
  root: string,
  options: { appRoot?: string; maxFiles?: number } = {},
): Promise<CodeFingerprint> {
  const maxFiles = options.maxFiles ?? MAX_FINGERPRINT_FILES;
  const realAppRoot = realpathOrResolve(options.appRoot ?? DEFAULT_APP_ROOT);
  const lines: string[] = [];
  const files: Record<string, string> = {};
  let fileCount = 0;
  const visitedDirs = new Set<string>();

  async function walk(absDir: string, relDir: string): Promise<void> {
    const realDir = await fsp.realpath(absDir);
    if (visitedDirs.has(realDir)) {
      lines.push(`C ${relDir}`);
      return;
    }
    visitedDirs.add(realDir);
    const entries = await fsp.readdir(absDir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = relDir ? path.join(relDir, entry.name) : entry.name;
      const abs = path.join(absDir, entry.name);
      if (EXCLUDED_DIR_SUFFIXES.some((suffix) => rel === suffix || rel.endsWith(`${path.sep}${suffix}`))) {
        continue;
      }
      const lst = await fsp.lstat(abs);
      if (lst.isSymbolicLink()) {
        lines.push(`L ${rel} ${await fsp.readlink(abs)}`);
        let target: fs.Stats;
        let realTarget: string;
        try {
          target = await fsp.stat(abs);
          realTarget = await fsp.realpath(abs);
        } catch {
          continue; // dangling link: nothing can be loaded through it
        }
        if (isPathInside(realTarget, realAppRoot)) {
          lines.push(`A ${rel}`);
          continue;
        }
        if (target.isDirectory()) {
          await walk(abs, rel);
        } else if (target.isFile()) {
          await addFile(realTarget, rel, target);
        } else {
          lines.push(`O ${rel}`);
        }
        continue;
      }
      if (lst.isDirectory()) {
        await walk(abs, rel);
      } else if (lst.isFile()) {
        await addFile(abs, rel, lst);
      } else {
        lines.push(`O ${rel}`);
      }
    }
  }

  async function addFile(realFile: string, rel: string, st: fs.Stats): Promise<void> {
    fileCount += 1;
    if (fileCount > maxFiles) throw new FingerprintTooLargeError(root, maxFiles);
    const sha = await hashFile(realFile, st);
    files[rel] = sha;
    lines.push(`F ${rel} ${sha}`);
  }

  await walk(path.resolve(root), "");
  const digest = createHash("sha256").update(lines.join("\n")).digest("hex");
  return { digest, files, fileCount };
}

// ---------------------------------------------------------------------------
// Code roots
// ---------------------------------------------------------------------------

/**
 * The folder a plugin's code is loaded from. Mirrors
 * resolvePluginPackageRoot in plugin-loader.ts: a local-path install's own
 * folder, otherwise the managed install folder (the whole folder, because an
 * npm plugin's dependencies sit in its node_modules and are loaded too).
 */
export function pluginCodeRoot(
  plugin: { packagePath?: string | null },
  localPluginDir: string,
): string {
  if (plugin.packagePath && fs.existsSync(plugin.packagePath)) {
    return path.resolve(plugin.packagePath);
  }
  return path.resolve(localPluginDir);
}

/** The folder an external adapter's code is loaded from. */
export function adapterCodeRoot(
  record: { localPath?: string | null },
  managedAdapterDir: string,
): string {
  return record.localPath ? path.resolve(record.localPath) : path.resolve(managedAdapterDir);
}

// ---------------------------------------------------------------------------
// Plain alert
// ---------------------------------------------------------------------------

const alertedRefusals = new Set<string>();

async function raiseRefusalAlert(db: Db, error: UntrustedCodeError): Promise<void> {
  const key = `${error.subject.kind}:${error.subject.codeRoot}:${error.reason}`;
  if (alertedRefusals.has(key)) return;
  alertedRefusals.add(key);
  logger.error(
    {
      kind: error.subject.kind,
      label: error.subject.label,
      codeRoot: error.subject.codeRoot,
      reason: error.reason,
    },
    `trusted-code: ${error.message}`,
  );
  try {
    const companyRows = await db.select({ id: companies.id }).from(companies);
    for (const row of companyRows) {
      await logActivity(db, {
        companyId: row.id,
        actorType: "system",
        actorId: "trusted-code",
        action: "instance.untrusted_code_refused",
        entityType: error.subject.kind,
        entityId: error.subject.label,
        details: {
          message: error.message,
          kind: error.subject.kind,
          label: error.subject.label,
          codeRoot: error.subject.codeRoot,
          reason: error.reason,
        },
      });
    }
  } catch (err) {
    // The refusal itself already happened; a failed alert must not undo it
    // or break the caller.
    logger.warn({ err, label: error.subject.label }, "trusted-code: could not write the refusal to the Activity feed");
  }
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export type TrustedCodeCheck =
  | { ok: true; exempt: boolean }
  | { ok: false; error: UntrustedCodeError };

export interface TrustedCodeService {
  readonly mode: TrustedCodeMode;
  /** True when `codeRoot` is inside Paperclip's own (root-owned) program folder. */
  isProtectedByAppRoot(codeRoot: string): boolean;
  /**
   * Record the current files of `subject.codeRoot` as trusted. Throws on
   * failure. Does nothing when the check is off.
   */
  record(subject: TrustedCodeSubject, reason: TrustedCodeRecordReason): Promise<void>;
  /** Compare the folder with its recorded fingerprint (whatever the mode). Never throws. */
  check(subject: TrustedCodeSubject): Promise<TrustedCodeCheck>;
  /**
   * Enforce: throw UntrustedCodeError (and raise the plain alert) unless the
   * folder matches. Off: return at once.
   */
  assertTrusted(subject: TrustedCodeSubject): Promise<void>;
  /**
   * Is this one file (under `codeRoot`) unchanged since it was recorded?
   * For serving single files (plugin UI bundles, adapter UI parsers) without
   * re-hashing the whole folder. Always true when the check is off.
   */
  checkFile(subject: TrustedCodeSubject, absFile: string): Promise<boolean>;
  /** Synchronous checkFile against the fingerprints this process last read. */
  checkFileSync(subject: TrustedCodeSubject, absFile: string): boolean;
  /** One-time: trust whatever add-ons are installed when this first runs. */
  recordFirstStartBaseline(subjects: TrustedCodeSubject[]): Promise<{ alreadyTaken: boolean; recorded: number; failed: number }>;
}

interface FingerprintRow {
  codeRoot: string;
  digest: string;
  fileHashes: Record<string, string>;
}

export function trustedCodeService(
  db: Db,
  options: { mode?: TrustedCodeMode; appRoot?: string } = {},
): TrustedCodeService {
  const mode = options.mode ?? detectTrustedCodeMode();
  const appRoot = options.appRoot ?? DEFAULT_APP_ROOT;
  const realAppRoot = realpathOrResolve(appRoot);
  /** The last fingerprint row this process read, per code root. */
  const knownRows = new Map<string, FingerprintRow>();

  function isProtectedByAppRoot(codeRoot: string): boolean {
    return isPathInside(realpathOrResolve(codeRoot), realAppRoot);
  }

  async function loadRow(codeRoot: string): Promise<FingerprintRow | null> {
    const rows = await db
      .select({
        codeRoot: trustedCodeFingerprints.codeRoot,
        digest: trustedCodeFingerprints.digest,
        fileHashes: trustedCodeFingerprints.fileHashes,
      })
      .from(trustedCodeFingerprints)
      .where(eq(trustedCodeFingerprints.codeRoot, codeRoot))
      .limit(1);
    const row = rows[0] ?? null;
    if (row) knownRows.set(codeRoot, row);
    else knownRows.delete(codeRoot);
    return row;
  }

  async function record(subject: TrustedCodeSubject, reason: TrustedCodeRecordReason): Promise<void> {
    if (mode === "off") return;
    const codeRoot = path.resolve(subject.codeRoot);
    if (isProtectedByAppRoot(codeRoot)) return;
    const fingerprint = await computeCodeFingerprint(codeRoot, { appRoot });
    const values = {
      codeRoot,
      kind: subject.kind,
      label: subject.label,
      digest: fingerprint.digest,
      fileHashes: fingerprint.files,
      fileCount: fingerprint.fileCount,
      recordedReason: reason,
      recordedAt: new Date(),
    };
    await db
      .insert(trustedCodeFingerprints)
      .values(values)
      .onConflictDoUpdate({
        target: trustedCodeFingerprints.codeRoot,
        set: {
          kind: values.kind,
          label: values.label,
          digest: values.digest,
          fileHashes: values.fileHashes,
          fileCount: values.fileCount,
          recordedReason: values.recordedReason,
          recordedAt: values.recordedAt,
        },
      });
    knownRows.set(codeRoot, { codeRoot, digest: fingerprint.digest, fileHashes: fingerprint.files });
    logger.info(
      { kind: subject.kind, label: subject.label, codeRoot, files: fingerprint.fileCount, reason },
      "trusted-code: recorded the fingerprint of add-on code",
    );
  }

  async function check(subject: TrustedCodeSubject): Promise<TrustedCodeCheck> {
    const codeRoot = path.resolve(subject.codeRoot);
    const normalized = { ...subject, codeRoot };
    if (isProtectedByAppRoot(codeRoot)) return { ok: true, exempt: true };
    let row: FingerprintRow | null;
    try {
      row = await loadRow(codeRoot);
    } catch (err) {
      return {
        ok: false,
        error: new UntrustedCodeError(normalized, "unverifiable", "the trusted-code record could not be read"),
      };
    }
    if (!row) return { ok: false, error: new UntrustedCodeError(normalized, "unknown") };
    let current: CodeFingerprint;
    try {
      current = await computeCodeFingerprint(codeRoot, { appRoot });
    } catch (err) {
      const detail =
        err instanceof FingerprintTooLargeError
          ? err.message
          : (err as NodeJS.ErrnoException).code === "ENOENT"
            ? "the folder is missing"
            : `a file could not be read (${(err as NodeJS.ErrnoException).code ?? "error"})`;
      return { ok: false, error: new UntrustedCodeError(normalized, "unverifiable", detail) };
    }
    if (current.digest !== row.digest) {
      return { ok: false, error: new UntrustedCodeError(normalized, "changed") };
    }
    return { ok: true, exempt: false };
  }

  async function assertTrusted(subject: TrustedCodeSubject): Promise<void> {
    if (mode === "off") return;
    const result = await check(subject);
    if (result.ok) return;
    await raiseRefusalAlert(db, result.error);
    throw result.error;
  }

  /** The recorded sha256 of `absFile`, or null if it is not a recorded file. */
  function expectedFileHash(row: FingerprintRow | undefined | null, codeRoot: string, absFile: string): string | null {
    if (!row) return null;
    const rel = path.relative(codeRoot, path.resolve(absFile));
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return row.fileHashes[rel] ?? null;
  }

  async function checkFile(subject: TrustedCodeSubject, absFile: string): Promise<boolean> {
    if (mode === "off") return true;
    const codeRoot = path.resolve(subject.codeRoot);
    if (isProtectedByAppRoot(codeRoot) || isProtectedByAppRoot(absFile)) return true;
    try {
      const row = knownRows.get(codeRoot) ?? (await loadRow(codeRoot));
      const expected = expectedFileHash(row, codeRoot, absFile);
      if (!expected) return false;
      const realFile = await fsp.realpath(absFile);
      const st = await fsp.stat(realFile);
      const ok = (await hashFile(realFile, st)) === expected;
      if (!ok) await raiseRefusalAlert(db, new UntrustedCodeError({ ...subject, codeRoot }, "changed"));
      return ok;
    } catch {
      return false;
    }
  }

  function checkFileSync(subject: TrustedCodeSubject, absFile: string): boolean {
    if (mode === "off") return true;
    const codeRoot = path.resolve(subject.codeRoot);
    if (isProtectedByAppRoot(codeRoot) || isProtectedByAppRoot(absFile)) return true;
    try {
      const expected = expectedFileHash(knownRows.get(codeRoot), codeRoot, absFile);
      if (!expected) return false;
      return hashFileSync(fs.realpathSync(absFile)) === expected;
    } catch {
      return false;
    }
  }

  async function recordFirstStartBaseline(subjects: TrustedCodeSubject[]) {
    if (mode === "off") return { alreadyTaken: false, recorded: 0, failed: 0 };
    const marker = await db
      .select({ id: trustedCodeFingerprints.id })
      .from(trustedCodeFingerprints)
      .where(eq(trustedCodeFingerprints.codeRoot, FIRST_START_BASELINE_MARKER))
      .limit(1);
    if (marker.length > 0) return { alreadyTaken: true, recorded: 0, failed: 0 };

    let recorded = 0;
    let failed = 0;
    const seen = new Set<string>();
    for (const subject of subjects) {
      const codeRoot = path.resolve(subject.codeRoot);
      if (seen.has(codeRoot)) continue;
      seen.add(codeRoot);
      if (isProtectedByAppRoot(codeRoot) || !fs.existsSync(codeRoot)) continue;
      const existing = await loadRow(codeRoot);
      if (existing) continue;
      try {
        await record({ ...subject, codeRoot }, "first_start");
        recorded += 1;
      } catch (err) {
        failed += 1;
        logger.error(
          { err, kind: subject.kind, label: subject.label, codeRoot },
          "trusted-code: could not record an installed add-on at first start; it will be refused until it is installed again",
        );
      }
    }
    await db
      .insert(trustedCodeFingerprints)
      .values({
        codeRoot: FIRST_START_BASELINE_MARKER,
        kind: "marker",
        label: "first-start baseline",
        digest: "",
        fileHashes: {},
        fileCount: recorded,
        recordedReason: "first_start",
      })
      .onConflictDoNothing({ target: trustedCodeFingerprints.codeRoot });
    logger.info({ recorded, failed }, "trusted-code: recorded the add-ons installed at first start");
    return { alreadyTaken: false, recorded, failed };
  }

  return {
    mode,
    isProtectedByAppRoot,
    record,
    check,
    assertTrusted,
    checkFile,
    checkFileSync,
    recordFirstStartBaseline,
  };
}

/**
 * Every add-on code folder currently installed: plugins from the database
 * (anything not uninstalled) and external adapters from the adapter store.
 */
export async function listInstalledCodeSubjects(
  db: Db,
  input: {
    localPluginDir: string;
    managedAdapterDir: string;
    adapterRecords: Array<{ type: string; packageName: string; localPath?: string | null }>;
  },
): Promise<TrustedCodeSubject[]> {
  const pluginRows = await db
    .select({ pluginKey: plugins.pluginKey, packagePath: plugins.packagePath })
    .from(plugins)
    .where(ne(plugins.status, "uninstalled"));
  const subjects: TrustedCodeSubject[] = pluginRows.map((row) => ({
    kind: "plugin",
    codeRoot: pluginCodeRoot(row, input.localPluginDir),
    label: row.pluginKey,
  }));
  for (const record of input.adapterRecords) {
    subjects.push({
      kind: "adapter",
      codeRoot: adapterCodeRoot(record, input.managedAdapterDir),
      label: record.type,
    });
  }
  return subjects;
}

// ---------------------------------------------------------------------------
// The server's configured instance (for module-level loaders)
// ---------------------------------------------------------------------------

let configuredService: TrustedCodeService | null = null;
let resolveConfigured: ((service: TrustedCodeService) => void) | null = null;
let configuredPromise = new Promise<TrustedCodeService>((resolve) => {
  resolveConfigured = resolve;
});

/**
 * Called once by the server at start-up, after the database is ready and the
 * first-start baseline has been taken. The external-adapter loader (which
 * starts at import time, before there is a database) waits for this.
 */
export function configureTrustedCode(service: TrustedCodeService): void {
  configuredService = service;
  resolveConfigured?.(service);
}

export function getConfiguredTrustedCode(): TrustedCodeService | null {
  return configuredService;
}

/** Resolves with the configured service, or null after `timeoutMs`. */
export async function waitForConfiguredTrustedCode(timeoutMs: number): Promise<TrustedCodeService | null> {
  if (configuredService) return configuredService;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([configuredPromise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Test-only: forget the configured service. */
export function resetConfiguredTrustedCodeForTests(): void {
  configuredService = null;
  configuredPromise = new Promise<TrustedCodeService>((resolve) => {
    resolveConfigured = resolve;
  });
}
