import { gitHubApiBase } from "./github-fetch.js";

/**
 * DUR-5179: what GitHub says about the checks of ONE exact commit.
 *
 * Same rules as check_ci_status in scripts/deploy-runner.sh, so the done gate, the CLI and the
 * deploy children read a commit the same way:
 * - every check-run of the commit (paged, 100 at a time) plus the combined commit status;
 * - a check that finished red (anything but success / neutral / skipped) is a failure, and a
 *   failure wins over checks that are still running (a red check is terminal);
 * - nothing running and nothing red is green;
 * - a commit with no check-run and no commit status at all is `none`;
 * - GitHub could not be asked, or answered something unreadable, is `unknown`. Never green.
 *
 * Unlike fetchCiStatus in merge-pr-automation.ts (which only looks at this repository's own
 * required check names), every check counts here: a repository's checks are whatever it set up.
 */

export type CommitCiState = "green" | "pending" | "failed" | "none" | "unknown";

export interface CommitCiStatus {
  state: CommitCiState;
  failedChecks: string[];
  pendingChecks: string[];
}

export type CommitCiFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface CommitCiDeps {
  fetchImpl?: CommitCiFetch;
  token?: string | null;
  /** Defaults to github.com. */
  hostname?: string;
}

/** GitHub's check-runs endpoint pages at 100; 10 pages = 1000 checks, far past any real commit. */
const CHECK_RUNS_PER_PAGE = 100;
const CHECK_RUNS_MAX_PAGES = 10;
const GITHUB_REQUEST_TIMEOUT_MS = 15_000;
const GREEN_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

function githubHeaders(token: string | null | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-commit-ci-status",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function getJson(url: string, fetchImpl: CommitCiFetch, token: string | null | undefined): Promise<unknown | null> {
  try {
    const response = await fetchImpl(url, {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export async function fetchCommitCiStatus(
  repo: { owner: string; name: string },
  sha: string,
  deps: CommitCiDeps = {},
): Promise<CommitCiStatus> {
  const unknown: CommitCiStatus = { state: "unknown", failedChecks: [], pendingChecks: [] };
  if (!SHA_PATTERN.test(sha)) return unknown;
  const fetchImpl: CommitCiFetch = deps.fetchImpl ?? fetch;
  const base = `${gitHubApiBase(deps.hostname ?? "github.com")}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/commits/${encodeURIComponent(sha)}`;

  const statusBody = asRecord(await getJson(`${base}/status`, fetchImpl, deps.token));
  if (!statusBody) return unknown;

  const checkRuns: Array<Record<string, unknown>> = [];
  for (let page = 1; page <= CHECK_RUNS_MAX_PAGES; page++) {
    const body = asRecord(
      await getJson(`${base}/check-runs?per_page=${CHECK_RUNS_PER_PAGE}&page=${page}`, fetchImpl, deps.token),
    );
    if (!body || !Array.isArray(body.check_runs)) return unknown;
    const runs = (body.check_runs as unknown[]).map(asRecord).filter((run): run is Record<string, unknown> => run !== null);
    checkRuns.push(...runs);
    const total = typeof body.total_count === "number" ? body.total_count : null;
    if (runs.length < CHECK_RUNS_PER_PAGE) break;
    if (total !== null && checkRuns.length >= total) break;
    // A full last page we are not allowed to read further is a commit we cannot judge.
    if (page === CHECK_RUNS_MAX_PAGES) return unknown;
  }

  const totalStatuses = typeof statusBody.total_count === "number" ? statusBody.total_count : 0;
  const statusState = typeof statusBody.state === "string" ? statusBody.state : "";
  if (totalStatuses === 0 && checkRuns.length === 0) return { state: "none", failedChecks: [], pendingChecks: [] };

  const failedChecks: string[] = [];
  const pendingChecks: string[] = [];

  for (const run of checkRuns) {
    const name = typeof run.name === "string" && run.name.trim() ? run.name.trim() : "unnamed check";
    if (run.status !== "completed") {
      pendingChecks.push(name);
    } else if (typeof run.conclusion !== "string" || !GREEN_CONCLUSIONS.has(run.conclusion)) {
      failedChecks.push(name);
    }
  }

  if (totalStatuses > 0) {
    const statuses = Array.isArray(statusBody.statuses) ? (statusBody.statuses as unknown[]).map(asRecord) : [];
    for (const entry of statuses) {
      if (!entry) continue;
      const name = typeof entry.context === "string" && entry.context.trim() ? entry.context.trim() : "commit status";
      if (entry.state === "pending") pendingChecks.push(name);
      else if (entry.state !== "success") failedChecks.push(name);
    }
    // The combined state says red but no single entry did (an unusually shaped answer):
    // still red, just without a name to give.
    if (statusState !== "success" && statusState !== "pending" && failedChecks.length === 0) {
      failedChecks.push("commit status");
    }
  }

  if (failedChecks.length > 0) {
    return { state: "failed", failedChecks: unique(failedChecks), pendingChecks: unique(pendingChecks) };
  }
  if (pendingChecks.length > 0 || (totalStatuses > 0 && statusState === "pending")) {
    return { state: "pending", failedChecks: [], pendingChecks: unique(pendingChecks) };
  }
  return { state: "green", failedChecks: [], pendingChecks: [] };
}
