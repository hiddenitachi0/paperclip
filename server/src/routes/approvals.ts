import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { companies, heartbeatRuns, issues, projectWorkspaces, projects, createRequestScopedDb, type Db } from "@paperclipai/db";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  deployRequestPayloadSchema,
  featureLaunchRequestPayloadSchema,
  formatApprovalTechnicalReference,
  formatApprovalTitle,
  type InstructionsChangeRequestPayload,
  instructionsChangeRequestPayloadSchema,
  modelBoostRequestPayloadSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
  toolGrantRequestPayloadSchema,
  withdrawApprovalSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  approvalService,
  accessService,
  agentInstructionsService,
  agentService,
  escalationGrantService,
  heartbeatService,
  issueApprovalService,
  issueThreadInteractionService,
  logActivity,
  secretService,
} from "../services/index.js";
import {
  resolveProjectDeployBranches,
  resolveProjectDeployBranchesByProjectId,
  type ProjectDeployBranches,
} from "../services/deploy-branches.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { redactEventPayload } from "../redaction.js";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { companyScope, companyScopeFromParam } from "../middleware/company-scope.js";
import { describeToolCapability, summarizeMcpServer } from "../services/agent-tool-audit.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { isStatusOnlyCheapRecoveryContext } from "../services/recovery/model-profile-hint.js";
import { recordCheapRunEscalation } from "../services/recovery/cheap-run-escalation.js";
import { ghFetch, gitHubApiBase } from "../services/github-fetch.js";

function redactApprovalPayload<T extends { payload: Record<string, unknown> }>(approval: T): T {
  return {
    ...approval,
    payload: redactEventPayload(approval.payload) ?? {},
  };
}

/**
 * `request_board_approval` approvals whose payload carries `kind:"deploy"` follow
 * the deploy-request convention (see deploy-poller.sh) and must validate against
 * deployRequestPayloadSchema before an operator ever sees them.
 */
function isDeployRequestApproval(type: unknown, payload: Record<string, unknown>) {
  return type === "request_board_approval" && payload.kind === "deploy";
}

/**
 * DUR-136: `deployRequestPayloadSchema` only checks that `projectId` is *a*
 * UUID, not that it names a real project -- an agent that copy-pastes
 * `PAPERCLIP_WORKSPACE_ID` into both fields (a workspace id is a UUID too)
 * produces a payload that parses cleanly, gets approved, and only fails
 * hours later when scripts/deploy-runner.sh tries to fetch a project by
 * that id and can't. Catch that class of mistake at filing time instead,
 * the same way isToolGrantRequestApproval/isInstructionsChangeRequestApproval
 * already verify their target ids resolve to something real in this company.
 */
async function assertDeployRequestProjectExists(
  db: Db,
  companyId: string,
  payload: { projectId: string },
) {
  const projectRow = await db
    .select({ id: projects.id, companyId: projects.companyId })
    .from(projects)
    .where(eq(projects.id, payload.projectId))
    .then((rows) => rows[0] ?? null);
  if (!projectRow) {
    throw unprocessable(
      `Deploy approval payload.projectId "${payload.projectId}" does not match any project. ` +
        "Double-check it's the project id, not the workspace id -- they're both UUIDs but not interchangeable.",
      { projectId: payload.projectId },
    );
  }
  if (projectRow.companyId !== companyId) {
    throw unprocessable(
      `Deploy approval payload.projectId "${payload.projectId}" belongs to a different company.`,
      { projectId: payload.projectId },
    );
  }
}

function parseGitHubRepoFromUrl(repoUrl: string | null | undefined): { owner: string; name: string } | null {
  if (!repoUrl) return null;
  try {
    const parsed = new URL(repoUrl);
    if (parsed.protocol !== "https:") return null;
    const host = parsed.host.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return null;
    const [owner, rawName] = parsed.pathname.replace(/^\/+/, "").split("/");
    if (!owner || !rawName) return null;
    return { owner, name: rawName.replace(/\.git$/i, "") };
  } catch {
    return null;
  }
}

/**
 * DUR-227: DUR-221 near-miss -- a deploy approval was filed for commit d55e5704, which
 * lived on master, while the project's declared deploy branch was custom. Nothing checked
 * that the commit was even reachable from the deploy branch before it reached the
 * operator's approval queue; the card looked identical to a normal, safe deploy. Confirms
 * via GitHub's compare API (the same mechanism merge-deploy-visibility.ts already uses to
 * check merge status) that `payload.commit` is actually `git merge-base --is-ancestor
 * <commit> <deployBranch>` before the approval can be filed.
 *
 * base=commit, head=deployBranch: deployBranch's compare `status` is "ahead" or
 * "identical" exactly when commit is an ancestor of (or equal to) deployBranch --
 * "behind"/"diverged" mean the branch does not contain that commit.
 *
 * Deliberately fails OPEN whenever ancestry can't be determined at all (no pinned commit
 * on the payload, project declares no deploy branch, the workspace isn't a github.com repo,
 * GitHub is unreachable, or the response can't be parsed) -- mirrors the "unknown must
 * never be treated as evidence" rule merge-deploy-visibility.ts already established for the
 * same GitHub-availability tradeoff. Only a GitHub-confirmed "behind"/"diverged" ever
 * blocks filing.
 */
async function assertDeployCommitIsAncestorOfDeployBranch(
  db: Db,
  companyId: string,
  payload: { projectId: string; workspaceId: string; commit?: string },
  deps: {
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
    resolveGitHubToken?: (companyId: string) => Promise<string | null>;
  } = {},
) {
  const commit = payload.commit?.trim();
  if (!commit) return;

  const branches = await resolveProjectDeployBranchesByProjectId(db, payload.projectId);
  const deployBranch = branches?.deployBranch;
  if (!deployBranch) return;

  const workspaceRow = await db
    .select({ repoUrl: projectWorkspaces.repoUrl })
    .from(projectWorkspaces)
    .where(
      and(eq(projectWorkspaces.id, payload.workspaceId), eq(projectWorkspaces.projectId, payload.projectId)),
    )
    .then((rows) => rows[0] ?? null);
  const repo = parseGitHubRepoFromUrl(workspaceRow?.repoUrl);
  if (!repo) return;

  const fetchImpl = deps.fetchImpl ?? ghFetch;
  const resolveGitHubToken =
    deps.resolveGitHubToken ??
    ((cid: string) =>
      secretService(db).resolveGitHubToken(cid, {
        consumerType: "system",
        consumerId: "deploy-approval-ancestry-precheck",
      }));
  const token = await resolveGitHubToken(companyId).catch(() => null);

  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-deploy-approval-ancestry-precheck",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetchImpl(
      `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/compare/${encodeURIComponent(commit)}...${encodeURIComponent(deployBranch)}`,
      { headers },
    );
  } catch {
    return;
  }
  if (!response.ok) return;

  let body: Record<string, unknown> | null = null;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    return;
  }
  const status = typeof body?.status === "string" ? body.status : null;
  if (status !== "behind" && status !== "diverged") return;

  const actualBranches = await lookupBranchesForCommitHead(fetchImpl, headers, repo, commit);
  const locationClause =
    actualBranches.length > 0
      ? `it is on ${actualBranches.map((b) => `"${b}"`).join(", ")} instead`
      : "confirm which branch this commit actually lives on before filing the approval";

  throw unprocessable(
    `Deploy approval targets commit ${commit}, which is not reachable from "${deployBranch}", the branch ` +
      `${repo.owner}/${repo.name} deploys from -- ${locationClause}. Deploying it would not ship what ` +
      "production expects.",
    { commit, deployBranch, repo: `${repo.owner}/${repo.name}`, compareStatus: status, actualBranches },
  );
}

/**
 * Best-effort lookup of which branch(es) `commit` is the tip of, so the rejection error can
 * name where the commit actually lives, not just where it doesn't. Uses GitHub's
 * "branches-where-head" endpoint, which only reports branches where `commit` is the current
 * HEAD -- it won't find every branch that merely contains the commit as an ancestor, but it
 * reliably catches the DUR-221 shape (a deploy approval filed right after the commit landed
 * as the tip of the wrong branch). Never throws; returns [] on any failure so this stays a
 * pure error-message enhancement and never affects whether filing is blocked.
 */
async function lookupBranchesForCommitHead(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  headers: Record<string, string>,
  repo: { owner: string; name: string },
  commit: string,
): Promise<string[]> {
  try {
    const response = await fetchImpl(
      `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/commits/${encodeURIComponent(commit)}/branches-where-head`,
      { headers },
    );
    if (!response.ok) return [];
    const body = (await response.json()) as unknown;
    if (!Array.isArray(body)) return [];
    return body
      .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>).name : null))
      .filter((name): name is string => typeof name === "string");
  } catch {
    return [];
  }
}

/**
 * DUR-284: best-effort resolution of `payload.sourceBranch`/`payload.deployBranch`
 * for a `kind:"deploy"` approval, so DUR-226's UI has real data for its "Deploys
 * from <branch>" badge and mismatch warning instead of rendering nothing. Runs
 * after assertDeployCommitIsAncestorOfDeployBranch already confirmed (or
 * deliberately failed open on) the commit -- never throws, and leaves a field
 * unset rather than guess when it can't be determined via GitHub.
 *
 * `deployBranch` is the project's declared deploy branch (same lookup the
 * ancestry guard uses). `sourceBranch` is the branch GitHub reports the pinned
 * commit is the current tip of; when that can't be pinned down (commit isn't a
 * branch tip, no GitHub repo, GitHub unreachable) it's left unset rather than
 * assumed equal to deployBranch, even though the ancestry guard makes that the
 * common case.
 */
async function resolveDeployApprovalBranchStamp(
  db: Db,
  companyId: string,
  payload: { projectId: string; workspaceId: string; commit?: string },
  deps: {
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
    resolveGitHubToken?: (companyId: string) => Promise<string | null>;
  } = {},
): Promise<{ sourceBranch?: string; deployBranch?: string }> {
  const branches = await resolveProjectDeployBranchesByProjectId(db, payload.projectId);
  const deployBranch = branches?.deployBranch;
  if (!deployBranch) return {};

  const commit = payload.commit?.trim();
  if (!commit) return { deployBranch };

  const workspaceRow = await db
    .select({ repoUrl: projectWorkspaces.repoUrl })
    .from(projectWorkspaces)
    .where(
      and(eq(projectWorkspaces.id, payload.workspaceId), eq(projectWorkspaces.projectId, payload.projectId)),
    )
    .then((rows) => rows[0] ?? null);
  const repo = parseGitHubRepoFromUrl(workspaceRow?.repoUrl);
  if (!repo) return { deployBranch };

  const fetchImpl = deps.fetchImpl ?? ghFetch;
  const resolveGitHubToken =
    deps.resolveGitHubToken ??
    ((cid: string) =>
      secretService(db).resolveGitHubToken(cid, {
        consumerType: "system",
        consumerId: "deploy-approval-branch-stamp",
      }));
  const token = await resolveGitHubToken(companyId).catch(() => null);

  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-deploy-approval-branch-stamp",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const actualBranches = await lookupBranchesForCommitHead(fetchImpl, headers, repo, commit);
  if (actualBranches.includes(deployBranch)) return { deployBranch, sourceBranch: deployBranch };
  if (actualBranches.length > 0) return { deployBranch, sourceBranch: actualBranches[0] };
  return { deployBranch };
}

/**
 * `request_board_approval` approvals whose payload carries `kind:"model_boost"`
 * follow the temporary model/effort escalation convention (DUR-31) and must
 * validate against modelBoostRequestPayloadSchema before an operator sees them.
 */
function isModelBoostRequestApproval(type: unknown, payload: Record<string, unknown>) {
  return type === "request_board_approval" && payload.kind === "model_boost";
}

/**
 * `request_board_approval` approvals whose payload carries `kind:"merge_pr"`
 * ask an operator to merge a pull request. DUR-40: a merge approval targeting
 * a project's declared upstream-mirror branch (read-only, never deployed)
 * must be refused before it ever reaches the operator — see DUR-38/DUR-39,
 * where an approval worded "merges this into master" was approved exactly as
 * filed and the feature it shipped never went live.
 */
function isMergePrRequestApproval(type: unknown, payload: Record<string, unknown>) {
  return type === "request_board_approval" && payload.kind === "merge_pr";
}

/**
 * `request_board_approval` approvals whose payload carries `kind:"tool_grant"`
 * are how an agent requests a new tool connection (MCP server) for itself --
 * the only path it has to gain one at all, since assertNoAgentToolConnectionMutation
 * refuses the direct PATCH path unconditionally for agent-authenticated callers.
 * Approving one is the operator's explicit, named grant: which agent, which
 * tool, and what it would be allowed to do (see appendToolGrantCapabilitySummary).
 */
function isToolGrantRequestApproval(type: unknown, payload: Record<string, unknown>) {
  return type === "request_board_approval" && payload.kind === "tool_grant";
}

/**
 * `request_board_approval` approvals whose payload carries `kind:"instructions_change"`
 * are how a boss proposes replacement instructions for a direct report (DUR-69/DUR-109).
 * An agent can never edit its own or another agent's instructions directly --
 * `assertNoAgentInstructionsConfigMutation` and `assertCanManageInstructionsPath` in
 * server/src/routes/agents.ts refuse every direct route unconditionally, including
 * for board-level file writes by a non-board caller. This approval is the only path,
 * and nothing is written to disk until an operator approves it (see the
 * `instructions_change` branch of approvalService.approve).
 */
function isInstructionsChangeRequestApproval(type: unknown, payload: Record<string, unknown>) {
  return type === "request_board_approval" && payload.kind === "instructions_change";
}

/**
 * `request_board_approval` approvals whose payload carries `kind:"feature_launch"`
 * are DUR-313 (DUR-299 point 2)'s mandatory launch card: the one plain-language
 * approval an operator makes for a finished, user-facing feature, instead of the
 * merges that preceded it. Approving one is the only thing that clears
 * evaluateFeatureLaunchDoneGate for an issue marked `featureLaunch`.
 */
function isFeatureLaunchRequestApproval(type: unknown, payload: Record<string, unknown>) {
  return type === "request_board_approval" && payload.kind === "feature_launch";
}

/**
 * Recomputes `beforeContent` from the target agent's current instructions file
 * on disk. Called both when a proposal is first filed and whenever it is
 * resubmitted after "send back for changes" -- the proposing boss can never
 * supply this value itself (see the schema doc comment), and re-reading it
 * fresh on resubmit also means a Reject/Send-back cycle can't leave a stale
 * "before" snapshot if something else touched the file in the meantime.
 */
async function resolveInstructionsChangeBeforeContent(
  instructions: ReturnType<typeof agentInstructionsService>,
  targetAgent: Parameters<ReturnType<typeof agentInstructionsService>["readFile"]>[0],
  relativePath: string,
): Promise<string> {
  const current = await instructions.readFile(targetAgent, relativePath).catch(() => null);
  return current?.content ?? "";
}

/**
 * DUR-109 follow-up: `summary` on instructionsChangeRequestPayloadSchema is an
 * optional, caller-supplied field. Trusting it would let a proposing boss
 * write whatever it wants into the text an operator reads to decide -- the
 * one field this ticket most needs to be honest is exactly the one a
 * self-interested proposer controls. Always overwrite it here with a
 * before/after built straight from the same beforeContent/afterContent that
 * get applied, so the approval text can never diverge from the actual change.
 */
function composeInstructionsChangeSummary(
  payload: Pick<InstructionsChangeRequestPayload, "beforeContent" | "afterContent" | "reason">,
  targetAgentName: string,
): string {
  const truncate = (content: string) =>
    content.length > 1500 ? `${content.slice(0, 1500)}\n…(truncated)` : content;
  const before = payload.beforeContent.trim().length > 0 ? truncate(payload.beforeContent) : "(no existing instructions)";
  return (
    `**Agent:** ${targetAgentName}\n\n` +
    `**Why:** ${payload.reason}\n\n` +
    `**Before:**\n\`\`\`\n${before}\n\`\`\`\n\n` +
    `**After:**\n\`\`\`\n${truncate(payload.afterContent)}\n\`\`\`\n\n` +
    `Approving applies these instructions immediately and records the change as a revision naming both the ` +
    `proposing boss and the approver. "Send back for changes" returns it to the boss with a note instead of applying anything.`
  );
}

/**
 * DUR-101: DUR-98 Class D found duplicate approvals for the same PR, deploy,
 * and hire piling up (six hire approvals for three roles, four deploy
 * approvals for one deploy) because nothing checked for an already-open
 * approval on the same target before filing a new one. Resolve to the
 * existing open (pending / revision_requested) approval that targets the
 * same PR, deploy target, or hire role, if any.
 */
async function findDuplicateOpenApproval(
  svc: ReturnType<typeof approvalService>,
  companyId: string,
  type: unknown,
  payload: Record<string, unknown>,
): Promise<{ id: string; targetDescription: string } | null> {
  if (type === "hire_agent") {
    const role = typeof payload.role === "string" && payload.role.trim() ? payload.role.trim() : "general";
    const existing = await svc.findOpenHireApprovalForRole(companyId, role);
    return existing ? { id: existing.id, targetDescription: `a hire request for the "${role}" role` } : null;
  }
  if (isMergePrRequestApproval(type, payload)) {
    const repo = typeof payload.repo === "string" ? payload.repo.trim() : "";
    const prNumber =
      typeof payload.prNumber === "number" || typeof payload.prNumber === "string"
        ? String(payload.prNumber).trim()
        : "";
    if (!repo || !prNumber) return null;
    const existing = await svc.findOpenMergePrApproval(companyId, repo, prNumber);
    return existing ? { id: existing.id, targetDescription: `a merge approval for ${repo}#${prNumber}` } : null;
  }
  if (isDeployRequestApproval(type, payload)) {
    const projectId = typeof payload.projectId === "string" ? payload.projectId : "";
    const workspaceId = typeof payload.workspaceId === "string" ? payload.workspaceId : "";
    if (!projectId || !workspaceId) return null;
    const existing = await svc.findOpenDeployApproval(companyId, projectId, workspaceId);
    return existing ? { id: existing.id, targetDescription: "a deploy request for this project/workspace" } : null;
  }
  if (isInstructionsChangeRequestApproval(type, payload)) {
    const agentId = typeof payload.agentId === "string" ? payload.agentId : "";
    const relativePath = typeof payload.relativePath === "string" ? payload.relativePath : "";
    if (!agentId || !relativePath) return null;
    const existing = await svc.findOpenInstructionsChangeApproval(companyId, agentId, relativePath);
    return existing
      ? { id: existing.id, targetDescription: "an instructions change proposal for this agent" }
      : null;
  }
  if (isFeatureLaunchRequestApproval(type, payload)) {
    const issueId = typeof payload.issueId === "string" ? payload.issueId : "";
    if (!issueId) return null;
    const existing = await svc.findOpenFeatureLaunchApproval(companyId, issueId);
    return existing ? { id: existing.id, targetDescription: "a feature launch card for this issue" } : null;
  }
  return null;
}

/**
 * Resolve the plain-words label an operator-facing approval title should lead
 * with: the linked issue's project name, falling back to the company name.
 * Never the repository slug — see DUR-24.
 */
async function resolveApprovalProjectLabel(db: Db, companyId: string, issueIds: string[]) {
  for (const issueId of issueIds) {
    const issueRow = await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!issueRow?.projectId) continue;
    const projectRow = await db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, issueRow.projectId))
      .then((rows) => rows[0] ?? null);
    if (projectRow?.name) return projectRow.name;
  }
  const companyRow = await db
    .select({ name: companies.name })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  return companyRow?.name ?? "Paperclip";
}

/**
 * `request_board_approval` is the type agents use to file merge/deploy/etc.
 * approvals by hand. Rewrite the title through the shared formatter so the
 * "<project> — <what this does>" convention can't drift per agent, and lift
 * any technical PR/branch/commit fields into a separate secondary field
 * instead of leaving them in the headline.
 */
/**
 * DUR-40 item 2: state the branch's consequence in plain words, in the text
 * an operator actually reads — not a bare branch name (that's the DUR-38/39
 * defect: "merges this into master" was true and still misleading, because
 * nothing said what "master" meant). Always computed and applied by the
 * system regardless of what the filing agent wrote or omitted — an operator
 * can't be the last line of defence against wording an agent happened to
 * choose (or forgot to include: unlike the earlier draft of this function,
 * this always sets `plainSummary` when we know something worth saying, even
 * if the agent never supplied one at all).
 */
function appendMergeConsequenceSentence(
  payload: Record<string, unknown>,
  deployBranches: ProjectDeployBranches | null,
) {
  if (payload.kind !== "merge_pr") return;
  const base = typeof payload.base === "string" ? payload.base.trim() : "";
  if (!base || !deployBranches?.deployBranch) return;

  const consequence =
    base === deployBranches.deployBranch
      ? `This goes to "${deployBranches.deployBranch}", the branch we deploy from. Approving the ` +
        "merge does not deploy it by itself — a separate deploy approval is still required before it goes live."
      : `This will land on "${base}", not "${deployBranches.deployBranch}" (the branch we deploy ` +
        "from) — confirm that is where you intend it before approving.";

  const existing = typeof payload.plainSummary === "string" ? payload.plainSummary.trim() : "";
  if (existing.includes(consequence)) return;
  payload.plainSummary = existing ? `${existing}\n\n${consequence}` : consequence;
}

/**
 * Same idea as appendMergeConsequenceSentence, for `kind:"tool_grant"`: an
 * operator deciding whether to grant an agent a new tool connection needs to
 * see, in the same plain-language `summary` the approval UI already renders,
 * what the tool can reach and what it would be allowed to do. Always
 * computed from the `server` definition and always applied, regardless of
 * what the requesting agent wrote in `reason` -- the capability description
 * is exactly the part a requester can't be trusted to characterize fairly.
 */
function appendToolGrantCapabilitySummary(payload: Record<string, unknown>) {
  if (payload.kind !== "tool_grant") return;
  const server = summarizeMcpServer(payload.server);
  if (!server) return;
  const capability = describeToolCapability(server);
  payload.capabilitySummary = capability;

  const existingSummary = typeof payload.summary === "string" ? payload.summary.trim() : "";
  payload.summary = existingSummary ? `${existingSummary}\n\n${capability}` : capability;

  const existingRisks = Array.isArray(payload.risks)
    ? payload.risks.filter((risk): risk is string => typeof risk === "string")
    : [];
  payload.risks = existingRisks.includes(capability) ? existingRisks : [...existingRisks, capability];
}

/**
 * DUR-237: `payload.mergeCommitSha` on a `kind:"merge_pr"` approval is read by
 * deploy-completion-gate.ts as proof the underlying PR merged as a specific commit --
 * ground truth that's only trustworthy when merge-deploy-visibility.ts wrote it after
 * independently verifying the merge via GitHub's API (see that file's markNoted). The
 * create/resubmit payload is otherwise caller-controlled, so without this, a requester
 * could hand-write any sha it likes -- including one already known to be live from an
 * unrelated deploy -- and short-circuit the completion gate without this approval's PR
 * ever merging. Always strip it on the way in; the backfill job's own `db.update` is the
 * only writer allowed to set it.
 */
function stripUntrustedMergeCommitSha(payload: Record<string, unknown>) {
  if (payload.kind === "merge_pr") delete payload.mergeCommitSha;
}

function parseOwnerSlashRepo(repo: unknown): { owner: string; name: string } | null {
  if (typeof repo !== "string") return null;
  const [owner, rawName] = repo.split("/");
  if (!owner || !rawName) return null;
  return { owner, name: rawName.replace(/\.git$/i, "") };
}

async function resolveProjectIdForIssues(db: Db, issueIds: string[]): Promise<string | null> {
  for (const issueId of issueIds) {
    const row = await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (row?.projectId) return row.projectId;
  }
  return null;
}

async function resolveProjectPrimaryRepo(
  db: Db,
  companyId: string,
  projectId: string,
): Promise<{ owner: string; name: string } | null> {
  const row = await db
    .select({ repoUrl: projectWorkspaces.repoUrl })
    .from(projectWorkspaces)
    .where(
      and(
        eq(projectWorkspaces.projectId, projectId),
        eq(projectWorkspaces.companyId, companyId),
        eq(projectWorkspaces.isPrimary, true),
      ),
    )
    .then((rows) => rows[0] ?? null);
  return parseGitHubRepoFromUrl(row?.repoUrl);
}

/**
 * DUR-252 security review finding #1: `payload.repo`/`payload.prNumber` on a `kind:"merge_pr"`
 * approval are caller-supplied and, before this, never cross-checked against the project's own
 * registered GitHub repo anywhere in the pipeline -- `merge-deploy-visibility.ts` hits whatever
 * repo the payload names directly to verify a PR merged. Only rejects on a *proven* mismatch
 * (both the claimed repo and the project's registered repo resolve, and they disagree) -- an
 * unresolvable claim or project is let through unchanged, the same fail-open-on-unknown posture
 * `appendMergeConsequenceSentence` above already takes, since this is a filing-time UX/integrity
 * check, not the fail-closed ancestry gate in deploy-carried-issues.ts.
 *
 * This alone does not close the finding's full misuse scenario (an attacker can still cite an
 * unrelated already-merged PR *within the correct repo*) -- see `originalIssueIds` below, which
 * is what actually anchors an approval to the issue(s) it was filed for regardless of repo.
 */
async function assertMergePrRepoMatchesProject(
  db: Db,
  companyId: string,
  issueIds: string[],
  payload: Record<string, unknown>,
) {
  if (payload.kind !== "merge_pr") return;
  const claimed = parseOwnerSlashRepo(payload.repo);
  if (!claimed) return;
  const projectId = await resolveProjectIdForIssues(db, issueIds);
  if (!projectId) return;
  const registered = await resolveProjectPrimaryRepo(db, companyId, projectId);
  if (!registered) return;
  if (
    claimed.owner.toLowerCase() !== registered.owner.toLowerCase() ||
    claimed.name.toLowerCase() !== registered.name.toLowerCase()
  ) {
    throw unprocessable(
      `"${payload.repo}" does not match this project's registered GitHub repository ` +
        `(${registered.owner}/${registered.name}) -- a merge_pr approval must reference the project's own repo.`,
      { claimedRepo: payload.repo, registeredRepo: `${registered.owner}/${registered.name}` },
    );
  }
}

/**
 * DUR-252 security review finding: the ONLY thing anchoring a `merge_pr` approval to a
 * particular issue, once approved, is the mutable `issueApprovals` link table -- and
 * `assertCanManageIssueApprovalLinks` lets whichever agent requested an approval relink it to
 * ANY issue in the company at any later time. `deploy-carried-issues.ts`'s sweep trusts that
 * link alone to auto-close an issue with zero further authorization check. Stamping the issue
 * id(s) an approval was actually filed for, once, at creation, and never letting the request
 * body overwrite it afterward (mirrors `stripUntrustedMergeCommitSha`'s "only one code path may
 * ever write this" pattern) gives `listCarriedCandidateIssues` an immutable ground truth to
 * check a candidate issue against instead of trusting the link table by itself.
 */
function stampOriginalIssueIds(payload: Record<string, unknown>, issueIds: string[]) {
  if (payload.kind !== "merge_pr") return;
  delete payload.originalIssueIds;
  payload.originalIssueIds = issueIds;
}

async function normalizeRequestBoardApprovalPayload(
  db: Db,
  companyId: string,
  issueIds: string[],
  payload: Record<string, unknown>,
  mergePrDeployBranches: ProjectDeployBranches | null = null,
) {
  appendMergeConsequenceSentence(payload, mergePrDeployBranches);
  appendToolGrantCapabilitySummary(payload);
  stripUntrustedMergeCommitSha(payload);
  await assertMergePrRepoMatchesProject(db, companyId, issueIds, payload);
  stampOriginalIssueIds(payload, issueIds);
  if (typeof payload.title !== "string" || !payload.title.trim()) return payload;
  const projectLabel = await resolveApprovalProjectLabel(db, companyId, issueIds);
  payload.title = formatApprovalTitle(projectLabel, payload.title);
  if (!payload.technicalReference) {
    const technicalReference = formatApprovalTechnicalReference({
      repo: typeof payload.repo === "string" ? payload.repo : null,
      prNumber:
        typeof payload.prNumber === "number" || typeof payload.prNumber === "string"
          ? payload.prNumber
          : null,
      branch: typeof payload.branch === "string" ? payload.branch : null,
      base: typeof payload.base === "string" ? payload.base : null,
      commit: typeof payload.commit === "string" ? payload.commit : null,
    });
    if (technicalReference) payload.technicalReference = technicalReference;
  }
  return payload;
}

async function firstLinkedIssueId(
  issueApprovalsSvc: { listIssuesForApproval: (approvalId: string) => Promise<Array<{ id: string }>> },
  approvalId: string,
): Promise<string | null> {
  const linked = await issueApprovalsSvc.listIssuesForApproval(approvalId);
  return Array.isArray(linked) ? linked[0]?.id ?? null : null;
}

function readIssueIdForEscalation(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const rawIssueIds = (body as Record<string, unknown>).issueIds;
  if (!Array.isArray(rawIssueIds)) return null;
  const first = rawIssueIds.find((value): value is string => typeof value === "string" && value.length > 0);
  return first ?? null;
}

function describeApprovalMutationForEscalation(body: unknown): string {
  if (body && typeof body === "object") {
    const payload = (body as Record<string, unknown>).payload;
    const kind = payload && typeof payload === "object" ? (payload as Record<string, unknown>).kind : undefined;
    if (typeof kind === "string" && kind) return `file a "${kind}" approval`;
  }
  return "file an approval";
}

export function approvalRoutes(
  rawDb: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  // DUR-394 (DUR-277 Wave 3): this file's own request-scoped instance; rawDb
  // stays unwrapped for the pre-scope approval lookups and access decisions
  // below (see middleware/company-scope.ts).
  const db = createRequestScopedDb(rawDb);
  const svc = approvalService(db);
  const access = accessService(db);
  const agentsSvc = agentService(db);
  const instructionsSvc = agentInstructionsService();
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const issueApprovalsSvc = issueApprovalService(db);
  const interactionsSvc = issueThreadInteractionService(db);
  const secretsSvc = secretService(db);
  const escalationGrantsSvc = escalationGrantService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  const rawSvc = approvalService(rawDb);
  const rawAccess = accessService(rawDb);

  /** Pre-scope companyId resolution (b): look up the approval by :id, 404 if missing. */
  async function resolveApprovalCompanyId(req: Request): Promise<string> {
    const id = req.params.id as string;
    const approval = await rawSvc.getById(id);
    if (!approval) throw notFound("Approval not found");
    return approval.companyId;
  }

  /** The plain company-membership check every approval route requires. */
  function checkCompanyAccess(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
  }

  /** Board-only routes (approve/reject/request-revision). */
  function checkBoardCompanyAccess(req: Request, companyId: string) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
  }

  /**
   * Read routes additionally require the `company_scope:read` policy
   * decision on top of plain company membership (DUR-146 Stage 1's
   * `assertApprovalAccessAllowed`, folded into the pre-scope checkAccess
   * callback so an unauthorized read is refused before scope is ever
   * established -- see middleware/company-scope.ts's checkAccess doc).
   */
  async function checkApprovalReadAccess(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    const decision = await rawAccess.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (!decision.allowed) {
      throw forbidden("Approvals are outside this actor's authorization boundary");
    }
  }

  function scopeFromCompanyIdParam(checkAccess: (req: Request, companyId: string) => void | Promise<void>) {
    return companyScopeFromParam(rawDb, checkAccess);
  }

  function scopeFromApprovalIdParam(checkAccess: (req: Request, companyId: string) => void | Promise<void>) {
    return companyScope(rawDb, async (req) => {
      const companyId = await resolveApprovalCompanyId(req);
      await checkAccess(req, companyId);
      return companyId;
    });
  }

  // DUR-146 Stage 1: filing a deploy or merge request approval requires the
  // "ask" right (deploys:request / merges:request) — company_scope:read alone
  // (assertApprovalAccessAllowed above) is not enough. This never touches who
  // may APPROVE — assertBoard on /approvals/:id/approve is unchanged and no
  // grant here ever satisfies it (see DEPLOY_APPROVAL_KEYS in
  // services/agent-roles.ts, which refuses to let a role carry
  // "deploys:approve"/"merges:approve" in the first place).
  async function assertApprovalRequestPermissionAllowed(
    req: Request,
    res: any,
    companyId: string,
    permissionKey: "deploys:request" | "merges:request",
  ): Promise<boolean> {
    const decision = await access.decide({
      actor: req.actor,
      action: permissionKey,
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({
      error:
        permissionKey === "deploys:request"
          ? "This actor does not hold the right to ask for a deploy."
          : "This actor does not hold the right to ask for a merge.",
    });
    return false;
  }

  async function assertApprovalMutationAllowedByRunContext(
    req: Request,
    res: any,
    companyId: string,
    opts: {
      describeBlockedAction?: () => string;
      resolveIssueId?: () => Promise<string | null>;
    } = {},
  ) {
    if (req.actor.type !== "agent") return true;
    const runId = req.actor.runId?.trim();
    if (!runId || !req.actor.agentId) return true;

    const run = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run || run.companyId !== companyId || run.agentId !== req.actor.agentId) return true;
    if (!isStatusOnlyCheapRecoveryContext(run.contextSnapshot)) return true;

    // DUR-45: this cheap run genuinely cannot take this action, but the issue
    // must not be left to rot -- hand the action to a normal-model run on the
    // same issue instead of just refusing and hoping the agent finds another way.
    const issueId = opts.resolveIssueId
      ? await opts.resolveIssueId()
      : readIssueIdForEscalation(req.body);
    let escalation: Awaited<ReturnType<typeof recordCheapRunEscalation>> | null = null;
    if (issueId) {
      escalation = await recordCheapRunEscalation(db, heartbeat.wakeup, {
        companyId,
        issueId,
        agentId: run.agentId,
        sourceRunId: run.id,
        blockedAction: (opts.describeBlockedAction ?? (() => "create or modify an approval"))(),
      });
    }

    res.status(403).json({
      error: "Cheap status-only recovery runs cannot create or modify approvals",
      details: {
        companyId,
        runId: run.id,
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        resumeRequiresNormalModel: true,
        escalation,
      },
    });
    return false;
  }

  router.get("/companies/:companyId/approvals", scopeFromCompanyIdParam(checkApprovalReadAccess), async (req, res) => {
    const companyId = req.params.companyId as string;
    const status = req.query.status as string | undefined;
    const result = await svc.list(companyId, status);
    res.json(result.map((approval) => redactApprovalPayload(approval)));
  });

  router.get("/approvals/:id", scopeFromApprovalIdParam(checkApprovalReadAccess), async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    res.json(redactApprovalPayload(approval));
  });

  router.post(
    "/companies/:companyId/approvals",
    scopeFromCompanyIdParam(checkApprovalReadAccess),
    validate(createApprovalSchema),
    async (req, res) => {
    const companyId = req.params.companyId as string;
    if (
      !(await assertApprovalMutationAllowedByRunContext(req, res, companyId, {
        describeBlockedAction: () => describeApprovalMutationForEscalation(req.body),
      }))
    ) return;
    const rawIssueIds = req.body.issueIds;
    const issueIds = Array.isArray(rawIssueIds)
      ? rawIssueIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const uniqueIssueIds = Array.from(new Set(issueIds));
    const { issueIds: _issueIds, dryRun, ...approvalInput } = req.body;
    const actor = getActorInfo(req);
    if (isDeployRequestApproval(approvalInput.type, approvalInput.payload)) {
      if (!(await assertApprovalRequestPermissionAllowed(req, res, companyId, "deploys:request"))) return;
      const deployPayload = deployRequestPayloadSchema.parse(approvalInput.payload);
      await assertDeployRequestProjectExists(db, companyId, deployPayload);
      await assertDeployCommitIsAncestorOfDeployBranch(db, companyId, deployPayload);
      const branchStamp = await resolveDeployApprovalBranchStamp(db, companyId, deployPayload);
      approvalInput.payload = deployRequestPayloadSchema.parse({
        ...deployPayload,
        sourceBranch: branchStamp.sourceBranch,
        deployBranch: branchStamp.deployBranch,
      });
    }
    if (isMergePrRequestApproval(approvalInput.type, approvalInput.payload)) {
      if (!(await assertApprovalRequestPermissionAllowed(req, res, companyId, "merges:request"))) return;
    }
    if (isModelBoostRequestApproval(approvalInput.type, approvalInput.payload)) {
      const boostPayload = modelBoostRequestPayloadSchema.parse(approvalInput.payload);
      const requestingAgentId =
        approvalInput.requestedByAgentId ?? (actor.actorType === "agent" ? actor.actorId : null);
      if (actor.actorType === "agent" && actor.actorId !== boostPayload.agentId) {
        res.status(403).json({ error: "An agent can only request a boost for itself" });
        return;
      }
      if (!requestingAgentId) {
        res.status(422).json({ error: "A boost request must be filed by the requesting agent" });
        return;
      }
      await escalationGrantsSvc.assertRequestAllowed({
        companyId,
        issueId: boostPayload.issueId,
        agentId: boostPayload.agentId,
        reason: boostPayload.reason,
      });
    }
    if (isToolGrantRequestApproval(approvalInput.type, approvalInput.payload)) {
      const toolGrantPayload = toolGrantRequestPayloadSchema.parse(approvalInput.payload);
      if (actor.actorType === "agent" && actor.actorId !== toolGrantPayload.agentId) {
        res.status(403).json({ error: "An agent can only request a tool connection for itself" });
        return;
      }
      const targetAgent = await agentsSvc.getById(toolGrantPayload.agentId);
      if (!targetAgent || targetAgent.companyId !== companyId) {
        res.status(422).json({ error: "Tool connection request must target an agent in this company" });
        return;
      }
    }
    if (isInstructionsChangeRequestApproval(approvalInput.type, approvalInput.payload)) {
      // OPERATOR RULING (DUR-69): only a boss may propose, and never for itself.
      // An agent-authenticated caller with no direct reports can never satisfy
      // the reportsTo check below for any target, so "an agent cannot propose
      // at all" falls out of the same check as "a boss cannot propose for a
      // non-report" -- there is no separate case to gate.
      if (actor.actorType !== "agent") {
        res.status(403).json({ error: "Only a boss agent can propose an instructions change for a direct report" });
        return;
      }
      const instructionsPayload = instructionsChangeRequestPayloadSchema.parse(approvalInput.payload);
      if (instructionsPayload.agentId === actor.actorId) {
        res.status(403).json({ error: "A boss cannot propose an instructions change for itself" });
        return;
      }
      const targetAgent = await agentsSvc.getById(instructionsPayload.agentId);
      if (!targetAgent || targetAgent.companyId !== companyId) {
        res.status(422).json({ error: "Instructions change must target an agent in this company" });
        return;
      }
      if (targetAgent.reportsTo !== actor.actorId) {
        res.status(403).json({ error: "An agent can only propose instructions changes for its direct reports" });
        return;
      }
      const beforeContent = await resolveInstructionsChangeBeforeContent(
        instructionsSvc,
        targetAgent,
        instructionsPayload.relativePath,
      );
      approvalInput.payload = instructionsChangeRequestPayloadSchema.parse({
        ...instructionsPayload,
        beforeContent,
        summary: composeInstructionsChangeSummary(
          { beforeContent, afterContent: instructionsPayload.afterContent, reason: instructionsPayload.reason },
          targetAgent.name || targetAgent.id,
        ),
      });
    }
    if (isFeatureLaunchRequestApproval(approvalInput.type, approvalInput.payload)) {
      const launchPayload = featureLaunchRequestPayloadSchema.parse(approvalInput.payload);
      // Must be linked to EXACTLY the issue it names, and nothing else. linkManyForApproval
      // links this approval to every id in issueIds, and evaluateFeatureLaunchDoneGate treats
      // any approved feature_launch approval linked to an issue as covering that issue -- it
      // never cross-checks payload.issueId. A loose `.includes()` check here would let a filer
      // pad issueIds with an extra issue (e.g. issueIds: [X, Y] with payload.issueId: X) and
      // get Y silently approved as a launch riding on a card the operator only reviewed for X.
      if (uniqueIssueIds.length !== 1 || uniqueIssueIds[0] !== launchPayload.issueId) {
        res.status(422).json({
          error: "A feature launch approval must be linked (issueIds) to exactly the one issue named in payload.issueId",
        });
        return;
      }
      const targetIssue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, launchPayload.issueId))
        .then((rows) => rows[0] ?? null);
      if (!targetIssue || targetIssue.companyId !== companyId) {
        res.status(422).json({ error: "Feature launch approval must target an issue in this company" });
        return;
      }
    }
    let mergePrDeployBranches: ProjectDeployBranches | null = null;
    if (isMergePrRequestApproval(approvalInput.type, approvalInput.payload)) {
      const base =
        typeof approvalInput.payload.base === "string" ? approvalInput.payload.base.trim() : "";
      if (base) {
        mergePrDeployBranches = await resolveProjectDeployBranches(db, uniqueIssueIds);
        if (mergePrDeployBranches?.mirrorBranch && base === mergePrDeployBranches.mirrorBranch) {
          const correctBranch = mergePrDeployBranches.deployBranch ?? "the branch we deploy from";
          throw unprocessable(
            `"${base}" is a read-only mirror of the upstream project and is never deployed — merging there will not ship this change. File the merge approval with base "${correctBranch}" instead.`,
            { base, mirrorBranch: mergePrDeployBranches.mirrorBranch, deployBranch: mergePrDeployBranches.deployBranch },
          );
        }
      }
    }
    let normalizedPayload =
      approvalInput.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            companyId,
            approvalInput.payload,
            { strictMode: strictSecretsMode },
          )
        : approvalInput.payload;
    if (approvalInput.type === "request_board_approval") {
      normalizedPayload = await normalizeRequestBoardApprovalPayload(
        db,
        companyId,
        uniqueIssueIds,
        normalizedPayload,
        mergePrDeployBranches,
      );
    }

    const duplicate = await findDuplicateOpenApproval(svc, companyId, approvalInput.type, approvalInput.payload);
    if (duplicate) {
      const acknowledgedDuplicateId =
        typeof approvalInput.payload.acknowledgedDuplicateOfApprovalId === "string"
          ? approvalInput.payload.acknowledgedDuplicateOfApprovalId
          : null;
      if (acknowledgedDuplicateId !== duplicate.id) {
        throw conflict(
          `There is already an open approval for ${duplicate.targetDescription}. Review or resolve it instead of filing a second one — pass acknowledgedDuplicateOfApprovalId to confirm you need a genuine second approval.`,
          { existingApprovalId: duplicate.id },
        );
      }
      // A legitimate second approval was explicitly acknowledged: keep it linked
      // to the earlier one rather than letting it exist independently and silently.
      normalizedPayload = { ...normalizedPayload, relatedApprovalId: duplicate.id };
    }

    if (dryRun) {
      // Every check above (permissions, target existence, duplicate-open-approval)
      // has already run — this confirms the request would succeed without
      // actually writing a live, operator-visible approval. See DUR-162.
      res.status(200).json({ dryRun: true, wouldSucceed: true });
      return;
    }

    const approval = await svc.create(companyId, {
      ...approvalInput,
      payload: normalizedPayload,
      requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
      requestedByAgentId:
        approvalInput.requestedByAgentId ?? (actor.actorType === "agent" ? actor.actorId : null),
      status: "pending",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    if (uniqueIssueIds.length > 0) {
      await issueApprovalsSvc.linkManyForApproval(approval.id, uniqueIssueIds, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.created",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type, issueIds: uniqueIssueIds },
    });

    res.status(201).json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/issues", scopeFromApprovalIdParam(checkApprovalReadAccess), async (req, res) => {
    const id = req.params.id as string;
    const issues = await issueApprovalsSvc.listIssuesForApproval(id);
    res.json(issues);
  });

  router.post(
    "/approvals/:id/approve",
    scopeFromApprovalIdParam(checkBoardCompanyAccess),
    validate(resolveApprovalSchema),
    async (req, res) => {
    const id = req.params.id as string;
    const decidedByUserId = req.actor.userId ?? "board";
    const { approval, applied, toolGrant, instructionsChange } = await svc.approve(
      id,
      decidedByUserId,
      req.body.decisionNote,
    );

    if (applied) {
      // DUR-29: an agent may have raised a request_confirmation for the same decision as
      // this approval — resolve it now so the operator doesn't have to answer it separately.
      await interactionsSvc.resolveInteractionsLinkedToApproval(approval, {
        agentId: null,
        userId: req.actor.userId ?? "board",
      });

      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);
      const primaryIssueId = linkedIssueIds[0] ?? null;

      // DUR-40 item 4: whether this merge_pr approval eventually needs a
      // "no deploy approval followed" note on its issue is checked later by
      // mergeDeployVisibilityService's scheduled tick (server/src/index.ts),
      // not here. Checking synchronously at approval time would be wrong: a
      // deploy approval can only be filed AFTER a merge is approved, so an
      // immediate check would flag every single normal merge, not just the
      // ones that were actually forgotten.

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.approved",
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: approval.type,
          requestedByAgentId: approval.requestedByAgentId,
          linkedIssueIds,
        },
      });

      // A tool_grant approval is exactly when an agent's tool connections
      // change as a result of approving a request -- this must be as
      // operator-visible, in plain language, as a board caller adding one
      // directly through the agent's own PATCH path (see appendAgentAuditDetails
      // in routes/agents.ts). Logged against the target agent, not just the
      // approval, so it shows up on the agent's own activity history too.
      if (toolGrant) {
        await logActivity(db, {
          companyId: toolGrant.companyId,
          actorType: "user",
          actorId: req.actor.userId ?? "board",
          action: "agent.tool_connection_granted",
          entityType: "agent",
          entityId: toolGrant.agentId,
          details: {
            serverName: toolGrant.serverName,
            capability: toolGrant.capability,
            approvalId: approval.id,
            requestedByAgentId: approval.requestedByAgentId,
          },
        });
      }

      // Applying a boss-proposed instructions change is exactly when an
      // agent's actual instructions on disk change as a result of an
      // approval -- operator-visible against the target agent (per the
      // audit trail requirement in DUR-69's OPERATOR RULINGs), separate from
      // the agent_instructions_revisions row which is queried structurally.
      if (instructionsChange) {
        await logActivity(db, {
          companyId: instructionsChange.companyId,
          actorType: "user",
          actorId: req.actor.userId ?? "board",
          action: "agent.instructions_change_approved",
          entityType: "agent",
          entityId: instructionsChange.agentId,
          details: {
            relativePath: instructionsChange.relativePath,
            approvalId: approval.id,
            proposedByAgentId: instructionsChange.proposedByAgentId,
          },
        });
      }

      if (approval.requestedByAgentId) {
        try {
          const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "approval_approved",
            payload: {
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
            },
            requestedByActorType: "user",
            requestedByActorId: req.actor.userId ?? "board",
            contextSnapshot: {
              source: "approval.approved",
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
              taskId: primaryIssueId,
              wakeReason: "approval_approved",
            },
          });

          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.requester_wakeup_queued",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              wakeRunId: wakeRun?.id ?? null,
              linkedIssueIds,
            },
          });
        } catch (err) {
          logger.warn(
            {
              err,
              approvalId: approval.id,
              requestedByAgentId: approval.requestedByAgentId,
            },
            "failed to queue requester wakeup after approval",
          );
          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.requester_wakeup_failed",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              linkedIssueIds,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post(
    "/approvals/:id/reject",
    scopeFromApprovalIdParam(checkBoardCompanyAccess),
    validate(resolveApprovalSchema),
    async (req, res) => {
    const id = req.params.id as string;
    const decidedByUserId = req.actor.userId ?? "board";
    const { approval, applied } = await svc.reject(id, decidedByUserId, req.body.decisionNote);

    if (applied) {
      // DUR-29: resolve any request_confirmation linked to this approval too.
      await interactionsSvc.resolveInteractionsLinkedToApproval(approval, {
        agentId: null,
        userId: req.actor.userId ?? "board",
      });

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.rejected",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post(
    "/approvals/:id/request-revision",
    scopeFromApprovalIdParam(checkBoardCompanyAccess),
    validate(requestApprovalRevisionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const decidedByUserId = req.actor.userId ?? "board";
      const approval = await svc.requestRevision(id, decidedByUserId, req.body.decisionNote);

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.revision_requested",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });

      res.json(redactApprovalPayload(approval));
    },
  );

  router.post(
    "/approvals/:id/resubmit",
    scopeFromApprovalIdParam(checkCompanyAccess),
    validate(resubmitApprovalSchema),
    async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    if (
      !(await assertApprovalMutationAllowedByRunContext(req, res, existing.companyId, {
        describeBlockedAction: () => "resubmit an approval",
        resolveIssueId: () => firstLinkedIssueId(issueApprovalsSvc, existing.id),
      }))
    ) return;

    if (req.actor.type === "agent" && req.actor.agentId !== existing.requestedByAgentId) {
      res.status(403).json({ error: "Only requesting agent can resubmit this approval" });
      return;
    }

    if (req.body.payload && isDeployRequestApproval(existing.type, req.body.payload)) {
      const deployPayload = deployRequestPayloadSchema.parse(req.body.payload);
      await assertDeployRequestProjectExists(db, existing.companyId, deployPayload);
      await assertDeployCommitIsAncestorOfDeployBranch(db, existing.companyId, deployPayload);
      const branchStamp = await resolveDeployApprovalBranchStamp(db, existing.companyId, deployPayload);
      req.body.payload = deployRequestPayloadSchema.parse({
        ...deployPayload,
        sourceBranch: branchStamp.sourceBranch,
        deployBranch: branchStamp.deployBranch,
      });
    }
    let normalizedPayload = req.body.payload
      ? existing.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            existing.companyId,
            req.body.payload,
            { strictMode: strictSecretsMode },
          )
        : req.body.payload
      : undefined;
    if (normalizedPayload) {
      // DUR-112: a resubmit body is caller-controlled, so the requesting boss
      // could otherwise strip/mutate payload.kind to dodge the instructions_change
      // safety branch below (forced beforeContent/summary recompute) while still
      // landing whatever forged title/summary text it wants as a "pending" approval
      // again. Key the kind check off what's already persisted on this approval --
      // resubmit can update the rest of the payload, but never what kind it is.
      const existingKind = (existing.payload as Record<string, unknown> | null)?.kind;
      if (typeof existingKind === "string" && normalizedPayload.kind !== existingKind) {
        res.status(422).json({ error: "Cannot change an approval's payload kind on resubmit" });
        return;
      }
      // DUR-237: resubmit's payload is just as caller-controlled as create's -- see
      // stripUntrustedMergeCommitSha's docblock for why this can never come from the request body.
      stripUntrustedMergeCommitSha(normalizedPayload);
      if (normalizedPayload.kind === "merge_pr") {
        // DUR-252: resubmit is exactly as caller-controlled as create -- re-validate any new
        // `repo` claim, and, critically, never let resubmit overwrite `originalIssueIds` with
        // anything but what creation already anchored (stampOriginalIssueIds ignores its
        // issueIds argument's provenance and always wins, so feeding it the EXISTING persisted
        // value here rather than re-deriving from the current, mutable issueApprovals links is
        // what keeps this immutable across a relink).
        const existingOriginalIssueIds = (existing.payload as Record<string, unknown> | null)
          ?.originalIssueIds;
        const anchorIssueIds = Array.isArray(existingOriginalIssueIds)
          ? existingOriginalIssueIds.filter((value): value is string => typeof value === "string")
          : [];
        await assertMergePrRepoMatchesProject(db, existing.companyId, anchorIssueIds, normalizedPayload);
        stampOriginalIssueIds(normalizedPayload, anchorIssueIds);
      }
    }
    if (normalizedPayload && isInstructionsChangeRequestApproval(existing.type, normalizedPayload)) {
      // Re-verify the boss/report relationship still holds -- it may have
      // changed since the original proposal was filed -- and recompute
      // beforeContent fresh rather than trusting whatever the resubmit body
      // carried (same reasoning as the create route above).
      const instructionsPayload = instructionsChangeRequestPayloadSchema.parse(normalizedPayload);
      if (req.actor.type === "agent" && instructionsPayload.agentId === req.actor.agentId) {
        res.status(403).json({ error: "A boss cannot propose an instructions change for itself" });
        return;
      }
      const targetAgent = await agentsSvc.getById(instructionsPayload.agentId);
      if (!targetAgent || targetAgent.companyId !== existing.companyId) {
        res.status(422).json({ error: "Instructions change must target an agent in this company" });
        return;
      }
      if (req.actor.type === "agent" && targetAgent.reportsTo !== req.actor.agentId) {
        res.status(403).json({ error: "An agent can only propose instructions changes for its direct reports" });
        return;
      }
      const beforeContent = await resolveInstructionsChangeBeforeContent(
        instructionsSvc,
        targetAgent,
        instructionsPayload.relativePath,
      );
      normalizedPayload = instructionsChangeRequestPayloadSchema.parse({
        ...instructionsPayload,
        beforeContent,
        summary: composeInstructionsChangeSummary(
          { beforeContent, afterContent: instructionsPayload.afterContent, reason: instructionsPayload.reason },
          targetAgent.name || targetAgent.id,
        ),
      });
    }
    const approval = await svc.resubmit(id, normalizedPayload);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.resubmitted",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });
    res.json(redactApprovalPayload(approval));
  });

  // DUR-141: agent-only self-serve withdraw. Unlike approve/reject/request-
  // revision (assertBoard), this is deliberately NOT a board action -- it
  // lets the requesting agent kill its own stale/duplicate approval (e.g. a
  // merge_pr request whose PR was closed) instead of leaving a dead entry in
  // the board's pending queue indefinitely with only a "please ignore this"
  // comment as mitigation.
  router.post(
    "/approvals/:id/withdraw",
    scopeFromApprovalIdParam(checkCompanyAccess),
    validate(withdrawApprovalSchema),
    async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    if (
      !(await assertApprovalMutationAllowedByRunContext(req, res, existing.companyId, {
        describeBlockedAction: () => "withdraw an approval",
        resolveIssueId: () => firstLinkedIssueId(issueApprovalsSvc, existing.id),
      }))
    ) return;

    if (req.actor.type !== "agent" || req.actor.agentId !== existing.requestedByAgentId) {
      res.status(403).json({ error: "Only the requesting agent can withdraw this approval" });
      return;
    }

    const approval = await svc.withdraw(id, req.body.decisionNote);

    await interactionsSvc.resolveInteractionsLinkedToApproval(approval, {
      agentId: req.actor.agentId ?? null,
      userId: null,
    });

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: "agent",
      actorId: req.actor.agentId ?? "unknown",
      agentId: req.actor.agentId ?? undefined,
      action: "approval.withdrawn",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });

    res.json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/comments", scopeFromApprovalIdParam(checkCompanyAccess), async (req, res) => {
    const id = req.params.id as string;
    const comments = await svc.listComments(id);
    res.json(comments);
  });

  router.post(
    "/approvals/:id/comments",
    scopeFromApprovalIdParam(checkCompanyAccess),
    validate(addApprovalCommentSchema),
    async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    if (
      !(await assertApprovalMutationAllowedByRunContext(req, res, approval.companyId, {
        describeBlockedAction: () => "comment on an approval",
        resolveIssueId: () => firstLinkedIssueId(issueApprovalsSvc, approval.id),
      }))
    ) return;
    const actor = getActorInfo(req);
    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.comment_added",
      entityType: "approval",
      entityId: approval.id,
      details: { commentId: comment.id },
    });

    res.status(201).json(comment);
  });

  return router;
}
