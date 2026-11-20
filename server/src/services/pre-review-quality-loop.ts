import { spawn } from "node:child_process";
import { and, eq, gt, isNull, like, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueComments } from "@paperclipai/db";
import {
  QUALITY_PRE_REVIEW_MAX_ROUNDS,
  QUALITY_PRE_REVIEW_TEST_TIMEOUT_MS,
  maskSecretLikeText,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { findDoneGateLoopResetAt } from "./done-gate-critic.js";
import {
  readQualityLoopSettingsRow,
  resolveEffectiveQualityLoops,
  resolveProjectWorkspaceTestCommand,
  isHandOffToReview,
} from "./quality-loops.js";
import { sanitizeRuntimeServiceBaseEnv } from "./runtime-env.js";
import {
  MISSING_RUN_ID_GATE_MESSAGE,
  getCurrentHeadShaForIssueWorkspace,
  resolveIssueWorkspaceCheckout,
  type SelfReviewGateWakeup,
  type SelfReviewGateWakeupNotScheduledInfo,
} from "./self-review-gate.js";

/**
 * Pre-review quality loop. Before an agent may ask for review, the module's tests run and
 * the diff is checked against the task's acceptance criteria. Failures go back to the same
 * agent automatically, at most QUALITY_PRE_REVIEW_MAX_ROUNDS times, so the work improves
 * instead of only being retried.
 *
 * Applies when ALL of these hold: the company switched on "Run the tests before review"
 * (company_quality_loop_settings.pre_review_quality_loop), the mover is an agent, and the
 * task's project has a "Test command (run before review)" (project_workspaces.metadata.
 * testCommand, board users only). Unlike the other quality loops it does NOT stand aside
 * for a task with a review stage: running ahead of the reviewer is the point.
 *
 * What happens on an agent's move to in_review:
 * - The test command starts in the background, in the task's own workspace, with a time
 *   limit, and the move is refused (409) at once: "Running the module's tests before review".
 * - Pass for the current commit: a system comment "Quality loop: tests passed at abc1234",
 *   and the agent is woken to make the move again; that move is let through.
 * - Failure: "Quality loop: tests failed (round n of 2)" with the last lines of output, and
 *   the same agent is woken to fix it. Rounds are counted from those comments.
 * - Still failing after the last round: the move goes to review anyway, with the failures
 *   stated at the top of the last comment so the person sees them.
 * - The diff-vs-criteria check is evaluateQualityDoneCheck on in_review (quality-loops.ts).
 *
 * Safety: the command is host-executed, so it is set by board users only
 * (workspace-command-authz.ts); it runs without the server's own secrets
 * (sanitizeRuntimeServiceBaseEnv); output is masked before it is written to the task.
 * Every outcome is written on the task as a system comment, and to the activity log.
 */

export const PRE_REVIEW_TESTS_FAILED_REASON = "pre_review_tests_failed";
export const PRE_REVIEW_TESTS_PASSED_REASON = "pre_review_tests_passed";
export const PRE_REVIEW_RUNNING_MESSAGE = "Running the module's tests before review";

export const PRE_REVIEW_PASS_PREFIX = "Quality loop: tests passed at ";
export const PRE_REVIEW_FAIL_PREFIX = "Quality loop: tests failed (round ";
export const PRE_REVIEW_COULD_NOT_RUN_PREFIX = "Quality loop: could not run the tests";

const OUTPUT_TAIL_LINES = 60;
const OUTPUT_KEEP_BYTES = 64 * 1024;
const KILL_GRACE_MS = 5_000;
const FORCE_SETTLE_MS = 2_000;

export interface PreReviewTestRunResult {
  /** Process exit code; null when it was killed (timeout) or never started. */
  exitCode: number | null;
  timedOut: boolean;
  /** stdout and stderr together, in order, truncated to the last ~64 KB. */
  output: string;
  /** Set when the command could not be started at all. */
  startError?: string;
}

export type PreReviewTestRunner = (input: {
  command: string;
  cwd: string;
  timeoutMs: number;
}) => Promise<PreReviewTestRunResult>;

/** Runs the command through the shell in `cwd`, killing the whole process group on timeout. */
export const defaultPreReviewTestRunner: PreReviewTestRunner = ({ command, cwd, timeoutMs }) =>
  new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: PreReviewTestRunResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("/bin/sh", ["-c", command], {
        cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...sanitizeRuntimeServiceBaseEnv(process.env), CI: "1" },
      });
    } catch (err) {
      finish({ exitCode: null, timedOut: false, output: "", startError: err instanceof Error ? err.message : String(err) });
      return;
    }
    const append = (chunk: unknown) => {
      output += String(chunk);
      if (output.length > OUTPUT_KEEP_BYTES * 2) output = output.slice(-OUTPUT_KEEP_BYTES);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => {
        killGroup("SIGKILL");
        // A descendant that left the process group can hold the output pipes open, so "close"
        // would never fire. Give up on the pipes shortly after the kill and report the timeout.
        setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish({ exitCode: null, timedOut: true, output: output.slice(-OUTPUT_KEEP_BYTES) });
        }, FORCE_SETTLE_MS).unref();
      }, KILL_GRACE_MS).unref();
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ exitCode: null, timedOut: false, output: output.slice(-OUTPUT_KEEP_BYTES), startError: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ exitCode: code, timedOut, output: output.slice(-OUTPUT_KEEP_BYTES) });
    });
  });

// One check per task at a time, in this process. A check lost to a restart is simply started
// again by the agent's next move to review.
const runningChecks = new Map<string, Promise<void>>();

/** Test seam: resolves when the background check for the task (if any) has finished. */
export async function waitForPreReviewCheck(issueId: string): Promise<void> {
  await runningChecks.get(issueId);
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "unknown";
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export function lastLines(output: string, count = OUTPUT_TAIL_LINES): string {
  const lines = stripAnsi(output).replace(/\r\n?/g, "\n").trimEnd().split("\n");
  const tail = lines.slice(-count).join("\n");
  return maskSecretLikeText(tail);
}

function loopCommentWhere(input: { companyId: string; issueId: string; since?: Date | null }, bodyLike: string): SQL {
  const clauses: SQL[] = [
    eq(issueComments.companyId, input.companyId),
    eq(issueComments.issueId, input.issueId),
    eq(issueComments.authorType, "system"),
    isNull(issueComments.authorAgentId),
    isNull(issueComments.authorUserId),
    like(issueComments.body, bodyLike),
  ];
  if (input.since) clauses.push(gt(issueComments.createdAt, new Date(input.since.getTime() + 1)));
  return and(...clauses)!;
}

// LIKE treats % and _ as wildcards; none of our prefixes contain them, but the sha is hex only.
async function countLoopComments(
  db: Db,
  input: { companyId: string; issueId: string; since?: Date | null },
  bodyLike: string,
): Promise<number> {
  const rows = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(loopCommentWhere(input, bodyLike));
  return rows.length;
}

/** Failed test rounds in the current loop (since a person last stepped in), deleted comments included. */
export function countPreReviewFailedRounds(db: Db, input: { companyId: string; issueId: string; since?: Date | null }) {
  return countLoopComments(db, input, `${PRE_REVIEW_FAIL_PREFIX}%`);
}

async function postLoopComment(
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

export function buildPreReviewFailureComment(input: {
  round: number;
  maxRounds: number;
  command: string;
  headSha: string | null;
  result: PreReviewTestRunResult;
  timeoutMs: number;
}): string {
  const last = input.round >= input.maxRounds;
  const how = input.result.timedOut
    ? `it did not finish within ${Math.round(input.timeoutMs / 60_000)} minutes and was stopped`
    : `it exited with code ${input.result.exitCode ?? "unknown"}`;
  const lines = [
    `${PRE_REVIEW_FAIL_PREFIX}${input.round} of ${input.maxRounds})`,
    "",
  ];
  if (last) {
    lines.push(
      "These tests are STILL failing after the last automatic round. The task will go to review anyway, so the person looking at it sees the failures below first.",
      "",
    );
  }
  lines.push(
    `Test command: \`${maskSecretLikeText(input.command)}\` (${how}). Commit: ${shortSha(input.headSha)}.`,
    "",
    `Last ${OUTPUT_TAIL_LINES} lines of output:`,
    "```",
    lastLines(input.result.output),
    "```",
    "",
    last
      ? "What happens next: move the task to review again with a comment that names these failures; it will be let through."
      : "What happens next: fix what is failing, commit, and move the task to review again. The tests run again, so look at the output above first.",
  );
  return lines.join("\n");
}

async function wakeAgent(
  input: {
    wakeup: SelfReviewGateWakeup;
    agentId: string;
    issueId: string;
    sourceRunId: string;
    /** "failed": fix and try again. "passed": move to review again now. */
    kind: "failed" | "passed";
    instruction: string;
    keySuffix: string;
  },
): Promise<boolean> {
  const reason = input.kind === "failed" ? PRE_REVIEW_TESTS_FAILED_REASON : PRE_REVIEW_TESTS_PASSED_REASON;
  let notScheduled: SelfReviewGateWakeupNotScheduledInfo | undefined;
  try {
    await input.wakeup(input.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: input.kind === "failed" ? PRE_REVIEW_TESTS_FAILED_REASON : PRE_REVIEW_TESTS_PASSED_REASON,
      payload: {
        issueId: input.issueId,
        taskId: input.issueId,
        resumeIntent: true,
        resumeFromRunId: input.sourceRunId,
        qualityLoop: true,
        instruction: input.instruction,
      },
      contextSnapshot: {
        issueId: input.issueId,
        wakeReason: reason,
        resumeFromRunId: input.sourceRunId,
      },
      idempotencyKey: [reason, input.issueId, input.keySuffix].join(":"),
      requestedByActorType: "system",
      requestedByActorId: "pre_review_quality_loop",
      onNotScheduled: (info) => {
        notScheduled = info;
      },
    });
  } catch (err) {
    logger.warn({ err, issueId: input.issueId }, "pre-review quality loop: could not wake the agent");
    return false;
  }
  return notScheduled?.kind !== "skipped";
}

export interface PreReviewQualityLoopInput {
  db: Db;
  wakeup: SelfReviewGateWakeup;
  issue: {
    id: string;
    identifier: string | null;
    companyId: string;
    projectId: string | null;
    executionPolicy: unknown;
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
    executionState?: unknown;
  };
  actor: { actorType: string; agentId: string | null; runId: string | null };
  requestedStatus: string | undefined;
  currentStatus: string;
  /** Test seams. */
  runner?: PreReviewTestRunner;
  timeoutMs?: number;
}

/**
 * Returns null when the move to review may go ahead; otherwise the refusal (the route
 * answers 409). Never gates a person. Fails open on anything it cannot read or start, with
 * a note on the task, so a broken test setup never holds work hostage.
 */
export async function evaluatePreReviewQualityLoop(
  input: PreReviewQualityLoopInput,
): Promise<{ message: string } | null> {
  // A move to in_review, or a worker's "done" that the stage engine turns into a hand-off to a reviewer.
  if (!isHandOffToReview({ ...input, ...input.issue })) return null;
  if (input.actor.actorType !== "agent" || !input.actor.agentId) return null;
  const { db, issue } = input;
  const agentId = input.actor.agentId;

  let testCommand: string | null;
  try {
    const row = await readQualityLoopSettingsRow(db, issue.companyId);
    if (!resolveEffectiveQualityLoops(row, issue.executionPolicy).preReviewQualityLoop) return null;
    testCommand = await resolveProjectWorkspaceTestCommand(db, issue.companyId, issue.projectId);
  } catch (err) {
    logger.warn({ err, issueId: issue.id }, "pre-review quality loop: could not read settings; treating as off");
    return null;
  }
  if (!testCommand) return null;
  // The loop applies, so an agent with no trusted run cannot slip past it (same rule as the other gates).
  if (!input.actor.runId) return { message: MISSING_RUN_ID_GATE_MESSAGE };
  const sourceRunId = input.actor.runId;

  // Reserve the slot before any await, so two moves at the same moment cannot both start a run.
  if (runningChecks.has(issue.id)) return { message: PRE_REVIEW_RUNNING_MESSAGE };
  let releaseSlot: () => void = () => {};
  runningChecks.set(
    issue.id,
    new Promise<void>((resolve) => {
      releaseSlot = resolve;
    }),
  );
  let started = false;
  try {
    return await startPreReviewCheck(input, {
      testCommand,
      sourceRunId,
      agentId,
      markStarted: () => {
        started = true;
      },
      releaseSlot,
    });
  } finally {
    if (!started) {
      runningChecks.delete(issue.id);
      releaseSlot();
    }
  }
}

async function startPreReviewCheck(
  input: PreReviewQualityLoopInput,
  ctx: {
    testCommand: string;
    sourceRunId: string;
    agentId: string;
    markStarted: () => void;
    releaseSlot: () => void;
  },
): Promise<{ message: string } | null> {
  const { db, issue } = input;
  const { testCommand, sourceRunId, agentId } = ctx;
  const base = { companyId: issue.companyId, issueId: issue.id };

  let since: Date | null = null;
  try {
    since = await findDoneGateLoopResetAt(db, base);
  } catch (err) {
    logger.warn({ err, issueId: issue.id }, "pre-review quality loop: could not read the last intervention; counting all rounds");
  }

  const checkout = await resolveIssueWorkspaceCheckout(db, base);
  const headSha = checkout ? await getCurrentHeadShaForIssueWorkspace(db, base) : null;

  // A pass for this very commit, or a final failed round already on the task: let it through.
  try {
    // With a commit: a pass for that commit. Without one (no git HEAD to read), a pass in the
    // current loop counts, or the agent would be woken and re-tested forever.
    const passScope = headSha ? base : { ...base, since };
    if ((await countLoopComments(db, passScope, `${PRE_REVIEW_PASS_PREFIX}${shortSha(headSha)}%`)) > 0) return null;
    if ((await countPreReviewFailedRounds(db, { ...base, since })) >= QUALITY_PRE_REVIEW_MAX_ROUNDS) return null;
    // The tests could not be started earlier in this loop: say so once, then stop trying.
    if ((await countLoopComments(db, { ...base, since }, `${PRE_REVIEW_COULD_NOT_RUN_PREFIX}%`)) > 0) return null;
  } catch (err) {
    logger.warn({ err, issueId: issue.id }, "pre-review quality loop: could not read earlier rounds; letting the move through");
    return null;
  }

  if (!checkout) {
    await couldNotRun(db, input, sourceRunId, "The task has no workspace on this server to run them in.");
    return null;
  }

  const runner = input.runner ?? defaultPreReviewTestRunner;
  const timeoutMs = input.timeoutMs ?? QUALITY_PRE_REVIEW_TEST_TIMEOUT_MS;
  const job = runCheck({
    ...input,
    agentId,
    sourceRunId,
    testCommand,
    cwd: checkout.workspacePath,
    headSha,
    since,
    runner,
    timeoutMs,
  })
    .catch((err) => {
      logger.warn({ err, issueId: issue.id }, "pre-review quality loop: the background check failed");
    })
    .finally(() => {
      runningChecks.delete(issue.id);
      ctx.releaseSlot();
    });
  runningChecks.set(issue.id, job);
  ctx.markStarted();
  return { message: PRE_REVIEW_RUNNING_MESSAGE };
}

async function couldNotRun(
  db: Db,
  input: { issue: { id: string; companyId: string }; actor: { agentId: string | null } },
  sourceRunId: string,
  why: string,
): Promise<void> {
  try {
    await postLoopComment(db, {
      companyId: input.issue.companyId,
      issueId: input.issue.id,
      sourceRunId,
      body: `${PRE_REVIEW_COULD_NOT_RUN_PREFIX}.\n\n${why} This task is allowed to go to review without them; say so to the reviewer.`,
    });
    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "pre_review_quality_loop",
      action: "issue.pre_review_tests_not_run",
      entityType: "issue",
      entityId: input.issue.id,
      agentId: input.actor.agentId,
      runId: sourceRunId,
      details: { reason: why },
    });
  } catch (err) {
    logger.warn({ err, issueId: input.issue.id }, "pre-review quality loop: could not note that the tests did not run");
  }
}

async function runCheck(
  input: PreReviewQualityLoopInput & {
    agentId: string;
    sourceRunId: string;
    testCommand: string;
    cwd: string;
    headSha: string | null;
    since: Date | null;
    runner: PreReviewTestRunner;
    timeoutMs: number;
  },
): Promise<void> {
  const { db, issue, agentId, sourceRunId, headSha } = input;
  const base = { companyId: issue.companyId, issueId: issue.id };
  const label = issue.identifier ?? "the task";
  const result = await input.runner({ command: input.testCommand, cwd: input.cwd, timeoutMs: input.timeoutMs });

  if (result.startError) {
    await couldNotRun(db, input, sourceRunId, `The test command could not be started (${maskSecretLikeText(result.startError)}).`);
    await wakeAgent({
      wakeup: input.wakeup,
      agentId,
      issueId: issue.id,
      sourceRunId,
      kind: "passed",
      instruction: `The tests for ${label} could not be started, so they were not run. Move the task to in_review again; it will be let through. Say in your comment that the tests were not run.`,
      keySuffix: `${shortSha(headSha)}:not_run:${sourceRunId}`,
    });
    return;
  }

  if (result.exitCode === 0 && !result.timedOut) {
    await postLoopComment(db, {
      ...base,
      sourceRunId,
      body: `${PRE_REVIEW_PASS_PREFIX}${shortSha(headSha)}\n\n\`${maskSecretLikeText(input.testCommand)}\` exited with code 0.`,
    });
    await safeActivity(db, issue, agentId, sourceRunId, "issue.pre_review_tests_passed", { commit: shortSha(headSha) });
    await wakeAgent({
      wakeup: input.wakeup,
      agentId,
      issueId: issue.id,
      sourceRunId,
      kind: "passed",
      instruction: `The tests for ${label} passed at ${shortSha(headSha)}. Move the task to in_review again now, with a comment saying what you did.`,
      keySuffix: `${shortSha(headSha)}:${sourceRunId}`,
    });
    return;
  }

  const round = (await countPreReviewFailedRounds(db, { ...base, since: input.since })) + 1;
  await postLoopComment(db, {
    ...base,
    sourceRunId,
    body: buildPreReviewFailureComment({
      round,
      maxRounds: QUALITY_PRE_REVIEW_MAX_ROUNDS,
      command: input.testCommand,
      headSha,
      result,
      timeoutMs: input.timeoutMs,
    }),
  });
  await safeActivity(db, issue, agentId, sourceRunId, "issue.pre_review_tests_failed", {
    round,
    maxRounds: QUALITY_PRE_REVIEW_MAX_ROUNDS,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    commit: shortSha(headSha),
  });
  const last = round >= QUALITY_PRE_REVIEW_MAX_ROUNDS;
  await wakeAgent({
    wakeup: input.wakeup,
    agentId,
    issueId: issue.id,
    sourceRunId,
    kind: "failed",
    instruction: last
      ? `The tests for ${label} are still failing after round ${round} of ${QUALITY_PRE_REVIEW_MAX_ROUNDS}. Read the last comment from the quality loop, then move the task to in_review with a comment that names the failures; this attempt is let through.`
      : `The tests for ${label} failed (round ${round} of ${QUALITY_PRE_REVIEW_MAX_ROUNDS}). Read the last comment from the quality loop, fix what is failing, commit, and move the task to in_review again.`,
    keySuffix: `${round}:${shortSha(headSha)}:${sourceRunId}`,
  });
}

async function safeActivity(
  db: Db,
  issue: { id: string; companyId: string },
  agentId: string,
  runId: string,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "pre_review_quality_loop",
      action,
      entityType: "issue",
      entityId: issue.id,
      agentId,
      runId,
      details,
    });
  } catch (err) {
    logger.warn({ err, issueId: issue.id }, "pre-review quality loop: could not write the activity row");
  }
}
