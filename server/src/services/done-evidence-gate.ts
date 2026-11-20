import { and, asc, desc, eq, gte, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueComments, issueWorkProducts, projectWorkspaces } from "@paperclipai/db";
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
 *  (a) each is on origin AND on the project's branch (repo_ref): the commit answers 200 and
 *      compare/{branch}...{sha} says it is behind or identical. A fork shares the object store
 *      of its upstream, so a bare 200 also happens for a commit that is on no branch we use;
 *  (b) together they change every file the task's "## Acceptance Criteria" names (when the
 *      section names none, this passes and the refusal text says the files were not checked,
 *      and the commit must then be newer than the task or mention its identifier);
 *  (c) a commit with green checks for that exact SHA (failed, pending, none and unknown all
 *      refuse; the first two say which checks). A merge commit's own checks are often just
 *      the lockfile refresh, so the pull request head (its second parent) must be green too.
 * Evidence = the commits named in the done note, commit work products on the issue, and the
 * merge commit of a merge_pr approval that was filed for this issue.
 *
 * `report` mode runs the same check but only posts the note: the transition still goes through.
 */

export type DoneEvidenceReason =
  | "no_commit"
  | "not_on_origin"
  | "not_on_branch"
  | "no_github_access"
  | "github_unreachable"
  | "commit_not_new"
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
/** Slack for clocks: a commit made a few minutes before the task row was created still counts. */
const NEW_COMMIT_SLACK_MS = 10 * 60 * 1000;
/** The same refusal is not posted twice on a task within this window. */
const DUPLICATE_NOTE_WINDOW_MS = 10 * 60 * 1000;

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

/**
 * "Do not change X", "never touch X", "without X", "except X", "no change to X": whatever follows
 * the cue, up to the end of its clause, is what must NOT change.
 */
const NEGATION_PREFIX_CUE =
  /\b(?:do(?:es)?\s+not|don't|doesn't|must\s+not|mustn't|should\s+not|shouldn't|will\s+not|won't|can\s*not|can't|never|without|except(?:\s+for)?|excluding|no\s+changes?\s+(?:to|in|on|of)|not\s+(?:to\s+)?(?:chang|touch|modif|edit|alter|renam|delet|remov)\w*)\b/i;
/** "X must stay unchanged", "X is untouched": what stands before the cue is what must not change. */
const NEGATION_SUFFIX_CUE = /\b(?:unchanged|untouched|unmodified)\b/i;
/** Where one clause ends and the next begins. A "." only counts before a space or the end ("a.ts" is a file). */
const CLAUSE_BREAK = /;|\.(?=\s|$)|\s(?:but|however|and\s+then)\s/i;

/**
 * The text of a line with the parts that say what must NOT change cut out. A negation only
 * silences the paths it is about: "`server/x.ts` returns 409 when the token is not set" still
 * names the file, "Do not change `package.json`" and "`package.json` must stay unchanged" do not.
 */
function withoutNegatedParts(line: string): string {
  return line
    .split(new RegExp(CLAUSE_BREAK.source, "gi"))
    .map((clause) => {
      const prefix = NEGATION_PREFIX_CUE.exec(clause);
      if (prefix) return clause.slice(0, prefix.index);
      const suffix = NEGATION_SUFFIX_CUE.exec(clause);
      if (suffix) return clause.slice(suffix.index + suffix[0].length);
      return clause;
    })
    .join("\n");
}

export type NamedPath = { path: string; /** no file extension: a folder, or not a path at all */ dir: boolean };

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
 * dead end they cannot clear). Skipped: URLs, globs, placeholders, routes and API paths that
 * start with "/", scoped packages (@a/b), content types, and any line that says what must not
 * change ("Do not change `package.json`"). Markdown link targets are read. A folder-like name
 * (no extension) that turns out not to exist in the repo is dropped by the gate itself, which is
 * how `origin/custom` or `application/json` stop being "required files".
 */
export function extractAcceptanceCriteriaPaths(description: string | null | undefined): NamedPath[] {
  const section = extractMarkdownSection(description, "Acceptance Criteria", 50_000);
  if (!section) return [];
  const found = new Map<string, NamedPath>();
  const add = (raw: string, backticked: boolean) => {
    let token = raw.trim().replace(/^[("'<[]+/, "");
    if (!token || token.startsWith("/") || /:\/\//.test(token)) return;
    token = token
      .replace(/[)"'>\],.;:!?]+$/, "")
      .replace(/:\d+(?::\d+)?$/, "") // file.ts:42 or file.ts:42:7
      .replace(/#L\d+(?:-L?\d+)?$/, "")
      .replace(/^\.\//, "")
      .replace(/\/+$/, ""); // ui/src/ -> ui/src
    if (!token || token.includes("..") || /[*{}<>$|\s:@+#\\]/.test(token)) return;
    const hasSlash = token.includes("/");
    const ext = hasKnownExtension(token);
    if (!ext && !(backticked && hasSlash)) return;
    if (!hasSlash && !backticked && JS_PRODUCT_NAMES.test(token)) return;
    if (!found.has(token)) found.set(token, { path: token, dir: !ext });
  };
  const lines = section.split("\n").map(withoutNegatedParts);
  const withoutLinks = lines.join("\n").replace(/\[[^\]\n]*\]\(([^)\s]+)\)/g, (_match, target: string) => {
    add(target, true);
    return " ";
  });
  const withoutTicks = withoutLinks.replace(/`([^`\n]+)`/g, (_match, inner: string) => {
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

type GitHubRepo = { owner: string; name: string; /** the project's branch (repo_ref / default_ref), when it names one */ branch: string | null };

type CommitLookup =
  | { found: true; sha: string; files: Set<string>; parents: string[]; committedAt: Date | null; message: string }
  | { found: false; reason: "not_found" | "no_access" | "denied" | "unreachable" };

function githubHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-done-evidence-gate",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

/** 401 (bad token), 403 (not allowed) and 429 (rate limit): GitHub answered, but not with what we asked for. */
function isDeniedStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429;
}

function repoBase(repo: GitHubRepo): string {
  return `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

/** Can this token see the repository? "no" for a repository GitHub says does not exist for it (404) or refuses it (401/403/429). */
async function repoIsVisible(repo: GitHubRepo, fetchImpl: CommitCiFetch, token: string | null): Promise<"yes" | "no" | "unreachable"> {
  try {
    const response = await fetchImpl(repoBase(repo), {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404 || isDeniedStatus(response.status)) return "no";
    return response.ok ? "yes" : "unreachable";
  } catch {
    return "unreachable";
  }
}

/** The repository's default branch (from GET /repos/{owner}/{repo}). */
async function fetchDefaultBranch(
  repo: GitHubRepo,
  fetchImpl: CommitCiFetch,
  token: string | null,
): Promise<{ branch: string } | { branch: null; reason: "denied" | "unreachable" }> {
  try {
    const response = await fetchImpl(repoBase(repo), {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404 || isDeniedStatus(response.status)) return { branch: null, reason: "denied" };
    if (!response.ok) return { branch: null, reason: "unreachable" };
    const body = (await response.json()) as Record<string, unknown> | null;
    const branch = typeof body?.default_branch === "string" ? body.default_branch.trim() : "";
    return branch ? { branch } : { branch: null, reason: "unreachable" };
  } catch {
    return { branch: null, reason: "unreachable" };
  }
}

async function lookupCommit(
  repo: GitHubRepo,
  sha: string,
  fetchImpl: CommitCiFetch,
  token: string | null,
): Promise<CommitLookup> {
  const base = `${repoBase(repo)}/commits/${encodeURIComponent(sha)}`;
  const files = new Set<string>();
  let fullSha: string | null = null;
  let parents: string[] = [];
  let committedAt: Date | null = null;
  let message = "";
  try {
    for (let page = 1; page <= COMMIT_FILES_MAX_PAGES; page++) {
      const response = await fetchImpl(`${base}?per_page=${COMMIT_FILES_PER_PAGE}&page=${page}`, {
        headers: githubHeaders(token),
        signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
      });
      // 404/422 = no such commit as far as GitHub will say. With no token a private repository
      // answers 404 for everything, so that is "no access", not proof the commit was never pushed.
      if (response.status === 404 || response.status === 422) {
        if (!token) return { found: false, reason: "no_access" };
        // A token that cannot see a private repository gets 404 for everything in it too, which
        // is not proof the commit was never pushed: ask whether the token can see the repo at all.
        const visible = await repoIsVisible(repo, fetchImpl, token);
        return { found: false, reason: visible === "no" ? "denied" : visible === "unreachable" ? "unreachable" : "not_found" };
      }
      // Bad credentials, not allowed, or rate limited: GitHub could not be asked.
      if (isDeniedStatus(response.status)) return { found: false, reason: "denied" };
      if (!response.ok) return { found: false, reason: "unreachable" };
      const body = (await response.json()) as Record<string, unknown> | null;
      if (!body || typeof body.sha !== "string") return { found: false, reason: "unreachable" };
      fullSha = body.sha.toLowerCase();
      if (page === 1) {
        parents = Array.isArray(body.parents)
          ? (body.parents as Array<Record<string, unknown>>)
              .map((parent) => (typeof parent?.sha === "string" ? parent.sha.toLowerCase() : ""))
              .filter(Boolean)
          : [];
        const commitInfo = (body.commit ?? {}) as Record<string, unknown>;
        const date = ((commitInfo.committer ?? {}) as Record<string, unknown>).date;
        committedAt = typeof date === "string" && !Number.isNaN(Date.parse(date)) ? new Date(date) : null;
        message = typeof commitInfo.message === "string" ? commitInfo.message : "";
      }
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
  return fullSha
    ? { found: true, sha: fullSha, files, parents, committedAt, message }
    : { found: false, reason: "unreachable" };
}

/** Is the commit on (an ancestor of, or equal to) the project's branch? */
async function commitIsOnBranch(
  repo: GitHubRepo,
  branchName: string,
  sha: string,
  fetchImpl: CommitCiFetch,
  token: string | null,
): Promise<"yes" | "no" | "unreachable" | "denied" | "unknown_branch"> {
  const branch = branchName.split("/").map(encodeURIComponent).join("/");
  try {
    const response = await fetchImpl(`${repoBase(repo)}/compare/${branch}...${encodeURIComponent(sha)}`, {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
    // The named branch does not exist (any more): nothing to compare against.
    if (response.status === 404) return "unknown_branch";
    if (isDeniedStatus(response.status)) return "denied";
    if (!response.ok) return "unreachable";
    const body = (await response.json()) as Record<string, unknown> | null;
    // base=branch, head=sha: the sha is behind (an ancestor) or identical exactly when the branch has it.
    return body?.status === "behind" || body?.status === "identical" ? "yes" : "no";
  } catch {
    return "unreachable";
  }
}

async function pathExistsAtCommit(
  repo: GitHubRepo,
  path: string,
  sha: string,
  fetchImpl: CommitCiFetch,
  token: string | null,
): Promise<"yes" | "no" | "unreachable" | "denied"> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  try {
    const response = await fetchImpl(`${repoBase(repo)}/contents/${encoded}?ref=${encodeURIComponent(sha)}`, {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404) return "no";
    if (isDeniedStatus(response.status)) return "denied";
    return response.ok ? "yes" : "unreachable";
  } catch {
    return "unreachable";
  }
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
): Promise<GitHubRepo | null> {
  if (!input.projectId) return null;
  const rows = await db
    .select({ repoUrl: projectWorkspaces.repoUrl, repoRef: projectWorkspaces.repoRef, defaultRef: projectWorkspaces.defaultRef })
    .from(projectWorkspaces)
    .where(and(eq(projectWorkspaces.companyId, input.companyId), eq(projectWorkspaces.projectId, input.projectId)))
    .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt));
  for (const row of rows) {
    const parsed = parseGitHubRepoUrl(row.repoUrl);
    if (parsed && (parsed.hostname === "github.com" || parsed.hostname === "www.github.com")) {
      const branch = row.repoRef?.trim() || row.defaultRef?.trim() || null;
      return { owner: parsed.owner, name: parsed.name, branch };
    }
  }
  return null;
}

/**
 * True when this exact note was already posted on the task a few minutes ago. Repeated refusals
 * (an agent retrying the same done) must not pile up identical comments.
 */
export async function hasRecentIdenticalNote(
  db: Db,
  input: { companyId: string; issueId: string; body: string; now?: Date },
): Promise<boolean> {
  const cutoff = new Date((input.now ?? new Date()).getTime() - DUPLICATE_NOTE_WINDOW_MS);
  const row = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.body, input.body),
        gte(issueComments.createdAt, cutoff),
        isNull(issueComments.deletedAt),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return Boolean(row);
}

type GateInput = {
  db: Db;
  issue: {
    id: string;
    identifier: string | null;
    companyId: string;
    projectId: string | null;
    description: string | null;
    createdAt?: Date | string | null;
  };
  actor: { actorType: string; agentId: string | null; runId: string | null };
  /** The status the issue is about to get, AFTER the review policy has run. */
  requestedStatus: string | undefined;
  currentStatus: string;
  patchComment: string | null;
  /** Agents (besides the actor) whose latest comment may carry the done note: the assignee and, during a review stage, the worker the task returns to. */
  otherNoteAgentIds?: Array<string | null | undefined>;
  deps?: DoneEvidenceGateDeps;
};

export async function evaluateDoneEvidenceGate(input: GateInput): Promise<DoneEvidenceGateResult | null> {
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

type CheckedCommit = Extract<CommitLookup, { found: true }> & { asNamed: string };
type EffectiveCi = { state: CommitCiStatus["state"]; failedChecks: string[]; pendingChecks: string[]; blameSha: string; denied?: boolean };

/** A merge commit's own checks are often only the lockfile refresh: its PR head (2nd parent) must be green. */
async function effectiveCiFor(
  repo: GitHubRepo,
  commit: CheckedCommit,
  fetchImpl: CommitCiFetch,
  token: string | null,
): Promise<EffectiveCi> {
  const own = await fetchCommitCiStatus(repo, commit.sha, { fetchImpl, token });
  const prHead = commit.parents.length >= 2 ? commit.parents[1]! : null;
  if (!prHead) return { ...own, blameSha: commit.sha };
  const head = await fetchCommitCiStatus(repo, prHead, { fetchImpl, token });
  if (own.state === "failed") return { ...own, blameSha: commit.sha };
  if (head.state === "failed") return { ...head, blameSha: prHead };
  if (own.state === "pending") return { ...own, blameSha: commit.sha };
  if (head.state === "pending") return { ...head, blameSha: prHead };
  if (head.state !== "green") return { ...head, blameSha: prHead };
  // The pull request head is green; the merge commit itself may have no checks at all, but
  // GitHub being unreadable for it is still not a pass.
  if (own.state === "unknown") return { ...own, blameSha: commit.sha };
  return { state: "green", failedChecks: [], pendingChecks: [], blameSha: commit.sha };
}

async function check(input: GateInput): Promise<DoneEvidenceGateResult | null> {
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
      namedPaths.length === 0 && (reason === "checks_failed" || reason === "checks_pending" || reason === "no_check_result")
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
  const cannotReach = (list: string, commits: string[], denied = false) =>
    refuse(
      "github_unreachable",
      denied
        ? `could not check commit ${list} because GitHub could not be reached (no access or rate limit). Check that this company's GitHub token can see the repository, or try again later.`
        : `could not check commit ${list} on GitHub because GitHub did not answer. Try again in a minute.`,
      commits,
    );

  const evidence = await collectEvidenceShas(input.db, {
    issue: input.issue,
    agentId: input.actor.agentId!,
    patchComment: input.patchComment,
    otherNoteAgentIds: input.otherNoteAgentIds,
  });
  if (evidence.length === 0) {
    return refuse(
      "no_commit",
      "no commit is named. Put the full commit hash of the change in your done note (after it is pushed to GitHub), or link the commit to the task.",
      [],
    );
  }

  // (a) on origin
  const lookups = await Promise.all(evidence.map((sha) => lookupCommit(repo, sha, fetchImpl, token)));
  const found: CheckedCommit[] = lookups.flatMap((lookup, index) => (lookup.found ? [{ asNamed: evidence[index]!, ...lookup }] : []));
  if (found.length === 0) {
    const list = listWords(evidence.map(short));
    if (lookups.some((lookup) => !lookup.found && lookup.reason === "no_access")) {
      return refuse(
        "no_github_access",
        `Paperclip has no GitHub access for this company, so commit ${list} could not be checked. Ask the owner to add a GitHub token.`,
        evidence,
      );
    }
    if (lookups.some((lookup) => !lookup.found && lookup.reason === "unreachable")) return cannotReach(list, evidence);
    if (lookups.some((lookup) => !lookup.found && lookup.reason === "denied")) return cannotReach(list, evidence, true);
    return refuse(
      "not_on_origin",
      `${evidence.length === 1 ? "commit" : "commits"} ${list} ${evidence.length === 1 ? "is" : "are"} not on GitHub. Push the work and name the commit that is there.`,
      evidence,
    );
  }

  // ... and on the project's branch (a fork shares its upstream's commits, a stray branch is not shipped work).
  // A project that names no branch, or names one that does not exist, is held to the repository's
  // default branch: skipping the check would let a commit on any stray branch through.
  const foundShas = found.map((commit) => commit.sha);
  const foundList = listWords(found.map((commit) => short(commit.sha)));
  const compareAgainst = (branchName: string) =>
    Promise.all(found.map((commit) => commitIsOnBranch(repo, branchName, commit.sha, fetchImpl, token)));
  let branchName = repo.branch;
  let branchStates: Array<Awaited<ReturnType<typeof commitIsOnBranch>>> | null = null;
  if (branchName) {
    const named = await compareAgainst(branchName);
    // A 404 means the named branch does not exist (any more): fall back to the default branch.
    if (!named.some((state) => state === "unknown_branch")) branchStates = named;
  }
  if (!branchStates) {
    const fallback = await fetchDefaultBranch(repo, fetchImpl, token);
    if (fallback.branch === null) return cannotReach(foundList, foundShas, fallback.reason === "denied");
    if (fallback.branch === branchName) return cannotReach(foundList, foundShas); // named, "missing" and default at once: GitHub is inconsistent
    branchName = fallback.branch;
    branchStates = await compareAgainst(branchName);
  }
  if (branchStates.some((state) => state === "unknown_branch")) return cannotReach(foundList, foundShas);
  const onBranch = found.filter((_, index) => branchStates![index] === "yes");
  if (onBranch.length === 0) {
    if (branchStates.some((state) => state === "denied")) return cannotReach(foundList, foundShas, true);
    if (branchStates.some((state) => state === "unreachable")) return cannotReach(foundList, foundShas);
    return refuse(
      "not_on_branch",
      `commit ${foundList} is on GitHub but not on ${branchName} yet. Merge it, then name the commit that is on ${branchName}.`,
      foundShas,
    );
  }

  // When the task names no files, the commit has to belong to THIS task: made after it started,
  // or naming it. Otherwise the newest merge commit on the branch would pass any task.
  let candidates = onBranch;
  const createdAt = input.issue.createdAt ? new Date(input.issue.createdAt) : null;
  if (namedPaths.length === 0 && createdAt && !Number.isNaN(createdAt.getTime())) {
    const identifier = input.issue.identifier?.trim() ?? "";
    const fresh = onBranch.filter(
      (commit) =>
        (commit.committedAt && commit.committedAt.getTime() >= createdAt.getTime() - NEW_COMMIT_SLACK_MS) ||
        (identifier !== "" && commit.message.toLowerCase().includes(identifier.toLowerCase())),
    );
    if (fresh.length === 0) {
      return refuse(
        "commit_not_new",
        `commit ${listWords(onBranch.map((commit) => short(commit.sha)))} was made before this task started${identifier ? ` and does not mention ${identifier}` : ""}. Name the commit that carries this task's change.`,
        onBranch.map((commit) => commit.sha),
      );
    }
    candidates = fresh;
  }
  const candidateShas = candidates.map((commit) => commit.sha);
  const candidateList = listWords(candidates.map((commit) => short(commit.sha)));

  // (b) touches every file the task names. A name with no file extension that does not exist in
  // the repository at that commit was never a path (a branch, a content type): drop it.
  const allFiles = new Set(candidates.flatMap((commit) => [...commit.files]));
  const notTouched = namedPaths.filter((named) => !pathIsCovered(named, allFiles));
  const dropped = new Set<NamedPath>();
  for (const named of notTouched) {
    if (!named.dir) continue;
    const exists = await pathExistsAtCommit(repo, named.path, candidates[0]!.sha, fetchImpl, token);
    if (exists === "unreachable" || exists === "denied") return cannotReach(candidateList, candidateShas, exists === "denied");
    if (exists === "no") dropped.add(named);
  }
  const missing = notTouched.filter((named) => !dropped.has(named));
  if (missing.length > 0) {
    return refuse(
      "files_not_touched",
      `commit ${candidateList} does not change ${listWords(missing.map((named) => named.path))}, which the task names.`,
      candidateShas,
    );
  }
  const requiredPaths = namedPaths.filter((named) => !dropped.has(named));

  // (c) green checks for that exact commit
  const cis = await Promise.all(candidates.map((commit) => effectiveCiFor(repo, commit, fetchImpl, token)));
  const checked = candidates.map((commit, index) => ({ ...commit, ci: cis[index]! }));
  const green = checked.filter((commit) => commit.ci.state === "green");
  const greenFiles = new Set(green.flatMap((commit) => [...commit.files]));
  const coveredByGreen = (named: NamedPath) => pathIsCovered(named, greenFiles);
  if (green.length > 0 && requiredPaths.every(coveredByGreen)) return null;

  // Blame the commits that carry the files the green ones do not (or all, when none is green).
  const blamed = checked.filter((commit) => {
    if (commit.ci.state === "green") return false;
    if (green.length === 0) return true;
    return requiredPaths.some((named) => !coveredByGreen(named) && pathIsCovered(named, commit.files));
  });
  const pool = blamed.length > 0 ? blamed : checked.filter((commit) => commit.ci.state !== "green");
  const worst =
    pool.find((commit) => commit.ci.state === "failed") ??
    pool.find((commit) => commit.ci.state === "pending") ??
    pool[0] ??
    checked[0]!;
  const blame = short(worst.ci.blameSha);
  const viaPullRequest = worst.ci.blameSha !== worst.sha ? ` (the pull request behind ${short(worst.sha)})` : "";
  if (worst.ci.state === "failed") {
    return refuse("checks_failed", `the checks for ${blame}${viaPullRequest} failed: ${listWords(worst.ci.failedChecks)}.`, candidateShas);
  }
  if (worst.ci.state === "pending") {
    const running = worst.ci.pendingChecks.length > 0 ? ` (${listWords(worst.ci.pendingChecks)})` : "";
    return refuse("checks_pending", `the checks for ${blame}${viaPullRequest} are still running${running}. Wait for them to finish.`, candidateShas);
  }
  if (worst.ci.state === "unknown" && worst.ci.denied) return cannotReach(candidateList, candidateShas, true);
  return refuse("no_check_result", `there is no check result for commit ${blame}${viaPullRequest}.`, candidateShas);
}
