import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  MAX_SELF_REVIEW_PASSES_FOR_UNREADABLE_DIFF,
  RISKY_SURFACE_CATEGORY_LABELS,
  SELF_REVIEW_PASS_CONTEXT_KEY,
  SELF_REVIEW_PASS_NOTICE_COMMENT,
  SELF_REVIEW_PASS_REASON,
  buildSelfReviewPassIdempotencyKey,
  buildSelfReviewPassInstruction,
  computeReviewedDiffFingerprint,
  countSelfReviewPassWakesForIssue,
  detectRiskySurfaceFromDiff,
  detectRiskySurfaceFromDiffContent,
  evaluateSelfReviewDoneGate,
  findCompletedSelfReviewPassForIssue,
  findExistingSelfReviewPassNoticeCommentForRun,
  getChangedDiffContentForIssueWorkspace,
  getChangedFilePathsForIssueWorkspace,
  isSelfReviewPassContext,
  isSelfReviewPassRun,
  issueExecutionPolicyOptsOutOfSelfReview,
  postSelfReviewPassNoticeComment,
  type SelfReviewGateWakeup,
  type SelfReviewGateWakeupNotScheduledInfo,
} from "./self-review-gate.js";

const execFileAsync = promisify(execFile);

describe("isSelfReviewPassContext", () => {
  it("recognizes the explicit marker", () => {
    expect(isSelfReviewPassContext({ [SELF_REVIEW_PASS_CONTEXT_KEY]: true })).toBe(true);
  });

  it("recognizes a matching wakeReason", () => {
    expect(isSelfReviewPassContext({ wakeReason: SELF_REVIEW_PASS_REASON })).toBe(true);
  });

  it("returns false for unrelated context", () => {
    expect(isSelfReviewPassContext({ wakeReason: "something_else" })).toBe(false);
    expect(isSelfReviewPassContext(null)).toBe(false);
    expect(isSelfReviewPassContext(undefined)).toBe(false);
    expect(isSelfReviewPassContext("not an object")).toBe(false);
    expect(isSelfReviewPassContext([])).toBe(false);
  });
});

describe("isSelfReviewPassRun", () => {
  it("recognizes a run scheduled with the self-review retry reason", () => {
    expect(isSelfReviewPassRun({ scheduledRetryReason: SELF_REVIEW_PASS_REASON, contextSnapshot: null })).toBe(true);
  });

  it("recognizes a run via its contextSnapshot even without the retry reason column set", () => {
    expect(
      isSelfReviewPassRun({
        scheduledRetryReason: null,
        contextSnapshot: { [SELF_REVIEW_PASS_CONTEXT_KEY]: true },
      }),
    ).toBe(true);
  });

  it("returns false for an unrelated run", () => {
    expect(
      isSelfReviewPassRun({ scheduledRetryReason: "max_turn_continuation", contextSnapshot: { issueId: "issue-1" } }),
    ).toBe(false);
  });
});

describe("issueExecutionPolicyOptsOutOfSelfReview", () => {
  it("opts out only when selfReview is explicitly false", () => {
    expect(issueExecutionPolicyOptsOutOfSelfReview({ selfReview: false })).toBe(true);
  });

  it("defaults to on (no opt-out) when unset or missing", () => {
    expect(issueExecutionPolicyOptsOutOfSelfReview({ selfReview: true })).toBe(false);
    expect(issueExecutionPolicyOptsOutOfSelfReview({})).toBe(false);
    expect(issueExecutionPolicyOptsOutOfSelfReview(null)).toBe(false);
    expect(issueExecutionPolicyOptsOutOfSelfReview(undefined)).toBe(false);
  });
});

describe("buildSelfReviewPassIdempotencyKey", () => {
  it("is stable for the same issue/run pair and distinct across runs", () => {
    const key = buildSelfReviewPassIdempotencyKey({ issueId: "issue-1", sourceRunId: "run-1" });
    expect(key).toBe(`${SELF_REVIEW_PASS_REASON}:issue-1:run-1`);
    expect(buildSelfReviewPassIdempotencyKey({ issueId: "issue-1", sourceRunId: "run-2" })).not.toBe(key);
  });
});

describe("buildSelfReviewPassInstruction", () => {
  it("tells the agent to continue the normal handoff when not already handed off", () => {
    const instruction = buildSelfReviewPassInstruction({ issueIdentifier: "PAP-1", alreadyHandedOff: false });
    expect(instruction).toContain("PAP-1");
    expect(instruction).toContain("continue the normal handoff");
  });

  it("tells the agent nothing further is required if the review finds nothing when already handed off", () => {
    const instruction = buildSelfReviewPassInstruction({ issueIdentifier: "PAP-1", alreadyHandedOff: true });
    expect(instruction).toContain("no further action is required");
  });

  it("falls back to a generic label when no issue identifier is available", () => {
    const instruction = buildSelfReviewPassInstruction({ issueIdentifier: null, alreadyHandedOff: false });
    expect(instruction).toContain("this issue");
  });

  it("names the concrete PATCH call and forbids deferring to a future pass when not already handed off", () => {
    const instruction = buildSelfReviewPassInstruction({
      issueIdentifier: "PAP-1",
      alreadyHandedOff: false,
      requestedStatus: "done",
    });
    expect(instruction).toContain("PATCH .../done");
    expect(instruction).toContain('Do not defer this to "the next self-review-pass run"');
  });

  it("omits the concrete-PATCH line when no requestedStatus is given, but still forbids deferring", () => {
    const instruction = buildSelfReviewPassInstruction({ issueIdentifier: "PAP-1", alreadyHandedOff: false });
    expect(instruction).not.toContain("PATCH .../");
    expect(instruction).toContain('Do not defer this to "the next self-review-pass run"');
  });

  it("DUR-167: explicitly tells a same-run reader (the just-declined run) to stop and not retry", () => {
    const instruction = buildSelfReviewPassInstruction({
      issueIdentifier: "PAP-1",
      alreadyHandedOff: false,
      requestedStatus: "done",
    });
    expect(instruction).toContain("If you are the run whose PATCH was just declined: stop");
    expect(instruction).toContain("Do not retry that PATCH in this run");
    expect(instruction).toContain("even if you post a self-review comment first");
    expect(instruction).toContain("If you are that freshly-started run");
  });

  it("is byte-for-byte unchanged for an ordinary change with no risky surface", () => {
    const withoutCategories = buildSelfReviewPassInstruction({ issueIdentifier: "PAP-1", alreadyHandedOff: false });
    const withEmptyCategories = buildSelfReviewPassInstruction({
      issueIdentifier: "PAP-1",
      alreadyHandedOff: false,
      riskySurfaceCategories: [],
    });
    expect(withEmptyCategories).toBe(withoutCategories);
    // The three confirmatory bullets from self-review-gate.ts must survive untouched.
    expect(withoutCategories).toContain(
      "- Check that every requirement in the description is actually met, not just partially addressed.",
    );
    expect(withoutCategories).toContain("- Look for bugs, mistakes, or loose ends you may have missed the first time.");
    expect(withoutCategories).toContain("- Fix anything real that you find. Do not invent extra scope beyond the task.");
    expect(withoutCategories).not.toContain("risky surface");
    expect(withoutCategories).not.toContain("dishonest agent");
  });

  it("appends adversarial questions on top of (not instead of) the ordinary bullets for a risky change", () => {
    const instruction = buildSelfReviewPassInstruction({
      issueIdentifier: "PAP-1",
      alreadyHandedOff: false,
      riskySurfaceCategories: ["authorization_or_permissions", "agent_configuration"],
    });
    // Ordinary bullets still present, unmodified.
    expect(instruction).toContain(
      "- Check that every requirement in the description is actually met, not just partially addressed.",
    );
    expect(instruction).toContain("- Fix anything real that you find. Do not invent extra scope beyond the task.");
    // Adversarial block present, naming the detected categories.
    expect(instruction).toContain(RISKY_SURFACE_CATEGORY_LABELS.authorization_or_permissions);
    expect(instruction).toContain(RISKY_SURFACE_CATEGORY_LABELS.agent_configuration);
    expect(instruction).toContain("If a dishonest agent wanted to abuse this change");
    expect(instruction).toContain("Does this add a field, route, or setting that an agent could set on itself");
    expect(instruction).toContain("Does this only work because something elsewhere is configured");
    expect(instruction).toContain("What did the ticket NOT ask for");
    // A risky-change finding outside the ticket's scope must be reported, not suppressed by
    // the "do not invent extra scope" line above.
    expect(instruction).toContain("don't suppress it");
  });
});

describe("detectRiskySurfaceFromDiff", () => {
  it("returns no categories for an ordinary change", () => {
    expect(detectRiskySurfaceFromDiff(["ui/src/components/WidgetCard.tsx", "README.md"])).toEqual([]);
  });

  it("returns an empty array (not risky) for an empty diff", () => {
    expect(detectRiskySurfaceFromDiff([])).toEqual([]);
  });

  it("flags authorization/permissions surfaces", () => {
    expect(detectRiskySurfaceFromDiff(["server/src/services/authorization.ts"])).toEqual([
      "authorization_or_permissions",
    ]);
  });

  it("flags agent-configuration surfaces", () => {
    expect(detectRiskySurfaceFromDiff(["server/src/routes/agents.ts"])).toEqual(["agent_configuration"]);
  });

  it("flags secrets/credentials surfaces", () => {
    expect(detectRiskySurfaceFromDiff(["server/src/services/secrets.ts"])).toEqual(["secrets_or_credentials"]);
  });

  it("flags migrations", () => {
    expect(detectRiskySurfaceFromDiff(["packages/db/src/migrations/0099_add_widget.sql"])).toEqual(["migrations"]);
  });

  it("flags outbound/spend surfaces", () => {
    expect(detectRiskySurfaceFromDiff(["server/src/services/deploy-runner-status.ts"])).toEqual(["outbound_or_spend"]);
  });

  it("dedupes categories across multiple matching files and can flag more than one category", () => {
    const categories = detectRiskySurfaceFromDiff([
      "server/src/services/authorization.ts",
      "server/src/routes/authorization-admin.ts",
      "server/src/services/secrets.ts",
      "ui/src/components/Unrelated.tsx",
    ]);
    expect(categories).toEqual(
      expect.arrayContaining(["authorization_or_permissions", "secrets_or_credentials"]),
    );
    expect(categories).toHaveLength(2);
  });
});

describe("detectRiskySurfaceFromDiffContent", () => {
  it("returns no categories for an ordinary diff", () => {
    const diff = ["diff --git a/foo.ts b/foo.ts", "+++ b/foo.ts", "+export const widgetCount = 3;"].join("\n");
    expect(detectRiskySurfaceFromDiffContent(diff)).toEqual([]);
  });

  it("returns an empty array for empty diff content", () => {
    expect(detectRiskySurfaceFromDiffContent("")).toEqual([]);
  });

  // DUR-91: this is exactly the DUR-67 blind spot -- codex-home.ts/runtime-config.ts match no
  // filename pattern, but the added lines strip an mcp_servers block whose env can carry secrets.
  it("flags secrets/mcp content in an added line even when the file path is generic", () => {
    const diff = [
      "diff --git a/packages/adapters/codex-local/src/server/codex-home.ts b/packages/adapters/codex-local/src/server/codex-home.ts",
      "+++ b/packages/adapters/codex-local/src/server/codex-home.ts",
      "-const config = readToml(source);",
      "+const config = stripMcpServersBlocks(readToml(source)); // mcp_servers env may carry secrets",
    ].join("\n");
    const categories = detectRiskySurfaceFromDiffContent(diff);
    expect(categories).toEqual(
      expect.arrayContaining(["agent_configuration", "secrets_or_credentials"]),
    );
  });

  it("ignores the '+++ b/path' file header line so a risky filename alone doesn't trigger a content match", () => {
    const diff = ["diff --git a/server/src/services/secrets.ts b/server/src/services/secrets.ts", "+++ b/server/src/services/secrets.ts", "+export const NOTHING_RISKY = 1;"].join(
      "\n",
    );
    expect(detectRiskySurfaceFromDiffContent(diff)).toEqual([]);
  });

  it("ignores removed and context lines, only scanning added lines", () => {
    const diff = ["diff --git a/foo.ts b/foo.ts", "+++ b/foo.ts", "-const secretToken = getSecret();", " const unrelated = 1;", "+const ok = 2;"].join(
      "\n",
    );
    expect(detectRiskySurfaceFromDiffContent(diff)).toEqual([]);
  });
});

describe("computeReviewedDiffFingerprint", () => {
  it("returns null only when both reads are null", () => {
    expect(computeReviewedDiffFingerprint(null, null)).toBeNull();
  });

  // DUR-276: getChangedFilePathsForIssueWorkspace (1MB, --name-only) and
  // getChangedDiffContentForIssueWorkspace (4MB, full hunks) are independent git invocations
  // that can fail independently on maxBuffer overflow. If either comes back null, the
  // fingerprint must be null too -- otherwise it silently degrades to a pure function of the
  // file-path set, and two different diffs touching the same path(s) hash identically.
  it("returns null when diffContent is null but changedFilePaths is not (content buffer overflow)", () => {
    expect(computeReviewedDiffFingerprint(["server/src/adapters/agent-runtime-helpers.ts"], null)).toBeNull();
  });

  it("returns null when changedFilePaths is null but diffContent is not (path buffer overflow)", () => {
    expect(computeReviewedDiffFingerprint(null, "+some content")).toBeNull();
  });

  it("does not collapse to path-only when two different diffs touch the same path", () => {
    const path = ["server/src/adapters/agent-runtime-helpers.ts"];
    const first = computeReviewedDiffFingerprint(path, "+benign change");
    const second = computeReviewedDiffFingerprint(path, "+strip mcp_servers secret block");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toEqual(second);
  });

  it("is stable for identical inputs regardless of path ordering", () => {
    const a = computeReviewedDiffFingerprint(["b.ts", "a.ts"], "+content");
    const b = computeReviewedDiffFingerprint(["a.ts", "b.ts"], "+content");
    expect(a).toEqual(b);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres self-review-gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("self-review-gate DB-backed behavior", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-self-review-gate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  const tempDirs = new Set<string>();

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);

    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function runGit(cwd: string, args: string[]) {
    await execFileAsync("git", ["-C", cwd, ...args], { cwd });
  }

  /**
   * A real temp git checkout with a base ref ("base") and a HEAD commit that changed
   * `changedFilePath` -- so getChangedFilePathsForIssueWorkspace/detectRiskySurfaceFromDiff
   * run against an actual diff, not a stubbed file list. `content` defaults to an innocuous
   * line; pass a risky one to exercise the DUR-91 content-based signal for a generically
   * named file.
   */
  async function createTempRepoWithChange(changedFilePath: string, content = "// change under test\n") {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-self-review-gate-"));
    tempDirs.add(repoRoot);
    await runGit(repoRoot, ["init"]);
    await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
    await runGit(repoRoot, ["config", "user.email", "test@paperclip.local"]);
    await fs.writeFile(path.join(repoRoot, "README.md"), "# Test repo\n", "utf8");
    await runGit(repoRoot, ["add", "README.md"]);
    await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
    await runGit(repoRoot, ["branch", "-M", "main"]);
    await runGit(repoRoot, ["branch", "base"]);

    const targetPath = path.join(repoRoot, changedFilePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content, "utf8");
    await runGit(repoRoot, ["add", changedFilePath]);
    await runGit(repoRoot, ["commit", "-m", "Work for this issue"]);

    return repoRoot;
  }

  async function seedCodeIssueFixture(input?: { status?: string }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Widgets",
      status: "active",
    });

    await db.insert(projectWorkspaces).values({
      id: randomUUID(),
      companyId,
      projectId,
      name: "main",
      sourceType: "git",
      repoUrl: "https://example.com/widgets.git",
      isPrimary: true,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Fix the widget",
      status: input?.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, projectId, issueId, runId };
  }

  function makeRecordingWakeup(db: ReturnType<typeof createDb>, companyId: string) {
    const calls: Array<{ agentId: string; opts: Parameters<SelfReviewGateWakeup>[1] }> = [];
    const wakeup: SelfReviewGateWakeup = async (agentId, opts) => {
      calls.push({ agentId, opts });
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId,
        source: opts.source ?? "automation",
        triggerDetail: opts.triggerDetail ?? "system",
        reason: opts.reason ?? null,
        payload: opts.payload ?? {},
        status: "queued",
        idempotencyKey: opts.idempotencyKey ?? null,
        requestedByActorType: opts.requestedByActorType ?? "system",
        requestedByActorId: opts.requestedByActorId ?? null,
      });
      return { ok: true };
    };
    return { wakeup, calls };
  }

  it("posts the plain-language instruction as a system comment when scheduling a new self-review pass", async () => {
    const { companyId, agentId, projectId, issueId, runId } = await seedCodeIssueFixture();
    const { wakeup, calls } = makeRecordingWakeup(db, companyId);

    const result = await evaluateSelfReviewDoneGate({
      db,
      wakeup,
      issue: {
        id: issueId,
        identifier: `T-1`,
        companyId,
        projectId,
        executionPolicy: null,
      },
      actor: { actorType: "agent", agentId, runId },
      requestedStatus: "done",
      currentStatus: "in_progress",
    });

    expect(result).not.toBeNull();
    expect(calls).toHaveLength(1);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.authorType).toBe("system");
    expect(comments[0]?.createdByRunId).toBe(runId);
    // Plain-language, non-technical instruction (matches buildSelfReviewPassInstruction).
    expect(comments[0]?.body).toContain("Review your diff/changes against the task description");
    expect(comments[0]?.body).not.toContain("self_review_pass");
    // DUR-125: names the concrete PATCH call so the exempt run acts on its own exemption
    // instead of deferring to "the next self-review-pass run" (which never comes).
    expect(comments[0]?.body).toContain("PATCH .../done");
    expect(comments[0]?.body).toContain('Do not defer this to "the next self-review-pass run"');

    // DUR-125: the scheduled wake must ask heartbeat.ts's coalescing logic for a genuinely
    // new run rather than letting it merge onto the source run's own (still-running, already
    // gated) row -- see shouldDeferFollowupWakeForSameIssue's requiresDistinctRunBoundary.
    expect(calls[0]?.opts.contextSnapshot?.requiresDistinctRunBoundary).toBe(true);
  });

  // DUR-293: input.wakeup (heartbeat.wakeup / enqueueWakeup) resolving without throwing does
  // NOT mean a corrective run was actually scheduled -- many of its skip paths just write a
  // "skipped" wakeup row and resolve to null. A mock that reports one of those skip outcomes
  // via onNotScheduled (exactly like the real enqueueWakeup now does) simulates that gap.
  function makeSkippedWakeup(info: SelfReviewGateWakeupNotScheduledInfo) {
    const calls: Array<{ agentId: string; opts: Parameters<SelfReviewGateWakeup>[1] }> = [];
    const wakeup: SelfReviewGateWakeup = async (agentId, opts) => {
      calls.push({ agentId, opts });
      opts.onNotScheduled?.(info);
      return null;
    };
    return { wakeup, calls };
  }

  it("returns an honest blocked-by-dependency message instead of a false 'scheduled' claim when the wake is silently skipped for an unresolved blocker", async () => {
    const { companyId, agentId, projectId, issueId, runId } = await seedCodeIssueFixture();
    const blockerIssueId = randomUUID();
    const { wakeup, calls } = makeSkippedWakeup({
      kind: "skipped",
      reason: "issue_dependencies_blocked",
      unresolvedBlockerIssueIds: [blockerIssueId],
    });

    const result = await evaluateSelfReviewDoneGate({
      db,
      wakeup,
      issue: {
        id: issueId,
        identifier: `T-1`,
        companyId,
        projectId,
        executionPolicy: null,
      },
      actor: { actorType: "agent", agentId, runId },
      requestedStatus: "done",
      currentStatus: "in_progress",
    });

    expect(calls).toHaveLength(1);
    // Still blocks the transition (the dependency really is unresolved)...
    expect(result).not.toBeNull();
    // ...but the message must be honest: no follow-up run exists or ever will.
    expect(result?.message).not.toContain("scheduled a separate follow-up run");
    expect(result?.message.toLowerCase()).toContain("blocked");
    expect(result?.message).toContain(blockerIssueId);

    // No misleading "please self-review" comment should be posted for a run that was never
    // actually scheduled.
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it("lets the transition through when the wake is silently skipped for a reason unrelated to the issue's own dependency state", async () => {
    const { companyId, agentId, projectId, issueId, runId } = await seedCodeIssueFixture();
    const { wakeup, calls } = makeSkippedWakeup({
      kind: "skipped",
      reason: "heartbeat.wakeOnDemand.disabled",
    });

    const result = await evaluateSelfReviewDoneGate({
      db,
      wakeup,
      issue: {
        id: issueId,
        identifier: `T-1`,
        companyId,
        projectId,
        executionPolicy: null,
      },
      actor: { actorType: "agent", agentId, runId },
      requestedStatus: "done",
      currentStatus: "in_progress",
    });

    expect(calls).toHaveLength(1);
    // No corrective run was, or ever will be, scheduled -- and nothing about the issue
    // itself is blocking the transition, so it must be allowed through rather than stuck
    // behind a promise that can't be kept.
    expect(result).toBeNull();
  });

  it("still blocks with the normal follow-up message when the wake is genuinely deferred (queued behind the caller's own active run)", async () => {
    const { companyId, agentId, projectId, issueId, runId } = await seedCodeIssueFixture();
    const { wakeup, calls } = makeSkippedWakeup({ kind: "deferred", reason: "issue_execution_deferred" });

    const result = await evaluateSelfReviewDoneGate({
      db,
      wakeup,
      issue: {
        id: issueId,
        identifier: `T-1`,
        companyId,
        projectId,
        executionPolicy: null,
      },
      actor: { actorType: "agent", agentId, runId },
      requestedStatus: "done",
      currentStatus: "in_progress",
    });

    expect(calls).toHaveLength(1);
    // A deferred wake is a real (if delayed) schedule -- it will fire once the active run
    // finishes -- so this is the same "wait for the follow-up run" outcome as a fresh schedule.
    expect(result).not.toBeNull();
    expect(result?.message).toContain("scheduled a separate follow-up run");
  });

  // DUR-295 (security review of DUR-293): unlike the other no-throw skip reasons, the agent's
  // own daily heartbeat run/cost cap is keyed on this SAME agent's own usage for the current
  // UTC day -- an agent can land here through ordinary wakeup volume with no special
  // permission or operator action, so letting the transition through here (like the other
  // skip reasons) would let a busy day silently bypass the one adversarial review this gate
  // exists to guarantee. It must block honestly instead, same shape as the dependency-blocked
  // case above.
  it.each(["heartbeat.daily_run_limit", "heartbeat.daily_cost_limit"] as const)(
    "returns an honest blocked message instead of letting the transition through when the wake is silently skipped for %s",
    async (reason) => {
      const { companyId, agentId, projectId, issueId, runId } = await seedCodeIssueFixture();
      const { wakeup, calls } = makeSkippedWakeup({ kind: "skipped", reason });

      const result = await evaluateSelfReviewDoneGate({
        db,
        wakeup,
        issue: {
          id: issueId,
          identifier: `T-1`,
          companyId,
          projectId,
          executionPolicy: null,
        },
        actor: { actorType: "agent", agentId, runId },
        requestedStatus: "done",
        currentStatus: "in_progress",
      });

      expect(calls).toHaveLength(1);
      // Still blocks the transition -- letting it through would bypass the review this
      // agent's own usage, not an operator decision, made unschedulable.
      expect(result).not.toBeNull();
      // ...but the message must be honest: no follow-up run exists or ever will for this
      // attempt, unlike the false "scheduled a separate follow-up run" claim this PR fixes.
      expect(result?.message).not.toContain("scheduled a separate follow-up run");
      expect(result?.message.toLowerCase()).toContain("daily heartbeat cap");

      // No misleading "please self-review" comment should be posted for a run that was never
      // actually scheduled.
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments).toHaveLength(0);
    },
  );

  it("does not double-post the comment when a self-review wake already exists for this run chain", async () => {
    const { companyId, agentId, projectId, issueId, runId } = await seedCodeIssueFixture();
    const { wakeup } = makeRecordingWakeup(db, companyId);

    const gateInput = {
      db,
      wakeup,
      issue: {
        id: issueId,
        identifier: `T-1`,
        companyId,
        projectId,
        executionPolicy: null,
      },
      actor: { actorType: "agent" as const, agentId, runId },
      requestedStatus: "done" as const,
      currentStatus: "in_progress" as const,
    };

    await evaluateSelfReviewDoneGate(gateInput);
    await evaluateSelfReviewDoneGate(gateInput);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
  });

  it("lets the self-review pass run itself through without re-gating (no infinite loop)", async () => {
    const { companyId, agentId, projectId, issueId } = await seedCodeIssueFixture();
    const selfReviewRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: selfReviewRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "running",
      scheduledRetryReason: SELF_REVIEW_PASS_REASON,
    });
    const { wakeup, calls } = makeRecordingWakeup(db, companyId);

    const result = await evaluateSelfReviewDoneGate({
      db,
      wakeup,
      issue: {
        id: issueId,
        identifier: `T-1`,
        companyId,
        projectId,
        executionPolicy: null,
      },
      actor: { actorType: "agent", agentId, runId: selfReviewRunId },
      requestedStatus: "done",
      currentStatus: "in_progress",
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it("DUR-245: lets a later run's PATCH through once an earlier self-review pass for this issue has already completed, instead of scheduling another one forever", async () => {
    const { companyId, agentId, projectId, issueId } = await seedCodeIssueFixture();

    // Simulate the earlier declined run's scheduled pass reaching a terminal "completed"
    // state without ever landing the handoff (e.g. it burned its turn budget).
    const earlierSourceRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: earlierSourceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "completed",
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: SELF_REVIEW_PASS_REASON,
      payload: {},
      status: "completed",
      idempotencyKey: buildSelfReviewPassIdempotencyKey({ issueId, sourceRunId: earlierSourceRunId }),
      requestedByActorType: "system",
      requestedByActorId: "issue_self_review_gate",
    });

    // A brand-new run (different runId, so it doesn't match the completed wake's idempotency
    // key) now attempts the same PATCH.
    const laterRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: laterRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
    });
    const { wakeup, calls } = makeRecordingWakeup(db, companyId);

    const result = await evaluateSelfReviewDoneGate({
      db,
      wakeup,
      issue: {
        id: issueId,
        identifier: `T-1`,
        companyId,
        projectId,
        executionPolicy: null,
      },
      actor: { actorType: "agent", agentId, runId: laterRunId },
      requestedStatus: "done",
      currentStatus: "in_progress",
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it("findCompletedSelfReviewPassForIssue only matches a terminal completed wake for this exact issue", async () => {
    const { companyId, agentId, issueId } = await seedCodeIssueFixture();
    const otherIssueId = randomUUID();

    expect(await findCompletedSelfReviewPassForIssue(db, { companyId, issueId })).toBeNull();

    // A queued (still in-flight) wake for this issue must not count as a completed pass.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      reason: SELF_REVIEW_PASS_REASON,
      payload: {},
      status: "queued",
      idempotencyKey: buildSelfReviewPassIdempotencyKey({ issueId, sourceRunId: randomUUID() }),
    });
    expect(await findCompletedSelfReviewPassForIssue(db, { companyId, issueId })).toBeNull();

    // A completed wake for a DIFFERENT issue must not count either.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      reason: SELF_REVIEW_PASS_REASON,
      payload: {},
      status: "completed",
      idempotencyKey: buildSelfReviewPassIdempotencyKey({ issueId: otherIssueId, sourceRunId: randomUUID() }),
    });
    expect(await findCompletedSelfReviewPassForIssue(db, { companyId, issueId })).toBeNull();

    // A completed wake for THIS issue counts.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      reason: SELF_REVIEW_PASS_REASON,
      payload: {},
      status: "completed",
      idempotencyKey: buildSelfReviewPassIdempotencyKey({ issueId, sourceRunId: randomUUID() }),
    });
    expect(await findCompletedSelfReviewPassForIssue(db, { companyId, issueId })).not.toBeNull();
  });

  it("DUR-286: matchingDiffFingerprint null never matches, even against a completed pass whose own stored fingerprint is also null", async () => {
    const { companyId, agentId, issueId } = await seedCodeIssueFixture();

    // A completed pass that was itself scheduled with an unreadable diff (e.g. a totally
    // unrelated earlier commit that also overflowed the content buffer) stores `null` too.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      reason: SELF_REVIEW_PASS_REASON,
      payload: { reviewedDiffFingerprint: null },
      status: "completed",
      idempotencyKey: buildSelfReviewPassIdempotencyKey({ issueId, sourceRunId: randomUUID() }),
    });

    // undefined still means "no diff to compare at all" -- lenient, matches any completed pass.
    expect(await findCompletedSelfReviewPassForIssue(db, { companyId, issueId })).not.toBeNull();

    // null means "a diff exists but couldn't be fully read" -- must never match, even a stored
    // null, or an unrelated earlier partial-read-failure pass could vouch for this one.
    expect(
      await findCompletedSelfReviewPassForIssue(db, { companyId, issueId, matchingDiffFingerprint: null }),
    ).toBeNull();
  });

  it("skips the gate (and posts no comment) when the issue's project has no git workspace", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId: null,
      title: "Write the launch memo",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    const { wakeup, calls } = makeRecordingWakeup(db, companyId);

    const result = await evaluateSelfReviewDoneGate({
      db,
      wakeup,
      issue: { id: issueId, identifier: `T-1`, companyId, projectId: null, executionPolicy: null },
      actor: { actorType: "agent", agentId, runId },
      requestedStatus: "done",
      currentStatus: "in_progress",
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  describe("risky-surface detection reads the real diff of the issue's workspace", () => {
    async function seedIssueWithWorkspace(input: { changedFilePath: string; content?: string }) {
      const { companyId, agentId, projectId, issueId, runId } = await seedCodeIssueFixture();
      const repoRoot = await createTempRepoWithChange(input.changedFilePath, input.content);
      const executionWorkspaceId = randomUUID();
      await db.insert(executionWorkspaces).values({
        id: executionWorkspaceId,
        companyId,
        projectId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "test workspace",
        status: "active",
        providerType: "local_fs",
        cwd: repoRoot,
        baseRef: "base",
        sourceIssueId: issueId,
      });
      await db.update(issues).set({ executionWorkspaceId }).where(eq(issues.id, issueId));
      return { companyId, agentId, projectId, issueId, runId, executionWorkspaceId, repoRoot };
    }

    it("reads the changed file paths for a real diff via git", async () => {
      const { companyId, issueId } = await seedIssueWithWorkspace({
        changedFilePath: "server/src/services/authorization.ts",
      });
      const changedFiles = await getChangedFilePathsForIssueWorkspace(db, { companyId, issueId });
      expect(changedFiles).toEqual(["server/src/services/authorization.ts"]);
    });

    it("returns null (not empty) when there's no execution workspace on the issue, so callers can't mistake 'couldn't check' for 'checked, found nothing'", async () => {
      const changedFiles = await getChangedFilePathsForIssueWorkspace(db, {
        companyId: randomUUID(),
        issueId: null,
      });
      expect(changedFiles).toBeNull();
    });

    it("gets ONLY the ordinary confirmatory prompt for a change that doesn't touch a risky surface, from a real diff read", async () => {
      const { companyId, projectId, agentId, issueId, runId } = await seedIssueWithWorkspace({
        changedFilePath: "ui/src/components/WidgetCard.tsx",
      });
      const { wakeup } = makeRecordingWakeup(db, companyId);

      await evaluateSelfReviewDoneGate({
        db,
        wakeup,
        issue: { id: issueId, identifier: "T-1", companyId, projectId, executionPolicy: null },
        actor: { actorType: "agent", agentId, runId },
        requestedStatus: "done",
        currentStatus: "in_progress",
      });

      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).not.toContain("risky surface");
      expect(comments[0]?.body).not.toContain("dishonest agent");
    });

    it("adds the adversarial questions when the diff touches a risky surface -- driven by the diff, not the agent's own say-so", async () => {
      const { companyId, projectId, agentId, issueId, runId } = await seedIssueWithWorkspace({
        changedFilePath: "server/src/services/authorization.ts",
      });
      const { wakeup } = makeRecordingWakeup(db, companyId);

      const result = await evaluateSelfReviewDoneGate({
        db,
        wakeup,
        // Note: the actor/caller never asserts riskiness themselves -- there is no "isRisky"
        // input anywhere here. The gate must derive it itself from the workspace's diff.
        issue: { id: issueId, identifier: "T-1", companyId, projectId, executionPolicy: null },
        actor: { actorType: "agent", agentId, runId },
        requestedStatus: "done",
        currentStatus: "in_progress",
      });

      expect(result?.message).toContain("authorization or permissions");

      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).toContain("risky surface");
      expect(comments[0]?.body).toContain("authorization or permissions");
      expect(comments[0]?.body).toContain("If a dishonest agent wanted to abuse this change");
      // The ordinary bullets are still there too -- adversarial is additive, not a replacement.
      expect(comments[0]?.body).toContain(
        "- Check that every requirement in the description is actually met, not just partially addressed.",
      );
    });

    it("DUR-91: adds the adversarial questions for a risky change in a generically-named file, driven by diff content -- the DUR-67 blind spot", async () => {
      // Neither the file path nor anything about it matches RISKY_SURFACE_PATTERNS -- only
      // the added line's content (mcp_servers/secret literals) does. Reproduces the exact gap
      // DUR-67 slipped through: detectRiskySurfaceFromDiff(["server/src/adapter-home.ts"]) alone
      // would return [].
      const { companyId, projectId, agentId, issueId, runId } = await seedIssueWithWorkspace({
        changedFilePath: "server/src/adapter-home.ts",
        content: "export function stripMcpServersBlocks(toml) {\n  // mcp_servers env can carry secrets\n  return toml;\n}\n",
      });
      const { wakeup } = makeRecordingWakeup(db, companyId);

      const result = await evaluateSelfReviewDoneGate({
        db,
        wakeup,
        issue: { id: issueId, identifier: "T-1", companyId, projectId, executionPolicy: null },
        actor: { actorType: "agent", agentId, runId },
        requestedStatus: "done",
        currentStatus: "in_progress",
      });

      expect(result?.message).toContain("agent configuration");

      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).toContain("risky surface");
      expect(comments[0]?.body).toContain("If a dishonest agent wanted to abuse this change");
    });

    it("reads the full added-line diff content for a real diff via git", async () => {
      const { companyId, issueId } = await seedIssueWithWorkspace({
        changedFilePath: "server/src/adapter-home.ts",
        content: "// mcp_servers secret handling\n",
      });
      const diffContent = await getChangedDiffContentForIssueWorkspace(db, { companyId, issueId });
      expect(diffContent).toContain("+// mcp_servers secret handling");
    });

    it("DUR-83: still detects the risky surface after the assignee clears issue.executionWorkspaceId, because detection resolves the workspace by execution_workspaces.sourceIssueId, not the mutable issue column", async () => {
      const { companyId, projectId, agentId, issueId, runId } = await seedIssueWithWorkspace({
        changedFilePath: "server/src/services/authorization.ts",
      });
      // Simulate exactly the bypass DUR-83 describes: a plain field-only PATCH that clears
      // the issue's own executionWorkspaceId pointer without touching status.
      await db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, issueId));
      const { wakeup } = makeRecordingWakeup(db, companyId);

      const result = await evaluateSelfReviewDoneGate({
        db,
        wakeup,
        issue: { id: issueId, identifier: "T-1", companyId, projectId, executionPolicy: null },
        actor: { actorType: "agent", agentId, runId },
        requestedStatus: "done",
        currentStatus: "in_progress",
      });

      expect(result?.message).toContain("authorization or permissions");
    });

    it("falls back to the ordinary-only prompt when the workspace path can't actually be read (never guesses risky)", async () => {
      const { companyId, agentId, projectId, issueId, runId } = await seedCodeIssueFixture();
      const executionWorkspaceId = randomUUID();
      await db.insert(executionWorkspaces).values({
        id: executionWorkspaceId,
        companyId,
        projectId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "unreachable workspace",
        status: "active",
        providerType: "local_fs",
        cwd: "/nonexistent/paperclip-self-review-gate-test-path",
        baseRef: "base",
        sourceIssueId: issueId,
      });
      const { wakeup } = makeRecordingWakeup(db, companyId);

      await evaluateSelfReviewDoneGate({
        db,
        wakeup,
        issue: { id: issueId, identifier: "T-1", companyId, projectId, executionPolicy: null },
        actor: { actorType: "agent", agentId, runId },
        requestedStatus: "done",
        currentStatus: "in_progress",
      });

      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).not.toContain("risky surface");
    });

    it("DUR-270: still schedules a fresh pass when a later commit on the same issue adds a risky-surface change, even though an earlier (non-risky) diff already completed its one pass", async () => {
      const { companyId, projectId, agentId, issueId, repoRoot } = await seedIssueWithWorkspace({
        changedFilePath: "ui/src/components/WidgetCard.tsx",
      });

      // Fingerprint the diff exactly as evaluateSelfReviewDoneGate would have at the time the
      // earlier pass was scheduled, and record it as a completed pass under a different run --
      // simulating that pass reaching a terminal state without landing the handoff.
      const earlierFingerprint = computeReviewedDiffFingerprint(
        await getChangedFilePathsForIssueWorkspace(db, { companyId, issueId }),
        await getChangedDiffContentForIssueWorkspace(db, { companyId, issueId }),
      );
      const earlierSourceRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: earlierSourceRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "completed",
      });
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: SELF_REVIEW_PASS_REASON,
        payload: { reviewedDiffFingerprint: earlierFingerprint },
        status: "completed",
        idempotencyKey: buildSelfReviewPassIdempotencyKey({ issueId, sourceRunId: earlierSourceRunId }),
        requestedByActorType: "system",
        requestedByActorId: "issue_self_review_gate",
      });

      // The issue continues and a NEW commit lands a real risky-surface change.
      await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
      const riskyPath = path.join(repoRoot, "server/src/services/authorization.ts");
      await fs.mkdir(path.dirname(riskyPath), { recursive: true });
      await fs.writeFile(riskyPath, "// later risky change\n", "utf8");
      await runGit(repoRoot, ["add", "server/src/services/authorization.ts"]);
      await runGit(repoRoot, ["commit", "-m", "Later risky change"]);

      const laterRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: laterRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "running",
      });
      const { wakeup, calls } = makeRecordingWakeup(db, companyId);

      const result = await evaluateSelfReviewDoneGate({
        db,
        wakeup,
        issue: { id: issueId, identifier: "T-1", companyId, projectId, executionPolicy: null },
        actor: { actorType: "agent", agentId, runId: laterRunId },
        requestedStatus: "done",
        currentStatus: "in_progress",
      });

      // Must NOT silently bypass -- the new commit is risky and was never reviewed.
      expect(result?.message).toContain("authorization or permissions");
      expect(calls).toHaveLength(1);
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).toContain("risky surface");
      expect(comments[0]?.body).toContain("If a dishonest agent wanted to abuse this change");
    });

    it("DUR-270: still lets a later run through without scheduling a second pass when the diff is unchanged since the completed pass (no DUR-245 regression)", async () => {
      const { companyId, projectId, agentId, issueId } = await seedIssueWithWorkspace({
        changedFilePath: "ui/src/components/WidgetCard.tsx",
      });

      const fingerprint = computeReviewedDiffFingerprint(
        await getChangedFilePathsForIssueWorkspace(db, { companyId, issueId }),
        await getChangedDiffContentForIssueWorkspace(db, { companyId, issueId }),
      );
      const earlierSourceRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: earlierSourceRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "completed",
      });
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: SELF_REVIEW_PASS_REASON,
        payload: { reviewedDiffFingerprint: fingerprint },
        status: "completed",
        idempotencyKey: buildSelfReviewPassIdempotencyKey({ issueId, sourceRunId: earlierSourceRunId }),
        requestedByActorType: "system",
        requestedByActorId: "issue_self_review_gate",
      });

      const laterRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: laterRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "running",
      });
      const { wakeup, calls } = makeRecordingWakeup(db, companyId);

      const result = await evaluateSelfReviewDoneGate({
        db,
        wakeup,
        issue: { id: issueId, identifier: "T-1", companyId, projectId, executionPolicy: null },
        actor: { actorType: "agent", agentId, runId: laterRunId },
        requestedStatus: "done",
        currentStatus: "in_progress",
      });

      expect(result).toBeNull();
      expect(calls).toHaveLength(0);
    });

    it("DUR-286: a completed pass on an earlier, unrelated diff must not vouch for a later diff whose content buffer overflowed -- schedules a fresh pass instead", async () => {
      const { companyId, projectId, agentId, issueId, repoRoot } = await seedIssueWithWorkspace({
        changedFilePath: "ui/src/components/WidgetCard.tsx",
      });

      // An earlier, unrelated diff on this issue already completed its one bounded pass.
      const earlierFingerprint = computeReviewedDiffFingerprint(
        await getChangedFilePathsForIssueWorkspace(db, { companyId, issueId }),
        await getChangedDiffContentForIssueWorkspace(db, { companyId, issueId }),
      );
      const earlierSourceRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: earlierSourceRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "completed",
      });
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: SELF_REVIEW_PASS_REASON,
        payload: { reviewedDiffFingerprint: earlierFingerprint },
        status: "completed",
        idempotencyKey: buildSelfReviewPassIdempotencyKey({ issueId, sourceRunId: earlierSourceRunId }),
        requestedByActorType: "system",
        requestedByActorId: "issue_self_review_gate",
      });

      // A later commit touches a single file, but with a diff hunk large enough to overflow
      // RISKY_SURFACE_GIT_DIFF_CONTENT_MAX_BUFFER_BYTES (4MB) while the path-only read
      // (--name-only, RISKY_SURFACE_GIT_MAX_BUFFER_BYTES = 1MB) stays trivially small --
      // exactly the "big generated/vendored file" scenario from DUR-286, not an attacker
      // needing to defeat git itself.
      await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
      const bigPath = path.join(repoRoot, "server/src/services/authorization.ts");
      await fs.mkdir(path.dirname(bigPath), { recursive: true });
      await fs.writeFile(bigPath, "line of generated fixture content padding text\n".repeat(150_000), "utf8");
      await runGit(repoRoot, ["add", "server/src/services/authorization.ts"]);
      await runGit(repoRoot, ["commit", "-m", "Large generated fixture update"]);

      // Confirm the premise: paths are readable, content overflowed to null.
      const changedFilePaths = await getChangedFilePathsForIssueWorkspace(db, { companyId, issueId });
      const diffContent = await getChangedDiffContentForIssueWorkspace(db, { companyId, issueId });
      expect(changedFilePaths).not.toBeNull();
      expect(diffContent).toBeNull();

      const laterRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: laterRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "running",
      });
      const { wakeup, calls } = makeRecordingWakeup(db, companyId);

      const result = await evaluateSelfReviewDoneGate({
        db,
        wakeup,
        issue: { id: issueId, identifier: "T-1", companyId, projectId, executionPolicy: null },
        actor: { actorType: "agent", agentId, runId: laterRunId },
        requestedStatus: "done",
        currentStatus: "in_progress",
      });

      // Must NOT silently ride on the earlier, unrelated pass -- this diff was never seen by
      // any pass, so a fresh one must be scheduled.
      expect(result).not.toBeNull();
      expect(calls).toHaveLength(1);
    });

    it("DUR-290: stops scheduling more self-review passes once MAX_SELF_REVIEW_PASSES_FOR_UNREADABLE_DIFF have already been requested for a permanently oversized diff, and fails loud instead", async () => {
      const { companyId, projectId, agentId, issueId, repoRoot } = await seedIssueWithWorkspace({
        changedFilePath: "ui/src/components/WidgetCard.tsx",
      });

      // A diff hunk large enough to permanently overflow
      // RISKY_SURFACE_GIT_DIFF_CONTENT_MAX_BUFFER_BYTES while the path-only read stays small --
      // the "one large generated/vendored file that isn't going away" shape from DUR-290, not a
      // one-off transient failure.
      await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
      const bigPath = path.join(repoRoot, "server/src/services/authorization.ts");
      await fs.mkdir(path.dirname(bigPath), { recursive: true });
      await fs.writeFile(bigPath, "line of generated fixture content padding text\n".repeat(150_000), "utf8");
      await runGit(repoRoot, ["add", "server/src/services/authorization.ts"]);
      await runGit(repoRoot, ["commit", "-m", "Large generated fixture update"]);

      // Confirm the premise: paths are readable, content overflowed to null.
      expect(await getChangedFilePathsForIssueWorkspace(db, { companyId, issueId })).not.toBeNull();
      expect(await getChangedDiffContentForIssueWorkspace(db, { companyId, issueId })).toBeNull();

      // Simulate MAX_SELF_REVIEW_PASSES_FOR_UNREADABLE_DIFF earlier passes already having been
      // scheduled for this issue (from earlier runs that each failed to land their handoff --
      // e.g. turn-budget exhaustion, per the DUR-245 comment), none of which ever reached
      // "completed" for this diff.
      for (let i = 0; i < MAX_SELF_REVIEW_PASSES_FOR_UNREADABLE_DIFF; i++) {
        const priorRunId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: priorRunId,
          companyId,
          agentId,
          invocationSource: "assignment",
          status: "failed",
        });
        await db.insert(agentWakeupRequests).values({
          companyId,
          agentId,
          source: "automation",
          triggerDetail: "system",
          reason: SELF_REVIEW_PASS_REASON,
          payload: { reviewedDiffFingerprint: null },
          status: "failed",
          idempotencyKey: buildSelfReviewPassIdempotencyKey({ issueId, sourceRunId: priorRunId }),
          requestedByActorType: "system",
          requestedByActorId: "issue_self_review_gate",
        });
      }

      const laterRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: laterRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "running",
      });
      const { wakeup, calls } = makeRecordingWakeup(db, companyId);

      const result = await evaluateSelfReviewDoneGate({
        db,
        wakeup,
        issue: { id: issueId, identifier: "T-1", companyId, projectId, executionPolicy: null },
        actor: { actorType: "agent", agentId, runId: laterRunId },
        requestedStatus: "done",
        currentStatus: "in_progress",
      });

      // Must decline the transition (never silently let an unreviewed diff through -- that's
      // the exact security tradeoff DUR-286 established), but must NOT schedule yet another
      // pass, and the message must say something distinct from the ordinary "I've scheduled a
      // follow-up run" claim so an operator can tell this apart from a normal, bounded wait.
      expect(result).not.toBeNull();
      expect(result?.message).toMatch(/operator/i);
      expect(calls).toHaveLength(0);

      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).toMatch(/operator/i);
    });

    it("DUR-290: still schedules a bounded pass below the cap for a permanently oversized diff", async () => {
      const { companyId, projectId, agentId, issueId, repoRoot } = await seedIssueWithWorkspace({
        changedFilePath: "ui/src/components/WidgetCard.tsx",
      });

      await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
      const bigPath = path.join(repoRoot, "server/src/services/authorization.ts");
      await fs.mkdir(path.dirname(bigPath), { recursive: true });
      await fs.writeFile(bigPath, "line of generated fixture content padding text\n".repeat(150_000), "utf8");
      await runGit(repoRoot, ["add", "server/src/services/authorization.ts"]);
      await runGit(repoRoot, ["commit", "-m", "Large generated fixture update"]);

      expect(await countSelfReviewPassWakesForIssue(db, { companyId, issueId })).toBe(0);

      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "running",
      });
      const { wakeup, calls } = makeRecordingWakeup(db, companyId);

      const result = await evaluateSelfReviewDoneGate({
        db,
        wakeup,
        issue: { id: issueId, identifier: "T-1", companyId, projectId, executionPolicy: null },
        actor: { actorType: "agent", agentId, runId },
        requestedStatus: "done",
        currentStatus: "in_progress",
      });

      expect(result).not.toBeNull();
      expect(result?.message).not.toMatch(/operator/i);
      expect(calls).toHaveLength(1);
    });
  });

  describe("postSelfReviewPassNoticeComment / findExistingSelfReviewPassNoticeCommentForRun", () => {
    it("inserts a system comment and finds it again by company/issue/run/body", async () => {
      const { companyId, issueId, runId } = await seedCodeIssueFixture();

      const before = await findExistingSelfReviewPassNoticeCommentForRun(db, {
        companyId,
        issueId,
        sourceRunId: runId,
        body: SELF_REVIEW_PASS_NOTICE_COMMENT,
      });
      expect(before).toBeNull();

      await postSelfReviewPassNoticeComment(db, {
        companyId,
        issueId,
        sourceRunId: runId,
        body: SELF_REVIEW_PASS_NOTICE_COMMENT,
      });

      const after = await findExistingSelfReviewPassNoticeCommentForRun(db, {
        companyId,
        issueId,
        sourceRunId: runId,
        body: SELF_REVIEW_PASS_NOTICE_COMMENT,
      });
      expect(after).not.toBeNull();

      const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.body).toBe(SELF_REVIEW_PASS_NOTICE_COMMENT);
      expect(rows[0]?.authorType).toBe("system");
    });
  });
});
