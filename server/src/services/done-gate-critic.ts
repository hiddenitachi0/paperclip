import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, gt, isNotNull, isNull, like, ne, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, approvals, companies, issueApprovals, issueComments, issues } from "@paperclipai/db";
import {
  DEFAULT_DONE_GATE_SETTINGS,
  formatApprovalTitle,
  type DoneGateMode,
  type DoneGateSettings,
  type InstanceGeneralSettings,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { approvalService } from "./approvals.js";
import { costService } from "./costs.js";
import { issueApprovalService } from "./issue-approvals.js";
import {
  getChangedDiffContentForIssueWorkspace,
  getChangedFilePathsForIssueWorkspace,
} from "./self-review-gate.js";
import { approvalPayloadKind, approvalPayloadOriginalIssueIds } from "./deploy-completion-gate.js";

/**
 * Done-gate quality check ("critic"): the first OFFENSIVE quality loop.
 *
 * The existing loops around an agent's "I'm done" are defensive -- retry a run that
 * crashed, recover a stranded issue, bound a self-review pass so it can't spin forever.
 * None of them asks whether the work is actually what the task asked for. This gate does:
 * when an AGENT tries to move an issue to `done`, a second, cheap model call (the same
 * direct Anthropic plumbing lane-a.ts / secretary-classifier.ts already use -- not a full
 * heartbeat run) reads the task's description and acceptance criteria next to the agent's
 * final comment (plus the change summary when a merge_pr approval is linked) and answers
 * `pass` or `needs_work` with one to three plain-language findings.
 *
 * Composes with, and sits right after, the self-review gate (self-review-gate.ts) and the
 * goal-condition judge (goal-condition-judge.ts) in routes/issues.ts: those two schedule a
 * separate run to look again; this one answers synchronously inside the PATCH, so a
 * `needs_work` verdict is a plain 409 the agent sees immediately, and the findings land as
 * a comment on the issue.
 *
 * Bounded on purpose:
 * - Ships dormant: instance setting `general.doneGate.mode` defaults to "off"; per-company
 *   override via `general.doneGate.companyOverrides[companyId]`.
 * - "dry_run" only comments -- never blocks, never moves the issue, never escalates.
 * - "enforce" refuses the transition, sends the issue back to `in_progress`, and after
 *   `maxRounds` (default 2) needs_work rounds stops looping: the issue is parked as
 *   `blocked` and the operator gets one plain question on the board instead.
 * - Never gates a board/human actor, whatever the mode.
 * - The critic failing (no API key, upstream error, garbage output) never blocks work: the
 *   transition goes through and the failure is logged.
 *
 * Rounds are counted from the "needs work" comments this gate writes on the issue
 * (deleted ones included), so an agent can neither reset the counter by editing a field
 * it can PATCH nor by deleting the findings. Gate comments are authorType "system" with no
 * author agent/user; an agent or a board user cannot write one through the comment route
 * because issueService.addComment (assertIssueCommentAuthorTypeAllowed) refuses any
 * authorType that does not match the authenticated actor. Should some other caller ever
 * manage to write one, all it could do is inflate its own round count or pretend the
 * operator was already asked -- neither lets work through the gate.
 *
 * The loop is RECOVERABLE. Rounds and the "already asked the operator" marker are only
 * counted after the most recent operator intervention on the issue: a status change by
 * a non-agent actor (the escalation card's own recommended action is "put it back to in
 * progress with a comment"), or a decision on the board question this gate filed.
 * Without that, the round cap would be a dead end: once escalated, no agent could ever
 * mark the task done again, even after the operator sent it back with guidance.
 */

export const DONE_GATE_CRITIC_MODEL = process.env.PAPERCLIP_DONE_GATE_CRITIC_MODEL?.trim() || "claude-haiku-4-5";
const DONE_GATE_CRITIC_MAX_OUTPUT_TOKENS = 600;
// The critic answers synchronously inside PATCH /issues/:id, so a hung upstream must not
// stall the agent's "done" call for the SDK's default 10 minutes x 3 attempts. One retry on
// a 60 s timeout bounds the worst case at ~2 minutes; a timeout is thrown and treated by
// the caller as "the critic could not run" (fail open).
const DONE_GATE_CRITIC_TIMEOUT_MS = 60_000;
const DONE_GATE_CRITIC_MAX_RETRIES = 1;
// Anthropic list price for the default model (claude-haiku-4-5); a custom model via the env
// var is billed at the same rate here, which is fine for a cost line that only has to be
// roughly right (mirrors lane-a.ts's flat computeCostCents).
const DONE_GATE_CRITIC_INPUT_USD_PER_MILLION = 1;
const DONE_GATE_CRITIC_OUTPUT_USD_PER_MILLION = 5;

// Caps on what the critic is shown, so one PATCH can never turn into a huge model call.
const MAX_DESCRIPTION_CHARS = 12_000;
const MAX_FINAL_COMMENT_CHARS = 8_000;
const MAX_CHANGED_FILES = 80;
const MAX_DIFF_CHARS = 20_000;
const MAX_FINDINGS = 3;
const MAX_FINDING_CHARS = 400;

export const DONE_GATE_NEEDS_WORK_PREFIX = "Quality check: needs work";
export const DONE_GATE_DRY_RUN_NEEDS_WORK_PREFIX = "Quality check (dry run): needs work";
export const DONE_GATE_PASS_PREFIX = "Quality check: passed";
export const DONE_GATE_DRY_RUN_PASS_PREFIX = "Quality check (dry run): passed";
export const DONE_GATE_ESCALATED_PREFIX = "Quality check: asking the operator";

// Every comment this gate ever writes starts with this, so one LIKE finds them all.
const DONE_GATE_COMMENT_LIKE = "Quality check%";

export type DoneGateVerdict = "pass" | "needs_work";

export interface DoneGateCriticInput {
  issueIdentifier: string | null;
  title: string;
  description: string | null;
  finalComment: string | null;
  mergeSummary: string | null;
  changedFilePaths: string[] | null;
  diffExcerpt: string | null;
  round: number;
  maxRounds: number;
}

export interface DoneGateCriticVerdict {
  verdict: DoneGateVerdict;
  findings: string[];
  usage?: { inputTokens: number; outputTokens: number; model: string } | null;
}

export type DoneGateCritic = (input: DoneGateCriticInput) => Promise<DoneGateCriticVerdict>;

export function resolveDoneGateConfig(
  general: Pick<InstanceGeneralSettings, "doneGate"> | null | undefined,
  companyId: string,
): { mode: DoneGateMode; maxRounds: number } {
  const settings: DoneGateSettings = general?.doneGate ?? DEFAULT_DONE_GATE_SETTINGS;
  const override = settings.companyOverrides?.[companyId];
  return {
    mode: override?.mode ?? settings.mode ?? DEFAULT_DONE_GATE_SETTINGS.mode,
    maxRounds: override?.maxRounds ?? settings.maxRounds ?? DEFAULT_DONE_GATE_SETTINGS.maxRounds,
  };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[... cut off after ${max} characters]`;
}

export function buildDoneGateCriticSystemPrompt(): string {
  return [
    "You are a strict but fair reviewer inside a work-management tool. An AI agent has just declared a task finished.",
    "Your only job: compare what the task asked for (title, description, any acceptance criteria) against the evidence of what was actually done (the agent's final comment, and when present, the change summary and the changed files/diff excerpt).",
    "You have no tools and cannot check anything yourself. Judge only from what you are shown. Do not invent requirements the task never stated.",
    "",
    "Say needs_work when: a stated requirement or acceptance criterion is clearly missing or contradicted by the evidence; the agent's final comment does not say what was done at all; the agent says something is still not working, untested when tests were required, or deferred; or the evidence plainly describes different work than the task asked for.",
    "Say pass when the evidence reasonably covers what was asked, even if it is brief. Missing polish, style opinions, or things the task did not ask for are NOT reasons to say needs_work.",
    "",
    "Respond with ONLY one JSON object, no prose before or after:",
    '{"verdict": "pass" | "needs_work", "findings": ["...", "..."]}',
    `For needs_work give 1 to ${MAX_FINDINGS} findings. Each finding is one or two plain sentences a non-technical person can read: say what is missing or wrong and what would fix it. No code, no jargon, no ticket numbers as the only identifier.`,
    "For pass, findings may be empty or hold one short sentence saying why it passes.",
  ].join("\n");
}

export function buildDoneGateCriticUserMessage(input: DoneGateCriticInput): string {
  const label = input.issueIdentifier ?? "this task";
  const sections: string[] = [
    `Task ${label} (quality-check round ${input.round} of ${input.maxRounds})`,
    "",
    `## What the task asked for`,
    `Title: ${input.title}`,
    "",
    input.description?.trim() ? truncate(input.description.trim(), MAX_DESCRIPTION_CHARS) : "(no description was written for this task)",
    "",
    "## The agent's final comment when declaring it done",
    input.finalComment?.trim()
      ? truncate(input.finalComment.trim(), MAX_FINAL_COMMENT_CHARS)
      : "(the agent left no final comment describing what it did)",
  ];
  if (input.mergeSummary?.trim()) {
    sections.push("", "## Change summary from the merge request the agent filed", truncate(input.mergeSummary.trim(), MAX_FINAL_COMMENT_CHARS));
  }
  if (input.changedFilePaths && input.changedFilePaths.length > 0) {
    const shown = input.changedFilePaths.slice(0, MAX_CHANGED_FILES);
    const more = input.changedFilePaths.length - shown.length;
    sections.push("", "## Files changed", ...shown.map((p) => `- ${p}`), ...(more > 0 ? [`- (and ${more} more)`] : []));
  }
  if (input.diffExcerpt?.trim()) {
    sections.push("", "## Diff excerpt (may be cut off)", truncate(input.diffExcerpt, MAX_DIFF_CHARS));
  }
  return sections.join("\n");
}

function extractJsonObject(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * Parses the critic's reply. Returns null for anything that isn't clearly a verdict -- the
 * caller treats that as "the critic couldn't run" (fail open), never as needs_work, so a
 * flaky model can't hold work hostage.
 */
export function parseDoneGateCriticReply(text: string): { verdict: DoneGateVerdict; findings: string[] } | null {
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== "object") return null;
  const { verdict, findings } = parsed as Record<string, unknown>;
  if (verdict !== "pass" && verdict !== "needs_work") return null;
  const cleaned = (Array.isArray(findings) ? findings : [])
    .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
    .map((f) => f.trim().slice(0, MAX_FINDING_CHARS))
    .slice(0, MAX_FINDINGS);
  if (verdict === "needs_work" && cleaned.length === 0) {
    cleaned.push("The reviewer could not match what was done to what the task asked for. Say plainly what you did and how it covers each point of the task.");
  }
  return { verdict, findings: cleaned };
}

/** The default critic: one cheap Anthropic call, same shape as secretary-classifier.ts. */
export const anthropicDoneGateCritic: DoneGateCritic = async (input) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("done-gate critic is not configured on this instance (ANTHROPIC_API_KEY unset)");
  }
  const client = new Anthropic({
    apiKey,
    timeout: DONE_GATE_CRITIC_TIMEOUT_MS,
    maxRetries: DONE_GATE_CRITIC_MAX_RETRIES,
  });
  const response = await client.messages.create({
    model: DONE_GATE_CRITIC_MODEL,
    max_tokens: DONE_GATE_CRITIC_MAX_OUTPUT_TOKENS,
    system: buildDoneGateCriticSystemPrompt(),
    messages: [{ role: "user", content: buildDoneGateCriticUserMessage(input) }],
  });
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  const parsed = parseDoneGateCriticReply(text);
  if (!parsed) {
    throw new Error("done-gate critic returned no readable verdict");
  }
  return {
    ...parsed,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      model: DONE_GATE_CRITIC_MODEL,
    },
  };
};

export function computeDoneGateCriticCostCents(inputTokens: number, outputTokens: number): number {
  const usd =
    (inputTokens / 1_000_000) * DONE_GATE_CRITIC_INPUT_USD_PER_MILLION +
    (outputTokens / 1_000_000) * DONE_GATE_CRITIC_OUTPUT_USD_PER_MILLION;
  return Math.max(0, Math.round(usd * 100));
}

/**
 * The WHERE clause for "a comment this gate wrote on this issue": system-authored with no
 * author agent/user (what postDoneGateComment stamps and what the comment route cannot
 * produce for an agent or a user), optionally only those newer than `since`.
 */
function doneGateCommentWhere(input: { companyId: string; issueId: string; since?: Date | null }, bodyLike: string): SQL {
  const clauses: SQL[] = [
    eq(issueComments.companyId, input.companyId),
    eq(issueComments.issueId, input.issueId),
    eq(issueComments.authorType, "system"),
    isNull(issueComments.authorAgentId),
    isNull(issueComments.authorUserId),
    like(issueComments.body, bodyLike),
  ];
  // Postgres keeps microseconds, the driver hands back milliseconds: anything written in
  // the same millisecond as the intervention is treated as before it, so the escalation
  // comment that immediately preceded the operator's action can never leak into the new loop.
  if (input.since) clauses.push(gt(issueComments.createdAt, new Date(input.since.getTime() + 1)));
  return and(...clauses)!;
}

/**
 * When the operator last intervened on this issue, or null if never. The round counter and
 * the "already asked the operator" marker only look at gate comments newer than this, so
 * following the escalation card's own advice (move it back to in progress, or decide the
 * card) gives the agent a fresh set of rounds instead of a permanent refusal.
 *
 * Two sources, the newer wins:
 * - a status change on the issue by a non-agent actor (activity log `issue.updated` rows
 *   carry the PATCH's fields, so `details.status` is set exactly when a status was sent);
 * - a decision (any status other than pending) on a board question this gate filed for
 *   the issue.
 * The gate's own status writes (back to in_progress, park as blocked) are direct DB updates
 * without an activity row, so they never count as an intervention.
 */
export async function findDoneGateLoopResetAt(
  db: Db,
  input: { companyId: string; issueId: string },
): Promise<Date | null> {
  const [statusChange, decision] = await Promise.all([
    db
      .select({ createdAt: activityLog.createdAt })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, input.companyId),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, input.issueId),
          eq(activityLog.action, "issue.updated"),
          ne(activityLog.actorType, "agent"),
          sql`${activityLog.details}->>'status' IS NOT NULL`,
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(1)
      .then((rows) => rows[0]?.createdAt ?? null),
    db
      .select({ decidedAt: approvals.decidedAt })
      .from(issueApprovals)
      .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
      .where(
        and(
          eq(issueApprovals.companyId, input.companyId),
          eq(issueApprovals.issueId, input.issueId),
          sql`${approvals.payload}->>'kind' = 'done_gate_exhausted'`,
          ne(approvals.status, "pending"),
          isNotNull(approvals.decidedAt),
        ),
      )
      .orderBy(desc(approvals.decidedAt))
      .limit(1)
      .then((rows) => rows[0]?.decidedAt ?? null),
  ]);
  const candidates = [statusChange, decision].filter((value): value is Date => value instanceof Date);
  if (candidates.length === 0) return null;
  return new Date(Math.max(...candidates.map((value) => value.getTime())));
}

/**
 * How many "needs work" rounds this issue has had in the current loop. Counts the gate's
 * own needs-work comments (deleted ones included -- see the module docblock for why) newer
 * than `since` (the last operator intervention; pass null to count the issue's whole life).
 * `mode` restricts the count to that mode's comments, so rounds from a "Comment only" trial
 * never count against the agent once the check is switched to "On"; omit it to count both.
 */
export async function countDoneGateNeedsWorkRounds(
  db: Db,
  input: { companyId: string; issueId: string; since?: Date | null; mode?: DoneGateMode },
): Promise<number> {
  const rows = await db
    .select({ body: issueComments.body })
    .from(issueComments)
    .where(doneGateCommentWhere(input, DONE_GATE_COMMENT_LIKE));
  const prefixes =
    input.mode === "enforce"
      ? [DONE_GATE_NEEDS_WORK_PREFIX]
      : input.mode === "dry_run"
        ? [DONE_GATE_DRY_RUN_NEEDS_WORK_PREFIX]
        : [DONE_GATE_NEEDS_WORK_PREFIX, DONE_GATE_DRY_RUN_NEEDS_WORK_PREFIX];
  return rows.filter((row) => prefixes.some((prefix) => row.body.startsWith(prefix))).length;
}

/** Whether this gate has already asked the operator about the issue in the current loop (newer than `since`). */
export async function hasDoneGateEscalationComment(
  db: Db,
  input: { companyId: string; issueId: string; since?: Date | null },
): Promise<boolean> {
  const row = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(doneGateCommentWhere(input, `${DONE_GATE_ESCALATED_PREFIX}%`))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return Boolean(row);
}

/** The acting agent's most recent, not-deleted comment on the issue -- its "final word". */
export async function findLatestAgentCommentForIssue(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string },
): Promise<string | null> {
  const row = await db
    .select({ body: issueComments.body })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.authorAgentId, input.agentId),
        isNull(issueComments.deletedAt),
      ),
    )
    .orderBy(desc(issueComments.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row?.body ?? null;
}

async function postDoneGateComment(
  db: Db,
  input: { companyId: string; issueId: string; sourceRunId: string | null; body: string },
): Promise<void> {
  await db.insert(issueComments).values({
    companyId: input.companyId,
    issueId: input.issueId,
    authorType: "system",
    body: input.body,
    createdByRunId: input.sourceRunId,
  });
}

export function formatDoneGateFindings(findings: string[]): string {
  return findings.map((finding, index) => `${index + 1}. ${finding}`).join("\n");
}

export function buildDoneGateNeedsWorkComment(input: {
  round: number;
  maxRounds: number;
  findings: string[];
  dryRun: boolean;
}): string {
  const prefix = input.dryRun ? DONE_GATE_DRY_RUN_NEEDS_WORK_PREFIX : DONE_GATE_NEEDS_WORK_PREFIX;
  const lines = [
    `${prefix} (round ${input.round} of ${input.maxRounds}).`,
    "",
    "An independent reviewer compared what this task asked for with what was reported done, and found:",
    formatDoneGateFindings(input.findings),
    "",
  ];
  if (input.dryRun) {
    lines.push(
      "This is a dry run: nothing has been changed and the task can still move to done. The reviewer's notes are here so you can judge whether this check is useful.",
    );
  } else if (input.round >= input.maxRounds) {
    lines.push(
      "The task has gone back to in progress. Fix what is listed above and mark it done again with a comment saying what you did. This was the last automatic round: if the next attempt still needs work, the operator will be asked to decide instead of another automatic check.",
    );
  } else {
    lines.push(
      "The task has gone back to in progress. Fix what is listed above and mark it done again with a comment saying what you did. If you believe a finding is wrong, say why in that comment -- the reviewer sees it.",
    );
  }
  return lines.join("\n");
}

export function buildDoneGateEscalationText(input: {
  issueIdentifier: string | null;
  title: string;
  maxRounds: number;
  lastFindings: string[];
}): { comment: string; approvalTitle: string; plainSummary: string; recommendedAction: string } {
  const label = input.issueIdentifier ?? "this task";
  const findingsText =
    input.lastFindings.length > 0 ? formatDoneGateFindings(input.lastFindings) : "(no findings were recorded)";
  const plainSummary = [
    `The agent has said "${input.title}" (${label}) is finished ${input.maxRounds + 1} times, and an independent quality check disagreed ${input.maxRounds} times.`,
    "",
    "The last time, the check found:",
    findingsText,
    "",
    "The task has been parked so the agent stops going round in circles. Nothing else has changed.",
  ].join("\n");
  const recommendedAction =
    "Look at the task and the findings. If the work is actually fine, mark the task done yourself. If not, put it back to in progress with a comment telling the agent what still needs doing.";
  return {
    comment: [
      `${DONE_GATE_ESCALATED_PREFIX}.`,
      "",
      plainSummary,
      "",
      `What happens next: ${recommendedAction}`,
    ].join("\n"),
    approvalTitle: `decide whether "${input.title}" is really finished`,
    plainSummary,
    recommendedAction,
  };
}

export interface DoneGateEvaluationInput {
  db: Db;
  issue: {
    id: string;
    identifier: string | null;
    companyId: string;
    title: string;
    description: string | null;
  };
  actor: { actorType: string; agentId: string | null; runId: string | null };
  requestedStatus: string | undefined;
  currentStatus: string;
  /** The `comment` sent along with the PATCH, if any -- the agent's final word takes precedence over older comments. */
  patchComment?: string | null;
  readGeneralSettings: () => Promise<Pick<InstanceGeneralSettings, "doneGate">>;
  critic?: DoneGateCritic;
}

export interface DoneGateEvaluationResult {
  /** Operator/agent-facing reason the transition was refused (route answers 409 with it). */
  message: string;
  findings: string[];
  /** True when this attempt filed the board question instead of running another round. */
  escalated: boolean;
}

/**
 * Returns null when the transition should proceed (gate off, not an agent, not a move to
 * done, dry run, critic passed, or critic could not run). Returns a result when the
 * transition must be refused; by then the issue has already been moved back to in_progress
 * (or parked as blocked, on escalation) and the findings comment is on the issue.
 */
export async function evaluateDoneGateCritic(input: DoneGateEvaluationInput): Promise<DoneGateEvaluationResult | null> {
  if (input.requestedStatus !== "done") return null;
  if (input.currentStatus === "done") return null;
  // Never gates a board/human actor -- this guards agent self-certification, not operator authority.
  if (input.actor.actorType !== "agent" || !input.actor.agentId) return null;

  let config: { mode: DoneGateMode; maxRounds: number };
  try {
    config = resolveDoneGateConfig(await input.readGeneralSettings(), input.issue.companyId);
  } catch (err) {
    logger.warn({ err, issueId: input.issue.id }, "done-gate critic: could not read settings; treating as off");
    return null;
  }
  if (config.mode === "off") return null;
  const dryRun = config.mode === "dry_run";
  const { db } = input;
  const companyId = input.issue.companyId;
  const issueId = input.issue.id;
  const sourceRunId = input.actor.runId ?? null;

  // Only rounds since the operator last intervened count (see findDoneGateLoopResetAt).
  let resetAt: Date | null = null;
  try {
    resetAt = await findDoneGateLoopResetAt(db, { companyId, issueId });
  } catch (err) {
    logger.warn({ err, issueId }, "done-gate critic: could not read the last operator intervention; counting all rounds");
  }
  const priorRounds = await countDoneGateNeedsWorkRounds(db, { companyId, issueId, since: resetAt, mode: config.mode });

  if (priorRounds >= config.maxRounds) {
    if (dryRun) {
      // Dry run never blocks or escalates; it just stops spending on this issue.
      logger.info({ issueId, priorRounds }, "done-gate critic (dry run): round cap reached, letting done through");
      return null;
    }
    return escalateToBoard({ ...input, maxRounds: config.maxRounds, resetAt });
  }

  const round = priorRounds + 1;

  // Evidence: the agent's final word, the merge summary, the changed files and a diff excerpt.
  const finalComment =
    (input.patchComment && input.patchComment.trim()) ||
    (await findLatestAgentCommentForIssue(db, { companyId, issueId, agentId: input.actor.agentId }));

  let mergeSummary: string | null = null;
  try {
    const linked = await issueApprovalService(db).listApprovalsForIssue(issueId);
    const merge = linked.find(
      (approval) =>
        approval.type === "request_board_approval" &&
        approvalPayloadKind(approval.payload) === "merge_pr" &&
        approvalPayloadOriginalIssueIds(approval.payload).includes(issueId),
    );
    if (merge) {
      const payload = (merge.payload ?? {}) as Record<string, unknown>;
      const parts = [
        typeof payload.title === "string" ? `Title: ${payload.title}` : null,
        typeof payload.summary === "string" ? payload.summary : null,
        typeof payload.plainSummary === "string" ? payload.plainSummary : null,
        typeof payload.repo === "string" && payload.prNumber != null ? `Pull request: ${payload.repo}#${String(payload.prNumber)}` : null,
      ].filter((part): part is string => Boolean(part));
      mergeSummary = parts.length > 0 ? parts.join("\n") : null;
    }
  } catch (err) {
    logger.warn({ err, issueId }, "done-gate critic: could not read linked approvals; continuing without a merge summary");
  }

  let changedFilePaths: string[] | null = null;
  let diffExcerpt: string | null = null;
  try {
    [changedFilePaths, diffExcerpt] = await Promise.all([
      getChangedFilePathsForIssueWorkspace(db, { companyId, issueId }),
      getChangedDiffContentForIssueWorkspace(db, { companyId, issueId }),
    ]);
  } catch (err) {
    logger.warn({ err, issueId }, "done-gate critic: could not read the workspace diff; continuing without it");
  }

  const critic = input.critic ?? anthropicDoneGateCritic;
  let verdict: DoneGateCriticVerdict;
  try {
    verdict = await critic({
      issueIdentifier: input.issue.identifier,
      title: input.issue.title,
      description: input.issue.description,
      finalComment,
      mergeSummary,
      changedFilePaths,
      diffExcerpt,
      round,
      maxRounds: config.maxRounds,
    });
  } catch (err) {
    // The critic not running must never hold real work hostage.
    logger.warn({ err, issueId, round }, "done-gate critic could not run; letting the transition through");
    return null;
  }

  if (verdict.usage && verdict.usage.inputTokens + verdict.usage.outputTokens > 0) {
    try {
      await costService(db).createEvent(companyId, {
        agentId: input.actor.agentId,
        issueId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "metered_api",
        model: verdict.usage.model,
        inputTokens: verdict.usage.inputTokens,
        outputTokens: verdict.usage.outputTokens,
        costCents: computeDoneGateCriticCostCents(verdict.usage.inputTokens, verdict.usage.outputTokens),
        occurredAt: new Date(),
      });
    } catch (err) {
      logger.warn({ err, issueId }, "done-gate critic: failed to record cost event");
    }
  }

  if (verdict.verdict === "pass") {
    const prefix = dryRun ? DONE_GATE_DRY_RUN_PASS_PREFIX : DONE_GATE_PASS_PREFIX;
    const why = verdict.findings[0] ? ` ${verdict.findings[0]}` : "";
    try {
      await postDoneGateComment(db, {
        companyId,
        issueId,
        sourceRunId,
        body: `${prefix} (round ${round} of ${config.maxRounds}).${why}`,
      });
    } catch (err) {
      logger.warn({ err, issueId }, "done-gate critic: failed to post pass comment");
    }
    return null;
  }

  const comment = buildDoneGateNeedsWorkComment({
    round,
    maxRounds: config.maxRounds,
    findings: verdict.findings,
    dryRun,
  });
  try {
    await postDoneGateComment(db, { companyId, issueId, sourceRunId, body: comment });
  } catch (err) {
    logger.warn({ err, issueId }, "done-gate critic: failed to post needs-work comment");
    // Without the comment the round can't be counted and the findings are invisible; in
    // enforce mode that would make the refusal both silent and unbounded. Let it through.
    return null;
  }

  if (dryRun) return null;

  if (input.currentStatus !== "in_progress") {
    try {
      await db.update(issues).set({ status: "in_progress", updatedAt: new Date() }).where(eq(issues.id, issueId));
    } catch (err) {
      logger.warn({ err, issueId }, "done-gate critic: failed to move the issue back to in_progress");
    }
  }

  const label = input.issue.identifier ?? "This task";
  const lastRoundNote =
    round >= config.maxRounds
      ? " That was the last automatic round: if the next attempt still needs work, the operator will be asked to decide."
      : "";
  return {
    message:
      `${label} can't move to done yet -- an independent quality check found ${verdict.findings.length} thing(s) that still need work ` +
      `(round ${round} of ${config.maxRounds}). The task is back in progress; the findings are in a comment on it. ` +
      `Fix them and mark it done again with a comment saying what you did.${lastRoundNote}\n\n` +
      formatDoneGateFindings(verdict.findings),
    findings: verdict.findings,
    escalated: false,
  };
}

async function escalateToBoard(
  input: DoneGateEvaluationInput & { maxRounds: number; resetAt: Date | null },
): Promise<DoneGateEvaluationResult> {
  const { db } = input;
  const companyId = input.issue.companyId;
  const issueId = input.issue.id;
  const label = input.issue.identifier ?? "This task";

  // "Already asked" only counts a question filed in THIS loop: once the operator has acted
  // (status change / card decision) and the agent has used up a fresh set of rounds, a new
  // card is filed rather than a silent, permanent refusal.
  const alreadyEscalated = await hasDoneGateEscalationComment(db, { companyId, issueId, since: input.resetAt });
  const lastFindings = await findLastDoneGateFindings(db, { companyId, issueId, since: input.resetAt });
  const text = buildDoneGateEscalationText({
    issueIdentifier: input.issue.identifier,
    title: input.issue.title,
    maxRounds: input.maxRounds,
    lastFindings,
  });

  const message =
    `${label} can't move to done: an independent quality check has asked for changes ${input.maxRounds} times already, ` +
    "so the operator has been asked to decide instead of running another automatic round. Don't retry this; wait for the operator's answer on the task.";

  if (alreadyEscalated) {
    return { message, findings: lastFindings, escalated: true };
  }

  try {
    await postDoneGateComment(db, { companyId, issueId, sourceRunId: input.actor.runId ?? null, body: text.comment });
  } catch (err) {
    logger.warn({ err, issueId }, "done-gate critic: failed to post escalation comment");
  }
  try {
    await db.update(issues).set({ status: "blocked", updatedAt: new Date() }).where(eq(issues.id, issueId));
  } catch (err) {
    logger.warn({ err, issueId }, "done-gate critic: failed to park the issue as blocked");
  }
  try {
    const companyLabel = await db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0]?.name ?? "Paperclip");
    const approval = await approvalService(db).create(companyId, {
      type: "request_board_approval",
      payload: {
        kind: "done_gate_exhausted",
        title: formatApprovalTitle(companyLabel, text.approvalTitle),
        // `summary` is what the board card renders (ui BoardApprovalPayloadContent);
        // `plainSummary` is kept for the shape other operator cards use.
        summary: text.plainSummary,
        plainSummary: text.plainSummary,
        recommendedAction: text.recommendedAction,
        issueId,
      },
      requestedByAgentId: null,
      requestedByUserId: null,
      status: "pending",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });
    await issueApprovalService(db).linkManyForApproval(approval.id, [issueId], {});
  } catch (err) {
    // Best-effort -- the blocked status and the comment already surface this to the operator.
    logger.warn({ err, issueId }, "done-gate critic: failed to file the board question");
  }

  return { message, findings: lastFindings, escalated: true };
}

/** The findings from the most recent needs-work comment (in the current loop when `since` is given), parsed back out of its numbered list. */
export async function findLastDoneGateFindings(
  db: Db,
  input: { companyId: string; issueId: string; since?: Date | null },
): Promise<string[]> {
  const row = await db
    .select({ body: issueComments.body })
    .from(issueComments)
    .where(doneGateCommentWhere(input, `${DONE_GATE_NEEDS_WORK_PREFIX}%`))
    .orderBy(desc(issueComments.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) return [];
  return row.body
    .split("\n")
    .map((line) => line.match(/^\d+\.\s+(.+)$/)?.[1]?.trim() ?? null)
    .filter((line): line is string => Boolean(line));
}
