/**
 * DUR-316 (child of DUR-292): periodic scan for known secret patterns in
 * places the Secrets store (packages/db secret_access_events /
 * company_secrets) does not cover -- host git configs, .env files,
 * docker-compose files, and the free-text heartbeat_runs columns that agent
 * runs write to. NOR-316 and NOR-304 both trace back to the same root
 * cause: nothing scanned these surfaces, so one leaked credential sat in
 * plain text (NOR-316: a git remote URL, replayed into 706 heartbeat_runs
 * rows by every git command that logged it) until a human happened to
 * stumble onto it.
 *
 * Design choices worth flagging for the Security Reviewer adversarial pass
 * this hands off to:
 *  - A match NEVER gets written back into the issue it files (title,
 *    description, or logs) in full -- only `maskSecretMatch()` output. An
 *    auto-filer that echoes the full secret back into a new issue would
 *    just be NOR-316 again, one more copy.
 *  - Dedup is keyed on (surface, location, pattern) via
 *    `computeFindingFingerprint`, NOT on the secret value, so a rotated
 *    credential at the same location still opens a fresh ticket once the
 *    old one is closed, but the same live leak does not refile every tick.
 *    Enforced two ways, matching every other auto-filer in issues.ts
 *    (task_watchdog, harness_liveness_escalation, ...): the app-level
 *    findOpenDuplicateTicket check inside issueService.create(), and the
 *    DB-level partial unique index from migration
 *    0152_secret_scan_finding_dedup_index.sql, which closes the
 *    check-then-insert race that a single app-level check alone would leave
 *    open across concurrent scan ticks / replicas.
 *  - The filesystem surfaces are walked under
 *    resolvePaperclipInstanceRoot() only -- the tree this process actually
 *    manages (company/project checkouts, agent workspaces) -- not the whole
 *    host filesystem. That is a deliberate, bounded scope, not full
 *    coverage of every possible place a secret could land on the box.
 *  - Company attribution for filesystem matches is inferred from a
 *    `companies/<uuid>` or `projects/<uuid>` path segment. When that is not
 *    resolvable, the match is logged at warn level but no issue is filed
 *    (nowhere unambiguous to file it) -- a known gap, called out below.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, gt, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { SECRET_LEAK_PATTERNS, type SecretLeakPattern } from "../redaction.js";
import { issueService } from "./issues.js";

export const SECRET_SCAN_ORIGIN_KIND = "secret_scan_finding";
const ACTIVE_SECRET_SCAN_FINDING_CONSTRAINT = "issues_active_secret_scan_finding_uq";

export type SecretScanSurface = "git_config" | "dotenv" | "docker_compose" | "heartbeat_run";

export type SecretPattern = SecretLeakPattern;

// DUR-327: shares the write-time masking pattern list (server/src/redaction.ts)
// instead of keeping a separate copy, so the periodic scanner (this file) and
// the heartbeat_runs write-time gate can never drift out of sync again.
export const SECRET_PATTERNS: readonly SecretPattern[] = SECRET_LEAK_PATTERNS;

const FALSE_POSITIVE_PATH_SEGMENTS = [
  "node_modules",
  "__tests__",
  "__fixtures__",
  "/fixtures/",
  "/test-fixtures/",
  "/dist/",
  "/.git/objects/",
];

const FALSE_POSITIVE_LINE_HINTS = [
  "redacted",
  "example",
  "changeme",
  "change_me",
  "change-me",
  "replace_me",
  "replace-me",
  "your_",
  "your-",
  "placeholder",
  "dummy",
  "sample",
  "xxxxxxxx",
  "0000000000",
];

const EXCLUDED_WALK_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".turbo",
  ".next",
  ".pnpm-store",
  ".pnpm",
  "coverage",
  ".vite-temp",
]);

const DOTENV_FILE_RE = /^\.env(\..+)?$/;
const DOCKER_COMPOSE_FILE_RE = /^docker-compose.*\.ya?ml$/i;
const MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024;
const MAX_WALK_ENTRIES_PER_SWEEP = 300_000;
const COMPANY_ID_PATH_RE = /\/(?:companies|projects)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

export interface RawSecretMatch {
  pattern: string;
  value: string;
  lineHint: string;
}

/**
 * Scan arbitrary text for every configured secret pattern, filtering obvious
 * placeholders. Matches against the whole text (not line-by-line) because
 * the shared pattern list (DUR-327) includes the PEM private-key pattern,
 * which spans a BEGIN...END block across multiple lines -- a per-line split
 * would never let that regex see both markers at once. `lineHint` is still
 * derived per-match from just the line containing the match's start, so
 * single-line patterns behave exactly as before.
 */
export function scanTextForSecrets(text: string): RawSecretMatch[] {
  if (!text) return [];
  const matches: RawSecretMatch[] = [];
  for (const pattern of SECRET_PATTERNS) {
    const re = new RegExp(pattern.regex.source, pattern.regex.flags.includes("g") ? pattern.regex.flags : `${pattern.regex.flags}g`);
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const value = match[0];
      const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
      const nextNewline = text.indexOf("\n", match.index);
      const lineEnd = nextNewline === -1 ? text.length : nextNewline;
      const line = text.slice(lineStart, lineEnd);
      if (!isLikelyFalsePositiveValue(value, line)) {
        matches.push({ pattern: pattern.name, value, lineHint: line.slice(0, 200) });
      }
      if (match.index === re.lastIndex) re.lastIndex += 1;
    }
  }
  return matches;
}

function isLikelyFalsePositiveValue(value: string, line: string): boolean {
  const lowerLine = line.toLowerCase();
  if (FALSE_POSITIVE_LINE_HINTS.some((hint) => lowerLine.includes(hint))) return true;
  return hasLowEntropy(value);
}

/** Placeholder-shaped values ("xxxxxxxxxxxxxxxxxxxx", "aaaaaaaa...") rarely are real secrets. */
function hasLowEntropy(value: string): boolean {
  const chars = value.replace(/^[a-z_-]+[-_]/i, ""); // drop known prefixes like "ghp_", "sk-"
  if (chars.length < 6) return false;
  const counts = new Map<string, number>();
  for (const ch of chars) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const maxCount = Math.max(...counts.values());
  return maxCount / chars.length >= 0.6;
}

/** Mask a matched secret so forensic issues carry enough signal without becoming a new leak site. */
export function maskSecretMatch(value: string): string {
  if (value.length <= 10) return "*".repeat(value.length);
  const head = value.slice(0, 6);
  const tail = value.slice(-4);
  return `${head}${"*".repeat(Math.max(4, value.length - 10))}${tail}`;
}

function isExcludedPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return FALSE_POSITIVE_PATH_SEGMENTS.some((segment) => normalized.includes(segment));
}

interface ScanCandidateFile {
  absolutePath: string;
  surface: SecretScanSurface;
}

/** Bounded, symlink-safe walk of the instance root for the 3 filesystem surfaces this ticket covers. */
export async function* walkScanCandidates(root: string): AsyncGenerator<ScanCandidateFile> {
  let visited = 0;
  let truncated = false;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (visited >= MAX_WALK_ENTRIES_PER_SWEEP) {
        truncated = true;
        break;
      }
      visited += 1;
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git") {
          const configPath = path.join(entryPath, "config");
          if (await fileExists(configPath)) {
            yield { absolutePath: configPath, surface: "git_config" };
          }
          continue; // never recurse into .git internals beyond the config file
        }
        if (EXCLUDED_WALK_DIR_NAMES.has(entry.name)) continue;
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (DOTENV_FILE_RE.test(entry.name)) {
        yield { absolutePath: entryPath, surface: "dotenv" };
      } else if (DOCKER_COMPOSE_FILE_RE.test(entry.name)) {
        yield { absolutePath: entryPath, surface: "docker_compose" };
      }
    }
    if (truncated) break;
  }
  if (truncated) {
    logger.warn(
      { root, maxEntries: MAX_WALK_ENTRIES_PER_SWEEP },
      "secret-surface-scanner: filesystem walk hit the entry cap and stopped early this sweep -- some files were not scanned",
    );
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort company attribution for a filesystem finding, from a /companies/<uuid>/ or /projects/<uuid>/ path segment. */
export function resolveCompanyIdFromPath(filePath: string): string | null {
  const match = filePath.match(COMPANY_ID_PATH_RE);
  return match ? match[1].toLowerCase() : null;
}

/** Deterministic per-(surface, location, pattern) fingerprint -- deliberately excludes the secret value itself. */
export function computeFindingFingerprint(input: { surface: SecretScanSurface; location: string; pattern: string }): string {
  const hash = crypto
    .createHash("sha256")
    .update(`${input.surface} ${input.location} ${input.pattern}`)
    .digest("hex");
  return `secret_scan:${hash.slice(0, 40)}`;
}

async function findSecurityReviewerAgentId(db: Db, companyId: string): Promise<string | null> {
  const row = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        ne(agents.status, "terminated"),
        or(sqlIlike(agents.title, "%security%"), sqlIlike(agents.role, "%security%")),
      ),
    )
    .orderBy(asc(agents.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row?.id ?? null;
}

// Small local `ilike` helper -- avoids pulling in drizzle-orm's `ilike` just
// for this one lookup and keeps the case-insensitive match explicit.
function sqlIlike(column: unknown, pattern: string) {
  return sql`${column} ILIKE ${pattern}`;
}

function isUniqueConstraintConflict(error: unknown, constraintName: string): boolean {
  const queue: unknown[] = [error];
  const messages: string[] = [];
  let hasUniqueCode = false;
  let hasConstraint = false;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;
    const typed = current as Record<string, unknown>;
    if (typed.code === "23505") hasUniqueCode = true;
    if (typed.constraint === constraintName || typed.constraint_name === constraintName) hasConstraint = true;
    if (typeof typed.message === "string") messages.push(typed.message);
    if (typed.cause) queue.push(typed.cause);
  }
  const message = messages.join("\n");
  return (hasUniqueCode || message.includes("duplicate key value violates unique constraint")) &&
    (hasConstraint || message.includes(constraintName));
}

export interface FileFindingInput {
  companyId: string;
  surface: SecretScanSurface;
  location: string;
  pattern: string;
  maskedValue: string;
  detail: string;
}

export interface FileFindingResult {
  filed: boolean;
  issueId?: string;
  reason: "created" | "already_open" | "race_lost" | "assignee_not_assignable";
}

/** File (or no-op dedupe against) exactly one issue per unique finding. Never receives/logs the raw secret. */
export async function fileSecretFinding(db: Db, input: FileFindingInput): Promise<FileFindingResult> {
  const fingerprint = computeFindingFingerprint(input);
  const securityReviewerAgentId = await findSecurityReviewerAgentId(db, input.companyId).catch(() => null);

  const description = [
    `Automated secret scan (DUR-316) found a likely **${input.pattern}** credential outside the Secrets store.`,
    "",
    `- Surface: ${input.surface}`,
    `- Location: ${input.location}`,
    `- Matched value (masked): \`${input.maskedValue}\``,
    "",
    input.detail,
    "",
    "**Do not paste the real credential into this issue or any comment.** Rotate/revoke it at the provider, remove it from the source location, and confirm no other surface still references it before closing.",
    securityReviewerAgentId
      ? `\nagent://${securityReviewerAgentId} -- tagging for adversarial review per DUR-316's acceptance criteria.`
      : "\nNo agent with a security-titled role was found for this company -- assign a security reviewer manually.",
  ].join("\n");

  const title = `Leaked ${input.pattern} secret in ${input.surface} (${shortenLocation(input.location)})`;

  const create = (assigneeAgentId: string | undefined) =>
    issueService(db).create(input.companyId, {
      title,
      description,
      status: "todo",
      priority: "critical",
      assigneeAgentId,
      originKind: SECRET_SCAN_ORIGIN_KIND,
      originId: input.location,
      originFingerprint: fingerprint,
    });

  try {
    const created = await create(securityReviewerAgentId ?? undefined);
    return { filed: true, issueId: created.id, reason: "created" };
  } catch (error) {
    // The resolved "security reviewer" agent may not currently be
    // assignable (pending approval / terminated / broken org chain) --
    // checked before the generic 409 branch below, since assertAssignableAgent
    // also throws via conflict() (status 409) and would otherwise be
    // misread as "issue already filed". Retry unassigned rather than drop
    // the finding entirely.
    if (securityReviewerAgentId && isAssigneeConflict(error)) {
      const created = await create(undefined);
      return { filed: true, issueId: created.id, reason: "assignee_not_assignable" };
    }
    if (error instanceof HttpError && error.status === 409) {
      return { filed: false, reason: "already_open" };
    }
    if (isUniqueConstraintConflict(error, ACTIVE_SECRET_SCAN_FINDING_CONSTRAINT)) {
      return { filed: false, reason: "race_lost" };
    }
    throw error;
  }
}

function isAssigneeConflict(error: unknown): boolean {
  return error instanceof HttpError && (error.details as { code?: string } | undefined)?.code === "agent_not_assignable";
}

function shortenLocation(location: string): string {
  if (location.length <= 80) return location;
  return `...${location.slice(-77)}`;
}

export interface FilesystemScanSummary {
  filesScanned: number;
  matchesFound: number;
  issuesFiled: number;
  unattributedMatches: number;
}

export async function scanFilesystemForLeakedSecrets(
  db: Db,
  opts: { root?: string } = {},
): Promise<FilesystemScanSummary> {
  const root = opts.root ?? resolvePaperclipInstanceRoot();
  const summary: FilesystemScanSummary = { filesScanned: 0, matchesFound: 0, issuesFiled: 0, unattributedMatches: 0 };

  for await (const candidate of walkScanCandidates(root)) {
    if (isExcludedPath(candidate.absolutePath)) continue;
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(candidate.absolutePath);
    } catch {
      continue;
    }
    if (stat.size > MAX_SCAN_FILE_BYTES) continue;

    let text: string;
    try {
      text = await fs.readFile(candidate.absolutePath, "utf8");
    } catch {
      continue;
    }
    summary.filesScanned += 1;

    const matches = scanTextForSecrets(text);
    if (matches.length === 0) continue;
    summary.matchesFound += matches.length;

    const companyId = resolveCompanyIdFromPath(candidate.absolutePath);
    const location = path.relative(root, candidate.absolutePath) || candidate.absolutePath;
    for (const match of matches) {
      if (!companyId) {
        summary.unattributedMatches += 1;
        logger.warn(
          { location, surface: candidate.surface, pattern: match.pattern },
          "secret-surface-scanner: matched a secret pattern but could not attribute it to a company -- no issue filed, needs manual triage",
        );
        continue;
      }
      const result = await fileSecretFinding(db, {
        companyId,
        surface: candidate.surface,
        location,
        pattern: match.pattern,
        maskedValue: maskSecretMatch(match.value),
        detail: `Found while scanning ${candidate.surface === "git_config" ? "a .git/config remote URL" : candidate.surface === "dotenv" ? "a .env file" : "a docker-compose file"} under the Paperclip instance root.`,
      });
      if (result.filed) summary.issuesFiled += 1;
    }
  }

  return summary;
}

export interface HeartbeatRunCursor {
  createdAt: Date;
  id: string;
}

export interface HeartbeatRunScanSummary {
  rowsScanned: number;
  matchesFound: number;
  issuesFiled: number;
  cursor: HeartbeatRunCursor | null;
  truncated: boolean;
}

const HEARTBEAT_RUN_SCAN_COLUMNS = ["error", "stdoutExcerpt", "stderrExcerpt"] as const;
const HEARTBEAT_RUN_BATCH_SIZE = 500;
const HEARTBEAT_RUN_MAX_BATCHES_PER_SWEEP = 100;
// DUR-360 security review of DUR-327: scanTextForSecrets runs the shared
// pem_private_key pattern (a lazy [\s\S]*? scan for an unmatched BEGIN
// marker) against the WHOLE field text, which is O(n^2) on adversarial input
// with many BEGIN markers and no END (benchmarked: 1.6MB ~= 10s, blocking
// the main API event loop for the duration of one sweep tick). Unlike the
// filesystem surface (MAX_SCAN_FILE_BYTES), these columns/resultJson have no
// write-time size cap, and this path selects them directly rather than
// through the 64KB-gated `left(...)` truncation used for API display
// (heartbeat-run-summary.ts's HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES).
// Truncating each field to this cap before scanning keeps worst-case
// per-field scan time bounded to tens of ms regardless of how large the
// underlying column value is -- a real secret is always far shorter than
// this cap, so detection is unaffected in the non-adversarial case.
const HEARTBEAT_RUN_SCAN_FIELD_MAX_CHARS = 64 * 1024;

export async function scanHeartbeatRunsForLeakedSecrets(
  db: Db,
  opts: { cursor?: HeartbeatRunCursor | null } = {},
): Promise<HeartbeatRunScanSummary> {
  const summary: HeartbeatRunScanSummary = {
    rowsScanned: 0,
    matchesFound: 0,
    issuesFiled: 0,
    cursor: opts.cursor ?? null,
    truncated: false,
  };

  for (let batch = 0; batch < HEARTBEAT_RUN_MAX_BATCHES_PER_SWEEP; batch += 1) {
    const cursor = summary.cursor;
    const rows = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        createdAt: heartbeatRuns.createdAt,
        error: heartbeatRuns.error,
        stdoutExcerpt: heartbeatRuns.stdoutExcerpt,
        stderrExcerpt: heartbeatRuns.stderrExcerpt,
        resultJson: heartbeatRuns.resultJson,
      })
      .from(heartbeatRuns)
      .where(
        cursor
          ? or(
              gt(heartbeatRuns.createdAt, cursor.createdAt),
              and(eq(heartbeatRuns.createdAt, cursor.createdAt), gt(heartbeatRuns.id, cursor.id)),
            )
          : undefined,
      )
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(HEARTBEAT_RUN_BATCH_SIZE);

    if (rows.length === 0) break;
    summary.rowsScanned += rows.length;

    for (const row of rows) {
      const fields: Array<{ column: string; text: string | null }> = HEARTBEAT_RUN_SCAN_COLUMNS.map((col) => ({
        column: col,
        text: row[col],
      }));
      if (row.resultJson) {
        fields.push({ column: "resultJson", text: safeStringify(row.resultJson) });
      }

      for (const field of fields) {
        if (!field.text) continue;
        const text =
          field.text.length > HEARTBEAT_RUN_SCAN_FIELD_MAX_CHARS
            ? field.text.slice(0, HEARTBEAT_RUN_SCAN_FIELD_MAX_CHARS)
            : field.text;
        const matches = scanTextForSecrets(text);
        if (matches.length === 0) continue;
        summary.matchesFound += matches.length;
        const location = `heartbeat_runs.${field.column} row ${row.id}`;
        for (const match of matches) {
          const result = await fileSecretFinding(db, {
            companyId: row.companyId,
            surface: "heartbeat_run",
            location,
            pattern: match.pattern,
            maskedValue: maskSecretMatch(match.value),
            detail: `Found in the \`${field.column}\` column of heartbeat_runs row ${row.id} (run recorded ${row.createdAt.toISOString()}).`,
          });
          if (result.filed) summary.issuesFiled += 1;
        }
      }
    }

    summary.cursor = { createdAt: rows[rows.length - 1].createdAt, id: rows[rows.length - 1].id };
    if (rows.length < HEARTBEAT_RUN_BATCH_SIZE) return summary;
    if (batch === HEARTBEAT_RUN_MAX_BATCHES_PER_SWEEP - 1) {
      summary.truncated = true;
      logger.warn(
        { scanned: summary.rowsScanned, cursor: summary.cursor },
        "secret-surface-scanner: heartbeat_runs scan hit its per-sweep batch cap -- resuming from cursor next sweep",
      );
    }
  }

  return summary;
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export interface SecretSurfaceScanSummary {
  filesystem: FilesystemScanSummary;
  heartbeatRuns: HeartbeatRunScanSummary;
}

/**
 * Run one full sweep across all 4 surfaces. `state.heartbeatRunCursor` is
 * mutated in place so callers (the setInterval loop below, or a test) can
 * keep resuming the heartbeat_runs keyset scan across ticks without a DB
 * column of its own -- a restart re-walks from the start of the table,
 * which is a bounded, acceptable cost (see module header).
 */
export async function runSecretSurfaceScan(
  db: Db,
  state: { heartbeatRunCursor: HeartbeatRunCursor | null } = { heartbeatRunCursor: null },
): Promise<SecretSurfaceScanSummary> {
  const filesystem = await scanFilesystemForLeakedSecrets(db);
  const heartbeatRunsResult = await scanHeartbeatRunsForLeakedSecrets(db, { cursor: state.heartbeatRunCursor });
  state.heartbeatRunCursor = heartbeatRunsResult.cursor;

  if (filesystem.issuesFiled > 0 || heartbeatRunsResult.issuesFiled > 0) {
    logger.warn(
      { filesystem, heartbeatRuns: heartbeatRunsResult },
      "secret-surface-scanner: sweep filed one or more critical secret-leak issues",
    );
  } else if (filesystem.matchesFound > 0 || heartbeatRunsResult.matchesFound > 0) {
    logger.info(
      { filesystem, heartbeatRuns: heartbeatRunsResult },
      "secret-surface-scanner: sweep found matches that were already covered by open issues",
    );
  }

  return { filesystem, heartbeatRuns: heartbeatRunsResult };
}

const DEFAULT_SCAN_INTERVAL_MS = 30 * 60 * 1_000; // 30 minutes

/** Start the periodic sweep. Mirrors startPluginLogRetention's run-once-then-interval shape. */
export function startSecretSurfaceScanner(db: Db, intervalMs: number = DEFAULT_SCAN_INTERVAL_MS): () => void {
  const state: { heartbeatRunCursor: HeartbeatRunCursor | null } = { heartbeatRunCursor: null };

  const tick = () => {
    runSecretSurfaceScan(db, state).catch((err) => {
      logger.warn({ err }, "secret-surface-scanner: sweep failed");
    });
  };

  const timer = setInterval(tick, intervalMs);
  tick();

  return () => clearInterval(timer);
}
