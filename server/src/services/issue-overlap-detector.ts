import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  executionWorkspaces,
  issueComments,
  issueOverlaps,
  issues,
  issueWorkProducts,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { ghFetch } from "./github-fetch.js";
import {
  fetchCiStatus,
  fetchPullRequestFacts,
  type ConditionStatus,
  type FetchLike,
} from "./merge-pr-automation.js";
import { secretService } from "./secrets.js";
import { serverChildProcessEnv } from "./runtime-env.js";

/**
 * DUR-4468 (DUR-4464): spot early when two open tasks change the same files or
 * claim the same migration number. Warn-only: this service never blocks,
 * reassigns or mutates an issue -- it records `issue_overlaps` rows and posts
 * one system comment per affected issue the first time a pair is detected.
 */

export const OVERLAP_KINDS = ["file", "migration_number", "journal_json", "stale_behind"] as const;
export type OverlapKind = (typeof OVERLAP_KINDS)[number];

export const OVERLAP_OPEN_ISSUE_STATUSES = ["todo", "in_progress", "in_review", "blocked"] as const;
/** `activeOverlapWarnings` only surfaces overlaps re-confirmed this recently. */
export const ACTIVE_OVERLAP_WINDOW_MS = 30 * 60 * 1000;

const MIGRATIONS_DIR = "packages/db/src/migrations/";
const JOURNAL_PATH = `${MIGRATIONS_DIR}meta/_journal.json`;
const MIGRATION_FILE_RE = /^packages\/db\/src\/migrations\/(\d{4})_[^/]+\.sql$/;
const DEFAULT_BASE_REF = "origin/custom";

const execFileAsync = promisify(execFile);

export interface WorkspaceSnapshot {
  issueId: string;
  workspaceId: string;
  /** Changed vs base: path -> git status letter (A, M, D, ...). */
  files: Map<string, string>;
  /** Files changed on base since this branch forked -> subject of the commit that changed them. */
  staleFiles: Map<string, string | null>;
  /** Migration numbers that already exist on base. */
  baseMigrationNumbers: number[];
}

export interface OverlapCandidate {
  issueAId: string;
  issueBId: string;
  kind: OverlapKind;
  detailKey: string;
  detail: Record<string, unknown>;
}

export interface PrProgress {
  ci: ConditionStatus;
  review: "approved" | "changes_requested" | "none";
  merged: boolean;
}

export interface OverlapDetectorDeps {
  /** Read the workspace's changed files; null = could not be read (never resolves its rows). */
  snapshotWorkspace?: (ws: { id: string; cwd: string; baseRef: string | null }) => Promise<Omit<WorkspaceSnapshot, "issueId" | "workspaceId"> | null>;
  getPrProgress?: (companyId: string, issueId: string) => Promise<PrProgress | null>;
  now?: () => Date;
}

export function canonicalPair(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}

function rowKey(r: { issueAId: string; issueBId: string; kind: string; detailKey: string }) {
  return `${r.issueAId}|${r.issueBId}|${r.kind}|${r.detailKey}`;
}

function migrationNumbersAdded(snapshot: WorkspaceSnapshot): Set<string> {
  const out = new Set<string>();
  for (const [path, status] of snapshot.files) {
    if (status !== "A") continue;
    const m = MIGRATION_FILE_RE.exec(path);
    if (m) out.add(m[1]!);
  }
  return out;
}

/** Pure: derive the overlaps implied by a set of workspace snapshots. */
export function computeOverlaps(snapshots: WorkspaceSnapshot[]): OverlapCandidate[] {
  const out: OverlapCandidate[] = [];
  for (let i = 0; i < snapshots.length; i++) {
    const a = snapshots[i]!;
    for (const [file, subject] of a.staleFiles) {
      if (!a.files.has(file) || file.startsWith(`${MIGRATIONS_DIR}meta/`)) continue;
      out.push({
        issueAId: a.issueId,
        issueBId: a.issueId,
        kind: "stale_behind",
        detailKey: file,
        detail: { file, mergedCommit: subject },
      });
    }
    for (let j = i + 1; j < snapshots.length; j++) {
      const b = snapshots[j]!;
      if (a.issueId === b.issueId || a.workspaceId === b.workspaceId) continue;
      const [issueAId, issueBId] = canonicalPair(a.issueId, b.issueId);
      for (const file of a.files.keys()) {
        if (!b.files.has(file)) continue;
        if (file === JOURNAL_PATH) {
          out.push({ issueAId, issueBId, kind: "journal_json", detailKey: file, detail: { file } });
        } else if (!file.startsWith(`${MIGRATIONS_DIR}meta/`)) {
          out.push({ issueAId, issueBId, kind: "file", detailKey: file, detail: { file } });
        }
      }
      const bNumbers = migrationNumbersAdded(b);
      for (const n of migrationNumbersAdded(a)) {
        if (bNumbers.has(n)) {
          out.push({ issueAId, issueBId, kind: "migration_number", detailKey: n, detail: { migrationNumber: n } });
        }
      }
    }
  }
  return out;
}

/** Higher = further along. Never used to block anything. */
function progressScore(p: PrProgress | null): number {
  if (!p) return 0;
  if (p.merged) return 10;
  let score = 0;
  if (p.review === "approved") score += 2;
  if (p.review === "changes_requested") score -= 2;
  if (p.ci === "met") score += 1;
  if (p.ci === "not_met") score -= 1;
  return score;
}

export function suggestOrder(a: PrProgress | null, b: PrProgress | null): "a_first" | "b_first" | "none" {
  const sa = progressScore(a);
  const sb = progressScore(b);
  if (sa === sb) return "none";
  return sa > sb ? "a_first" : "b_first";
}

/** Next migration number nobody has used: max of base + every open branch's added numbers, plus one. */
export function nextFreeMigrationNumber(snapshots: WorkspaceSnapshot[]): string {
  let max = -1;
  for (const s of snapshots) {
    for (const n of s.baseMigrationNumbers) max = Math.max(max, n);
    for (const n of migrationNumbersAdded(s)) max = Math.max(max, Number(n));
  }
  return String(max + 1).padStart(4, "0");
}

export interface OverlapIssueRef {
  id: string;
  identifier: string | null;
  title: string;
  assigneeName: string | null;
}

function issueLink(ref: OverlapIssueRef) {
  const label = ref.identifier ?? ref.id;
  const prefix = ref.identifier?.split("-")[0];
  return prefix ? `[${label}](/${prefix}/issues/${label})` : label;
}

/** Strips characters that could break out of a markdown code span (backticks, newlines). */
function sanitizeDetailKey(detailKey: string): string {
  return detailKey.replace(/[`\r\n]/g, "");
}

function describeRow(row: OverlapCandidate, freeMigration: string) {
  const detailKey = sanitizeDetailKey(row.detailKey);
  switch (row.kind) {
    case "file":
      return `both change \`${detailKey}\``;
    case "migration_number":
      return `both add migration \`${detailKey}\` (next free number: \`${freeMigration}\`)`;
    case "journal_json":
      return "both edit `packages/db/src/migrations/meta/_journal.json`, so one will conflict after the other merges";
    case "stale_behind": {
      const commit = typeof row.detail.mergedCommit === "string" ? ` (${row.detail.mergedCommit})` : "";
      return `\`${detailKey}\` already changed on the base branch${commit} since this branch started`;
    }
  }
}

const MAX_LISTED_ROWS = 10;

export function buildWarningComment(input: {
  other: OverlapIssueRef | null;
  rows: OverlapCandidate[];
  order: "self_first" | "other_first" | "none";
  freeMigration: string;
}): string {
  const { other, rows, order, freeMigration } = input;
  const lines: string[] = [];
  if (!other) {
    lines.push(
      "**Heads up: your branch is behind the base branch.** Rebase before you keep editing these files:",
    );
  } else {
    lines.push(
      `**Heads up: this task overlaps with ${issueLink(other)}${other.assigneeName ? ` (${other.assigneeName})` : ""}.** ` +
        "Check that task before you edit further:",
    );
  }
  for (const row of rows.slice(0, MAX_LISTED_ROWS)) lines.push(`- ${describeRow(row, freeMigration)}`);
  if (rows.length > MAX_LISTED_ROWS) lines.push(`- …and ${rows.length - MAX_LISTED_ROWS} more`);
  if (other) {
    lines.push("");
    if (order === "self_first") {
      lines.push(`**Suggested order:** this task goes first (its PR is further along); ${issueLink(other)} should wait and rebase after it merges.`);
    } else if (order === "other_first") {
      lines.push(`**Suggested order:** ${issueLink(other)} goes first (its PR is further along); wait and rebase after it merges.`);
    } else {
      lines.push("**Suggested order:** no clear leader yet. Whichever merges first, the other rebases.");
    }
  }
  lines.push("", "_This is a warning only. Nothing has been blocked._");
  return lines.join("\n");
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    cwd,
    env: serverChildProcessEnv(),
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

function parseNameStatus(out: string, files: Map<string, string>) {
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [status, ...rest] = line.split("\t");
    const path = rest[rest.length - 1];
    if (status && path) files.set(path, status[0]!);
  }
}

const snapshotCache = new Map<string, { key: string; value: Omit<WorkspaceSnapshot, "issueId" | "workspaceId"> }>();

async function defaultSnapshotWorkspace(ws: { id: string; cwd: string; baseRef: string | null }) {
  try {
    const wanted = ws.baseRef ?? DEFAULT_BASE_REF;
    let base: string | null = null;
    for (const ref of [wanted, `origin/${wanted}`]) {
      try {
        base = (await runGit(ws.cwd, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
        break;
      } catch {
        /* try next */
      }
    }
    if (!base) return null;
    const head = (await runGit(ws.cwd, ["rev-parse", "HEAD"])).trim();
    const porcelain = await runGit(ws.cwd, ["status", "--porcelain"]);
    const key = `${head}|${base}|${porcelain}`;
    const cached = snapshotCache.get(ws.id);
    if (cached?.key === key) return cached.value;

    const files = new Map<string, string>();
    parseNameStatus(await runGit(ws.cwd, ["diff", "--name-status", "--no-renames", `${base}...${head}`]), files);
    // Uncommitted work counts too: it is what an agent is editing right now.
    parseNameStatus(await runGit(ws.cwd, ["diff", "--name-status", "--no-renames", "HEAD"]), files);
    for (const p of (await runGit(ws.cwd, ["ls-files", "--others", "--exclude-standard"])).split("\n")) {
      if (p.trim() && !files.has(p)) files.set(p, "A");
    }

    const staleFiles = new Map<string, string | null>();
    const mergeBase = (await runGit(ws.cwd, ["merge-base", base, head])).trim();
    if (mergeBase && mergeBase !== base) {
      const log = await runGit(ws.cwd, ["log", "--format=%x00%h %s", "--name-only", "--no-renames", `${mergeBase}..${base}`]);
      for (const block of log.split("\u0000")) {
        const [subject, ...paths] = block.split("\n");
        for (const p of paths) {
          if (p.trim() && !staleFiles.has(p)) staleFiles.set(p, subject?.trim() || null);
        }
      }
    }

    const baseMigrationNumbers = (await runGit(ws.cwd, ["ls-tree", "--name-only", base, MIGRATIONS_DIR]))
      .split("\n")
      .map((p) => MIGRATION_FILE_RE.exec(p.trim())?.[1])
      .filter((n): n is string => Boolean(n))
      .map(Number);

    const value = { files, staleFiles, baseMigrationNumbers };
    snapshotCache.set(ws.id, { key, value });
    return value;
  } catch (err) {
    logger.warn({ err, workspaceId: ws.id }, "issue-overlap: could not read workspace changes");
    return null;
  }
}

const PR_URL_RE = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

function defaultGetPrProgress(db: Db, fetchImpl: FetchLike) {
  const secretsSvc = secretService(db);
  return async (companyId: string, issueId: string): Promise<PrProgress | null> => {
    const product = await db
      .select()
      .from(issueWorkProducts)
      .where(and(eq(issueWorkProducts.issueId, issueId), eq(issueWorkProducts.type, "pull_request")))
      .orderBy(desc(issueWorkProducts.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!product) return null;
    const review: PrProgress["review"] =
      product.reviewState === "approved" || product.status === "approved"
        ? "approved"
        : product.reviewState === "changes_requested" || product.status === "changes_requested"
          ? "changes_requested"
          : "none";
    const merged = product.status === "merged";
    const m = product.url ? PR_URL_RE.exec(product.url) : null;
    if (!m || merged) return { ci: "unknown", review, merged };
    try {
      const token = await secretsSvc
        .resolveGitHubToken(companyId, { consumerType: "system", consumerId: "issue-overlap-detector" })
        .catch(() => null);
      const deps = { fetchImpl, token };
      const ref = { owner: m[1]!, name: m[2]!, prNumber: Number(m[3]) };
      const facts = await fetchPullRequestFacts(ref, deps);
      const ci = facts?.headSha ? await fetchCiStatus(ref, facts.headSha, deps) : "unknown";
      return { ci, review, merged };
    } catch {
      return { ci: "unknown", review, merged };
    }
  };
}

export function issueOverlapDetectorService(
  db: Db,
  options: OverlapDetectorDeps & { fetch?: FetchLike } = {},
) {
  const snapshotWorkspace = options.snapshotWorkspace ?? defaultSnapshotWorkspace;
  const getPrProgress = options.getPrProgress ?? defaultGetPrProgress(db, options.fetch ?? ghFetch);
  const nowFn = options.now ?? (() => new Date());

  async function loadSnapshots(companyId: string) {
    const rows = await db
      .select({
        issueId: issues.id,
        workspaceId: executionWorkspaces.id,
        cwd: executionWorkspaces.cwd,
        baseRef: executionWorkspaces.baseRef,
      })
      .from(issues)
      .innerJoin(executionWorkspaces, eq(issues.executionWorkspaceId, executionWorkspaces.id))
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(executionWorkspaces.companyId, companyId),
          inArray(issues.status, [...OVERLAP_OPEN_ISSUE_STATUSES]),
          isNull(issues.hiddenAt),
          eq(executionWorkspaces.status, "active"),
          eq(executionWorkspaces.strategyType, "git_worktree"),
        ),
      );
    const snapshots: WorkspaceSnapshot[] = [];
    const unreadable = new Set<string>();
    for (const row of rows) {
      if (!row.cwd) continue;
      const snap = await snapshotWorkspace({ id: row.workspaceId, cwd: row.cwd, baseRef: row.baseRef });
      if (!snap) {
        unreadable.add(row.issueId);
        continue;
      }
      snapshots.push({ issueId: row.issueId, workspaceId: row.workspaceId, ...snap });
    }
    return { snapshots, unreadable };
  }

  async function issueRefs(ids: string[]): Promise<Map<string, OverlapIssueRef>> {
    const out = new Map<string, OverlapIssueRef>();
    if (ids.length === 0) return out;
    const rows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        assigneeName: agents.name,
      })
      .from(issues)
      .leftJoin(agents, eq(agents.id, issues.assigneeAgentId))
      .where(inArray(issues.id, ids));
    for (const r of rows) out.set(r.id, r);
    return out;
  }

  /** Post one comment per affected issue per pair; each overlap row is claimed (warned_at) atomically first. */
  async function deliverWarnings(
    companyId: string,
    snapshots: WorkspaceSnapshot[],
    now: Date,
  ): Promise<number> {
    const pending = await db
      .select()
      .from(issueOverlaps)
      .where(
        and(
          eq(issueOverlaps.companyId, companyId),
          eq(issueOverlaps.status, "open"),
          isNull(issueOverlaps.warnedAt),
        ),
      );
    if (pending.length === 0) return 0;

    const groups = new Map<string, typeof pending>();
    for (const row of pending) {
      const key = `${row.issueAId}|${row.issueBId}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const refs = await issueRefs([...new Set(pending.flatMap((r) => [r.issueAId, r.issueBId]))]);
    const freeMigration = nextFreeMigrationNumber(snapshots);
    let posted = 0;

    for (const rows of groups.values()) {
      const claimed = [];
      for (const row of rows) {
        const won = await db
          .update(issueOverlaps)
          .set({ warnedAt: now, updatedAt: now })
          .where(and(eq(issueOverlaps.id, row.id), isNull(issueOverlaps.warnedAt), eq(issueOverlaps.status, "open")))
          .returning({ id: issueOverlaps.id });
        if (won.length > 0) claimed.push(row);
      }
      if (claimed.length === 0) continue;

      const { issueAId, issueBId } = claimed[0]!;
      const candidates: OverlapCandidate[] = claimed.map((r) => ({
        issueAId: r.issueAId,
        issueBId: r.issueBId,
        kind: r.kind as OverlapKind,
        detailKey: r.detailKey,
        detail: r.detail,
      }));
      const a = refs.get(issueAId);
      const b = refs.get(issueBId);
      if (!a || !b) continue;
      try {
        if (issueAId === issueBId) {
          await db.insert(issueComments).values({
            companyId,
            issueId: issueAId,
            authorType: "system",
            body: buildWarningComment({ other: null, rows: candidates, order: "none", freeMigration }),
          });
          posted += 1;
          continue;
        }
        const [pa, pb] = await Promise.all([getPrProgress(companyId, issueAId), getPrProgress(companyId, issueBId)]);
        const order = suggestOrder(pa, pb);
        await db.insert(issueComments).values([
          {
            companyId,
            issueId: issueAId,
            authorType: "system",
            body: buildWarningComment({
              other: b,
              rows: candidates,
              order: order === "a_first" ? "self_first" : order === "b_first" ? "other_first" : "none",
              freeMigration,
            }),
          },
          {
            companyId,
            issueId: issueBId,
            authorType: "system",
            body: buildWarningComment({
              other: a,
              rows: candidates,
              order: order === "b_first" ? "self_first" : order === "a_first" ? "other_first" : "none",
              freeMigration,
            }),
          },
        ]);
        posted += 2;
      } catch (err) {
        logger.warn({ err, issueAId, issueBId }, "issue-overlap: failed to post warning comment");
      }
    }
    return posted;
  }

  async function runOverlapDetection(companyId: string) {
    const now = nowFn();
    const { snapshots, unreadable } = await loadSnapshots(companyId);
    const desired = new Map(computeOverlaps(snapshots).map((c) => [rowKey(c), c]));
    const existing = await db.select().from(issueOverlaps).where(eq(issueOverlaps.companyId, companyId));
    const existingByKey = new Map(existing.map((r) => [rowKey(r), r]));

    let opened = 0;
    let resolved = 0;
    for (const [key, cand] of desired) {
      const row = existingByKey.get(key);
      if (!row) {
        await db
          .insert(issueOverlaps)
          .values({ companyId, ...cand, status: "open", firstDetectedAt: now, lastSeenAt: now })
          .onConflictDoNothing();
        opened += 1;
      } else if (row.status === "open") {
        await db.update(issueOverlaps).set({ lastSeenAt: now, detail: cand.detail, updatedAt: now }).where(eq(issueOverlaps.id, row.id));
      } else {
        // A resolved overlap that is back is a new fact: it may warn again.
        await db
          .update(issueOverlaps)
          .set({ status: "open", resolvedAt: null, warnedAt: null, firstDetectedAt: now, lastSeenAt: now, detail: cand.detail, updatedAt: now })
          .where(eq(issueOverlaps.id, row.id));
        opened += 1;
      }
    }
    for (const row of existing) {
      if (row.status !== "open" || desired.has(rowKey(row))) continue;
      // Don't resolve on a failed read: an unreadable workspace is "unknown", not "clean".
      if (unreadable.has(row.issueAId) || unreadable.has(row.issueBId)) continue;
      await db
        .update(issueOverlaps)
        .set({ status: "resolved", resolvedAt: now, updatedAt: now })
        .where(eq(issueOverlaps.id, row.id));
      resolved += 1;
    }

    const commentsPosted = await deliverWarnings(companyId, snapshots, now);
    return { opened, resolved, commentsPosted, workspacesScanned: snapshots.length };
  }

  /** Open overlaps joined with both issues, for the board panel. */
  async function listOpenOverlaps(companyId: string, filter: { issueId?: string; seenSince?: Date } = {}) {
    const conditions = [eq(issueOverlaps.companyId, companyId), eq(issueOverlaps.status, "open")];
    if (filter.issueId) {
      conditions.push(or(eq(issueOverlaps.issueAId, filter.issueId), eq(issueOverlaps.issueBId, filter.issueId))!);
    }
    if (filter.seenSince) conditions.push(gte(issueOverlaps.lastSeenAt, filter.seenSince));
    const rows = await db
      .select()
      .from(issueOverlaps)
      .where(and(...conditions))
      .orderBy(desc(issueOverlaps.lastSeenAt));
    const refs = await issueRefs([...new Set(rows.flatMap((r) => [r.issueAId, r.issueBId]))]);
    const statuses = await db
      .select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(inArray(issues.id, [...refs.keys()]));
    const meta = new Map(statuses.map((s) => [s.id, s]));
    const view = (id: string) => {
      const r = refs.get(id);
      return {
        id,
        identifier: r?.identifier ?? null,
        title: r?.title ?? "",
        status: meta.get(id)?.status ?? null,
        assigneeAgentId: meta.get(id)?.assigneeAgentId ?? null,
        assigneeName: r?.assigneeName ?? null,
      };
    };
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as OverlapKind,
      detail: r.detail,
      firstDetectedAt: r.firstDetectedAt,
      lastSeenAt: r.lastSeenAt,
      warnedAt: r.warnedAt,
      issueA: view(r.issueAId),
      issueB: view(r.issueBId),
    }));
  }

  /** Open overlaps for one issue that were re-confirmed within the last 30 minutes. */
  async function listActiveWarningsForIssue(companyId: string, issueId: string, now = nowFn()) {
    const all = await listOpenOverlaps(companyId, {
      issueId,
      seenSince: new Date(now.getTime() - ACTIVE_OVERLAP_WINDOW_MS),
    });
    return all
      .filter((o) => o.kind !== "stale_behind")
      .map((o) => {
        const other = o.issueA.id === issueId ? o.issueB : o.issueA;
        return {
          kind: o.kind,
          detail: o.detail,
          lastSeenAt: o.lastSeenAt,
          otherIssue: {
            id: other.id,
            identifier: other.identifier,
            title: other.title,
            status: other.status,
            assigneeAgentId: other.assigneeAgentId,
          },
          instruction: `Before editing, check ${other.identifier ?? other.id}: it changed the same ${
            o.kind === "migration_number" ? "migration number" : o.kind === "journal_json" ? "migrations journal" : "file"
          } in the last 30 minutes.`,
        };
      });
  }

  return { runOverlapDetection, listOpenOverlaps, listActiveWarningsForIssue };
}
