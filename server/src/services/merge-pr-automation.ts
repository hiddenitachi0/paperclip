import { and, eq, inArray } from "drizzle-orm";
import { approvals, type Db } from "@paperclipai/db";
import { approvalService } from "./approvals.js";
import { instanceSettingsService } from "./instance-settings.js";
import { secretService } from "./secrets.js";
import { logActivity } from "./activity-log.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * DUR-299 point 6 / DUR-314: the delegated, non-human, non-agent identity that
 * may approve the "61 percent" of merge_pr approvals (CI green + no
 * fundamental-surface path touched + an independent agent review) without
 * reaching the operator.
 *
 * Hard rules, enforced here, not by convention:
 * - This NEVER goes through server/src/services/agent-roles.ts
 *   (companyAgentRoles/principalPermissionGrants). It never calls
 *   sanitizeGrants, never consults access.decide, and carries no
 *   PrincipalType. It cannot trigger or route around DEPLOY_APPROVAL_KEYS --
 *   see that file's own comment ("Hard rule: no role right may ever carry
 *   deploy-approval power") which this module must never need to touch.
 * - assertMergePrOnly throws (does not skip silently) for any approval that
 *   is not a pending request_board_approval with payload.kind === "merge_pr".
 *   Called both as a query-level filter AND as a per-row guard so a bug in
 *   the query can never widen this to another approval kind.
 * - Every condition check fails CLOSED: GitHub unreachable, ambiguous, or
 *   any field missing/malformed => "unknown", and "unknown" is never treated
 *   as evidence the condition holds.
 * - Approvals are recorded with decidedByUserId starting with "automation:"
 *   (never req.actor.userId, never "board") and logged via logActivity with
 *   actorType "system" so the operator's own name never appears on a
 *   decision he did not make, while still landing in the same activityLog
 *   trail as human decisions (DUR-299's explicit requirement).
 */
export const AUTOMATION_DECIDED_BY_PREFIX = "automation:dur299-rule6";

export type ConditionStatus = "met" | "not_met" | "unknown";

export interface MergePrEvaluation {
  eligible: boolean;
  ci: ConditionStatus;
  paths: ConditionStatus;
  independentReview: ConditionStatus;
  reason?: string;
  matchedPathCategories?: string[];
  matchedPaths?: string[];
  independentReviewerLogin?: string;
}

export interface GitHubRef {
  owner: string;
  name: string;
  prNumber: number;
}

export function parsePullRequestReference(payload: Record<string, unknown>): GitHubRef | null {
  const repo = typeof payload.repo === "string" ? payload.repo.trim() : "";
  const prNumberRaw = payload.prNumber;
  const prNumber = typeof prNumberRaw === "number" ? prNumberRaw : Number(prNumberRaw);
  const [owner, name] = repo.split("/");
  if (!owner || !name || !Number.isFinite(prNumber) || prNumber <= 0) return null;
  return { owner, name, prNumber };
}

/**
 * DUR-299 point 3-4 denylist: any changed path matching one of these
 * categories means the PR touches the platform's fundament, so the
 * automation must fall back to the operator. Deliberately broad — a false
 * "blocked" here just means a human looks at it (the status quo today);
 * a false "clean" would let something fundamental slip through unreviewed.
 *
 * "approval_mechanism" includes this very file: a PR that edits
 * merge-pr-automation.ts, approvals.ts, agent-roles.ts, or instance-settings
 * (which carries the kill switch) can never be self-approved by the
 * automation it would be modifying.
 */
export type FundamentalPathCategory =
  | "auth_or_authorization"
  | "secrets_or_credentials"
  | "company_isolation_or_rls"
  | "approval_mechanism"
  | "budget_or_cost_caps"
  | "data_deletion"
  | "money"
  | "customer_data"
  | "outbound_communication"
  | "database_migration";

const FUNDAMENTAL_PATH_PATTERNS: Array<{ category: FundamentalPathCategory; pattern: RegExp }> = [
  { category: "auth_or_authorization", pattern: /\bauth\b|authoriz|authentic|\bacl\b|\brbac\b|access-control|\bsession\b|\bjwt\b|\boauth\b|\blogin\b/i },
  { category: "secrets_or_credentials", pattern: /secret|credential|\btoken\b|api[-_]?key|\.env(\.|$)/i },
  { category: "company_isolation_or_rls", pattern: /company-scope|companyScope|row-level-security|\brls\b|\btenant\b|multi-tenan/i },
  {
    category: "approval_mechanism",
    pattern: /merge-pr-automation|merge-deploy-visibility|\bapprovals?\.ts$|approval-schema|agent-roles\.ts$|instance-settings|\baccess\.ts$/i,
  },
  { category: "budget_or_cost_caps", pattern: /\bbudgets?\.ts$|budget-polic|cost[-_]?cap|spend[-_]?limit/i },
  { category: "data_deletion", pattern: /\bdelete\b|\bpurge\b|retention-polic|\bgdpr\b|company-deletion/i },
  { category: "money", pattern: /billing|payment|invoice|\bstripe\b|\bfiken\b|finance/i },
  { category: "customer_data", pattern: /customer|\bpii\b|personal-data/i },
  { category: "outbound_communication", pattern: /webhook|notification|\bslack\b|\btelegram\b|\bemail\b|\bsms\b|outbound/i },
  { category: "database_migration", pattern: /\/migrations\// },
];

/**
 * Pure, testable core of the path-denylist check (DUR-299 condition 2). Takes
 * plain strings so it can run against a GitHub PR-files response without any
 * network/DB access in tests.
 */
export function checkFundamentalPaths(changedPaths: readonly string[]): {
  clean: boolean;
  matchedCategories: FundamentalPathCategory[];
  matchedPaths: string[];
} {
  const categories = new Set<FundamentalPathCategory>();
  const matchedPaths: string[] = [];
  for (const rawPath of changedPaths) {
    if (!rawPath) continue;
    for (const { category, pattern } of FUNDAMENTAL_PATH_PATTERNS) {
      if (pattern.test(rawPath)) {
        categories.add(category);
        matchedPaths.push(rawPath);
        break;
      }
    }
  }
  return { clean: categories.size === 0, matchedCategories: Array.from(categories), matchedPaths };
}

/**
 * Throws (hard failure, not a silent skip) for anything that is not a
 * pending request_board_approval with payload.kind === "merge_pr". This is
 * the in-code enforcement of DUR-314's acceptance criterion: "An attempt to
 * let the automation process a deploy- or other non-merge_pr approval must
 * fail hard, not silently."
 */
export function assertMergePrOnly(approval: {
  type: string;
  status: string;
  payload: unknown;
}): void {
  if (approval.type !== "request_board_approval") {
    throw new Error(
      `merge-pr-automation refuses to process approval of type "${approval.type}" — it may only decide request_board_approval/merge_pr approvals`,
    );
  }
  const kind = (approval.payload as Record<string, unknown> | null)?.kind;
  if (kind !== "merge_pr") {
    throw new Error(
      `merge-pr-automation refuses to process approval with payload.kind "${String(kind)}" — it may only decide merge_pr approvals, never deploy or any other kind`,
    );
  }
  if (approval.status !== "pending" && approval.status !== "revision_requested") {
    throw new Error(
      `merge-pr-automation refuses to process approval in status "${approval.status}" — only pending/revision_requested approvals may be decided`,
    );
  }
}

interface GitHubDeps {
  fetchImpl: FetchLike;
  token: string | null;
}

function githubHeaders(deps: GitHubDeps): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-merge-pr-automation",
    "x-github-api-version": "2022-11-28",
  };
  if (deps.token) headers.authorization = `Bearer ${deps.token}`;
  return headers;
}

async function githubGetJson(url: string, deps: GitHubDeps): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
  let response: Response;
  try {
    response = await deps.fetchImpl(url, { headers: githubHeaders(deps) });
  } catch {
    return { ok: false, reason: "github_fetch_failed" };
  }
  if (!response.ok) return { ok: false, reason: `github_http_${response.status}` };
  try {
    return { ok: true, body: await response.json() };
  } catch {
    return { ok: false, reason: "github_invalid_response" };
  }
}

interface PullRequestFacts {
  state: string;
  authorLogin: string | null;
  headSha: string | null;
}

async function fetchPullRequestFacts(ref: GitHubRef, deps: GitHubDeps): Promise<PullRequestFacts | null> {
  const result = await githubGetJson(
    `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/pulls/${ref.prNumber}`,
    deps,
  );
  if (!result.ok) return null;
  const body = result.body as Record<string, unknown>;
  const user = body.user as Record<string, unknown> | null;
  const head = body.head as Record<string, unknown> | null;
  return {
    state: typeof body.state === "string" ? body.state : "unknown",
    authorLogin: typeof user?.login === "string" ? user.login : null,
    headSha: typeof head?.sha === "string" ? head.sha : null,
  };
}

async function fetchCiStatus(ref: GitHubRef, headSha: string, deps: GitHubDeps): Promise<ConditionStatus> {
  const base = `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`;
  const [statusResult, checkRunsResult] = await Promise.all([
    githubGetJson(`${base}/commits/${encodeURIComponent(headSha)}/status`, deps),
    githubGetJson(`${base}/commits/${encodeURIComponent(headSha)}/check-runs`, deps),
  ]);
  if (!statusResult.ok || !checkRunsResult.ok) return "unknown";

  const statusBody = statusResult.body as Record<string, unknown>;
  const checkRunsBody = checkRunsResult.body as Record<string, unknown>;
  const totalStatusCount = typeof statusBody.total_count === "number" ? statusBody.total_count : 0;
  const checkRuns = Array.isArray(checkRunsBody.check_runs) ? (checkRunsBody.check_runs as Array<Record<string, unknown>>) : [];

  if (totalStatusCount === 0 && checkRuns.length === 0) {
    // No CI configured at all for this commit -- absence of failure is not evidence of success.
    return "unknown";
  }

  if (totalStatusCount > 0 && statusBody.state !== "success") return "not_met";

  const allChecksGreen = checkRuns.every((run) => {
    const status = run.status;
    const conclusion = run.conclusion;
    return status === "completed" && (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped");
  });
  if (checkRuns.length > 0 && !allChecksGreen) return "not_met";

  return "met";
}

async function fetchChangedPaths(ref: GitHubRef, deps: GitHubDeps): Promise<string[] | null> {
  const paths: string[] = [];
  const maxPages = 10; // 100/page cap -> up to 1000 files; beyond that, fail closed rather than guess.
  for (let page = 1; page <= maxPages; page++) {
    const result = await githubGetJson(
      `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/pulls/${ref.prNumber}/files?per_page=100&page=${page}`,
      deps,
    );
    if (!result.ok) return null;
    const body = result.body;
    if (!Array.isArray(body)) return null;
    for (const entry of body as Array<Record<string, unknown>>) {
      if (typeof entry.filename === "string") paths.push(entry.filename);
      if (typeof entry.previous_filename === "string") paths.push(entry.previous_filename);
    }
    if (body.length < 100) return paths;
    if (page === maxPages) return null; // too many changed files to verify with confidence
  }
  return paths;
}

async function fetchIndependentReviewApproval(
  ref: GitHubRef,
  authorLogin: string | null,
  headSha: string | null,
  deps: GitHubDeps,
): Promise<{ status: ConditionStatus; reviewerLogin?: string }> {
  const result = await githubGetJson(
    `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/pulls/${ref.prNumber}/reviews?per_page=100`,
    deps,
  );
  if (!result.ok || !Array.isArray(result.body)) return { status: "unknown" };
  if (!authorLogin || !headSha) return { status: "unknown" };

  const reviews = result.body as Array<Record<string, unknown>>;
  const approving = reviews.find((review) => {
    const state = review.state;
    const commitId = review.commit_id;
    const login = (review.user as Record<string, unknown> | null)?.login;
    return (
      state === "APPROVED" &&
      commitId === headSha && // reject stale approvals of an earlier commit
      typeof login === "string" &&
      login.length > 0 &&
      login !== authorLogin // "independent" -- never the PR's own author
    );
  });
  if (!approving) return { status: "not_met" };
  const reviewerLogin = (approving.user as Record<string, unknown>).login as string;
  return { status: "met", reviewerLogin };
}

/**
 * Evaluates all three DUR-299 conditions for a single merge_pr approval
 * payload. Fails closed: any missing PR reference, unreachable GitHub, or
 * ambiguous state anywhere makes the overall result ineligible.
 */
export async function evaluateMergePrApproval(
  payload: Record<string, unknown>,
  deps: GitHubDeps,
): Promise<MergePrEvaluation> {
  const ref = parsePullRequestReference(payload);
  if (!ref) {
    return { eligible: false, ci: "unknown", paths: "unknown", independentReview: "unknown", reason: "missing_pr_reference" };
  }

  const facts = await fetchPullRequestFacts(ref, deps);
  if (!facts || !facts.headSha) {
    return { eligible: false, ci: "unknown", paths: "unknown", independentReview: "unknown", reason: "github_pr_unreachable" };
  }
  if (facts.state !== "open") {
    return { eligible: false, ci: "unknown", paths: "unknown", independentReview: "unknown", reason: `pr_state_${facts.state}` };
  }

  const [ci, changedPaths, review] = await Promise.all([
    fetchCiStatus(ref, facts.headSha, deps),
    fetchChangedPaths(ref, deps),
    fetchIndependentReviewApproval(ref, facts.authorLogin, facts.headSha, deps),
  ]);

  const pathCheck =
    changedPaths === null
      ? { clean: false as const, matchedCategories: [] as FundamentalPathCategory[], matchedPaths: [] as string[], status: "unknown" as ConditionStatus }
      : (() => {
          const result = checkFundamentalPaths(changedPaths);
          return { ...result, status: (result.clean ? "met" : "not_met") as ConditionStatus };
        })();

  const eligible = ci === "met" && pathCheck.status === "met" && review.status === "met";

  return {
    eligible,
    ci,
    paths: pathCheck.status,
    independentReview: review.status,
    matchedPathCategories: pathCheck.matchedCategories,
    matchedPaths: pathCheck.matchedPaths.slice(0, 20),
    independentReviewerLogin: review.reviewerLogin,
  };
}

export interface MergePrAutomationTickResult {
  evaluated: number;
  approved: number;
  killSwitchOff: boolean;
}

export function mergePrAutomationService(
  db: Db,
  options: {
    fetch?: FetchLike;
    approvalsSvc?: ReturnType<typeof approvalService>;
    instanceSettings?: ReturnType<typeof instanceSettingsService>;
    getGitHubToken?: (companyId: string) => Promise<string | null>;
    logActivityImpl?: typeof logActivity;
    limit?: number;
  } = {},
) {
  const fetchImpl = options.fetch ?? ghFetch;
  const approvalsSvc = options.approvalsSvc ?? approvalService(db);
  const instanceSettings = options.instanceSettings ?? instanceSettingsService(db);
  const secretsSvc = secretService(db);
  const getGitHubToken =
    options.getGitHubToken ??
    ((companyId: string) =>
      secretsSvc
        .resolveGitHubToken(companyId, { consumerType: "system", consumerId: "merge-pr-automation" })
        .catch(() => null));
  const logActivityImpl = options.logActivityImpl ?? logActivity;
  const limit = options.limit ?? 25;

  async function tick(now = new Date()): Promise<MergePrAutomationTickResult> {
    const general = await instanceSettings.getGeneral();
    if (!general.mergePrAutomationEnabled) {
      return { evaluated: 0, approved: 0, killSwitchOff: true };
    }

    const pending = await db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.type, "request_board_approval"),
          inArray(approvals.status, ["pending", "revision_requested"]),
        ),
      )
      .limit(limit * 4); // over-fetch before the merge_pr filter below; kind lives in JSONB, not a column

    let evaluated = 0;
    let approved = 0;

    for (const row of pending) {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      if (payload.kind !== "merge_pr") continue; // not this automation's concern -- never touched, never counted
      if (evaluated >= limit) break;

      // Defense in depth: re-assert immediately before any decision, even
      // though the query above already filtered to merge_pr only.
      assertMergePrOnly({ type: row.type, status: row.status, payload });

      evaluated += 1;
      const token = await getGitHubToken(row.companyId);
      const evaluation = await evaluateMergePrApproval(payload, { fetchImpl, token });
      if (!evaluation.eligible) continue;

      const decidedByUserId = AUTOMATION_DECIDED_BY_PREFIX;
      const note =
        `Approved automatically per DUR-299 rule 6: CI green, no fundamental-surface path touched, ` +
        `independent review by ${evaluation.independentReviewerLogin ?? "another reviewer"}.`;
      const { approval, applied } = await approvalsSvc.approve(row.id, decidedByUserId, note);
      if (!applied) continue;

      approved += 1;
      await logActivityImpl(db, {
        companyId: approval.companyId,
        actorType: "system",
        actorId: decidedByUserId,
        action: "approval.approved",
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: approval.type,
          automated: true,
          ruleId: "dur299-rule6",
          ci: evaluation.ci,
          paths: evaluation.paths,
          independentReview: evaluation.independentReview,
          independentReviewerLogin: evaluation.independentReviewerLogin ?? null,
        },
      });
    }

    return { evaluated, approved, killSwitchOff: false };
  }

  return { tick };
}
