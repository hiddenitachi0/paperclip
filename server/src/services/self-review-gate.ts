import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { and, desc, eq, inArray, isNotNull, like } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, executionWorkspaces, heartbeatRuns, issueComments, projectWorkspaces } from "@paperclipai/db";
import type { IssueExecutionPolicy } from "@paperclipai/shared";

const execFileAsync = promisify(execFile);

/**
 * DUR-22 slice 1: a bounded, one-time "review your own diff before handing off" pass
 * inserted before a code issue moves to in_review/done. See:
 * - server/src/routes/issues.ts (the synchronous done gate)
 * - server/src/services/heartbeat.ts handleSuccessfulRunHandoff (the run-finish backstop)
 */

export const SELF_REVIEW_PASS_REASON = "self_review_pass";

// Marker carried in a run's contextSnapshot/payload so a run started for the self-review
// pass (and anything it bounded-retries into) is recognized without re-gating it again.
export const SELF_REVIEW_PASS_CONTEXT_KEY = "selfReviewPass";

export function isSelfReviewPassContext(contextSnapshot: unknown): boolean {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return false;
  const context = contextSnapshot as Record<string, unknown>;
  return context[SELF_REVIEW_PASS_CONTEXT_KEY] === true || context.wakeReason === SELF_REVIEW_PASS_REASON;
}

/** Recognizes a run that IS the (bounded, one-time) self-review pass, however it was scheduled. */
export function isSelfReviewPassRun(run: {
  scheduledRetryReason?: string | null;
  contextSnapshot?: unknown;
}): boolean {
  if (run.scheduledRetryReason === SELF_REVIEW_PASS_REASON) return true;
  return isSelfReviewPassContext(run.contextSnapshot);
}

/**
 * Looks up whether a given run (by id) IS itself the self-review pass, so a caller that only
 * has a run id (e.g. the actor on an inbound PATCH request) can exempt that run from being
 * gated again. Without this, each self-review pass run would be gated on its own attempt to
 * hand off, scheduling another self-review pass indefinitely — the exact loop this feature is
 * meant to bound to exactly one extra pass.
 */
export async function isSelfReviewPassRunId(db: Db, runId: string | null | undefined): Promise<boolean> {
  if (!runId) return false;
  const run = await db
    .select({ scheduledRetryReason: heartbeatRuns.scheduledRetryReason, contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!run) return false;
  return isSelfReviewPassRun(run);
}

export function issueExecutionPolicyOptsOutOfSelfReview(
  policy: IssueExecutionPolicy | Record<string, unknown> | null | undefined,
): boolean {
  return (policy as { selfReview?: unknown } | null | undefined)?.selfReview === false;
}

/** A "code issue" is one whose project has at least one git-backed workspace. */
export async function issueProjectHasGitWorkspace(
  db: Db,
  companyId: string,
  projectId: string | null | undefined,
): Promise<boolean> {
  if (!projectId) return false;
  const row = await db
    .select({ id: projectWorkspaces.id })
    .from(projectWorkspaces)
    .where(
      and(
        eq(projectWorkspaces.companyId, companyId),
        eq(projectWorkspaces.projectId, projectId),
        isNotNull(projectWorkspaces.repoUrl),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return Boolean(row);
}

export function buildSelfReviewPassIdempotencyKey(input: { issueId: string; sourceRunId: string }) {
  return [SELF_REVIEW_PASS_REASON, input.issueId, input.sourceRunId].join(":");
}

/**
 * DUR-71: a change touching one of these surfaces gets a second, adversarial set of
 * questions appended to the ordinary self-review instruction (see
 * buildSelfReviewPassInstruction below). Detection runs against the actual changed file
 * paths (detectRiskySurfaceFromDiff), not the agent's own judgment of whether its work is
 * risky — see getChangedFilePathsForIssueWorkspace for where those paths come from.
 */
export type RiskySurfaceCategory =
  | "authorization_or_permissions"
  | "agent_configuration"
  | "secrets_or_credentials"
  | "migrations"
  | "outbound_or_spend";

export const RISKY_SURFACE_CATEGORY_LABELS: Record<RiskySurfaceCategory, string> = {
  authorization_or_permissions: "authorization or permissions",
  agent_configuration: "agent configuration",
  secrets_or_credentials: "secrets or credentials",
  migrations: "database migrations",
  outbound_or_spend: "publishing outward or spending money",
};

const RISKY_SURFACE_PATTERNS: Array<{ category: RiskySurfaceCategory; pattern: RegExp }> = [
  { category: "authorization_or_permissions", pattern: /authoriz|permission|\bacl\b|\brbac\b|access-control/i },
  {
    category: "agent_configuration",
    pattern: /adapterConfig|agent-permissions|agent-instructions|agent-secret-bindings|\bagents\.ts$|mcp[-_]?servers?|plugin-managed-agents/i,
  },
  { category: "secrets_or_credentials", pattern: /secret|credential|\btoken\b|api[-_]?key|\.env(\.|$)/i },
  { category: "migrations", pattern: /\/migrations\// },
  {
    category: "outbound_or_spend",
    pattern:
      /deploy-runner|deploy-policy|deploy-branches|merge-deploy|webhook|notification|\bslack\b|\btelegram\b|\bemail\b|billing|\bcosts?\.ts$|\bbudgets?\.ts$|approvals?\.ts/i,
  },
];

/**
 * Pure, testable core of surface detection: given the paths changed by a diff, returns
 * which risky-surface categories they touch (empty array for an ordinary change). Takes
 * plain strings so it can be exercised without any git/DB access.
 */
export function detectRiskySurfaceFromDiff(changedFilePaths: readonly string[]): RiskySurfaceCategory[] {
  const found = new Set<RiskySurfaceCategory>();
  for (const rawPath of changedFilePaths) {
    if (!rawPath) continue;
    for (const { category, pattern } of RISKY_SURFACE_PATTERNS) {
      if (pattern.test(rawPath)) found.add(category);
    }
  }
  return [...found];
}

/**
 * DUR-91: content-based counterpart to detectRiskySurfaceFromDiff. The path-based check
 * alone misses risky content living in a generically-named file (e.g. DUR-67's
 * codex-home.ts/runtime-config.ts, which strip `mcp_servers` blocks carrying secrets but
 * match none of the RISKY_SURFACE_PATTERNS filename regexes). This runs the same patterns
 * against the *added* lines of a unified diff -- lines starting with "+" other than the
 * "+++ b/path" file header -- so risky literals (mcp_servers, secret, token, ...) trip the
 * gate regardless of what file they land in. Deliberately only looks at added lines: new
 * code introducing a risky capability is the case that matters, and limiting to additions
 * (vs. also scanning removed/context lines) keeps the signal closer to "what did this change
 * actually introduce" rather than flagging every diff that happens to touch a file
 * mentioning these words anywhere nearby.
 */
export function detectRiskySurfaceFromDiffContent(diffContent: string): RiskySurfaceCategory[] {
  const found = new Set<RiskySurfaceCategory>();
  for (const line of diffContent.split(/\r?\n/)) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const { category, pattern } of RISKY_SURFACE_PATTERNS) {
      if (pattern.test(line)) found.add(category);
    }
  }
  return [...found];
}

const RISKY_SURFACE_GIT_MAX_BUFFER_BYTES = 1024 * 1024;
const RISKY_SURFACE_GIT_DIFF_CONTENT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/**
 * DUR-290: bounds how many self-review passes evaluateSelfReviewDoneGate will schedule for a
 * single issue whose diff is structurally unreadable -- changedFilePaths resolves (a real
 * workspace and diff exist) but diffContent permanently overflows
 * RISKY_SURFACE_GIT_DIFF_CONTENT_MAX_BUFFER_BYTES, e.g. because the diff touches one large
 * generated/vendored file (lockfile, snapshot fixture, bundle) that isn't going away.
 *
 * Per the DUR-286 fingerprint contract on computeReviewedDiffFingerprint/
 * findCompletedSelfReviewPassForIssue above, that shape always produces a `null` fingerprint,
 * which always misses -- correctly, since no prior pass can be proven to have reviewed this
 * exact content. But it also means this diff shape can never earn a `priorPass` exit: every
 * evaluation schedules a fresh pass, forever, if that pass's own corrective run doesn't land
 * its handoff in the same run (see the DUR-245 comment above -- turn-budget exhaustion, crash).
 * Once MAX_SELF_REVIEW_PASSES_FOR_UNREADABLE_DIFF passes have already been scheduled for the
 * issue, stop scheduling more and fail loud instead: decline the transition with an
 * operator-facing message rather than silently retrying forever.
 */
export const MAX_SELF_REVIEW_PASSES_FOR_UNREADABLE_DIFF = 3;

/**
 * Resolves the issue's current execution workspace to a local, on-disk git checkout
 * (local_fs/git_worktree with a base ref recorded) that getChangedFilePathsForIssueWorkspace
 * and getChangedDiffContentForIssueWorkspace can run `git diff` against. Returns null
 * whenever there's no such workspace to read -- cloud/adapter-managed workspaces, a missing
 * path, or a missing base ref -- so callers degrade to "couldn't check" rather than guessing.
 *
 * DUR-83: resolves the workspace by execution_workspaces.sourceIssueId (set only by the
 * server when a workspace is realized, never writable by an issue PATCH) rather than by
 * trusting issues.executionWorkspaceId. That field is a plain, ungated column an issue's
 * own assignee can PATCH to null on an unrelated field-only update -- doing so right before
 * a status transition would silently skip risk detection (and any adversarial questions)
 * without ever tripping the self-review gate itself.
 */
async function resolveIssueGitWorkspace(
  db: Db,
  input: { companyId: string; issueId: string | null | undefined },
): Promise<{ workspacePath: string; baseRef: string } | null> {
  if (!input.issueId) return null;
  const workspace = await db
    .select({
      cwd: executionWorkspaces.cwd,
      providerRef: executionWorkspaces.providerRef,
      providerType: executionWorkspaces.providerType,
      baseRef: executionWorkspaces.baseRef,
    })
    .from(executionWorkspaces)
    .where(and(eq(executionWorkspaces.sourceIssueId, input.issueId), eq(executionWorkspaces.companyId, input.companyId)))
    .orderBy(desc(executionWorkspaces.lastUsedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!workspace) return null;
  if (workspace.providerType !== "local_fs" && workspace.providerType !== "git_worktree") return null;

  const workspacePath = workspace.providerRef ?? workspace.cwd;
  if (!workspacePath || !workspace.baseRef) return null;

  try {
    await fs.access(workspacePath);
  } catch {
    return null;
  }

  return { workspacePath, baseRef: workspace.baseRef };
}

/**
 * Runs `git diff --name-only` against the issue's resolved workspace to get the paths
 * changed since the base ref. Returns null (not an empty array) whenever the diff genuinely
 * can't be read -- no resolvable workspace or the git command failing -- so callers can tell
 * "no risky surface detected" apart from "couldn't check" and fall back to the ordinary-only
 * prompt rather than guessing.
 */
export async function getChangedFilePathsForIssueWorkspace(
  db: Db,
  input: { companyId: string; issueId: string | null | undefined },
): Promise<string[] | null> {
  const resolved = await resolveIssueGitWorkspace(db, input);
  if (!resolved) return null;

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", resolved.workspacePath, "diff", "--name-only", `${resolved.baseRef}...HEAD`],
      { cwd: resolved.workspacePath, maxBuffer: RISKY_SURFACE_GIT_MAX_BUFFER_BYTES },
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * DUR-91: sibling to getChangedFilePathsForIssueWorkspace that reads the actual diff hunk
 * text (`git diff <base>...HEAD`, not `--name-only`) so detectRiskySurfaceFromDiffContent can
 * catch risky content living in a generically-named file. Same null-vs-empty-string contract:
 * null means "couldn't check", not "checked, found nothing".
 */
export async function getChangedDiffContentForIssueWorkspace(
  db: Db,
  input: { companyId: string; issueId: string | null | undefined },
): Promise<string | null> {
  const resolved = await resolveIssueGitWorkspace(db, input);
  if (!resolved) return null;

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", resolved.workspacePath, "diff", `${resolved.baseRef}...HEAD`],
      { cwd: resolved.workspacePath, maxBuffer: RISKY_SURFACE_GIT_DIFF_CONTENT_MAX_BUFFER_BYTES },
    );
    return stdout;
  } catch {
    return null;
  }
}

function buildAdversarialSurfaceLines(categories: readonly RiskySurfaceCategory[]): string[] {
  const categoryLabels = categories.map((category) => RISKY_SURFACE_CATEGORY_LABELS[category]).join(", ");
  return [
    `This change touches a risky surface (${categoryLabels}). On top of the check above, also ask yourself these questions -- they're adversarial on purpose, not another way of confirming you did what the ticket asked:`,
    "- If a dishonest agent wanted to abuse this change, what would it do? Actually try to find the path -- don't just assert there is none.",
    "- Does this add a field, route, or setting that an agent could set on itself? If so, say who is allowed to set it, and go verify the check that enforces that actually exists -- don't assume it does.",
    "- Does this only work because something elsewhere is configured a particular way? If so, check right now whether that configuration is actually set that way -- don't assume it.",
    "- What did the ticket NOT ask for that a reasonable person would still expect anyway (the obvious abuse case, the missing guard, the config nobody wired up)?",
    "",
    'If this turns up a real security or correctness gap -- even one outside what the ticket asked for -- report it in a comment. "Do not invent extra scope" above is about not padding the work, not about staying quiet on a genuine finding; fixing it can be its own follow-up issue, but don\'t suppress it.',
  ];
}

export function buildSelfReviewPassInstruction(input: {
  issueIdentifier: string | null;
  alreadyHandedOff: boolean;
  riskySurfaceCategories?: readonly RiskySurfaceCategory[];
  requestedStatus?: string | null;
}) {
  const issueLabel = input.issueIdentifier ?? "this issue";
  const lines = [
    `Before ${issueLabel} moves on, take one pass over your own work first.`,
    "",
    "Review your diff/changes against the task description and:",
    "- Check that every requirement in the description is actually met, not just partially addressed.",
    "- Look for bugs, mistakes, or loose ends you may have missed the first time.",
    "- Fix anything real that you find. Do not invent extra scope beyond the task.",
  ];
  const riskySurfaceCategories = input.riskySurfaceCategories ?? [];
  if (riskySurfaceCategories.length > 0) {
    lines.push("", ...buildAdversarialSurfaceLines(riskySurfaceCategories));
  }
  lines.push("");
  if (input.alreadyHandedOff) {
    lines.push(
      "This issue already shows as handed off. If your review finds nothing wrong, leave the status as-is — no further action is required. If you find a real problem, fix it and leave a short comment describing what you fixed.",
    );
  } else {
    // DUR-125/DUR-167: this comment is posted immediately when a PATCH gets declined,
    // attributed to (and visible in real time to) the SOURCE run that just got declined --
    // not to the distinct future run this instruction is actually meant for, which doesn't
    // exist yet. A same-run reader wording ("this run", "yourself, right now") reads as
    // self-addressed and reliably caused the declined run to retry the same PATCH in-run
    // (confirmed on DUR-132: two separate runs did exactly this, immediately after posting
    // their own self-review comment, and both got declined again). Naming both possible
    // audiences explicitly closes that gap instead of assuming the reader is the exempt one.
    const statusLine = input.requestedStatus
      ? ` That freshly-started run's own \`PATCH .../${input.requestedStatus}\` will not be gated again — it should call it itself, right away.`
      : "";
    lines.push(
      "One of two things is true about whoever reads this:",
      "- If you are the run whose PATCH was just declined: stop. Do not retry that PATCH in this run, even after doing the review above and even if you post a self-review comment first — only a separate, freshly-started run is exempt from this gate, and retrying here will be declined again no matter what you post.",
      `- If you are that freshly-started run (you were woken up specifically for a self-review pass on ${issueLabel}): do the check above, fix anything real, then continue the normal handoff.${statusLine} Do not defer this to "the next self-review-pass run" — you already are that pass, and there is no other one coming.`,
    );
  }
  return lines.join("\n");
}

export const SELF_REVIEW_PASS_NOTICE_COMMENT =
  "Before this moves on, I'm doing one more pass over my own work to double-check it against the task.";

/**
 * Posts a plain-language, system-authored issue comment explaining the self-review pass.
 *
 * The synchronous gate (evaluateSelfReviewDoneGate) and the run-finish backstop
 * (heartbeat.ts handleSuccessfulRunHandoff) both schedule a wakeup tagged with
 * SELF_REVIEW_PASS_REASON, but the generic wake payload (buildPaperclipWakePayload in
 * heartbeat.ts) only surfaces specific known contextSnapshot fields — it does not read an
 * arbitrary `instruction` field out of the wakeup payload/context. Posting an issue comment
 * is the pragmatic way to make sure the agent actually sees the plain-language instruction,
 * since comments are already reliably surfaced to agents on wake.
 */
export async function postSelfReviewPassNoticeComment(
  db: Db,
  input: { companyId: string; issueId: string; sourceRunId?: string | null; body: string },
): Promise<void> {
  await db.insert(issueComments).values({
    companyId: input.companyId,
    issueId: input.issueId,
    authorType: "system",
    body: input.body,
    createdByRunId: input.sourceRunId ?? null,
  });
}

/**
 * Looks for a self-review-pass notice comment already posted for this exact run, so callers
 * that don't already have a wake-level idempotency check (e.g. the heartbeat.ts backstop)
 * can avoid posting a duplicate comment if the same run chain is re-evaluated.
 */
export async function findExistingSelfReviewPassNoticeCommentForRun(
  db: Db,
  input: { companyId: string; issueId: string; sourceRunId: string; body: string },
) {
  return db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.createdByRunId, input.sourceRunId),
        eq(issueComments.body, input.body),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

const IDEMPOTENT_SELF_REVIEW_PASS_WAKE_STATUSES = ["queued", "deferred_issue_execution", "claimed", "completed"] as const;

export async function findExistingSelfReviewPassWake(
  db: Db,
  input: { companyId: string; idempotencyKey: string },
) {
  return db
    .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        inArray(agentWakeupRequests.status, [...IDEMPOTENT_SELF_REVIEW_PASS_WAKE_STATUSES]),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

/**
 * DUR-245: findExistingSelfReviewPassWake only matches the exact (issueId, sourceRunId) pair,
 * so it only protects against the SAME run retrying its own declined PATCH. It does nothing
 * for a DIFFERENT run (a later heartbeat, after the scheduled pass finished without actually
 * completing the handoff -- e.g. the corrective run burned its turn budget re-investigating
 * instead of just reviewing and re-PATCHing) attempting the transition later: that run gets
 * its own fresh idempotency key, sails past findExistingSelfReviewPassWake, and this gate
 * schedules yet another "one extra pass" for it. If that pass also fails to land the handoff,
 * the cycle repeats indefinitely -- silently, with no operator-visible signal beyond the issue
 * sitting in `blocked`/`todo` forever (see DUR-245).
 *
 * The gate's own design intent (see isSelfReviewPassRunId above) is to bound this to exactly
 * one extra pass per issue, not one per attempting run. This checks whether ANY self-review
 * pass wake has already reached a terminal `completed` state for this issue, regardless of
 * which run originally triggered it, so a second (or third, ...) run doesn't pay for another
 * pass that was already used up.
 */
/**
 * DUR-270 (security review of DUR-245): a stable fingerprint of what a self-review pass
 * actually reviewed, so a completed pass on an OLD diff can't silently vouch for a NEW,
 * unreviewed diff on the same issue -- see the reviewedDiffFingerprint comment on
 * evaluateSelfReviewDoneGate below. null when EITHER read couldn't be produced, not just
 * when both are null (DUR-276): changedFilePaths and diffContent come from two independent
 * git invocations with different maxBuffer caps, so a diff can routinely blow the content
 * buffer while staying under the path-only buffer. If content silently degraded to null
 * while paths stayed non-null, the old both-null check let the fingerprint collapse to a
 * pure function of the file-path set -- two different diffs touching the same path(s) would
 * hash identically and a stale pass could vouch for content it never actually saw. Callers
 * must treat "either read unknown" as "fingerprint unknown", not as a fingerprint of its own.
 */
export function computeReviewedDiffFingerprint(
  changedFilePaths: readonly string[] | null,
  diffContent: string | null,
): string | null {
  if (changedFilePaths === null || diffContent === null) return null;
  const hash = createHash("sha256");
  hash.update(JSON.stringify([...changedFilePaths].sort()));
  hash.update(" ");
  hash.update(diffContent);
  return hash.digest("hex");
}

/**
 * DUR-270: `matchingDiffFingerprint` narrows "has this issue used its one bounded pass" to
 * "...for THIS diff". Passing it undefined preserves the original DUR-245 semantics (any
 * completed pass for the issue counts, regardless of diff) for callers that don't have a
 * diff to compare against at all -- e.g. the issue's git workspace itself can't be resolved,
 * so there is genuinely nothing to compare. Passing a real fingerprint only matches a pass
 * that reviewed that exact diff, so a later, different diff on the same issue -- e.g. a new
 * commit adding a risky-surface change -- doesn't get waved through on an older, unrelated
 * pass's coattails.
 *
 * DUR-286: `null` is intentionally NOT treated the same as `undefined` here. `null` means a
 * diff exists but couldn't be fully read (e.g. computeReviewedDiffFingerprint nulled out
 * because the diff-content buffer overflowed while the path-only read succeeded -- an
 * ordinary occurrence, not a workspace-resolution failure). A stored `reviewedDiffFingerprint`
 * of `null` on some OTHER completed pass could come from a completely different diff that
 * happened to hit the same partial-read failure, so matching null-to-null here would silently
 * let a stale, unrelated pass vouch for content it never saw -- the exact class of gap DUR-270
 * closed for the false-hash-match case. `null` therefore always misses, forcing the caller to
 * schedule a fresh pass for that diff.
 */
export async function findCompletedSelfReviewPassForIssue(
  db: Db,
  input: { companyId: string; issueId: string; matchingDiffFingerprint?: string | null },
) {
  if (input.matchingDiffFingerprint === null) return null;

  const rows = await db
    .select({ id: agentWakeupRequests.id, payload: agentWakeupRequests.payload })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.reason, SELF_REVIEW_PASS_REASON),
        like(agentWakeupRequests.idempotencyKey, `${SELF_REVIEW_PASS_REASON}:${input.issueId}:%`),
        eq(agentWakeupRequests.status, "completed"),
      ),
    );
  if (input.matchingDiffFingerprint === undefined) {
    return rows[0] ?? null;
  }
  const fingerprint = input.matchingDiffFingerprint;
  return (
    rows.find((row) => (row.payload as { reviewedDiffFingerprint?: string } | null)?.reviewedDiffFingerprint === fingerprint) ??
    null
  );
}

/**
 * DUR-290: counts self-review-pass wakeups ever requested for this issue that were scheduled
 * for a diff that couldn't be fingerprinted at all -- unlike findCompletedSelfReviewPassForIssue
 * above, this deliberately does NOT filter to `status: "completed"`, because the failure mode
 * this caps is passes that never reach "completed" (the corrective run crashes, runs out of
 * turn budget, etc. before landing its handoff -- see the DUR-245 comment above). Used by
 * evaluateSelfReviewDoneGate to bound how many passes it will schedule for an issue whose diff
 * is structurally unreadable, since that shape can never produce a matching `priorPass` to stop
 * the loop on its own.
 *
 * DUR-290 fast-follow (flagged by DUR-3894's security review of the original cap): the
 * idempotencyKey prefix this matches on (`self_review_pass:{issueId}:`) is shared by EVERY
 * self-review pass this issue has ever had scheduled, including ordinary passes on a small,
 * readable diff -- those record a real (non-null) `reviewedDiffFingerprint` in their payload
 * (see the DUR-270 comment on the wakeup call below). Without filtering on that, unrelated
 * ordinary passes from earlier in the issue's life would inflate this count and could trip
 * MAX_SELF_REVIEW_PASSES_FOR_UNREADABLE_DIFF after fewer than that many real attempts at the
 * oversized diff. Only rows whose payload recorded a null fingerprint -- this cap's own
 * unreadable-diff shape, or the separate workspace-fully-unresolvable shape (which never
 * actually reaches this call, since it exits via `priorPass` first) -- count toward the cap.
 */
export async function countSelfReviewPassWakesForIssue(
  db: Db,
  input: { companyId: string; issueId: string },
): Promise<number> {
  const rows = await db
    .select({ id: agentWakeupRequests.id, payload: agentWakeupRequests.payload })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.reason, SELF_REVIEW_PASS_REASON),
        like(agentWakeupRequests.idempotencyKey, `${SELF_REVIEW_PASS_REASON}:${input.issueId}:%`),
      ),
    );
  return rows.filter(
    (row) => (row.payload as { reviewedDiffFingerprint?: string | null } | null)?.reviewedDiffFingerprint === null,
  ).length;
}

// DUR-293: mirrors heartbeat.ts's WakeupNotScheduledInfo. `wakeup` (heartbeat.wakeup /
// enqueueWakeup) has many legitimate no-throw skip paths -- company inactive, heartbeat
// disabled, an unresolved dependency blocker, etc -- that just write a "skipped" wakeup
// row and resolve to `null`, indistinguishable from a real schedule by return value alone.
// Passing onNotScheduled lets the gate observe which of those actually happened instead of
// assuming every non-throwing call means a corrective run was scheduled.
export type SelfReviewGateWakeupNotScheduledInfo =
  | { kind: "skipped"; reason: string; unresolvedBlockerIssueIds?: string[] }
  | { kind: "deferred"; reason: string };

export type SelfReviewGateWakeup = (
  agentId: string,
  opts: {
    source?: "timer" | "assignment" | "on_demand" | "automation";
    triggerDetail?: "manual" | "ping" | "callback" | "system";
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    idempotencyKey?: string | null;
    requestedByActorType?: "user" | "agent" | "system";
    requestedByActorId?: string | null;
    contextSnapshot?: Record<string, unknown>;
    onNotScheduled?: (info: SelfReviewGateWakeupNotScheduledInfo) => void;
  },
) => Promise<unknown>;

/**
 * Evaluates whether an agent-initiated transition to in_review/done should be deferred
 * for a self-review pass, and if so, schedules the corrective wake. Returns null when the
 * transition should proceed as requested.
 */
export async function evaluateSelfReviewDoneGate(input: {
  db: Db;
  wakeup: SelfReviewGateWakeup;
  issue: {
    id: string;
    identifier: string | null;
    companyId: string;
    projectId: string | null;
    executionPolicy: unknown;
  };
  actor: { actorType: string; agentId: string | null; runId: string | null };
  requestedStatus: string | undefined;
  currentStatus: string;
}): Promise<{ message: string } | null> {
  if (input.requestedStatus !== "in_review" && input.requestedStatus !== "done") return null;
  if (input.currentStatus === input.requestedStatus) return null;
  if (input.actor.actorType !== "agent" || !input.actor.agentId || !input.actor.runId) return null;
  if (issueExecutionPolicyOptsOutOfSelfReview(input.issue.executionPolicy as IssueExecutionPolicy | null)) return null;

  // The self-review pass run itself must be allowed through — otherwise its own handoff
  // attempt would re-trigger this gate and schedule another pass, looping indefinitely.
  if (await isSelfReviewPassRunId(input.db, input.actor.runId)) return null;

  const hasGitWorkspace = await issueProjectHasGitWorkspace(input.db, input.issue.companyId, input.issue.projectId);
  if (!hasGitWorkspace) return null;

  const sourceRunId = input.actor.runId;
  const idempotencyKey = buildSelfReviewPassIdempotencyKey({ issueId: input.issue.id, sourceRunId });
  const existingWake = await findExistingSelfReviewPassWake(input.db, {
    companyId: input.issue.companyId,
    idempotencyKey,
  });

  const baseMessage =
    "This task needs one more self-check before it can move to review or done. I've scheduled a separate follow-up run to do that check and complete the handoff — retrying this same PATCH again in this run will not succeed, even right after posting a self-review comment yourself. Don't retry here; wait for the follow-up run.";

  if (existingWake) return { message: baseMessage };

  // DUR-71: detection is driven by the actual changed file paths, not by asking the agent
  // whether its own work is risky. changedFilePaths is null (not []) when the diff genuinely
  // couldn't be read (e.g. a non-local workspace) -- that degrades to the ordinary-only
  // prompt rather than guessing at risk.
  //
  // DUR-91: path-only detection misses risky content in a generically-named file (e.g.
  // DUR-67's codex-home.ts, which strips `mcp_servers` blocks carrying secrets but matches
  // no filename pattern). getChangedDiffContentForIssueWorkspace/detectRiskySurfaceFromDiffContent
  // supplement the path check with the same patterns run against added diff lines.
  //
  // DUR-270 (security review of DUR-245): this now has to run BEFORE the "already used its
  // one pass" check below, not after -- DUR-245's fix let a later run through as soon as ANY
  // prior pass had completed for this issue, without ever looking at whether the diff had
  // changed since. That silently skipped risky-surface detection for a genuinely new, risky
  // commit landed under an issue that had already burned its one pass on an earlier, boring
  // diff. Reading the diff on every retry (not just when actually scheduling) is the price of
  // closing that gap.
  const [changedFilePaths, diffContent] = await Promise.all([
    getChangedFilePathsForIssueWorkspace(input.db, { companyId: input.issue.companyId, issueId: input.issue.id }),
    getChangedDiffContentForIssueWorkspace(input.db, { companyId: input.issue.companyId, issueId: input.issue.id }),
  ]);
  const riskySurfaceCategories = [
    ...new Set([
      ...(changedFilePaths ? detectRiskySurfaceFromDiff(changedFilePaths) : []),
      ...(diffContent ? detectRiskySurfaceFromDiffContent(diffContent) : []),
    ]),
  ];
  const reviewedDiffFingerprint = computeReviewedDiffFingerprint(changedFilePaths, diffContent);

  // DUR-286: computeReviewedDiffFingerprint nulls the fingerprint whenever EITHER read failed
  // (DUR-276), but only a workspace that's genuinely unresolvable (BOTH reads null -- no diff
  // exists to compare against at all, e.g. the workspace hasn't been realized yet) should fall
  // back to findCompletedSelfReviewPassForIssue's lenient "any completed pass counts" mode. A
  // partial failure (one read succeeded) means a real diff exists but couldn't be fully read
  // -- routinely just the diff-content buffer overflowing on a large generated/vendored file
  // while the path-only read stays under its own, separate cap -- and must be treated like a
  // new, unreviewed diff instead: passing the real (null) fingerprint here makes the lookup
  // below always miss, so this attempt falls through to scheduling a fresh pass rather than
  // letting an unrelated older pass on this issue silently vouch for content it never saw.
  const workspaceFullyUnresolvable = changedFilePaths === null && diffContent === null;

  // DUR-245: this issue already used its one bounded extra pass under a different run, and
  // that pass reached a terminal state without landing the handoff (otherwise currentStatus
  // would already equal requestedStatus and we wouldn't be here). Scheduling yet another pass
  // for the SAME diff would just repeat the same failure mode indefinitely; let this attempt
  // through instead. DUR-270: scoped to the current diff's fingerprint so this only bypasses
  // re-review of a diff that was actually reviewed -- a later, different (possibly risky) diff
  // on the same issue still gets its own pass, matching detectRiskySurfaceFromDiff(Content)'s
  // fresh-per-diff design intent.
  const priorPass = await findCompletedSelfReviewPassForIssue(input.db, {
    companyId: input.issue.companyId,
    issueId: input.issue.id,
    matchingDiffFingerprint: workspaceFullyUnresolvable ? undefined : reviewedDiffFingerprint,
  });
  if (priorPass) return null;

  // DUR-290: `changedFilePaths !== null && diffContent === null` means a diff genuinely exists
  // (the workspace resolved and the cheaper path-only read succeeded) but couldn't be fully
  // read -- routinely the diff-content buffer permanently overflowing on a large
  // generated/vendored file that isn't going away, not a transient failure. That shape can
  // never earn a `priorPass` match above (see the DUR-286 comment on
  // findCompletedSelfReviewPassForIssue), so left unchecked this would schedule a fresh pass on
  // every single attempt, forever, whenever a scheduled pass's own corrective run doesn't land
  // its handoff. Cap it instead of looping silently.
  const diffStructurallyUnreadable = changedFilePaths !== null && diffContent === null;
  if (diffStructurallyUnreadable) {
    const priorPassCount = await countSelfReviewPassWakesForIssue(input.db, {
      companyId: input.issue.companyId,
      issueId: input.issue.id,
    });
    if (priorPassCount >= MAX_SELF_REVIEW_PASSES_FOR_UNREADABLE_DIFF) {
      const capMessage =
        "This task's diff is too large for me to fully read and review (it likely touches a " +
        `large generated/vendored file), and ${priorPassCount} self-review pass(es) have already ` +
        "been scheduled for it without resolving that. I'm not scheduling another one -- this " +
        "needs an operator to look at it directly (e.g. split the diff, exclude the oversized " +
        'file from review, or set this issue\'s execution policy to {"selfReview": false}).';
      try {
        await postSelfReviewPassNoticeComment(input.db, {
          companyId: input.issue.companyId,
          issueId: input.issue.id,
          sourceRunId,
          body: capMessage,
        });
      } catch {
        // Best-effort — the blocking return below is what actually matters.
      }
      return { message: capMessage };
    }
  }

  const riskySurfaceNote =
    riskySurfaceCategories.length > 0
      ? ` This one also touches ${riskySurfaceCategories.map((category) => RISKY_SURFACE_CATEGORY_LABELS[category]).join(", ")}, so I've included some adversarial questions on top of the usual check.`
      : "";
  const message = baseMessage + riskySurfaceNote;

  const instruction = buildSelfReviewPassInstruction({
    issueIdentifier: input.issue.identifier,
    alreadyHandedOff: false,
    riskySurfaceCategories,
    requestedStatus: input.requestedStatus,
  });

  // DUR-293: input.wakeup resolving without throwing does NOT mean a corrective run was
  // actually scheduled -- enqueueWakeup has many legitimate no-throw skip paths (company
  // inactive, heartbeat disabled, an unresolved dependency blocker, ...) that just record a
  // "skipped" wakeup row and resolve to null, indistinguishable from a real schedule by
  // return value alone. onNotScheduled reports which (if either) actually happened so this
  // gate can respond honestly instead of always claiming "I've scheduled a follow-up run".
  let notScheduled: SelfReviewGateWakeupNotScheduledInfo | undefined;

  try {
    await input.wakeup(input.actor.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: SELF_REVIEW_PASS_REASON,
      payload: {
        issueId: input.issue.id,
        taskId: input.issue.id,
        resumeIntent: true,
        resumeFromRunId: sourceRunId,
        [SELF_REVIEW_PASS_CONTEXT_KEY]: true,
        instruction,
        // DUR-270: recorded so a later findCompletedSelfReviewPassForIssue lookup can tell
        // whether THIS pass actually reviewed the diff a later attempt is asking to bypass.
        reviewedDiffFingerprint,
      },
      contextSnapshot: {
        issueId: input.issue.id,
        wakeReason: SELF_REVIEW_PASS_REASON,
        [SELF_REVIEW_PASS_CONTEXT_KEY]: true,
        resumeFromRunId: sourceRunId,
        // DUR-125: the run this scheduling call spawns must be exempt from this same gate
        // (see isSelfReviewPassRunId above). That only holds if it lands as a genuinely new
        // heartbeat_runs row -- if the source run is still "running" when this fires, the
        // generic same-agent/same-issue coalescing in heartbeat.ts's enqueueWakeup would
        // otherwise merge this contextSnapshot onto the source run's own (already-gated) row
        // instead of producing a new one. This flag routes it through the defer-and-promote
        // path so the exemption always lands on a fresh run.
        requiresDistinctRunBoundary: true,
      },
      idempotencyKey,
      requestedByActorType: "system",
      requestedByActorId: "issue_self_review_gate",
      onNotScheduled: (info) => {
        notScheduled = info;
      },
    });
  } catch {
    // Scheduling the extra pass failed (e.g. the agent is paused or the company is over
    // budget). Don't let a self-review scheduling failure block a real disposition — let
    // the transition through as requested instead.
    return null;
  }

  // "deferred" means the wake is genuinely queued behind the caller's own still-active
  // execution run and will fire once that run finishes -- that's a real scheduled follow-up,
  // just like "queued"/"coalesced", so it falls through to the normal blocking message below.
  if (notScheduled?.kind === "skipped") {
    if (notScheduled.reason === "issue_dependencies_blocked") {
      // Honest version of the standard "blocked by unresolved blockers" shape used elsewhere
      // (see server/src/routes/issues.ts) instead of the false "I've scheduled a follow-up
      // run" claim -- no run was, or ever will be, dispatched by this skipped wake.
      const blockerNote =
        notScheduled.unresolvedBlockerIssueIds && notScheduled.unresolvedBlockerIssueIds.length > 0
          ? ` (${notScheduled.unresolvedBlockerIssueIds.join(", ")})`
          : "";
      return {
        message:
          `This task is blocked by unresolved blocker issue(s)${blockerNote} and can't move to review or ` +
          "done until they're resolved. No follow-up self-review run was scheduled for this attempt " +
          "because the issue is dependency-blocked, not because a check is pending.",
      };
    }
    // DUR-295 (security review of DUR-293): the agent's own daily heartbeat run/cost cap
    // (getHeartbeatDailyCapBlock in heartbeat.ts) is keyed on THIS agent's own usage for the
    // current UTC day -- unlike the other skip reasons below, an agent can land here through
    // its own ordinary wakeup volume (no operator action, no special permission needed), and
    // then have this exact PATCH -- the one the self-review pass exists to check -- sail
    // through with the adversarial risky-surface review never run. Letting the transition
    // through here would turn "I happened to be busy today" into a silent bypass of the one
    // review this gate is supposed to guarantee. Block honestly instead: the cap resets at
    // the next UTC day boundary, so this is a real, bounded wait, not a permanent stall.
    if (notScheduled.reason === "heartbeat.daily_run_limit" || notScheduled.reason === "heartbeat.daily_cost_limit") {
      return {
        message:
          "This task needs one more self-check before it can move to review or done, but I couldn't " +
          "schedule that follow-up run because this agent has already hit its own daily heartbeat cap " +
          "for today. No follow-up run was, or will be, scheduled for this attempt -- retrying this PATCH " +
          "won't help. The cap resets at the next UTC day boundary; retry after that, or ask an operator " +
          "to raise it sooner.",
      };
    }
    // Every other no-throw skip reason (company inactive, heartbeat disabled on this agent,
    // wakeOnDemand disabled, an active tree-control pause hold, ...) is operator-controlled
    // configuration or state, not something this agent's own request volume can land it in --
    // nothing was, or ever will be, scheduled either way, so treat it the same as the
    // catch block above and let the transition through rather than block forever on a promise
    // that can't be kept.
    return null;
  }

  try {
    // Best-effort: the wakeup is already scheduled (and is what actually re-gates the
    // transition), so a failure here shouldn't change the gate's outcome.
    await postSelfReviewPassNoticeComment(input.db, {
      companyId: input.issue.companyId,
      issueId: input.issue.id,
      sourceRunId,
      body: instruction,
    });
  } catch {
    // Ignore — see comment above.
  }

  return { message };
}
