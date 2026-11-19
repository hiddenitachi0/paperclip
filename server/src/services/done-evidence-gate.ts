import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts, projectWorkspaces } from "@paperclipai/db";
import type { QualityDoneEvidenceMode } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { fetchCommitCiStatus, type CommitCiFetch, type CommitCiStatus } from "./commit-ci-status.js";
import { gitHubApiBase } from "./github-fetch.js";
import { parseGitHubRepoUrl } from "./github-token-check.js";
import { approvalPayloadKind, approvalPayloadMergeCommitSha, approvalPayloadOriginalIssueIds } from "./deploy-completion-gate.js";
import { issueApprovalService } from "./issue-approvals.js";
import { extractMarkdownSection } from "./issue-continuation-summary.js";
import { extractNamedCommits, findLatestAgentComment } from "./origin-commit-gate.js";
import { normalizeDoneEvidenceMode, readQualityLoopSettingsRow } from "./quality-loops.js";
import { secretService } from "./secrets.js";

/**
 * DUR-5179: a code task only reaches `done` with a verified commit.
 *
 * Incident NOR-230: an agent marked a code task done with detailed claims (changed lines, a
 * named test, "29 tests pass") and none of it existed in any branch. The agent's text is never
 * trusted here; every claim is checked against GitHub on the server.
 *
 * Applies only when ALL of these hold (otherwise it returns null and is invisible):
 * - the actor is an AGENT (a board user is the human override and is never gated);
 * - the target status is `done` and the issue is not already done;
 * - the issue's project has a workspace with a github.com repo_url (a "code ticket");
 * - the company's done_evidence_mode is not `off` (the default).
 *
 * Passes when the evidence commits satisfy all three:
 *  (a) each is on origin: GET /repos/{o}/{r}/commits/{sha} answers 200;
 *  (b) together they change every file the task's "## Acceptance Criteria" names (when the
 *      section names none, this passes and the refusal text says the files were not checked);
 *  (c) a commit with green checks for that exact SHA (failed, pending, none and unknown all
 *      refuse; the first two say which checks).
 * Evidence = the commits named in the done note, commit work products on the issue, and the
 * merge commit of a merge_pr approval that was filed for this issue.
 *
 * `report` mode runs the same check but only posts the note: the transition still goes through.
 */

export type DoneEvidenceReason =
  | "no_commit"
  | "not_on_origin"
  | "github_unreachable"
  | "files_not_touched"
  | "checks_failed"
  | "checks_pending"
  | "no_check_result";

export type DoneEvidenceGateResult = {
  mode: Exclude<QualityDoneEvidenceMode, "off">;
  /** true -> refuse with 409 done_evidence_missing; false (report mode) -> note only. */
  refuse: boolean;
  reason: DoneEvidenceReason;
  /** One plain-words comment for the task. */
  message: string;
  reasons: string[];
  commits: string[];
};

export type DoneEvidenceGateDeps = {
  fetchImpl?: CommitCiFetch;
  getGitHubToken?: (companyId: string) => Promise<string | null>;
};

const MAX_EVIDENCE_COMMITS = 5;
const COMMIT_FILES_PER_PAGE = 100;
const COMMIT_FILES_MAX_PAGES = 30;
const GITHUB_REQUEST_TIMEOUT_MS = 15_000;
const HEX_SHA = /^[0-9a-f]{7,40}$/i;

/**
 * Extensions that make a bare word a file name. A closed list on purpose: "e.g.", "Node.js" or
 * "v1.2" must never become a file the agent is then refused for not touching.
 */
const PATH_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "mdx", "sql", "sh", "bash", "yml", "yaml",
  "css", "scss", "html", "py", "go", "rs", "toml", "txt", "tf", "svg", "csv", "env", "lock", "ini", "xml",
]);

/** Product names that end in ".js" and are never the file a task means ("Node.js", "Next.js"). */
const JS_PRODUCT_NAMES = /^(node|next|nuxt|vue|react|express|three|d3|chart|socket|alpine|ember|backbone|moment|nest|solid|svelte|angular|bun|deno)\.js$/i;

export type NamedPath = { path: string; /** a directory-like path (matches anything under it) */ dir: boolean };

function stripPathDecorations(raw: string): string {
  return raw
    .trim()
    .replace(/^[("'<\[]+/, "")
    .replace(/[)"'>\],.;:!?]+$/, "")
    .replace(/:\d+(?::\d+)?$/, "") // file.ts:42 or file.ts:42:7
    .replace(/#L\d+(?:-L?\d+)?$/, "")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

function hasKnownExtension(path: string): boolean {
  const last = path.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  if (dot <= 0 && !(dot === 0 && last.length > 1)) return false;
  return PATH_EXTENSIONS.has(last.slice(dot + 1).toLowerCase());
}

/**
 * The file paths a task's "## Acceptance Criteria" section names. Backticked tokens count when
 * they have a slash or a known extension; bare words only with a known extension (a bare
 * "and/or" or "client/server" is prose, and refusing someone for not touching it would be a
 * dead end they cannot clear). URLs, globs and placeholders are skipped.
 */
export function extractAcceptanceCriteriaPaths(description: string | null | undefined): NamedPath[] {
  const section = extractMarkdownSection(description, "Acceptance Criteria", 50_000);
  if (!section) return [];
  const found = new Map<string, NamedPath>();
  const add = (raw: string, backticked: boolean) => {
    if (/:\/\//.test(raw) || /[*{}<>$\s|]/.test(raw.trim())) return;
    const path = stripPathDecorations(raw);
    if (!path || path.includes("..") || /[*{}<>$|\s]/.test(path)) return;
    const hasSlash = path.includes("/");
    const ext = hasKnownExtension(path);
    if (!ext && !(backticked && hasSlash)) return;
    if (!hasSlash && !backticked && JS_PRODUCT_NAMES.test(path)) return;
    if (!found.has(path)) found.set(path, { path, dir: !ext });
  };
  const withoutTicks = section.replace(/`([^`\n]+)`/g, (_match, inner: string) => {
    add(inner, true);
    return " ";
  });
  for (const token of withoutTicks.split(/\s+/)) add(token, false);
  return [...found.values()];
}

function pathIsCovered(named: NamedPath, files: Set<string>): boolean {
  for (const file of files) {
    if (file === named.path || file.endsWith(`/${named.path}`)) return true;
    if (named.dir && (file.startsWith(`${named.path}/`) || file.includes(`/${named.path}/`))) return true;
  }
  return false;
}

type CommitLookup =
  | { found: true; sha: string; files: Set<string> }
  | { found: false; reason: "not_found" | "unreachable" };

async function lookupCommit(
  repo: { owner: string; name: string },
  sha: string,
  fetchImpl: CommitCiFetch,
  token: string | null,
): Promise<CommitLookup> {
  const base = `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/commits/${encodeURIComponent(sha)}`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-done-evidence-gate",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const files = new Set<string>();
  let fullSha: string | null = null;
  try {
    for (let page = 1; page <= COMMIT_FILES_MAX_PAGES; page++) {
      const response = await fetchImpl(`${base}?per_page=${COMMIT_FILES_PER_PAGE}&page=${page}`, {
        headers,
        signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
      });
      // 404 = no such commit in this repo; 422 = GitHub could not resolve the (short) sha.
      if (response.status === 404 || response.status === 422) return { found: false, reason: "not_found" };
      if (!response.ok) return { found: false, reason: "unreachable" };
      const body = (await response.json()) as Record<string, unknown> | null;
      if (!body || typeof body.sha !== "string") return { found: false, reason: "unreachable" };
      fullSha = body.sha.toLowerCase();
      const pageFiles = Array.isArray(body.files) ? (body.files as Array<Record<string, unknown>>) : [];
      for (const file of pageFiles) {
        if (typeof file?.filename === "string") files.add(file.filename);
        if (typeof file?.previous_filename === "string") files.add(file.previous_filename);
      }
      if (pageFiles.length < COMMIT_FILES_PER_PAGE) break;
    }
  } catch {
    return { found: false, reason: "unreachable" };
  }
  return fullSha ? { found: true, sha: fullSha, files } : { found: false, reason: "unreachable" };
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function commitsFromWorkProductRow(row: {
  externalId: string | null;
  url: string | null;
  metadata: Record<string, unknown> | null;
}): string[] {
  const out: string[] = [];
  const consider = (value: unknown) => {
    if (typeof value === "string" && HEX_SHA.test(value.trim())) out.push(value.trim().toLowerCase());
  };
  consider(row.externalId);
  consider(row.metadata?.sha);
  consider(row.metadata?.commitSha);
  consider(row.metadata?.commit);
  const fromUrl = row.url?.match(/\/commit\/([0-9a-f]{7,40})\b/i);
  if (fromUrl) consider(fromUrl[1]);
  return out;
}

function dedupeShas(shas: string[]): string[] {
  const kept: string[] = [];
  for (const sha of shas) {
    if (kept.some((existing) => existing.startsWith(sha) || sha.startsWith(existing))) continue;
    kept.push(sha);
  }
  return kept;
}

async function collectEvidenceShas(
  db: Db,
  input: {
    issue: { id: string; companyId: string };
    agentId: string;
    patchComment: string | null;
    otherNoteAgentIds?: Array<string | null | undefined>;
  },
): Promise<string[]> {
  const doneNote = input.patchComment?.trim()
    ? input.patchComment
    : await findLatestAgentComment(db, {
        companyId: input.issue.companyId,
        issueId: input.issue.id,
        agentId: input.agentId,
      });
  // When someone else approves (the comment-approval path), the worker's own done note is
  // where the commit was named: read the latest note of each other agent the caller names.
  const otherNotes: Array<string | null> = [];
  for (const otherAgentId of new Set((input.otherNoteAgentIds ?? []).filter((id): id is string => Boolean(id)))) {
    if (otherAgentId === input.agentId) continue;
    otherNotes.push(
      await findLatestAgentComment(db, {
        companyId: input.issue.companyId,
        issueId: input.issue.id,
        agentId: otherAgentId,
      }),
    );
  }
  const fromNote = dedupeShas(
    [doneNote, ...otherNotes].flatMap((note) => extractNamedCommits(note, MAX_EVIDENCE_COMMITS)),
  ).slice(0, MAX_EVIDENCE_COMMITS);

  const productRows = await db
    .select({
      externalId: issueWorkProducts.externalId,
      url: issueWorkProducts.url,
      metadata: issueWorkProducts.metadata,
    })
    .from(issueWorkProducts)
    .where(
      and(
        eq(issueWorkProducts.companyId, input.issue.companyId),
        eq(issueWorkProducts.issueId, input.issue.id),
        eq(issueWorkProducts.type, "commit"),
      ),
    )
    .orderBy(desc(issueWorkProducts.createdAt))
    .limit(MAX_EVIDENCE_COMMITS);
  const fromProducts = productRows.flatMap(commitsFromWorkProductRow);

  const linked = await issueApprovalService(db).listApprovalsForIssue(input.issue.id);
  const fromApprovals = linked
    .filter(
      (approval) =>
        approval.status === "approved" &&
        approvalPayloadKind(approval.payload) === "merge_pr" &&
        // The link table is mutable: only an approval filed for THIS issue is evidence for it
        // (the same fail-closed check deploy-completion-gate.ts makes).
        approvalPayloadOriginalIssueIds(approval.payload).includes(input.issue.id),
    )
    .map((approval) => approvalPayloadMergeCommitSha(approval.payload)?.toLowerCase() ?? null)
    .filter((sha): sha is string => sha !== null && HEX_SHA.test(sha));

  return dedupeShas([...fromNote, ...fromProducts, ...fromApprovals]).slice(0, MAX_EVIDENCE_COMMITS);
}

async function resolveGitHubRepo(
  db: Db,
  input: { companyId: string; projectId: string | null | undefined },
): Promise<{ owner: string; name: string } | null> {
  if (!input.projectId) return null;
  const rows = await db
    .select({ repoUrl: projectWorkspaces.repoUrl })
    .from(projectWorkspaces)
    .where(and(eq(projectWorkspaces.companyId, input.companyId), eq(projectWorkspaces.projectId, input.projectId)))
    .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt));
  for (const row of rows) {
    const parsed = parseGitHubRepoUrl(row.repoUrl);
    if (parsed && (parsed.hostname === "github.com" || parsed.hostname === "www.github.com")) {
      return { owner: parsed.owner, name: parsed.name };
    }
  }
  return null;
}

export async function evaluateDoneEvidenceGate(input: {
  db: Db;
  issue: {
    id: string;
    identifier: string | null;
    companyId: string;
    projectId: string | null;
    description: string | null;
  };
  actor: { actorType: string; agentId: string | null; runId: string | null };
  requestedStatus: string | undefined;
  currentStatus: string;
  patchComment: string | null;
  /** Agents (besides the actor) whose latest comment may carry the done note, e.g. the assignee. */
  otherNoteAgentIds?: Array<string | null | undefined>;
  deps?: DoneEvidenceGateDeps;
}): Promise<DoneEvidenceGateResult | null> {
  if (input.actor.actorType !== "agent" || !input.actor.agentId) return null;
  if (input.requestedStatus !== "done" || input.currentStatus === "done") return null;
  try {
    return await check(input);
  } catch (err) {
    // Fails OPEN on an unexpected error of our own (a database hiccup, an odd row): this runs
    // inside the PATCH that closes a task, and a bug here must not make finishing impossible.
    // GitHub not answering is NOT this case -- that is handled inside check() as "unverified".
    logger.warn(
      { err, issueId: input.issue.id, companyId: input.issue.companyId },
      "done-evidence gate could not run; letting the transition through (DUR-5179)",
    );
    return null;
  }
}

async function check(input: Parameters<typeof evaluateDoneEvidenceGate>[0]): Promise<DoneEvidenceGateResult | null> {
  const row = await readQualityLoopSettingsRow(input.db, input.issue.companyId);
  const configuredMode = normalizeDoneEvidenceMode(row?.doneEvidenceMode);
  if (configuredMode === "off") return null;
  const mode = configuredMode;

  const repo = await resolveGitHubRepo(input.db, { companyId: input.issue.companyId, projectId: input.issue.projectId });
  if (!repo) return null; // not a code ticket

  const fetchImpl: CommitCiFetch = input.deps?.fetchImpl ?? fetch;
  const token = await (
    input.deps?.getGitHubToken ??
    ((companyId: string) =>
      secretService(input.db)
        .resolveGitHubToken(companyId, { consumerType: "system", consumerId: "done-evidence-gate" })
        .catch(() => null))
  )(input.issue.companyId).catch(() => null);

  const namedPaths = extractAcceptanceCriteriaPaths(input.issue.description);
  const refuse = (reason: DoneEvidenceReason, text: string, commits: string[]): DoneEvidenceGateResult => {
    const filesNote =
      namedPaths.length === 0 && reason !== "no_commit" && reason !== "not_on_origin" && reason !== "github_unreachable"
        ? " The task names no files, so this did not check which files the commit changes."
        : "";
    return {
      mode,
      refuse: mode === "enforce",
      reason,
      message:
        mode === "enforce"
          ? `Not done yet: ${text}${filesNote}`
          : `Check before done (this company only reports it, the task still closes): ${text}${filesNote}`,
      reasons: [text],
      commits,
    };
  };

  const evidence = await collectEvidenceShas(input.db, {
    issue: input.issue,
    agentId: input.actor.agentId!,
    patchComment: input.patchComment,
    otherNoteAgentIds: input.otherNoteAgentIds,
  });
  if (evidence.length === 0) {
    return refuse(
      "no_commit",
      "no commit is named. Put the full commit hash of the change in your done note (after it is pushed to GitHub), or attach it as a commit work product.",
      [],
    );
  }

  // (a) on origin
  const lookups = await Promise.all(evidence.map((sha) => lookupCommit(repo, sha, fetchImpl, token)));
  const existing = lookups.flatMap((lookup, index) => (lookup.found ? [{ asNamed: evidence[index]!, ...lookup }] : []));
  if (existing.length === 0) {
    const unreachable = lookups.some((lookup) => !lookup.found && lookup.reason === "unreachable");
    const list = listWords(evidence.map(short));
    if (unreachable) {
      return refuse(
        "github_unreachable",
        `could not check commit ${list} on GitHub because GitHub did not answer. Try again in a minute.`,
        evidence,
      );
    }
    return refuse(
      "not_on_origin",
      `${evidence.length === 1 ? "commit" : "commits"} ${list} ${evidence.length === 1 ? "is" : "are"} not on GitHub. Push the work and name the commit that is there.`,
      evidence,
    );
  }

  // (b) touches every file the task names
  const allFiles = new Set(existing.flatMap((commit) => [...commit.files]));
  const missingAnywhere = namedPaths.filter((named) => !pathIsCovered(named, allFiles));
  if (missingAnywhere.length > 0) {
    return refuse(
      "files_not_touched",
      `commit ${listWords(existing.map((commit) => short(commit.sha)))} does not change ${listWords(missingAnywhere.map((named) => named.path))}, which the task names.`,
      existing.map((commit) => commit.sha),
    );
  }

  // (c) green checks for that exact commit
  const cis = await Promise.all(
    existing.map((commit) => fetchCommitCiStatus(repo, commit.sha, { fetchImpl, token })),
  );
  const checked = existing.map((commit, index) => ({ ...commit, ci: cis[index]! as CommitCiStatus }));
  const green = checked.filter((commit) => commit.ci.state === "green");
  const greenFiles = new Set(green.flatMap((commit) => [...commit.files]));
  if (green.length > 0 && namedPaths.every((named) => pathIsCovered(named, greenFiles))) return null;

  // Blame the commits that carry the files the green ones do not (or all, when none is green).
  const blamed = checked.filter((commit) => {
    if (commit.ci.state === "green") return false;
    if (green.length === 0) return true;
    return namedPaths.some((named) => !pathIsCovered(named, greenFiles) && pathIsCovered(named, commit.files));
  });
  const pool = blamed.length > 0 ? blamed : checked.filter((commit) => commit.ci.state !== "green");
  const worst =
    pool.find((commit) => commit.ci.state === "failed") ??
    pool.find((commit) => commit.ci.state === "pending") ??
    pool[0] ??
    checked[0]!;
  const commits = checked.map((commit) => commit.sha);
  if (worst.ci.state === "failed") {
    return refuse(
      "checks_failed",
      `the checks for ${short(worst.sha)} failed: ${listWords(worst.ci.failedChecks)}.`,
      commits,
    );
  }
  if (worst.ci.state === "pending") {
    const running = worst.ci.pendingChecks.length > 0 ? ` (${listWords(worst.ci.pendingChecks)})` : "";
    return refuse("checks_pending", `the checks for ${short(worst.sha)} are still running${running}. Wait for them to finish.`, commits);
  }
  return refuse("no_check_result", `there is no check result for commit ${short(worst.sha)}.`, commits);
}
